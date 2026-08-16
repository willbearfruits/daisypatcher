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

/** Same cable? Same id AND same two ends. An id alone is not an identity. */
function sameConnection(a: Connection, b: Connection): boolean {
  return (
    a.id === b.id &&
    a.from.nodeId === b.from.nodeId &&
    a.from.socketId === b.from.socketId &&
    a.to.nodeId === b.to.nodeId &&
    a.to.socketId === b.to.socketId
  )
}

/**
 * Connections that must be torn down and rebuilt.
 *
 * Compared by id AND endpoints, not by id alone. Two patches can — and the
 * bundled examples all did — reuse the same connection ids (`c1`, `c2`, …)
 * for entirely different cables. Diffing by id treated those as unchanged,
 * so opening a second patch left the FIRST patch's Rete connections mounted:
 * still subscribed to nodes that no longer existed, still drawing the old
 * geometry, frozen in place while the new nodes sat elsewhere. That was
 * "cables don't refresh when I open a patch after another one".
 *
 * A connection whose id survives with different ends is reported as both
 * removed and added, which is what it is: a different cable that happens to
 * share a name.
 */
export function diffConnections(
  prev: Connection[],
  next: Connection[]
): ConnectionDiff {
  const prevById = new Map(prev.map((c) => [c.id, c]))
  const nextById = new Map(next.map((c) => [c.id, c]))

  const added: Connection[] = []
  const removed: Connection[] = []

  for (const c of next) {
    const p = prevById.get(c.id)
    if (!p || !sameConnection(p, c)) added.push(c)
  }
  for (const c of prev) {
    const n = nextById.get(c.id)
    if (!n || !sameConnection(c, n)) removed.push(c)
  }

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
