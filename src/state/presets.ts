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
import { bodyOf, withBody } from './subpatch'

export interface Preset {
  id: string
  name: string
  /**
   * PATH -> paramId -> value. Sparse: absent nodes keep their values.
   *
   * A path is the node's id at the root, or `<container>/<inner>` inside a
   * subpatch or poly body, nested as deep as the boxes go — the same
   * prefix `flattenGraph` gives inner nodes, minus the per-voice `/vN/`
   * segment. So `poly/osc` is one entry that means "the oscillator in
   * EVERY voice", which is the only sensible meaning for a preset: voices
   * are copies of one body and cannot be tuned apart from each other. Root
   * ids are nanoids and never contain `/`, so a preset saved before paths
   * existed is already a valid one.
   */
  values: Record<string, Record<string, number | string>>
}

/**
 * Walk the whole tree — root, every subpatch body, every poly body — and
 * hand each node to `fn` with its path and the graph it sits in.
 */
export function walkTree(
  graph: AudioGraph,
  fn: (node: NodeInstance, path: string, owner: AudioGraph) => void,
  prefix = ''
): void {
  for (const node of graph.nodes) {
    const path = prefix + node.id
    fn(node, path, graph)
    if (node.kind === 'subpatch' || node.kind === 'poly') {
      walkTree(bodyOf(node), fn, path + '/')
    }
  }
}

/**
 * The node a path names, and how to write it back.
 *
 * Returns the chain of containers from the root down to the node, so a
 * caller can rebuild the tree immutably from the leaf up: replace the
 * node in its body, then that body into its container, and so on. `null`
 * if any segment is missing — a preset from a patch that has since been
 * regrouped.
 */
export function resolvePath(
  graph: AudioGraph,
  path: string
): { node: NodeInstance; containers: NodeInstance[]; graphs: AudioGraph[] } | null {
  const segs = path.split('/')
  const containers: NodeInstance[] = []
  const graphs: AudioGraph[] = [graph]
  let cur = graph
  for (let i = 0; i < segs.length; i++) {
    const n = cur.nodes.find((x) => x.id === segs[i])
    if (!n) return null
    if (i === segs.length - 1) return { node: n, containers, graphs }
    if (n.kind !== 'subpatch' && n.kind !== 'poly') return null
    containers.push(n)
    cur = bodyOf(n)
    graphs.push(cur)
  }
  return null
}

/**
 * Set one param on the node at `path`, anywhere in the tree, returning a
 * new root graph. Immutable from the leaf up: the body that changed is
 * re-serialised into its container's `graph` param, and so on outward.
 * The root's own nodes array is only touched along the one chain.
 */
export function setParamAtPath(
  graph: AudioGraph,
  path: string,
  paramId: string,
  value: number | string
): AudioGraph {
  const hit = resolvePath(graph, path)
  if (!hit) return graph
  const { node, containers, graphs } = hit
  // Innermost graph with the node replaced.
  let body: AudioGraph = {
    ...graphs[graphs.length - 1],
    nodes: graphs[graphs.length - 1].nodes.map((n) =>
      n.id === node.id ? { ...n, params: { ...n.params, [paramId]: value } } : n
    )
  }
  // Wrap outward through each container.
  for (let i = containers.length - 1; i >= 0; i--) {
    const c = withBody(containers[i], body)
    const outer = graphs[i]
    body = { ...outer, nodes: outer.nodes.map((n) => (n.id === c.id ? c : n)) }
  }
  return body
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
const EXCLUDED_PARAMS = new Set(['bindingId', 'source', 'tree', 'elements', 'device'])

/**
 * Emulator-only stand-ins for physical controls. A preset that restored
 * these would fight the hardware on the device and fight your hands in the
 * app, so they are captured but explicitly skipped on recall for nodes that
 * are bound to something physical.
 */
export const SIMULATION_PARAMS = new Set(['value', 'sw_value', 'position', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'heading', 'dist', 'device'])

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

/**
 * Snapshot the whole TREE from `graph` down — every node at every depth,
 * keyed by path. Callers pass the root; a preset that only knew the open
 * level was useless the moment someone grouped their voice into a box.
 */
export function captureFrom(graph: AudioGraph, name: string, id: string): Preset {
  const values: Preset['values'] = {}
  walkTree(graph, (node, path) => {
    const ids = capturableParams(node)
    if (ids.length === 0) return
    const entry: Record<string, number | string> = {}
    for (const p of ids) {
      const v = node.params[p]
      if (typeof v === 'number' || typeof v === 'string') entry[p] = v
    }
    if (Object.keys(entry).length > 0) values[path] = entry
  })
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
export interface PresetEdit {
  /** Tree path — see `Preset.values`. Equal to the node id at the root. */
  path: string
  paramId: string
  value: number | string
}

export function recallEdits(graph: AudioGraph, preset: Preset): PresetEdit[] {
  const out: PresetEdit[] = []
  walkTree(graph, (node, path) => {
    const entry = preset.values[path]
    if (!entry) return
    for (const [paramId, value] of Object.entries(entry)) {
      if (isHardwareDriven(node, paramId)) continue
      if (node.params[paramId] === value) continue
      out.push({ path, paramId, value })
    }
  })
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
export function morphEdits(graph: AudioGraph, a: Preset, b: Preset, t: number): PresetEdit[] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  const out: PresetEdit[] = []
  walkTree(graph, (node, path) => {
    const ea = a.values[path]
    const eb = b.values[path]
    if (!ea || !eb) return
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
      out.push({ path, paramId, value })
    }
  })
  return out
}

/**
 * Re-key presets when nodes move between levels.
 *
 * Grouping a selection into a subpatch turns `osc` into `sub/osc`;
 * expanding it back does the reverse. A preset that still says `osc`
 * would silently stop reaching that node — the store calls this in the
 * same mutation as the collapse/expand so the presets never disagree with
 * the tree. `rename` maps old path → new path; anything not in the map is
 * kept as is.
 */
export function rekeyPresets(presets: Preset[], rename: ReadonlyMap<string, string>): Preset[] {
  if (rename.size === 0) return presets
  let changed = false
  const next = presets.map((p) => {
    let hit = false
    const values: Preset['values'] = {}
    for (const [key, entry] of Object.entries(p.values)) {
      // Rename the key itself, or any deeper path under a renamed prefix.
      let out = key
      for (const [from, to] of rename) {
        if (key === from) { out = to; break }
        if (key.startsWith(from + '/')) { out = to + key.slice(from.length); break }
      }
      if (out !== key) hit = true
      values[out] = entry
    }
    if (hit) changed = true
    return hit ? { ...p, values } : p
  })
  return changed ? next : presets
}

/** Every path in the tree — root ids plus `container/inner` at any depth. */
export function allNodePaths(graph: AudioGraph): Set<string> {
  const out = new Set<string>()
  walkTree(graph, (_n, path) => out.add(path))
  return out
}

/**
 * Presets referring to nodes that no longer exist, pruned.
 *
 * Also accepts a bare inner id where a path is expected: presets captured
 * by the build that keyed by "id of the open level" (before paths) named
 * `osc` for a node that is now `sub/osc`. If exactly one path in the tree
 * ends in that id, it is migrated rather than dropped.
 */
export function prunePresets(presets: Preset[], graph: AudioGraph): Preset[] {
  const live = allNodePaths(graph)
  const byLeaf = new Map<string, string[]>()
  for (const p of live) {
    const leaf = p.slice(p.lastIndexOf('/') + 1)
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), p])
  }
  let changed = false
  const next = presets.map((p) => {
    const values: Preset['values'] = {}
    let thisChanged = false
    for (const [key, entry] of Object.entries(p.values)) {
      if (live.has(key)) {
        values[key] = entry
        continue
      }
      const candidates = byLeaf.get(key)
      if (candidates && candidates.length === 1) {
        values[candidates[0]] = entry // legacy inner id → its one path
        thisChanged = true
        continue
      }
      thisChanged = true // gone
    }
    if (thisChanged) changed = true
    return thisChanged ? { ...p, values } : p
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
