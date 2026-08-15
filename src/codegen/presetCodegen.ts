/**
 * Presets on the device.
 *
 * The app has had presets since the Perform rework, and none of them
 * survived `Flash`. You could build a sound, capture eight variations,
 * play them from the Perform surface — then flash, and the box knew one
 * sound. That is not a preset system, it is a bookmark bar.
 *
 * THE MECHANISM IS BORROWED, DELIBERATELY. Menu leaves already needed a
 * way to change a node param at runtime, and `menuCodegen.ts` solved it by
 * emitting a mutable global per (node, param) and teaching `numParam()` to
 * resolve to that global instead of a literal. A preset recall is the same
 * operation with a different trigger, so it writes the same globals rather
 * than inventing a parallel path. Two consequences worth stating:
 *
 *   - A param driven by BOTH a menu leaf and a preset shares one variable.
 *     Recalling a preset moves the knob; turning the knob moves it back.
 *     That is the behaviour you want and it falls out for free.
 *   - Anything the menu path cannot reach, this cannot reach either. A few
 *     emitters read params through `rawNum()` to compute a buffer size or a
 *     pre-multiplied coefficient at codegen time; those are baked into the
 *     binary and no runtime write can move them. The audit in
 *     `makeOverrideAudit` catches it and warns, and the same warning now
 *     covers presets.
 *
 * WHAT IS NOT HERE: enum params. `Oscillator::WAVE_SIN` is a symbol the
 * emitter chose at codegen time, not a number in a variable, so a preset
 * that changes a waveform changes it in the emulator and cannot change it
 * on the device. Callers warn rather than pretend.
 */

import type { AudioGraph } from '@/types/graph'
import type { Preset } from '@/state/presets'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { nodeVar } from './graphWalk'
import type { MenuParamOverride } from './menuCodegen'
import { SIMULATION_PARAMS } from '@/state/presets'

/**
 * Params that stand in for a physical control while you are in the app.
 *
 * A `button`'s `value` is a slider in the Inspector and a GPIO read on the
 * device. Compiling a preset column for it produces a global the emitter
 * never uses — which the override audit then reports as "did not reach the
 * generated code", a true statement about a param that was never going to.
 * Recall already skips these in the app for hardware-bound nodes; firmware
 * skips them unconditionally, because on the device they are ALWAYS
 * hardware-bound.
 */

/** C float literal, matching the style the other emitters use. */
function f(n: number): string {
  if (!Number.isFinite(n)) return '0.f'
  return Number.isInteger(n) ? `${n}.f` : `${n}f`
}

/**
 * The (node, param) pairs any preset touches AND that firmware can move.
 *
 * Returns the same `MenuParamOverride` shape the menu path produces so the
 * two maps merge with a plain `set`. `menuVar`/`entryIndex` are empty here
 * — nothing reads them off a preset-only entry, and giving them fake
 * values would invite someone to.
 */
export function presetParamOverrides(
  graph: AudioGraph,
  presets: readonly Preset[],
  warn: (msg: string) => void
): Map<string, MenuParamOverride> {
  const out = new Map<string, MenuParamOverride>()
  if (presets.length === 0) return out

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  /** Warn once per param, not once per preset that mentions it. */
  const warned = new Set<string>()

  for (const preset of presets) {
    for (const [nodeId, entry] of Object.entries(preset.values)) {
      const node = nodeById.get(nodeId)
      if (!node) continue // a stale preset entry; the store prunes these
      const def = NODE_DEFINITIONS[node.kind]
      if (!def) continue

      for (const [paramId, value] of Object.entries(entry)) {
        const key = `${nodeId}|${paramId}`
        const param = def.params.find((p) => p.id === paramId)
        if (!param) continue
        if (SIMULATION_PARAMS.has(paramId)) continue

        if (param.kind !== 'number' || typeof value !== 'number') {
          if (!warned.has(key)) {
            warned.add(key)
            warn(
              `preset: ${node.kind}.${paramId} is not a numeric param — presets move it ` +
                `in the app but cannot move it on the device; drive it from a CV ` +
                `output instead if it needs to change at runtime`
            )
          }
          continue
        }
        if (out.has(key)) continue

        const raw = node.params[paramId]
        out.set(key, {
          varName: `dp_mp_${nodeVar(nodeId, node.kind)}_${paramId.replace(/[^A-Za-z0-9_]/g, '_')}`,
          nodeId,
          paramId,
          menuVar: '',
          entryIndex: -1,
          initial:
            typeof raw === 'number' && Number.isFinite(raw) ? raw : ((param.default as number) ?? 0)
        })
      }
    }
  }
  return out
}

export interface PresetTable {
  /** Column order: one entry per override, stable across both emitters. */
  columns: MenuParamOverride[]
  /** `rows[p][c]` — preset p's value for column c. */
  rows: number[][]
  names: string[]
}

/**
 * Flatten the presets into a dense table.
 *
 * Dense rather than sparse because the alternative — "absent means leave
 * it alone" — makes morphing between two presets that disagree about which
 * params they contain undefined. A preset that does not mention a param
 * gets the value the patch was saved with, which is what recalling it in
 * the app does too.
 */
export function buildPresetTable(
  graph: AudioGraph,
  presets: readonly Preset[],
  overrides: ReadonlyMap<string, MenuParamOverride>
): PresetTable {
  const columns = [...overrides.values()]
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const rows: number[][] = []

  for (const preset of presets) {
    const row: number[] = []
    for (const col of columns) {
      const stored = preset.values[col.nodeId]?.[col.paramId]
      if (typeof stored === 'number' && Number.isFinite(stored)) {
        row.push(stored)
        continue
      }
      // Not in this preset — fall back to the patch's own value.
      const live = nodeById.get(col.nodeId)?.params[col.paramId]
      row.push(typeof live === 'number' && Number.isFinite(live) ? live : col.initial)
    }
    rows.push(row)
  }

  return { columns, rows, names: presets.map((p) => p.name) }
}

/**
 * The preset table and the two functions that apply it.
 *
 * Emitted at file scope, after the param globals it writes to. `dp_preset_`
 * rather than `preset_` because these names live in the same flat namespace
 * as every node's variables, and a patch with a node called `preset` should
 * not collide with the runtime.
 */
export function emitPresetRuntime(table: PresetTable): string[] {
  if (table.rows.length === 0 || table.columns.length === 0) return []

  const nPresets = table.rows.length
  const nParams = table.columns.length
  const lines: string[] = []

  lines.push('// --- Presets (see presetCodegen.ts) ---')
  // The preset_recall emitter guards its calls on this, so a patch with the
  // node but no captured presets still links instead of failing at the
  // linker with a name nobody typed.
  lines.push('#define DP_PRESET_COUNT_OK 1')
  lines.push(`static const int DP_PRESET_COUNT = ${nPresets};`)
  lines.push(`static const int DP_PRESET_PARAMS = ${nParams};`)
  // Names are emitted as a comment, not a string table: nothing on the
  // device reads them, and a menu that wants to show them can be built
  // from the OLED nodes. Carrying dead strings into flash is not free.
  table.names.forEach((n, i) => lines.push(`// preset ${i}: ${n.replace(/\*\//g, '* /')}`))

  const body = table.rows
    .map((row) => `    { ${row.map(f).join(', ')} }`)
    .join(',\n')
  lines.push(`static const float dp_preset_table[DP_PRESET_COUNT][DP_PRESET_PARAMS] = {`)
  lines.push(body)
  lines.push('};')

  // Pointers into the live globals, so apply/morph are loops rather than
  // DP_PRESET_PARAMS lines of generated assignment.
  lines.push(`static float* const dp_preset_slots[DP_PRESET_PARAMS] = {`)
  lines.push(table.columns.map((c) => `    &${c.varName}`).join(',\n'))
  lines.push('};')

  lines.push(`
static inline void dp_preset_apply(int idx) {
    if (idx < 0) idx = 0;
    if (idx >= DP_PRESET_COUNT) idx = DP_PRESET_COUNT - 1;
    for (int i = 0; i < DP_PRESET_PARAMS; i++) {
        *dp_preset_slots[i] = dp_preset_table[idx][i];
    }
}

/* Linear interpolation between two presets. Numeric params only — see the
   header note on why enums cannot come along. */
static inline void dp_preset_morph(int a, int b, float t) {
    if (a < 0) a = 0;
    if (a >= DP_PRESET_COUNT) a = DP_PRESET_COUNT - 1;
    if (b < 0) b = 0;
    if (b >= DP_PRESET_COUNT) b = DP_PRESET_COUNT - 1;
    if (t < 0.f) t = 0.f;
    if (t > 1.f) t = 1.f;
    for (int i = 0; i < DP_PRESET_PARAMS; i++) {
        const float va = dp_preset_table[a][i];
        const float vb = dp_preset_table[b][i];
        *dp_preset_slots[i] = va + (vb - va) * t;
    }
}`)

  return lines
}

/**
 * True when the patch has a node that can actually fire a recall.
 *
 * A preset table nothing reaches is dead flash, and — worse — it reads as
 * a working feature to anyone browsing the generated code. The caller uses
 * this to warn instead.
 */
export function hasPresetDriver(graph: AudioGraph): boolean {
  return graph.nodes.some((n) => n.kind === 'preset_recall')
}
