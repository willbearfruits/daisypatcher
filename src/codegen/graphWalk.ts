/**
 * Shared graph-walking helpers. Extracted from `generateProject.ts` so
 * multiple target backends (Daisy Seed, ESP32-S3, ...) can reuse the
 * same topological sort + validation + identifier conventions without
 * duplicating them.
 *
 * Pure — no I/O, no side effects. Everything is deterministic on the
 * input graph.
 */
import type { AudioGraph, Connection, NodeInstance, NodeKind } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'

/** Sanitize a name into something safe for Make's TARGET + a C++ identifier. */
export function safeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!cleaned) return 'DaisypatcherPatch'
  if (/^[0-9]/.test(cleaned)) return `p_${cleaned}`
  return cleaned
}

/** C-identifier version of a node ID. */
export function nodeVar(nodeId: string, kind: NodeKind): string {
  return `${kind}_${nodeId.replace(/-/g, '_').replace(/[^A-Za-z0-9_]/g, '_')}`
}

export interface ConnectionIndex {
  byTarget: Map<string, { nodeId: string; socketId: string }>
}

export function targetKey(nodeId: string, socketId: string): string {
  return `${nodeId}|${socketId}`
}

export function buildConnectionIndex(conns: Connection[]): ConnectionIndex {
  const byTarget = new Map<string, { nodeId: string; socketId: string }>()
  for (const c of conns) {
    byTarget.set(targetKey(c.to.nodeId, c.to.socketId), c.from)
  }
  return { byTarget }
}

/**
 * Kahn's algorithm. Returns node IDs in processing order. On cycles, drops
 * the minimum-in-degree node (breaking the cycle) and continues.
 */
export function topoSort(
  nodes: NodeInstance[],
  conns: Connection[],
  warn: (msg: string) => void
): { order: string[]; cycleNodes: Set<string> } {
  const ids = new Set(nodes.map((n) => n.id))
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) {
    indeg.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const c of conns) {
    if (!ids.has(c.from.nodeId) || !ids.has(c.to.nodeId)) continue
    if (c.from.nodeId === c.to.nodeId) continue
    adj.get(c.from.nodeId)!.push(c.to.nodeId)
    indeg.set(c.to.nodeId, (indeg.get(c.to.nodeId) ?? 0) + 1)
  }

  const order: string[] = []
  const cycleNodes = new Set<string>()
  const isOutput = (id: string) => nodes.find((x) => x.id === id)?.kind === 'audio_output'

  const placed = new Set<string>()

  const pickNext = (): string | null => {
    let candidate: string | null = null
    for (const [id, d] of indeg) {
      if (placed.has(id)) continue
      if (d <= 0) {
        if (candidate === null) candidate = id
        else if (isOutput(candidate) && !isOutput(id)) candidate = id
      }
    }
    return candidate
  }

  while (placed.size < nodes.length) {
    let next = pickNext()
    if (next === null) {
      let minId: string | null = null
      let minVal = Infinity
      for (const [id, d] of indeg) {
        if (!placed.has(id) && d < minVal) {
          minVal = d
          minId = id
        }
      }
      if (minId === null) break
      warn(`cycle detected — forcing node ${minId} into order (may reference uninitialised outputs)`)
      cycleNodes.add(minId)
      next = minId
    }
    order.push(next)
    placed.add(next)
    for (const dep of adj.get(next) ?? []) {
      indeg.set(dep, (indeg.get(dep) ?? 1) - 1)
    }
  }

  return { order, cycleNodes }
}

export function validateGraph(graph: AudioGraph): string[] {
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const n of graph.nodes) {
    if (seen.has(n.id)) warnings.push(`duplicate node id: ${n.id}`)
    seen.add(n.id)
    if (!NODE_DEFINITIONS[n.kind]) warnings.push(`unknown node kind: ${n.kind}`)
  }
  const idSet = new Set(graph.nodes.map((n) => n.id))
  for (const c of graph.connections) {
    if (!idSet.has(c.from.nodeId)) warnings.push(`connection ${c.id}: unknown source ${c.from.nodeId}`)
    if (!idSet.has(c.to.nodeId)) warnings.push(`connection ${c.id}: unknown target ${c.to.nodeId}`)
    const srcNode = graph.nodes.find((n) => n.id === c.from.nodeId)
    const dstNode = graph.nodes.find((n) => n.id === c.to.nodeId)
    const fromDef = srcNode ? NODE_DEFINITIONS[srcNode.kind] : undefined
    const toDef = dstNode ? NODE_DEFINITIONS[dstNode.kind] : undefined
    if (fromDef && !fromDef.outputs.find((s) => s.id === c.from.socketId)) {
      warnings.push(`connection ${c.id}: unknown source socket ${c.from.socketId}`)
    }
    if (toDef && !toDef.inputs.find((s) => s.id === c.to.socketId)) {
      warnings.push(`connection ${c.id}: unknown target socket ${c.to.socketId}`)
    }
  }
  if (!graph.nodes.some((n) => n.kind === 'audio_output')) {
    warnings.push('no audio_output node — generated patch will be silent')
  }
  return warnings
}
