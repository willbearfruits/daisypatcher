/**
 * Menu → C++.
 *
 * The menu subsystem already has exactly one implementation of its layout
 * (`editor/menu/render.ts`) and one of its state machine
 * (`editor/menu/machine.ts`), shared by the in-node designer, the OLED
 * bitmap renderer and the Perform view. This module is the fourth consumer:
 * it translates the same two things into C++ so a physical encoder driving a
 * physical SSD1306 behaves identically to the emulator.
 *
 * It is target-agnostic on purpose. Everything here emits plain C++ over
 * `stdint`/`stdio`/`string`, and the only per-target pieces are the two
 * drawing back-ends at the bottom (libDaisy's `OneBitGraphicsDisplay` and
 * Arduino's `Adafruit_SSD1306`), which differ only in their draw calls.
 *
 * Three deliverables:
 *
 *   1. {@link MENU_RUNTIME_CPP} — the state machine and click classifier,
 *      a literal transliteration of `machine.ts`. Guarded by
 *      `#ifndef DP_MENU_RUNTIME` so any number of emitters can emit it.
 *   2. {@link emitMenuTables} — the user's tree flattened into a static
 *      table plus a mutable value array.
 *   3. {@link MENU_DRAW_DAISY_CPP} / {@link MENU_DRAW_ESP32_CPP} — the row
 *      layout from `render.ts`, drawn through each target's display API.
 *
 * Plus the two pieces of plumbing that let a leaf reach the rest of the
 * patch: {@link menuOrderingEdges} (topological ordering) and
 * {@link menuParamOverrides} (the value itself). See their docs.
 */

import type { AudioGraph, Connection, NodeInstance } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { collectValues, parseMenuTree, type MenuAction, type MenuNode, type MenuTree } from '@/editor/menu/tree'
import { nodeVar } from './graphWalk'

/* =====================================================================
 * Model — the tree, flattened for C++
 * ===================================================================== */

/** Numeric codes for the assignable long-press / double-click actions. */
const ACTION_CODE: Record<MenuAction, number> = {
  none: 0,
  back: 1,
  home: 2,
  reset: 3,
  toggle: 4
}

const OUT_SLOT: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 }

/**
 * Hard cap on tree size. `DpMenu::path` indexes a level with a `uint8_t`
 * and entries with an `int16_t`; a tree past this is a design mistake, not
 * something to silently truncate.
 */
const MAX_ENTRIES = 512
const MAX_LEVEL = 255

export interface MenuFlatEntry {
  label: string
  /** Index of this entry's first child, or -1 for a value leaf. */
  firstChild: number
  childCount: number
  isSubmenu: boolean
  isEnum: boolean
  /** 0..3 for CV outputs A..D, -1 for none. */
  out: number
  min: number
  max: number
  step: number
  defaultValue: number
  options: string[] | null
  unit: string
  /** Original leaf id — used to key param targets. */
  leafId: string
  target: { nodeId: string; paramId: string } | null
}

export interface MenuModel {
  entries: MenuFlatEntry[]
  rootFirst: number
  rootCount: number
  longMs: number
  doubleMs: number
  longAction: number
  doubleAction: number
  /** True when the tree has no entries at all — emitters skip the tables. */
  empty: boolean
}

/**
 * Flatten a tree so every parent's children occupy one contiguous run.
 *
 * That contiguity is what makes "the entries at the current path" a
 * `(first, count)` pair in C++ rather than a pointer chase, which in turn
 * lets `dp_menu_level()` mirror `entriesAt()` from `tree.ts` line for line.
 */
export function buildMenuModel(node: NodeInstance): MenuModel {
  const tree: MenuTree = parseMenuTree(node.params.tree)
  const entries: MenuFlatEntry[] = []
  let rootFirst = 0
  let rootCount = 0

  const blank = (n: MenuNode): MenuFlatEntry => ({
    label: n.label || n.id,
    firstChild: -1,
    childCount: 0,
    isSubmenu: n.kind === 'submenu',
    isEnum: n.kind === 'value' && n.type === 'enum',
    out: n.kind === 'value' ? (OUT_SLOT[n.out] ?? -1) : -1,
    min: n.kind === 'value' ? n.min : 0,
    max: n.kind === 'value' ? n.max : 0,
    step: n.kind === 'value' ? n.step : 0,
    defaultValue: n.kind === 'value' ? n.defaultValue : 0,
    options: n.kind === 'value' && n.type === 'enum' ? (n.options ?? []) : null,
    unit: n.kind === 'value' ? (n.unit ?? '') : '',
    leafId: n.id,
    target: n.kind === 'value' && n.target ? { ...n.target } : null
  })

  const blocks: { list: MenuNode[]; parent: number }[] = [{ list: tree.root, parent: -1 }]
  while (blocks.length) {
    const { list, parent } = blocks.shift()!
    const trimmed = list.slice(0, MAX_LEVEL)
    const first = entries.length
    if (entries.length + trimmed.length > MAX_ENTRIES) continue
    if (parent >= 0) {
      entries[parent].firstChild = first
      entries[parent].childCount = trimmed.length
    } else {
      rootFirst = first
      rootCount = trimmed.length
    }
    for (const n of trimmed) entries.push(blank(n))
    trimmed.forEach((n, i) => {
      if (n.kind === 'submenu') blocks.push({ list: n.children, parent: first + i })
    })
  }

  return {
    entries,
    rootFirst,
    rootCount,
    longMs: Math.max(50, Math.round(tree.longMs)),
    doubleMs: Math.max(50, Math.round(tree.doubleMs)),
    longAction: ACTION_CODE[tree.longPress] ?? 0,
    doubleAction: ACTION_CODE[tree.doubleClick] ?? 0,
    empty: entries.length === 0
  }
}

/**
 * Movement (in `delta` units) that counts as one encoder detent.
 *
 * `encoder_in` emits `delta = increment * step * (max - min)` — a scaled
 * quantity, not a detent count — so the menu has to know that scale to turn
 * it back into clicks. Resolving it from the actual upstream encoder is what
 * makes one physical click equal one menu step regardless of how the encoder
 * node is configured. Anything else feeding `delta` falls back to a unit
 * detent, which is the sane reading of "a raw CV pulse per step".
 */
export function menuDetentFor(graph: AudioGraph, menuNodeId: string): number {
  const conn = graph.connections.find((c) => c.to.nodeId === menuNodeId && c.to.socketId === 'delta')
  if (!conn) return 1
  const src = graph.nodes.find((n) => n.id === conn.from.nodeId)
  if (!src || src.kind !== 'encoder_in') return 1
  const num = (id: string, dflt: number): number => {
    const raw = src.params[id]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : dflt
  }
  const step = num('step', 0.02)
  const span = num('max', 1) - num('min', 0)
  const d = Math.abs(step * span)
  return d > 1e-9 ? d : 1
}

/* =====================================================================
 * Reaching the rest of the patch
 * ===================================================================== */

/** Socket-id prefix for the synthetic edges below. Never read by an emitter. */
const ORDER_SOCKET = '__dp_menu_order'

/**
 * Ordering-only edges from each menu to the nodes its leaves target.
 *
 * A leaf with a `target` drives a param with no cable — that is the whole
 * point of targets, and it is what makes "six oscillators x three params"
 * practical. But the value is written by the menu's `process` and read by
 * the target's, so the menu has to be emitted first or the target reads a
 * one-sample-stale value.
 *
 * Rather than special-case the scheduler, we hand `topoSort` a real edge on
 * a socket id no emitter ever queries. The ordering falls out of the
 * existing algorithm, cycles are reported by the existing warning, and
 * nothing downstream needs to know menus exist.
 *
 * Call AFTER `validateGraph` — these sockets are deliberately not in any
 * node definition and would otherwise be reported as unknown.
 */
export function menuOrderingEdges(graph: AudioGraph): Connection[] {
  const out: Connection[] = []
  const ids = new Set(graph.nodes.map((n) => n.id))
  let k = 0
  for (const node of graph.nodes) {
    if (node.kind !== 'menu') continue
    const seen = new Set<string>()
    for (const leaf of collectValues(parseMenuTree(node.params.tree))) {
      const t = leaf.target
      if (!t || !ids.has(t.nodeId) || t.nodeId === node.id) continue
      if (seen.has(t.nodeId)) continue
      seen.add(t.nodeId)
      const socket = `${ORDER_SOCKET}_${k++}`
      out.push({
        id: `__dp_menu_ord_${k}`,
        from: { nodeId: node.id, socketId: socket },
        to: { nodeId: t.nodeId, socketId: socket }
      })
    }
  }
  return out
}

export interface MenuParamOverride {
  /** C++ global that holds the live value. */
  varName: string
  /** Node whose param is being driven. */
  nodeId: string
  paramId: string
  /** Menu var + flat entry index the value comes from. */
  menuVar: string
  entryIndex: number
  initial: number
}

/**
 * Live-param globals for every numeric leaf target in the graph.
 *
 * The emitters bake params in as float literals (`SetFreq(220.f)`), which is
 * right for everything except a param something else drives at runtime. So
 * for exactly the params a menu targets we emit a mutable global and let
 * `numParam()` resolve to it instead of the literal — a two-line hook in
 * each emitter table rather than a rewrite of three thousand lines.
 *
 * Enum leaves are excluded: a graph enum param is a string the emitter
 * branches on at codegen time (`Oscillator::WAVE_SIN` is chosen, not
 * computed), so there is no variable to point at. Those still drive the
 * emulator and can still be patched through a CV output; the caller warns.
 */
export function menuParamOverrides(
  graph: AudioGraph,
  warn: (msg: string) => void
): Map<string, MenuParamOverride> {
  const byKey = new Map<string, MenuParamOverride>()
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))

  for (const node of graph.nodes) {
    if (node.kind !== 'menu') continue
    const model = buildMenuModel(node)
    const menuVar = nodeVar(node.id, 'menu')

    model.entries.forEach((e, idx) => {
      const t = e.target
      if (!t) return
      const target = nodeById.get(t.nodeId)
      if (!target) {
        warn(`menu ${node.id}: leaf "${e.label}" targets a node that is not in the patch`)
        return
      }
      const def = NODE_DEFINITIONS[target.kind]
      const param = def?.params.find((p) => p.id === t.paramId)
      if (!param) {
        warn(`menu ${node.id}: leaf "${e.label}" targets unknown param ${target.kind}.${t.paramId}`)
        return
      }
      if (e.isEnum || param.kind !== 'number') {
        warn(
          `menu ${node.id}: leaf "${e.label}" targets ${target.kind}.${t.paramId}, ` +
            `which is not a numeric param — it drives the emulator but not firmware; ` +
            `assign the leaf a CV output (A-D) and patch it instead`
        )
        return
      }
      const key = `${t.nodeId}|${t.paramId}`
      if (byKey.has(key)) {
        warn(`menu ${node.id}: ${target.kind}.${t.paramId} is targeted by more than one leaf; last wins`)
      }
      const raw = target.params[t.paramId]
      byKey.set(key, {
        varName: `dp_mp_${nodeVar(t.nodeId, target.kind)}_${t.paramId.replace(/[^A-Za-z0-9_]/g, '_')}`,
        nodeId: t.nodeId,
        paramId: t.paramId,
        menuVar,
        entryIndex: idx,
        initial: typeof raw === 'number' && Number.isFinite(raw) ? raw : (param.default as number) ?? 0
      })
    })
  }
  return byKey
}

/** Key used by both the override map and the emitter-side lookup. */
export function paramOverrideKey(nodeId: string, paramId: string): string {
  return `${nodeId}|${paramId}`
}

/**
 * Drop repeat copies of the include-guarded blocks from a declarations dump.
 *
 * Both the `menu` node and any OLED drawing it emit the runtime, because
 * neither can know which of them the topological sort will place first and
 * the definitions have to precede the OLED's draw function. The `#ifndef`
 * guards make that correct, but the preprocessor discards the duplicate
 * *after* it is already several hundred lines of generated source a user
 * might open. This trims them at the text level so the emitted file reads
 * the way it behaves.
 */
export function dedupeMenuBlocks(text: string): string {
  let out = text
  for (const block of [MENU_RUNTIME_CPP, MENU_DRAW_DAISY_CPP, MENU_DRAW_ESP32_CPP]) {
    const first = out.indexOf(block)
    if (first < 0) continue
    const head = out.slice(0, first + block.length)
    const tail = out.slice(first + block.length).split(block).join('')
    out = head + tail
  }
  return out
}

/** `${nodeId}|${paramId}` -> C++ global, the shape the emitters consume. */
export function overrideExprMap(
  overrides: ReadonlyMap<string, MenuParamOverride>
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, o] of overrides) out.set(k, o.varName)
  return out
}

/** File-scope declarations for the live-param globals. */
export function emitMenuParamGlobals(
  overrides: ReadonlyMap<string, MenuParamOverride>
): string[] {
  if (overrides.size === 0) return []
  const lines = ['// Params driven live by a menu leaf (see menuCodegen.ts).']
  for (const o of overrides.values()) {
    lines.push(`float ${o.varName} = ${f(o.initial)};`)
  }
  return lines
}

/**
 * Did the override actually land?
 *
 * `numParam()` is the hook, but a handful of emitters read a param through
 * `rawNum()` instead, to compute something at codegen time (a table size, a
 * pre-multiplied coefficient). Those cannot be made live, and the failure is
 * silent — the menu turns, the value changes, and the firmware ignores it.
 *
 * So after emitting a node, grep its own output for the global. If the name
 * is absent, the param was baked in somewhere this hook cannot reach, and
 * the user gets told rather than left wondering.
 */
export function makeOverrideAudit(
  overrides: ReadonlyMap<string, MenuParamOverride>,
  warn: (msg: string) => void
): (nodeId: string, emitted: string) => void {
  const byNode = new Map<string, MenuParamOverride[]>()
  for (const o of overrides.values()) {
    const list = byNode.get(o.nodeId)
    if (list) list.push(o)
    else byNode.set(o.nodeId, [o])
  }
  return (nodeId, emitted) => {
    for (const o of byNode.get(nodeId) ?? []) {
      if (emitted.includes(o.varName)) continue
      /*
       * `entryIndex < 0` marks a preset-only override (see presetCodegen).
       * Naming the wrong feature in the warning sends people to look at a
       * menu they never built.
       */
      const source = o.entryIndex < 0 ? 'preset' : 'menu'
      warn(
        `${source} target ${o.paramId} on node ${nodeId} did not reach the generated code — ` +
          `that emitter bakes the param in as a constant, so the ${source} will move the ` +
          `value in the app but not on the device`
      )
    }
  }
}

/* =====================================================================
 * C++ emission
 * ===================================================================== */

function cstr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function f(v: number): string {
  if (!Number.isFinite(v)) return '0.f'
  if (Number.isInteger(v)) return `${v}.f`
  let s = v.toPrecision(9)
  if (s.includes('e') || s.includes('E')) s = v.toFixed(9)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0')
  return `${s}f`
}

/**
 * The state machine, transliterated from `editor/menu/machine.ts`.
 *
 * Line-for-line on purpose: every function below has a counterpart there
 * with the same name and the same clamping, and the click classifier keeps
 * the same "short click fires on RELEASE, after the double-click window"
 * rule. If you change one, change both — that equivalence is the only thing
 * making the emulator a faithful preview of the hardware.
 */
export const MENU_RUNTIME_CPP = `#ifndef DP_MENU_RUNTIME
#define DP_MENU_RUNTIME 1
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define DP_MENU_MAX_DEPTH 8

// Assignable actions (long press / double click).
enum { DP_MENU_ACT_NONE = 0, DP_MENU_ACT_BACK, DP_MENU_ACT_HOME, DP_MENU_ACT_RESET, DP_MENU_ACT_TOGGLE };
// Gestures out of the click classifier.
enum { DP_MENU_EV_NONE = 0, DP_MENU_EV_CLICK, DP_MENU_EV_LONG, DP_MENU_EV_DOUBLE };

struct DpMenuEntry {
    const char*        label;
    int16_t            firstChild;   // -1 for a value leaf
    uint8_t            childCount;
    uint8_t            isSubmenu;
    uint8_t            isEnum;
    int8_t             out;          // 0..3 -> A..D, -1 none
    float              vmin;
    float              vmax;
    float              vstep;
    float              vdef;
    const char* const* options;      // enum labels, else 0
    uint8_t            optionCount;
    const char*        unit;
};

struct DpMenu {
    const DpMenuEntry* entries;
    float*             values;       // parallel to entries
    int16_t            entryCount;
    int16_t            rootFirst;
    uint8_t            rootCount;

    // Navigation. path[i] is the child index chosen at level i.
    uint8_t  path[DP_MENU_MAX_DEPTH];
    uint8_t  depth;
    int16_t  cursor;
    uint8_t  editing;

    // Click classifier.
    uint8_t  pressed;
    uint32_t pressedAtMs;
    uint32_t lastClickMs;
    uint8_t  clickPending;
    uint8_t  longFired;
    uint16_t longMs;
    uint16_t doubleMs;
    uint8_t  longAction;
    uint8_t  doubleAction;

    // Encoder movement -> detents.
    float    acc;
    float    detent;

    float    out[4];
};

static inline float dp_menu_clampf(float v, float lo, float hi) {
    if (!(v == v)) return lo;                 // NaN
    return v < lo ? lo : (v > hi ? hi : v);
}

/** Entries visible at the current path — mirrors entriesAt() in tree.ts. */
static inline void dp_menu_level(const DpMenu* m, int16_t* first, uint8_t* count) {
    int16_t fst = m->rootFirst;
    uint8_t cnt = m->rootCount;
    for (uint8_t i = 0; i < m->depth; i++) {
        uint8_t k = m->path[i];
        if (k >= cnt) break;
        const DpMenuEntry* e = &m->entries[fst + k];
        if (!e->isSubmenu) break;
        fst = e->firstChild;
        cnt = e->childCount;
    }
    *first = fst;
    *count = cnt;
}

/** Flat index of the entry under the cursor, or -1 on an empty level. */
static inline int16_t dp_menu_focused(const DpMenu* m) {
    int16_t first; uint8_t count;
    dp_menu_level(m, &first, &count);
    if (count == 0) return -1;
    int32_t c = m->cursor;
    if (c < 0) c = 0;
    if (c > (int32_t)count - 1) c = (int32_t)count - 1;
    return (int16_t)(first + c);
}

/** Refresh the four CV outputs from every leaf assigned to a slot. */
static inline void dp_menu_publish(DpMenu* m) {
    for (int16_t i = 0; i < m->entryCount; i++) {
        int8_t s = m->entries[i].out;
        if (s >= 0 && s < 4) m->out[s] = m->values[i];
    }
}

/**
 * Encoder rotation. Navigation clamps at the ends rather than wrapping, so
 * a fast spin lands predictably on the first or last entry.
 */
static inline void dp_menu_turn(DpMenu* m, int32_t detents) {
    if (detents == 0) return;
    int16_t first; uint8_t count;
    dp_menu_level(m, &first, &count);
    if (count == 0) return;

    if (!m->editing) {
        int32_t c = (int32_t)m->cursor + detents;
        if (c < 0) c = 0;
        if (c > (int32_t)count - 1) c = (int32_t)count - 1;
        m->cursor = (int16_t)c;
        return;
    }
    int16_t idx = dp_menu_focused(m);
    if (idx < 0) return;
    const DpMenuEntry* e = &m->entries[idx];
    if (e->isSubmenu) return;
    m->values[idx] = dp_menu_clampf(m->values[idx] + (float)detents * e->vstep, e->vmin, e->vmax);
}

/** Enter a submenu, start editing a leaf, or confirm an edit in progress. */
static inline void dp_menu_click(DpMenu* m) {
    int16_t first; uint8_t count;
    dp_menu_level(m, &first, &count);
    if (count == 0) return;
    int16_t idx = dp_menu_focused(m);
    if (idx < 0) return;

    if (m->editing) { m->editing = 0; return; }

    const DpMenuEntry* e = &m->entries[idx];
    if (e->isSubmenu) {
        if (m->depth < DP_MENU_MAX_DEPTH && e->childCount > 0) {
            m->path[m->depth++] = (uint8_t)(idx - first);
            m->cursor  = 0;
            m->editing = 0;
        }
        return;
    }
    m->editing = 1;
}

/** Up one level. No-op at the root, so a stray long press can't escape. */
static inline void dp_menu_back(DpMenu* m) {
    if (m->editing) { m->editing = 0; return; }
    if (m->depth == 0) return;
    m->depth--;
    // Land on the submenu we came out of, not the top of the parent list.
    m->cursor  = (int16_t)m->path[m->depth];
    m->editing = 0;
}

static inline void dp_menu_home(DpMenu* m) {
    m->depth = 0; m->cursor = 0; m->editing = 0;
}

static inline void dp_menu_reset(DpMenu* m) {
    int16_t idx = dp_menu_focused(m);
    if (idx < 0 || m->entries[idx].isSubmenu) return;
    m->values[idx] = m->entries[idx].vdef;
}

static inline void dp_menu_toggle(DpMenu* m) {
    int16_t idx = dp_menu_focused(m);
    if (idx < 0 || m->entries[idx].isSubmenu) return;
    const DpMenuEntry* e = &m->entries[idx];
    m->values[idx] = m->values[idx] > (e->vmin + e->vmax) * 0.5f ? e->vmin : e->vmax;
}

static inline void dp_menu_do(DpMenu* m, uint8_t action) {
    switch (action) {
        case DP_MENU_ACT_BACK:   dp_menu_back(m);   break;
        case DP_MENU_ACT_HOME:   dp_menu_home(m);   break;
        case DP_MENU_ACT_RESET:  dp_menu_reset(m);  break;
        case DP_MENU_ACT_TOGGLE: dp_menu_toggle(m); break;
        default: break;
    }
}

/**
 * Switch level -> gesture. A short click is reported on RELEASE and only
 * after the double-click window expires: until the button comes back up we
 * cannot know it is not a long press, and firing both would make every long
 * press also perform the short action.
 */
static inline uint8_t dp_menu_click_step(DpMenu* m, uint8_t level, uint32_t nowMs) {
    if (level && !m->pressed) {
        if (m->clickPending && (uint32_t)(nowMs - m->lastClickMs) <= (uint32_t)m->doubleMs) {
            m->pressed = 1; m->pressedAtMs = nowMs; m->clickPending = 0; m->longFired = 1;
            return DP_MENU_EV_DOUBLE;
        }
        m->pressed = 1; m->pressedAtMs = nowMs; m->longFired = 0;
        return DP_MENU_EV_NONE;
    }
    if (level && m->pressed && !m->longFired &&
        (uint32_t)(nowMs - m->pressedAtMs) >= (uint32_t)m->longMs) {
        m->longFired = 1;
        return DP_MENU_EV_LONG;
    }
    if (!level && m->pressed) {
        uint8_t wasLong = m->longFired;
        m->pressed = 0; m->longFired = 0;
        if (wasLong) { m->clickPending = 0; return DP_MENU_EV_NONE; }
        m->lastClickMs = nowMs; m->clickPending = 1;
        return DP_MENU_EV_NONE;
    }
    if (!level && m->clickPending && (uint32_t)(nowMs - m->lastClickMs) > (uint32_t)m->doubleMs) {
        m->clickPending = 0;
        return DP_MENU_EV_CLICK;
    }
    return DP_MENU_EV_NONE;
}

/**
 * Accumulate encoder movement and fire whole detents.
 *
 * Called every audio sample, so it stays an add plus two compares in the
 * common case. The 0.999 slack absorbs the last-ulp difference between the
 * detent size computed here and the one the encoder emitter computes.
 */
static inline void dp_menu_feed(DpMenu* m, float delta) {
    if (!(m->detent > 0.f)) return;
    m->acc += delta;
    float thr = m->detent * 0.999f;
    int guard = 0;
    while (m->acc >= thr && guard++ < 64)  { dp_menu_turn(m,  1); m->acc -= m->detent; }
    guard = 0;
    while (m->acc <= -thr && guard++ < 64) { dp_menu_turn(m, -1); m->acc += m->detent; }
}

/** Service the switch and refresh the outputs. Control rate is plenty. */
static inline void dp_menu_tick(DpMenu* m, uint8_t level, uint32_t nowMs) {
    uint8_t ev = dp_menu_click_step(m, level, nowMs);
    if      (ev == DP_MENU_EV_CLICK)  dp_menu_click(m);
    else if (ev == DP_MENU_EV_LONG)   dp_menu_do(m, m->longAction);
    else if (ev == DP_MENU_EV_DOUBLE) dp_menu_do(m, m->doubleAction);
    dp_menu_publish(m);
}

/* ---- text, mirroring formatValue() and titleFor() ---- */

static inline void dp_menu_value_text(const DpMenu* m, int16_t idx, char* buf, int n) {
    if (n <= 0) return;
    buf[0] = 0;
    if (idx < 0 || idx >= m->entryCount) return;
    const DpMenuEntry* e = &m->entries[idx];
    if (e->isSubmenu) return;
    float v = m->values[idx];
    if (e->isEnum) {
        int i = (int)(v + 0.5f);
        if (i < 0) i = 0;
        if (!e->options || e->optionCount == 0) { snprintf(buf, n, "%d", i); return; }
        if (i > (int)e->optionCount - 1) i = (int)e->optionCount - 1;
        snprintf(buf, n, "%s", e->options[i]);
        return;
    }
    int dec = e->vstep >= 1.f ? 0 : (e->vstep >= 0.1f ? 1 : 2);
    snprintf(buf, n, "%.*f%s", dec, (double)v, e->unit ? e->unit : "");
}

/** Title of the open level, upper-cased. "MENU" at the root. */
static inline void dp_menu_title(const DpMenu* m, char* buf, int n) {
    if (n <= 0) return;
    const char* label = "MENU";
    int16_t first = m->rootFirst;
    uint8_t count = m->rootCount;
    for (uint8_t i = 0; i < m->depth; i++) {
        uint8_t k = m->path[i];
        if (k >= count) break;
        const DpMenuEntry* e = &m->entries[first + k];
        if (!e->isSubmenu) break;
        label = e->label;
        first = e->firstChild;
        count = e->childCount;
    }
    int i = 0;
    for (; label[i] && i < n - 1; i++) {
        char c = label[i];
        buf[i] = (c >= 'a' && c <= 'z') ? (char)(c - 32) : c;
    }
    buf[i] = 0;
}

/**
 * First visible row. Scrolls by the minimum needed to keep the cursor in
 * view rather than paging, which is what makes a long list usable on six
 * rows. Mirrors buildMenuScreen() in render.ts.
 */
static inline int dp_menu_win_start(const DpMenu* m, uint8_t count, int visible) {
    if (visible <= 0 || (int)count <= visible) return 0;
    int c = m->cursor;
    if (c < 0) c = 0;
    if (c > (int)count - 1) c = (int)count - 1;
    int s = c - visible / 2;
    if (s < 0) s = 0;
    if (s > (int)count - visible) s = (int)count - visible;
    return s;
}
#endif // DP_MENU_RUNTIME
`

/**
 * Static tables plus the mutable value array for one menu node.
 *
 * The entry table is `const` so it lands in flash rather than RAM; only the
 * value array and the `DpMenu` itself are writable.
 */
export function emitMenuTables(v: string, m: MenuModel): string {
  const lines: string[] = []

  if (m.empty) {
    // An empty tree still needs a well-formed DpMenu so the OLED can draw
    // "empty" instead of dereferencing null.
    lines.push(`static const DpMenuEntry ${v}_entries[1] = { { "", -1, 0, 0, 0, -1, 0.f, 0.f, 0.f, 0.f, 0, 0, "" } };`)
    lines.push(`static float ${v}_values[1] = { 0.f };`)
    lines.push(`DpMenu ${v}_m;`)
    return lines.join('\n')
  }

  m.entries.forEach((e, i) => {
    if (!e.options || e.options.length === 0) return
    lines.push(
      `static const char* const ${v}_opt${i}[] = { ${e.options.map(cstr).join(', ')} };`
    )
  })

  lines.push(`// label, firstChild, childCount, isSubmenu, isEnum, out, min, max, step, default, options, optionCount, unit`)
  lines.push(`static const DpMenuEntry ${v}_entries[${m.entries.length}] = {`)
  m.entries.forEach((e, i) => {
    const opts = e.options && e.options.length ? `${v}_opt${i}` : '0'
    const optN = e.options ? e.options.length : 0
    lines.push(
      `    { ${cstr(e.label)}, ${e.firstChild}, ${e.childCount}, ${e.isSubmenu ? 1 : 0}, ` +
        `${e.isEnum ? 1 : 0}, ${e.out}, ${f(e.min)}, ${f(e.max)}, ${f(e.step)}, ${f(e.defaultValue)}, ` +
        `${opts}, ${optN}, ${cstr(e.unit)} },`
    )
  })
  lines.push(`};`)
  lines.push(
    `static float ${v}_values[${m.entries.length}] = { ${m.entries.map((e) => f(e.defaultValue)).join(', ')} };`
  )
  lines.push(`DpMenu ${v}_m;`)
  return lines.join('\n')
}

/** Runtime setup for one menu, called from the generated init block. */
export function emitMenuInit(v: string, m: MenuModel, detent: number): string {
  const n = m.empty ? 1 : m.entries.length
  return [
    `    // --- MENU ${v} ---`,
    `    {`,
    `        memset(&${v}_m, 0, sizeof ${v}_m);`,
    `        ${v}_m.entries      = ${v}_entries;`,
    `        ${v}_m.values       = ${v}_values;`,
    `        ${v}_m.entryCount   = ${n};`,
    `        ${v}_m.rootFirst    = ${m.rootFirst};`,
    `        ${v}_m.rootCount    = ${m.empty ? 0 : m.rootCount};`,
    `        ${v}_m.longMs       = ${m.longMs};`,
    `        ${v}_m.doubleMs     = ${m.doubleMs};`,
    `        ${v}_m.longAction   = ${m.longAction};`,
    `        ${v}_m.doubleAction = ${m.doubleAction};`,
    `        ${v}_m.detent       = ${f(detent)};`,
    `        dp_menu_publish(&${v}_m);`,
    `    }`
  ].join('\n')
}

export interface MenuProcessArgs {
  /** C++ variable prefix for this menu node. */
  v: string
  deltaExpr: string
  swExpr: string
  /** Target's millisecond clock (`System::GetNow()` / `millis()`). */
  nowExpr: string
  /** Output-socket variable names for A..D, in order. */
  outVars: [string, string, string, string]
  /** Param globals this menu drives, with the entry each reads from. */
  overrides: { varName: string; entryIndex: number }[]
}

/**
 * Per-sample body.
 *
 * Movement is fed every sample so no detent is lost, but the switch is only
 * classified every 32 samples (~0.7 ms at 48 kHz). A long press is half a
 * second; sampling a button at 1.5 kHz is already two orders of magnitude
 * more than the gesture needs, and it keeps a millisecond-clock read out of
 * the hot path.
 */
export function emitMenuProcess(a: MenuProcessArgs): string {
  const { v } = a
  const lines: string[] = [
    `    // --- MENU ${v}: feed movement every sample, classify the switch at control rate ---`,
    `    dp_menu_feed(&${v}_m, ${a.deltaExpr});`,
    `    if (++${v}_tick >= 32) {`,
    `        ${v}_tick = 0;`,
    `        dp_menu_tick(&${v}_m, (${a.swExpr}) >= 0.5f ? 1 : 0, ${a.nowExpr});`,
    `    }`
  ]
  a.outVars.forEach((name, i) => {
    lines.push(`    float ${name} = ${v}_m.out[${i}];`)
  })
  for (const o of a.overrides) {
    lines.push(`    ${o.varName} = ${v}_values[${o.entryIndex}];`)
  }
  return lines.join('\n') + '\n'
}

/* =====================================================================
 * Drawing — one back-end per display API
 * ===================================================================== */

/**
 * Row layout shared by both back-ends, as prose so the two stay honest:
 *
 *   y+1        title, then a rule at y+9
 *   y+12 ..    one 8px row per entry, cursor row inverted
 *   right      value, or `>` for a submenu, or `[value]` while editing
 *
 * This is the same geometry `drawMenuElement()` uses in the emulator's
 * bitmap renderer, so the in-app OLED preview and the physical panel agree.
 */
export const MENU_DRAW_DAISY_CPP = `#ifndef DP_MENU_DRAW
#define DP_MENU_DRAW 1
// Templated on the display so it works with any libDaisy OneBitGraphicsDisplay.
template <typename Disp>
static void dp_menu_draw(Disp& disp, const DpMenu* m, int ox, int oy, int ow, int oh, int rows) {
    char buf[40];
    dp_menu_title(m, buf, sizeof buf);
    disp.SetCursor(ox + 1, oy + 1);
    disp.WriteString(buf, Font_6x8, true);
    disp.DrawLine(ox, oy + 9, ox + ow - 1, oy + 9, true);

    int16_t first; uint8_t count;
    dp_menu_level(m, &first, &count);
    if (count == 0) {
        disp.SetCursor(ox + 2, oy + 14);
        disp.WriteString("(empty)", Font_6x8, true);
        return;
    }

    int start = dp_menu_win_start(m, count, rows);
    int end   = start + rows;
    if (end > (int)count) end = (int)count;
    if (start > 0)          { disp.SetCursor(ox + ow - 7, oy + 1); disp.WriteString("^", Font_6x8, true); }
    if (end < (int)count)   { disp.SetCursor(ox + ow - 7, oy + 1); disp.WriteString("v", Font_6x8, true); }

    int cur = m->cursor;
    if (cur < 0) cur = 0;
    if (cur > (int)count - 1) cur = (int)count - 1;

    int y = oy + 12;
    for (int i = start; i < end; i++) {
        if (y + 8 > oy + oh) break;
        const DpMenuEntry* e = &m->entries[first + i];
        bool sel = (i == cur);
        if (sel) disp.DrawRect(ox, y - 1, ox + ow - 1, y + 6, true, true);

        char tail[24];
        if (e->isSubmenu) { tail[0] = '>'; tail[1] = 0; }
        else if (sel && m->editing) {
            char vb[20];
            dp_menu_value_text(m, (int16_t)(first + i), vb, sizeof vb);
            snprintf(tail, sizeof tail, "[%s]", vb);
        } else {
            dp_menu_value_text(m, (int16_t)(first + i), tail, sizeof tail);
        }

        int tailW = (int)strlen(tail) * 6;
        int cols  = (ow - 4 - tailW) / 6;
        if (cols < 1) cols = 1;
        char lb[40];
        int k = 0;
        for (; e->label[k] && k < cols && k < (int)sizeof lb - 1; k++) lb[k] = e->label[k];
        lb[k] = 0;

        disp.SetCursor(ox + 2, y);
        disp.WriteString(lb, Font_6x8, !sel);
        if (tail[0]) {
            disp.SetCursor(ox + ow - tailW - 2, y);
            disp.WriteString(tail, Font_6x8, !sel);
        }
        y += 8;
    }
}
#endif // DP_MENU_DRAW
`

export const MENU_DRAW_ESP32_CPP = `#ifndef DP_MENU_DRAW
#define DP_MENU_DRAW 1
static void dp_menu_draw(Adafruit_SSD1306& disp, const DpMenu* m, int ox, int oy, int ow, int oh, int rows) {
    char buf[40];
    dp_menu_title(m, buf, sizeof buf);
    disp.setTextSize(1);
    disp.setTextColor(SSD1306_WHITE);
    disp.setCursor(ox + 1, oy + 1);
    disp.print(buf);
    disp.drawFastHLine(ox, oy + 9, ow, SSD1306_WHITE);

    int16_t first; uint8_t count;
    dp_menu_level(m, &first, &count);
    if (count == 0) {
        disp.setCursor(ox + 2, oy + 14);
        disp.print("(empty)");
        return;
    }

    int start = dp_menu_win_start(m, count, rows);
    int end   = start + rows;
    if (end > (int)count) end = (int)count;
    if (start > 0)        { disp.setCursor(ox + ow - 7, oy + 1); disp.print("^"); }
    if (end < (int)count) { disp.setCursor(ox + ow - 7, oy + 1); disp.print("v"); }

    int cur = m->cursor;
    if (cur < 0) cur = 0;
    if (cur > (int)count - 1) cur = (int)count - 1;

    int y = oy + 12;
    for (int i = start; i < end; i++) {
        if (y + 8 > oy + oh) break;
        const DpMenuEntry* e = &m->entries[first + i];
        bool sel = (i == cur);
        if (sel) disp.fillRect(ox, y - 1, ow, 8, SSD1306_WHITE);

        char tail[24];
        if (e->isSubmenu) { tail[0] = '>'; tail[1] = 0; }
        else if (sel && m->editing) {
            char vb[20];
            dp_menu_value_text(m, (int16_t)(first + i), vb, sizeof vb);
            snprintf(tail, sizeof tail, "[%s]", vb);
        } else {
            dp_menu_value_text(m, (int16_t)(first + i), tail, sizeof tail);
        }

        int tailW = (int)strlen(tail) * 6;
        int cols  = (ow - 4 - tailW) / 6;
        if (cols < 1) cols = 1;
        char lb[40];
        int k = 0;
        for (; e->label[k] && k < cols && k < (int)sizeof lb - 1; k++) lb[k] = e->label[k];
        lb[k] = 0;

        disp.setTextColor(sel ? SSD1306_BLACK : SSD1306_WHITE);
        disp.setCursor(ox + 2, y);
        disp.print(lb);
        if (tail[0]) {
            disp.setCursor(ox + ow - tailW - 2, y);
            disp.print(tail);
        }
        y += 8;
    }
    disp.setTextColor(SSD1306_WHITE);
}
#endif // DP_MENU_DRAW
`
