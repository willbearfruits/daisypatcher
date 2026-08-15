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

/**
 * Names declared at the OUTERMOST level of an emitted block.
 *
 * Depth matters and is the entire point. The bug this exists to catch is a
 * declaration that is present but nested:
 *
 *     {                       // scope opened for local-name isolation
 *         float node_out;     // dies here
 *         ...
 *     }
 *     // node_out is gone; every downstream node fails to compile
 *
 * A flat "does the name appear in a declaration anywhere" search calls that
 * correct, which is exactly the blind spot that let it ship. So we track
 * brace depth as we scan and only accept declarations at depth zero.
 *
 * Line-based rather than character-based because every declaration these
 * emitters produce is a single line; a declaration split across lines would
 * be missed, and being missed means a false "not declared" warning, which
 * is the safe direction to be wrong in.
 */
function declaredAtBlockScope(src: string): Set<string> {
  const out = new Set<string>()
  // A declaration cannot span a `;` or a brace, so the character class is
  // what keeps one statement from bleeding into the next.
  const DECL = /\b(?:float|double|int|bool|uint\d+_t|int\d+_t)\b([^;{}]*);/g
  let depth = 0

  for (const line of src.split('\n')) {
    if (depth === 0) {
      DECL.lastIndex = 0
      for (const m of line.matchAll(DECL)) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/[\s=[(]/)[0]?.replace(/^[*&]+/, '')
          if (name) out.add(name)
        }
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth = Math.max(0, depth - 1)
    }
  }
  return out
}

/**
 * Every output socket a node's process block assigns must also DECLARE its
 * variable at that block's top level.
 *
 * Thirteen ESP32 emitters once wrapped their body in braces for local-name
 * isolation and left the output declared inside them, so the variable died
 * at the closing brace and every downstream node failed to compile. The
 * snapshot tests never noticed — the emitted text was stable, it was just
 * wrong — and the compile harness misses it too whenever the offending
 * socket is a node's *secondary* output, because the minimal test graph only
 * ever wires the first one.
 *
 * So this is the always-on version: it runs on every generate and reports
 * into the file's warning header. Shared by both backends because the bug
 * class is shared by both emitter tables.
 *
 * Declarations are parsed rather than pattern-matched, because the real
 * emitters use the multi-declarator form (`float left, right;`) as often as
 * the single one, and a naive `float\\s+<name>` check calls every one of
 * those a bug.
 */
export function auditOutputDecls(
  node: NodeInstance,
  emitted: string,
  outputVar: (nodeId: string, socketId: string) => string,
  warn: (msg: string) => void
): void {
  const outputs = NODE_DEFINITIONS[node.kind]?.outputs ?? []
  if (outputs.length === 0 || !emitted) return

  const declared = declaredAtBlockScope(emitted)

  for (const sock of outputs) {
    const name = outputVar(node.id, sock.id)
    // Only complain about outputs the emitter actually produces; plenty of
    // nodes legitimately leave a socket unwritten.
    if (!emitted.includes(name)) continue
    if (declared.has(name)) continue
    warn(
      `${node.kind} ${node.id}: output "${sock.id}" is assigned but never declared ` +
        `at block scope — check for a stray brace around the emitter body`
    )
  }
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
