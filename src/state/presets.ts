/**
 * Presets — the whole parameter state, named and recallable.
 *
 * A patch describes a fixed circuit. An instrument has presets, and the
 * absence of them is most of what makes the Perform view feel like a wiring
 * diagram rather than something you play: every knob position you find is
 * one you then have to keep.
 *
 * WHAT A PRESET IS: every node's params, by id. Deliberately NOT the
 * topology — recalling a preset must never add, remove or rewire a node,
 * because that is the one thing you cannot do smoothly while a patch is
 * making sound. Topology is the patch; presets are positions within it.
 *
 * WHAT IT IS NOT: a snapshot of the hardware layout either. A preset that
 * moved pins would be unrecallable on a device already wired up.
 *
 * Morphing interpolates numeric params only. Enums and strings snap at the
 * halfway point — there is no meaningful value between `sine` and `square`,
 * and picking one arbitrarily partway would be a lie about what is
 * happening.
 */

import type { AudioGraph, NodeInstance } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'

export interface Preset {
  id: string
  name: string
  /** nodeId -> paramId -> value. Sparse: absent nodes keep their values. */
  values: Record<string, Record<string, number | string>>
}

/**
 * Params worth storing.
 *
 * Excludes `bindingId` (a hardware wiring reference — recalling a preset
 * must not repoint a knob at a different pot) and the opaque design blobs
 * (`source`, `tree`, `elements`), which are structure rather than state.
 * Storing those would make a preset able to rewrite a node's behaviour,
 * which is a different and much more surprising feature.
 */
const EXCLUDED_PARAMS = new Set(['bindingId', 'source', 'tree', 'elements'])

/**
 * Emulator-only stand-ins for physical controls. A preset that restored
 * these would fight the hardware on the device and fight your hands in the
 * app, so they are captured but explicitly skipped on recall for nodes that
 * are bound to something physical.
 */
export const SIMULATION_PARAMS = new Set(['value', 'sw_value', 'position', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'heading', 'dist'])

/**
 * Kinds whose params a preset must never touch.
 *
 * `preset_recall` is the only one so far, and it is a genuine foot-gun: its
 * params say WHICH preset to load, so capturing them means recalling preset
 * 2 can set the slot to 5, and the next trigger loads something you did not
 * ask for. A control that selects among snapshots cannot itself be part of
 * the snapshot.
 */
const EXCLUDED_KINDS = new Set<string>(['preset_recall'])

export function capturableParams(node: NodeInstance): string[] {
  const def = NODE_DEFINITIONS[node.kind]
  if (!def) return []
  if (EXCLUDED_KINDS.has(node.kind)) return []
  return def.params.map((p) => p.id).filter((id) => !EXCLUDED_PARAMS.has(id))
}

/** Snapshot the whole graph. */
export function captureFrom(graph: AudioGraph, name: string, id: string): Preset {
  const values: Preset['values'] = {}
  for (const node of graph.nodes) {
    const ids = capturableParams(node)
    if (ids.length === 0) continue
    const entry: Record<string, number | string> = {}
    for (const p of ids) {
      const v = node.params[p]
      if (typeof v === 'number' || typeof v === 'string') entry[p] = v
    }
    if (Object.keys(entry).length > 0) values[node.id] = entry
  }
  return { id, name, values }
}

/** Is this node's param driven by physical hardware right now? */
function isHardwareDriven(node: NodeInstance, paramId: string): boolean {
  const bound = typeof node.params.bindingId === 'string' && node.params.bindingId.length > 0
  return bound && SIMULATION_PARAMS.has(paramId)
}

/**
 * The params a recall would change, as `[nodeId, paramId, value]`.
 *
 * Returned rather than applied so the caller can put the whole recall in
 * one store transaction — a preset with sixty params must be one undo step,
 * not sixty.
 */
export function recallEdits(
  graph: AudioGraph,
  preset: Preset
): { nodeId: string; paramId: string; value: number | string }[] {
  const out: { nodeId: string; paramId: string; value: number | string }[] = []
  for (const node of graph.nodes) {
    const entry = preset.values[node.id]
    if (!entry) continue
    for (const [paramId, value] of Object.entries(entry)) {
      if (isHardwareDriven(node, paramId)) continue
      if (node.params[paramId] === value) continue
      out.push({ nodeId: node.id, paramId, value })
    }
  }
  return out
}

/**
 * Interpolate between two presets.
 *
 * `t` runs 0 (all `a`) to 1 (all `b`). Numeric params lerp; anything else
 * snaps at the midpoint rather than being invented. A param present in only
 * one preset is left alone — morphing toward a value that has no
 * counterpart would mean guessing what the other end was.
 */
export function morphEdits(
  graph: AudioGraph,
  a: Preset,
  b: Preset,
  t: number
): { nodeId: string; paramId: string; value: number | string }[] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  const out: { nodeId: string; paramId: string; value: number | string }[] = []
  for (const node of graph.nodes) {
    const ea = a.values[node.id]
    const eb = b.values[node.id]
    if (!ea || !eb) continue
    for (const [paramId, va] of Object.entries(ea)) {
      const vb = eb[paramId]
      if (vb === undefined) continue
      if (isHardwareDriven(node, paramId)) continue
      let value: number | string
      if (typeof va === 'number' && typeof vb === 'number') {
        value = va + (vb - va) * clamped
      } else {
        value = clamped < 0.5 ? va : vb
      }
      if (node.params[paramId] === value) continue
      out.push({ nodeId: node.id, paramId, value })
    }
  }
  return out
}

/** Presets referring to nodes that no longer exist, pruned. */
export function prunePresets(presets: Preset[], graph: AudioGraph): Preset[] {
  const live = new Set(graph.nodes.map((n) => n.id))
  let changed = false
  const next = presets.map((p) => {
    const values: Preset['values'] = {}
    for (const [nodeId, entry] of Object.entries(p.values)) {
      if (live.has(nodeId)) values[nodeId] = entry
      else changed = true
    }
    return changed ? { ...p, values } : p
  })
  return changed ? next : presets
}

/** Deserialize, tolerating anything. Never throws on a hand-edited file. */
export function parsePresets(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return []
  const out: Preset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.name !== 'string') continue
    const values: Preset['values'] = {}
    if (o.values && typeof o.values === 'object') {
      for (const [nodeId, entry] of Object.entries(o.values as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue
        const clean: Record<string, number | string> = {}
        for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v
          else if (typeof v === 'string') clean[k] = v
        }
        values[nodeId] = clean
      }
    }
    out.push({ id: o.id, name: o.name, values })
  }
  return out
}
