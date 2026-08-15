/**
 * Subpatches — a node whose body is another graph.
 *
 * THE PROBLEM: the tracker example is twenty-three nodes and already hard
 * to read. Nothing about the app stops you building a hundred-node patch;
 * what stops you is that you cannot see it. Collapsing a working chunk into
 * one box with named ports is the difference between a patch you can keep
 * extending and one you abandon.
 *
 * THE DESIGN: flatten at the boundary. Codegen and the audio engine both
 * consume a plain `AudioGraph`, and they are the two places a subpatch
 * would otherwise have to be understood. So it never reaches them — the
 * root graph is flattened first, and neither the emitters, the scheduler,
 * the connection index nor the engine learn that nesting exists.
 *
 * That is worth the constraint it implies: everything a subpatch can do is
 * something the flat graph could already do. No feedback across the
 * boundary that the flat graph would not allow, no separate scheduling. In
 * exchange, subpatches cost nothing at runtime and cannot introduce a class
 * of bug the flat path does not already have.
 *
 * PORTS: `sub_in` / `sub_out` nodes inside the body, the same inlet/outlet
 * idea Max and Pure Data use. Their `index` param says which of the
 * parent's four inputs or two outputs they stand for; a body with no port
 * nodes is legal and simply ignores its parent's cables.
 */

import type { AudioGraph, Connection, NodeInstance } from '@/types/graph'
import { emptyGraph } from '@/types/graph'

/** Port counts on the `subpatch` node. Fixed, for the same reason the code node's are. */
export const SUB_INPUTS = ['a', 'b', 'c', 'd'] as const
export const SUB_OUTPUTS = ['out', 'out2'] as const

/** How deep nesting may go. A cycle would otherwise hang the flattener. */
const MAX_DEPTH = 8

/**
 * Voices a `poly` node may hold.
 *
 * Capped because each voice is a full copy of the body in the flat graph:
 * eight copies of a six-node voice is forty-eight nodes of real DSP, which
 * is already more than a Daisy will run comfortably for anything
 * non-trivial. A limit you hit and understand beats one you discover as
 * dropouts.
 */
export const MAX_VOICES = 8

/** Read a subpatch node's body, tolerating anything on disk. */
export function bodyOf(node: NodeInstance): AudioGraph {
  const raw = node.params.graph
  if (typeof raw !== 'string' || !raw) return emptyGraph()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as AudioGraph).nodes) &&
      Array.isArray((parsed as AudioGraph).connections)
    ) {
      const g = parsed as AudioGraph
      return {
        nodes: g.nodes,
        connections: g.connections,
        meta: g.meta ?? { name: 'subpatch', sampleRate: 48000, blockSize: 48 }
      }
    }
  } catch {
    /* fall through */
  }
  return emptyGraph()
}

export function withBody(node: NodeInstance, body: AudioGraph): NodeInstance {
  return { ...node, params: { ...node.params, graph: JSON.stringify(body) } }
}

/** Port index a `sub_in` / `sub_out` node stands for. */
function portIndex(node: NodeInstance): number {
  const raw = node.params.index
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

/**
 * Expand every subpatch into its parent, recursively.
 *
 * Inner node ids are prefixed with the subpatch's id, which is what keeps
 * two instances of the same body from colliding — and is the whole reason
 * polyphony can later be "the same body, N times" rather than a special
 * case in codegen.
 *
 * Connections across the boundary are rewired, not deleted: a cable into
 * the parent's `a` lands on whatever the body's `sub_in 0` feeds. A port
 * with nothing behind it drops the cable, which is the honest reading of
 * "this subpatch does not use that input".
 */
export function flattenGraph(graph: AudioGraph, depth = 0): AudioGraph {
  if (depth > MAX_DEPTH) {
    return { ...graph, nodes: graph.nodes.filter((n) => n.kind !== 'subpatch' && n.kind !== 'poly') }
  }
  // Cheap exit for the common case, but it has to know about EVERY
  // structural kind — checking only for `subpatch` silently skipped
  // polyphony entirely, and a poly-only patch rendered as nothing.
  if (!graph.nodes.some((n) => n.kind === 'subpatch' || n.kind === 'poly')) return graph

  const nodes: NodeInstance[] = []
  const connections: Connection[] = [...graph.connections]

  for (const node of graph.nodes) {
    if (node.kind === 'poly') {
      expandPoly(node, nodes, connections, depth)
      continue
    }
    if (node.kind !== 'subpatch') {
      nodes.push(node)
      continue
    }

    const inner = flattenGraph(bodyOf(node), depth + 1)
    const prefix = `${node.id}/`
    const rename = (id: string): string => `${prefix}${id}`

    // Body nodes, minus the port markers — those are boundary metadata, not
    // DSP, and leaving them in would emit a passthrough node per port.
    const portIn = new Map<number, string>()
    const portOut = new Map<number, string>()
    for (const n of inner.nodes) {
      if (n.kind === 'sub_in') {
        portIn.set(portIndex(n), rename(n.id))
        continue
      }
      if (n.kind === 'sub_out') {
        portOut.set(portIndex(n), rename(n.id))
        continue
      }
      nodes.push({ ...n, id: rename(n.id) })
    }

    // Inner cables, renamed.
    const innerConns = inner.connections.map((c) => ({
      ...c,
      id: rename(c.id),
      from: { ...c.from, nodeId: rename(c.from.nodeId) },
      to: { ...c.to, nodeId: rename(c.to.nodeId) }
    }))

    /*
     * Splice out the port markers. A cable that ENDS at `sub_out 0` really
     * ends at the parent's `out`; a cable that STARTS at `sub_in 0` really
     * starts wherever the parent's `a` comes from. Resolving both here
     * means the flat graph has no trace of the boundary.
     */
    const outSource = new Map<number, { nodeId: string; socketId: string }>()
    const inTargets = new Map<number, { nodeId: string; socketId: string }[]>()
    const kept: Connection[] = []

    for (const c of innerConns) {
      const toPort = [...portOut.entries()].find(([, id]) => id === c.to.nodeId)
      const fromPort = [...portIn.entries()].find(([, id]) => id === c.from.nodeId)
      if (toPort) {
        outSource.set(toPort[0], c.from)
        continue
      }
      if (fromPort) {
        const list = inTargets.get(fromPort[0]) ?? []
        list.push(c.to)
        inTargets.set(fromPort[0], list)
        continue
      }
      kept.push(c)
    }
    connections.push(...kept)

    // Rewire the parent's cables onto the resolved inner endpoints.
    for (let i = connections.length - 1; i >= 0; i--) {
      const c = connections[i]
      if (c.to.nodeId === node.id) {
        const idx = SUB_INPUTS.indexOf(c.to.socketId as (typeof SUB_INPUTS)[number])
        const targets = idx >= 0 ? inTargets.get(idx) : undefined
        connections.splice(i, 1)
        if (!targets) continue
        // One inlet may feed several places inside; each becomes its own
        // cable, exactly as it would if you had drawn them by hand.
        targets.forEach((t, k) =>
          connections.push({ id: `${c.id}~${k}`, from: c.from, to: t })
        )
      } else if (c.from.nodeId === node.id) {
        const idx = SUB_OUTPUTS.indexOf(c.from.socketId as (typeof SUB_OUTPUTS)[number])
        const src = idx >= 0 ? outSource.get(idx) : undefined
        connections.splice(i, 1)
        if (!src) continue
        connections.push({ id: `${c.id}~o`, from: src, to: c.to })
      }
    }
  }

  return { ...graph, nodes, connections }
}

/**
 * Pull a selection out into a new subpatch body.
 *
 * Cables that crossed the selection boundary become ports, so collapsing
 * cannot silently disconnect anything — a chunk that took two inputs and
 * produced one output becomes a box with two inlets and one outlet, wired
 * the same way it was.
 *
 * Returns null when the selection cannot be collapsed cleanly: more
 * crossings than there are ports. Refusing is better than dropping cables
 * the user would only notice by ear.
 */
export function collapseSelection(
  graph: AudioGraph,
  selected: Set<string>,
  subpatchId: string,
  position: { x: number; y: number }
): { graph: AudioGraph; node: NodeInstance; warning?: string } | null {
  const inside = graph.nodes.filter((n) => selected.has(n.id))
  if (inside.length === 0) return null
  const insideIds = new Set(inside.map((n) => n.id))

  // Distinct external sources feeding in, and internal sources feeding out.
  const incoming: Connection[] = []
  const outgoing: Connection[] = []
  const internal: Connection[] = []

  for (const c of graph.connections) {
    const fromIn = insideIds.has(c.from.nodeId)
    const toIn = insideIds.has(c.to.nodeId)
    if (fromIn && toIn) internal.push(c)
    else if (!fromIn && toIn) incoming.push(c)
    else if (fromIn && !toIn) outgoing.push(c)
  }

  // One inlet per distinct external SOURCE, not per cable: two cables from
  // the same oscillator into the chunk are one signal arriving, and should
  // cost one port.
  const inKey = (c: { from: Connection['from'] }) => `${c.from.nodeId}|${c.from.socketId}`
  const outKey = (c: { from: Connection['from'] }) => `${c.from.nodeId}|${c.from.socketId}`
  const inSources = [...new Set(incoming.map(inKey))]
  const outSources = [...new Set(outgoing.map(outKey))]

  if (inSources.length > SUB_INPUTS.length || outSources.length > SUB_OUTPUTS.length) {
    return null
  }

  const bodyNodes: NodeInstance[] = inside.map((n) => ({ ...n }))
  const bodyConns: Connection[] = internal.map((c) => ({ ...c }))
  let seq = 0
  const nid = () => `p${++seq}`

  // Inlets.
  inSources.forEach((key, idx) => {
    const portId = nid()
    const anchor = inside[0]
    bodyNodes.push({
      id: portId,
      kind: 'sub_in',
      position: { x: anchor.position.x - 220, y: anchor.position.y + idx * 90 },
      params: { index: idx, label: SUB_INPUTS[idx] }
    })
    for (const c of incoming) {
      if (inKey(c) !== key) continue
      bodyConns.push({ id: `${portId}_${c.id}`, from: { nodeId: portId, socketId: 'out' }, to: c.to })
    }
  })

  // Outlets.
  outSources.forEach((key, idx) => {
    const portId = nid()
    const anchor = inside[inside.length - 1]
    bodyNodes.push({
      id: portId,
      kind: 'sub_out',
      position: { x: anchor.position.x + 220, y: anchor.position.y + idx * 90 },
      params: { index: idx, label: SUB_OUTPUTS[idx] }
    })
    const [nodeId, socketId] = key.split('|')
    bodyConns.push({ id: `${portId}_src`, from: { nodeId, socketId }, to: { nodeId: portId, socketId: 'in' } })
  })

  const body: AudioGraph = {
    nodes: bodyNodes,
    connections: bodyConns,
    meta: { name: 'subpatch', sampleRate: graph.meta.sampleRate, blockSize: graph.meta.blockSize }
  }

  const node: NodeInstance = {
    id: subpatchId,
    kind: 'subpatch',
    position,
    params: { graph: JSON.stringify(body), label: 'Subpatch' }
  }

  // Outer graph: drop the collapsed nodes and their cables, then reconnect
  // the crossings to the new box's ports.
  const outerNodes = graph.nodes.filter((n) => !insideIds.has(n.id))
  const outerConns: Connection[] = graph.connections.filter(
    (c) => !insideIds.has(c.from.nodeId) && !insideIds.has(c.to.nodeId)
  )
  let cseq = 0
  const cid = () => `${subpatchId}_c${++cseq}`

  inSources.forEach((key, idx) => {
    const [nodeId, socketId] = key.split('|')
    outerConns.push({ id: cid(), from: { nodeId, socketId }, to: { nodeId: subpatchId, socketId: SUB_INPUTS[idx] } })
  })
  outSources.forEach((key, idx) => {
    for (const c of outgoing) {
      if (outKey(c) !== key) continue
      outerConns.push({ id: cid(), from: { nodeId: subpatchId, socketId: SUB_OUTPUTS[idx] }, to: c.to })
    }
  })

  return {
    graph: { ...graph, nodes: [...outerNodes, node], connections: outerConns },
    node
  }
}

/**
 * Dissolve a subpatch back into its parent — the exact inverse of collapse.
 *
 * Reuses `flattenGraph` on a one-node graph rather than reimplementing the
 * splice, so expanding can never disagree with what codegen would have
 * produced. The two staying in step matters more than the few lines it
 * saves.
 */
export function expandSubpatch(graph: AudioGraph, nodeId: string): AudioGraph | null {
  const node = graph.nodes.find((n) => n.id === nodeId && n.kind === 'subpatch')
  if (!node) return null
  const flat = flattenGraph(graph)
  // Only this subpatch should dissolve, so put the others back untouched.
  const others = graph.nodes.filter((n) => n.kind === 'subpatch' && n.id !== nodeId)
  if (others.length === 0) return flat
  const otherIds = new Set(others.map((n) => n.id))
  const keptNodes = flat.nodes.filter((n) => ![...otherIds].some((id) => n.id.startsWith(`${id}/`)))
  const rebuilt = [...keptNodes, ...others]
  const ids = new Set(rebuilt.map((n) => n.id))
  const keptConns = graph.connections.filter(
    (c) => ids.has(c.from.nodeId) && ids.has(c.to.nodeId)
  )
  const inner = flattenGraph({ ...graph, nodes: [node], connections: [] })
  return {
    ...graph,
    nodes: [...rebuilt.filter((n) => n.id !== nodeId), ...inner.nodes],
    connections: [
      ...keptConns.filter((c) => c.from.nodeId !== nodeId && c.to.nodeId !== nodeId),
      ...inner.connections,
      ...rewireAcross(graph, nodeId)
    ]
  }
}

/** Parent cables into/out of a dissolved subpatch, landing on its innards. */
function rewireAcross(graph: AudioGraph, nodeId: string): Connection[] {
  const flatAll = flattenGraph(graph)
  return flatAll.connections.filter(
    (c) =>
      (c.from.nodeId.startsWith(`${nodeId}/`) && !c.to.nodeId.startsWith(`${nodeId}/`)) ||
      (!c.from.nodeId.startsWith(`${nodeId}/`) && c.to.nodeId.startsWith(`${nodeId}/`))
  )
}


/* =====================================================================
 * Polyphony
 * ===================================================================== */

/**
 * Expand a `poly` node into N copies of its body, summed.
 *
 * This is why flattening prefixes inner ids: "the same body, N times" is
 * already a solved problem the moment two instances cannot collide. So
 * polyphony needs no new emitter, no runtime voice manager and no change to
 * the audio engine — it is a graph transformation, and every copy is
 * ordinary DSP that codegen already knows how to emit.
 *
 * VOICE STACKING, NOT NOTE ALLOCATION. Every voice runs all the time and
 * hears the same inputs; what differs is `voice_id`, which flattening
 * replaces with a constant per copy. That gives detuned stacks, choruses
 * and per-voice variation — genuinely most of what the structure is for.
 * Assigning incoming notes to free voices is a separate feature that needs
 * runtime state, and pretending otherwise would be the dishonest version.
 *
 * Outputs are summed through a tree of `sum` nodes rather than by wiring
 * every voice at one socket: an input socket holds one cable, and quietly
 * keeping the last would drop seven voices out of eight.
 */
function expandPoly(
  node: NodeInstance,
  nodes: NodeInstance[],
  connections: Connection[],
  depth: number
): void {
  const raw = node.params.voices
  const count = Math.max(1, Math.min(MAX_VOICES, Math.round(typeof raw === 'number' ? raw : Number(raw) || 1)))
  const body = flattenGraph(bodyOf(node), depth + 1)

  /** Per-voice: where each outlet index ends up in the flat graph. */
  const voiceOuts: Map<number, { nodeId: string; socketId: string }>[] = []
  /** Per-voice: where each inlet index feeds. */
  const voiceIns: Map<number, { nodeId: string; socketId: string }[]>[] = []

  for (let v = 0; v < count; v++) {
    const prefix = `${node.id}/v${v}/`
    const rename = (id: string): string => `${prefix}${id}`
    const portIn = new Map<number, string>()
    const portOut = new Map<number, string>()

    for (const n of body.nodes) {
      if (n.kind === 'sub_in') {
        portIn.set(portIndex(n), rename(n.id))
        continue
      }
      if (n.kind === 'sub_out') {
        portOut.set(portIndex(n), rename(n.id))
        continue
      }
      if (n.kind === 'voice_id') {
        /*
         * Baked to a constant per copy. `index` is the voice number and
         * `norm` spreads 0..1 across the stack, which is the form you
         * actually want for detune and pan — and with one voice it is 0
         * rather than a division by zero.
         */
        nodes.push({
          id: rename(n.id),
          kind: 'constant',
          position: n.position,
          params: { value: count > 1 ? v / (count - 1) : 0 }
        })
        nodes.push({
          id: `${rename(n.id)}_i`,
          kind: 'constant',
          position: n.position,
          params: { value: v }
        })
        continue
      }
      nodes.push({ ...n, id: rename(n.id) })
    }

    const innerConns = body.connections.map((c) => ({
      ...c,
      id: rename(c.id),
      from: { ...c.from, nodeId: rename(c.from.nodeId) },
      to: { ...c.to, nodeId: rename(c.to.nodeId) }
    }))

    const outSource = new Map<number, { nodeId: string; socketId: string }>()
    const inTargets = new Map<number, { nodeId: string; socketId: string }[]>()

    for (const c of innerConns) {
      // `voice_id.index` is a second constant node; route it there.
      const fromVoiceIndex = c.from.socketId === 'index' && nodes.some((n) => n.id === `${c.from.nodeId}_i`)
      const from = fromVoiceIndex ? { nodeId: `${c.from.nodeId}_i`, socketId: 'out' } : c.from
      const fromNorm = c.from.socketId === 'norm' ? { nodeId: c.from.nodeId, socketId: 'out' } : from

      const toPort = [...portOut.entries()].find(([, id]) => id === c.to.nodeId)
      const fromPort = [...portIn.entries()].find(([, id]) => id === c.from.nodeId)
      if (toPort) {
        outSource.set(toPort[0], fromNorm)
        continue
      }
      if (fromPort) {
        const list = inTargets.get(fromPort[0]) ?? []
        list.push(c.to)
        inTargets.set(fromPort[0], list)
        continue
      }
      connections.push({ ...c, from: fromNorm })
    }

    voiceOuts.push(outSource)
    voiceIns.push(inTargets)
  }

  // Parent cables: inputs fan out to every voice, outputs come from the sum.
  const sumSources: Map<number, { nodeId: string; socketId: string }> = new Map()
  for (let o = 0; o < SUB_OUTPUTS.length; o++) {
    const sources = voiceOuts.map((m) => m.get(o)).filter((x): x is { nodeId: string; socketId: string } => !!x)
    if (sources.length === 0) continue
    if (sources.length === 1) {
      sumSources.set(o, sources[0])
      continue
    }
    sumSources.set(o, buildSumTree(node.id, o, sources, nodes, connections, node.position))
  }

  for (let i = connections.length - 1; i >= 0; i--) {
    const c = connections[i]
    if (c.to.nodeId === node.id) {
      const idx = SUB_INPUTS.indexOf(c.to.socketId as (typeof SUB_INPUTS)[number])
      connections.splice(i, 1)
      if (idx < 0) continue
      // Every voice hears the same input — that is what stacking means.
      let k = 0
      for (const m of voiceIns) {
        for (const t of m.get(idx) ?? []) {
          connections.push({ id: `${c.id}~v${k++}`, from: c.from, to: t })
        }
      }
    } else if (c.from.nodeId === node.id) {
      const idx = SUB_OUTPUTS.indexOf(c.from.socketId as (typeof SUB_OUTPUTS)[number])
      const src = idx >= 0 ? sumSources.get(idx) : undefined
      connections.splice(i, 1)
      if (!src) continue
      connections.push({ id: `${c.id}~p`, from: src, to: c.to })
    }
  }
}

/**
 * Chain `sum` nodes (four inputs each) until one output remains.
 *
 * A tree rather than a chain so eight voices cost two levels of addition
 * instead of seven — the depth shows up as latency in a feedback path and
 * as scheduling depth in the topological sort.
 */
function buildSumTree(
  polyId: string,
  outIndex: number,
  sources: { nodeId: string; socketId: string }[],
  nodes: NodeInstance[],
  connections: Connection[],
  position: { x: number; y: number }
): { nodeId: string; socketId: string } {
  let level = sources
  let tier = 0
  while (level.length > 1) {
    const next: { nodeId: string; socketId: string }[] = []
    for (let i = 0; i < level.length; i += 4) {
      const chunk = level.slice(i, i + 4)
      if (chunk.length === 1) {
        next.push(chunk[0])
        continue
      }
      const id = `${polyId}/sum${outIndex}_${tier}_${i}`
      nodes.push({
        id,
        kind: 'sum',
        position: { x: position.x + 160 + tier * 160, y: position.y + i * 40 },
        params: {}
      })
      chunk.forEach((src, k) => {
        connections.push({ id: `${id}_c${k}`, from: src, to: { nodeId: id, socketId: `in${k + 1}` } })
      })
      next.push({ nodeId: id, socketId: 'out' })
    }
    level = next
    tier++
  }
  return level[0]
}
