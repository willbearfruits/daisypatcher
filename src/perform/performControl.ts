/**
 * performControl — the single value path between a Perform-view control
 * and the patch graph.
 *
 * A placed hardware component (`PlacedComponent`) is linked to at most one
 * graph node via that node's `params.bindingId`. The Perform view's knobs,
 * faders and footswitches sweep the node's *emulated* value param — the
 * same param the Inspector slider drives — so the WebAudio emulation reacts
 * exactly as if the user had moved the sidebar slider.
 *
 * `setComponentValue01()` is deliberately the ONE write entry point:
 * mouse drags call it today; a future MIDI-learn driver maps CC 0..127 to
 * 0..1 and calls the identical function, so learned bindings and mouse
 * sweeps can never diverge in behavior.
 *
 * History note: callers own transaction bracketing. A drag gesture wraps
 * its whole pointer-capture lifetime in `beginTransaction()` /
 * `endTransaction()` (the Inspector slider pattern) so N move events
 * coalesce into one undo entry.
 */

import { NODE_DEFINITIONS, type ParamDef } from '@/nodes/definitions'
import { useEditorStore } from '@/state/store'
import type { AudioGraph, NodeInstance } from '@/types/graph'

export interface BoundControl {
  node: NodeInstance
  /** The numeric param this control sweeps (usually `value`). */
  param: ParamDef
  min: number
  max: number
  /** Param default as a number (reset target for double-click). */
  defaultValue: number
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Resolve the graph node bound to `componentId` and the numeric param a
 * physical control should sweep. Preference order: a param literally named
 * `value` (the emulator-input convention for `knob_in` / `button` /
 * `gate_in`), else the first numeric param. Returns null when the
 * component is unbound or the node exposes nothing sweepable — the view
 * renders such controls inert.
 */
export function resolveBoundControl(
  graph: AudioGraph,
  componentId: string
): BoundControl | null {
  const node = graph.nodes.find((n) => n.params.bindingId === componentId)
  if (!node) return null
  const def = NODE_DEFINITIONS[node.kind]
  if (!def) return null
  const param =
    def.params.find((p) => p.id === 'value' && p.kind === 'number') ??
    def.params.find((p) => p.kind === 'number')
  if (!param) return null
  const min = param.min ?? 0
  const max = param.max ?? 1
  const defaultValue =
    typeof param.default === 'number' ? param.default : Number(param.default) || 0
  return { node, param, min, max, defaultValue }
}

/**
 * Current normalized (0..1) value of the control bound to `componentId`,
 * or null when nothing sweepable is bound. Safe inside a Zustand selector:
 * returns a primitive.
 */
export function controlValue01(graph: AudioGraph, componentId: string): number | null {
  const bc = resolveBoundControl(graph, componentId)
  if (!bc) return null
  const raw = bc.node.params[bc.param.id]
  const v = typeof raw === 'number' ? raw : Number(raw ?? bc.defaultValue)
  const span = bc.max - bc.min
  if (span === 0 || !Number.isFinite(v)) return 0
  return clamp01((v - bc.min) / span)
}

/**
 * THE value-set path. Maps a normalized 0..1 position into the bound
 * param's declared range (clamped, snapped to `step` when present) and
 * writes it through the store's `setParam`. Mouse drag today; MIDI-learn
 * tomorrow — both go through here.
 */
export function setComponentValue01(componentId: string, value01: number): void {
  const store = useEditorStore.getState()
  const bc = resolveBoundControl(store.graph, componentId)
  if (!bc) return
  const span = bc.max - bc.min
  let value = bc.min + clamp01(value01) * span
  const step = bc.param.step
  if (step && step > 0) {
    value = bc.min + Math.round((value - bc.min) / step) * step
  }
  value = Math.min(bc.max, Math.max(bc.min, value))
  store.setParam(bc.node.id, bc.param.id, value)
}

/** Reset the bound param to its definition default (double-click). */
export function resetComponentValue(componentId: string): void {
  const store = useEditorStore.getState()
  const bc = resolveBoundControl(store.graph, componentId)
  if (!bc) return
  store.setParam(bc.node.id, bc.param.id, bc.defaultValue)
}

/**
 * Cycle a 3-way switch component through its bound node's `position` enum
 * (-1 → 0 → +1 → -1). No-op when unbound.
 */
export function cycleSwitchPosition(componentId: string): void {
  const store = useEditorStore.getState()
  const node = store.graph.nodes.find((n) => n.params.bindingId === componentId)
  if (!node) return
  const def = NODE_DEFINITIONS[node.kind]
  const param = def?.params.find((p) => p.id === 'position' && p.kind === 'enum')
  if (!param || !param.options || param.options.length === 0) return
  const cur = String(node.params.position ?? param.default)
  const idx = param.options.findIndex((o) => o.value === cur)
  const next = param.options[(idx + 1) % param.options.length]
  store.setParam(node.id, 'position', next.value)
}

/**
 * Current switch position of the bound `switch_3way` node as a number
 * (-1 | 0 | 1). Defaults to 0 when unbound. Primitive — selector-safe.
 */
export function switchPositionOf(graph: AudioGraph, componentId: string): number {
  const node = graph.nodes.find((n) => n.params.bindingId === componentId)
  if (!node) return 0
  const v = Number(node.params.position ?? 0)
  return v > 0 ? 1 : v < 0 ? -1 : 0
}
