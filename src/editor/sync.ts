/**
 * Diffing helpers. The store is canonical, so the editor reduces every store
 * change to a minimal set of add/remove/modify operations against its Rete
 * scene. Keeping this pure and synchronous makes the sync loop easy to reason
 * about and cheap — no DOM work happens here.
 */

import type { AudioGraph, Connection, NodeInstance } from '@/types/graph'

export interface NodeDiff {
  added: NodeInstance[]
  removed: NodeInstance[]
  /** Nodes whose position or params changed — identity preserved. */
  modified: { prev: NodeInstance; next: NodeInstance }[]
}

export interface ConnectionDiff {
  added: Connection[]
  removed: Connection[]
}

export interface GraphDiff {
  nodes: NodeDiff
  connections: ConnectionDiff
}

export function diffNodes(prev: NodeInstance[], next: NodeInstance[]): NodeDiff {
  const prevById = new Map(prev.map((n) => [n.id, n]))
  const nextById = new Map(next.map((n) => [n.id, n]))

  const added: NodeInstance[] = []
  const removed: NodeInstance[] = []
  const modified: { prev: NodeInstance; next: NodeInstance }[] = []

  for (const n of next) {
    const p = prevById.get(n.id)
    if (!p) {
      added.push(n)
    } else if (p !== n) {
      modified.push({ prev: p, next: n })
    }
  }
  for (const p of prev) {
    if (!nextById.has(p.id)) removed.push(p)
  }

  return { added, removed, modified }
}

export function diffConnections(
  prev: Connection[],
  next: Connection[]
): ConnectionDiff {
  const prevById = new Map(prev.map((c) => [c.id, c]))
  const nextById = new Map(next.map((c) => [c.id, c]))

  const added: Connection[] = []
  const removed: Connection[] = []

  for (const c of next) if (!prevById.has(c.id)) added.push(c)
  for (const c of prev) if (!nextById.has(c.id)) removed.push(c)

  return { added, removed }
}

export function diffGraph(prev: AudioGraph | null, next: AudioGraph): GraphDiff {
  return {
    nodes: diffNodes(prev?.nodes ?? [], next.nodes),
    connections: diffConnections(prev?.connections ?? [], next.connections)
  }
}

export function samePosition(a: NodeInstance, b: NodeInstance): boolean {
  return a.position.x === b.position.x && a.position.y === b.position.y
}
