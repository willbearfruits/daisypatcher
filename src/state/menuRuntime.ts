/**
 * Main-thread runtime for `menu` nodes.
 *
 * Drives the state machine from whatever is patched into a menu's `delta`
 * and `click` inputs, applies the resulting value changes, and pushes the
 * four CV outputs at the worklet.
 *
 * Why the main thread rather than the worklet: see the header of
 * `audio/worklets/menu.worklet.ts`. In short, worklets cannot import, so
 * running the machine there would mean a hand-copied fourth implementation.
 *
 * How input reaches it: in the emulator an `encoder_in` node has no physical
 * encoder — its `value` and `sw_value` params ARE the encoder. So rather
 * than sampling an audio-rate cable, the runtime resolves the connection
 * back to its source node and watches those params. That keeps the whole
 * path control-rate and observable, and it means the in-node menu preview
 * and the Perform view drive the menu through exactly the same route as a
 * physical encoder will on hardware.
 */

import { useEditorStore } from '@/state/store'
import type { AudioEngine } from '@/types/store'
import type { AudioGraph, NodeInstance } from '@/types/graph'
import {
  clickStep,
  initialClickState,
  initialMenuState,
  menuAction,
  menuClick,
  menuTurn,
  type ClickDetectorState,
  type MenuState
} from '@/editor/menu/machine'
import {
  collectValues,
  parseMenuTree,
  serializeMenuTree,
  type MenuTree,
  type MenuValue
} from '@/editor/menu/tree'

/** Per-menu-node runtime state, keyed by node id. */
interface MenuRuntimeEntry {
  state: MenuState
  click: ClickDetectorState
  /** Encoder position last seen, to derive detents from an absolute value. */
  lastEncoderValue: number
  /** Serialized outs last pushed, so we only post on change. */
  lastOutsJson: string
}

const entries = new Map<string, MenuRuntimeEntry>()

/*
 * The engine handle, set once by the app shell. `driveMenu` is called from
 * button handlers that have no engine reference, and a menu edit has to
 * reach the worklet's CV outs from there too — otherwise turning the
 * encoder moves target params but the A-D outputs (and anything watching
 * them, like an OLED meter) silently never change.
 */
let engineRef: AudioEngine | null = null

export function setMenuEngine(engine: AudioEngine | null): void {
  engineRef = engine
}

function entryFor(id: string): MenuRuntimeEntry {
  let e = entries.get(id)
  if (!e) {
    e = {
      state: initialMenuState(),
      click: initialClickState(),
      lastEncoderValue: Number.NaN,
      lastOutsJson: ''
    }
    entries.set(id, e)
  }
  return e
}

/** Forget state for nodes that no longer exist. */
function prune(graph: AudioGraph): void {
  if (entries.size === 0) return
  const live = new Set(graph.nodes.filter((n) => n.kind === 'menu').map((n) => n.id))
  for (const id of [...entries.keys()]) if (!live.has(id)) entries.delete(id)
}

/** The node feeding `socketId` on `nodeId`, or null. */
function sourceOf(graph: AudioGraph, nodeId: string, socketId: string): NodeInstance | null {
  const c = graph.connections.find((x) => x.to.nodeId === nodeId && x.to.socketId === socketId)
  if (!c) return null
  return graph.nodes.find((n) => n.id === c.from.nodeId) ?? null
}

function numParam(n: NodeInstance | null, id: string, fallback: number): number {
  if (!n) return fallback
  const raw = n.params[id]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/** Current values of the four CV outs, from leaves assigned to each slot. */
function outsFor(tree: MenuTree): number[] {
  const outs = [0, 0, 0, 0]
  const slot: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 }
  for (const v of collectValues(tree)) {
    const i = slot[v.out]
    if (i !== undefined) outs[i] = v.value
  }
  return outs
}

/**
 * Push a leaf's value at its target param.
 *
 * Enum targets take the option *value* string at the leaf's index, because
 * a graph enum param stores its value as a string (`'square'`), not the
 * index the menu counts in.
 */
function applyTarget(v: MenuValue, setParam: (n: string, p: string, x: number | string) => void): void {
  if (!v.target) return
  if (v.type === 'enum') {
    const label = v.options?.[Math.round(v.value)]
    if (label === undefined) return
    setParam(v.target.nodeId, v.target.paramId, label)
    return
  }
  setParam(v.target.nodeId, v.target.paramId, v.value)
}

/**
 * Advance every menu node once. Call from the engine's frame loop or any
 * steady tick; `nowMs` drives long-press and double-click timing.
 */
export function stepMenus(engine: AudioEngine | null, nowMs: number): void {
  if (engine) engineRef = engine
  const store = useEditorStore.getState()
  const graph = store.graph
  prune(graph)

  for (const node of graph.nodes) {
    if (node.kind !== 'menu') continue
    const e = entryFor(node.id)
    let tree = parseMenuTree(node.params.tree)

    /* ---- rotation ---- */
    const encNode = sourceOf(graph, node.id, 'delta')
    // `encoder_in.delta` pulses per detent; its `value` is the integrated
    // position. Differencing the position is more robust than sampling the
    // pulse, which a control-rate tick can miss entirely.
    const encValue = numParam(encNode, 'value', Number.NaN)
    const encStep = numParam(encNode, 'step', 0.02)
    let detents = 0
    if (Number.isFinite(encValue)) {
      if (Number.isFinite(e.lastEncoderValue) && encStep > 0) {
        detents = Math.round((encValue - e.lastEncoderValue) / encStep)
      }
      e.lastEncoderValue = encValue
    }

    /* ---- switch ---- */
    const clickNode = sourceOf(graph, node.id, 'click')
    const level = numParam(clickNode, 'sw_value', 0) >= 0.5
    const cs = clickStep(e.click, level, nowMs, tree.longMs, tree.doubleMs)
    e.click = cs.state

    if (detents === 0 && cs.event === null) {
      // Nothing happened; still make sure the outs are published once.
      publishOuts(engine, node.id, tree, e)
      continue
    }

    /* ---- run the machine ---- */
    const changed: { leafId: string; value: number }[] = []

    if (detents !== 0) {
      const r = menuTurn(tree, e.state, detents)
      e.state = r.state
      tree = r.tree
      changed.push(...r.changed)
    }
    if (cs.event === 'click') {
      const r = menuClick(tree, e.state)
      e.state = r.state
      tree = r.tree
      changed.push(...r.changed)
    } else if (cs.event === 'long') {
      const r = menuAction(tree, e.state, tree.longPress)
      e.state = r.state
      tree = r.tree
      changed.push(...r.changed)
    } else if (cs.event === 'double') {
      const r = menuAction(tree, e.state, tree.doubleClick)
      e.state = r.state
      tree = r.tree
      changed.push(...r.changed)
    }

    if (changed.length > 0) {
      /*
       * One transaction for the whole tick: a leaf edit writes both the
       * menu's own `tree` param and the target node's param, and a fast
       * spin produces a burst of ticks. Without this a single turn of the
       * encoder would fill the 50-entry undo stack.
       */
      store.beginTransaction()
      store.setParam(node.id, 'tree', serializeMenuTree(tree))
      const byId = new Map(collectValues(tree).map((v) => [v.id, v]))
      for (const c of changed) {
        const leaf = byId.get(c.leafId)
        if (leaf) applyTarget(leaf, store.setParam)
      }
      store.endTransaction()
    }
    // Pure navigation changes no values, so nothing is persisted — the
    // cursor lives in runtime state, not in the patch file.

    publishOuts(engine, node.id, tree, e)
  }
}

function publishOuts(
  engine: AudioEngine | null,
  nodeId: string,
  tree: MenuTree,
  e: MenuRuntimeEntry
): void {
  if (!engine) return
  const json = JSON.stringify(outsFor(tree))
  if (json === e.lastOutsJson) return
  e.lastOutsJson = json
  engine.updateParam(nodeId, 'outs', json)
}

/** Live navigation state, for the in-node preview and OLED rendering. */
export function menuStateFor(nodeId: string): MenuState {
  return entryFor(nodeId).state
}

/**
 * Drive a menu directly, bypassing the encoder — used by the in-node
 * editor's preview buttons so a menu can be designed and tested before any
 * hardware is wired.
 */
export function driveMenu(
  nodeId: string,
  gesture: 'cw' | 'ccw' | 'click' | 'long' | 'double'
): void {
  const store = useEditorStore.getState()
  const node = store.graph.nodes.find((n) => n.id === nodeId)
  if (!node || node.kind !== 'menu') return
  const e = entryFor(nodeId)
  let tree = parseMenuTree(node.params.tree)

  const r =
    gesture === 'cw'
      ? menuTurn(tree, e.state, 1)
      : gesture === 'ccw'
        ? menuTurn(tree, e.state, -1)
        : gesture === 'click'
          ? menuClick(tree, e.state)
          : menuAction(tree, e.state, gesture === 'long' ? tree.longPress : tree.doubleClick)

  e.state = r.state
  tree = r.tree
  if (r.changed.length > 0) {
    store.beginTransaction()
    store.setParam(nodeId, 'tree', serializeMenuTree(tree))
    const byId = new Map(collectValues(tree).map((v) => [v.id, v]))
    for (const c of r.changed) {
      const leaf = byId.get(c.leafId)
      if (leaf) applyTarget(leaf, store.setParam)
    }
    store.endTransaction()
  }
  publishOuts(engineRef, nodeId, tree, e)
}
