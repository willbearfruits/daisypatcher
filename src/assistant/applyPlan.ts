/**
 * Applying a validated plan to the store.
 *
 * The whole plan is ONE undo entry. That is not a nicety — an assistant
 * that adds six nodes and eight cables, and needs fourteen presses of
 * Ctrl+Z to take back, is an assistant nobody will risk using. Bracketing
 * with `beginTransaction`/`endTransaction` makes "undo" mean "never mind",
 * which is the only thing that makes trying a suggestion cheap.
 *
 * Nothing here re-validates: `validatePlan` has already run and the caller
 * has already refused an invalid plan. Duplicating the checks would mean
 * two places to keep in sync, and the second one would silently rot.
 */

import type { GraphEdit, EditPlan } from './editSchema'
import type { NodeKind } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { useEditorStore } from '@/state/store'

export interface ApplyResult {
  addedNodeIds: string[]
  /** Edits that could not be applied, with why. Never a throw. */
  skipped: { edit: GraphEdit; reason: string }[]
}

/** Clamp to the param's declared range, as `validatePlan` warns it will. */
function clampParam(kind: string, paramId: string, value: number | string): number | string {
  if (typeof value !== 'number') return value
  const p = NODE_DEFINITIONS[kind as NodeKind]?.params.find((q) => q.id === paramId)
  if (!p || p.kind !== 'number') return value
  let v = value
  if (typeof p.min === 'number' && v < p.min) v = p.min
  if (typeof p.max === 'number' && v > p.max) v = p.max
  return v
}

export function applyPlan(plan: EditPlan): ApplyResult {
  const store = useEditorStore.getState()
  const skipped: ApplyResult['skipped'] = []
  const addedNodeIds: string[] = []

  /** The model's local `ref` -> the real node id the store handed back. */
  const refToId = new Map<string, string>()
  const resolve = (key: string): string => refToId.get(key) ?? key

  /*
   * Placement for nodes the model did not position.
   *
   * Cascading from the current node count matches what `addNode` does for
   * a palette drop, so an assistant-built chain lands where a hand-built
   * one would rather than stacking at the origin.
   */
  let cascade = 0
  const nextPos = (): { x: number; y: number } => {
    const n = store.graph.nodes.length + cascade++
    return { x: 40 + (n % 6) * 220, y: 40 + Math.floor(n / 6) * 180 }
  }

  store.beginTransaction()
  try {
    for (const e of plan.edits) {
      switch (e.op) {
        case 'add_node': {
          const pos =
            typeof e.x === 'number' && typeof e.y === 'number' ? { x: e.x, y: e.y } : nextPos()
          const id = store.addNode(e.kind as NodeKind, pos)
          if (!id) {
            skipped.push({ edit: e, reason: 'the store refused to create it' })
            break
          }
          refToId.set(e.ref, id)
          addedNodeIds.push(id)
          const def = NODE_DEFINITIONS[e.kind as NodeKind]
          for (const [k, v] of Object.entries(e.params ?? {})) {
            const p = def?.params.find((q) => q.id === k)
            if (!p) continue // warned during validation
            if (typeof v !== 'number' && typeof v !== 'string') continue
            useEditorStore.getState().setParam(id, k, clampParam(e.kind, k, v))
          }
          break
        }

        case 'remove_node': {
          useEditorStore.getState().removeNode(resolve(e.id))
          break
        }

        case 'set_param': {
          const id = resolve(e.id)
          const node = useEditorStore.getState().graph.nodes.find((n) => n.id === id)
          if (!node) {
            skipped.push({ edit: e, reason: 'the node was gone by the time this ran' })
            break
          }
          useEditorStore.getState().setParam(id, e.param, clampParam(node.kind, e.param, e.value))
          break
        }

        case 'connect': {
          const made = useEditorStore.getState().connect(
            { nodeId: resolve(e.from), socketId: e.fromSocket },
            { nodeId: resolve(e.to), socketId: e.toSocket }
          )
          if (!made) {
            // The store is the second gate on connections; if it says no,
            // say so rather than leaving a cable the user cannot find.
            skipped.push({ edit: e, reason: 'the store rejected this connection' })
          }
          break
        }

        case 'disconnect': {
          const g = useEditorStore.getState().graph
          const from = resolve(e.from)
          const to = resolve(e.to)
          const conn = g.connections.find(
            (c) =>
              c.from.nodeId === from &&
              c.from.socketId === e.fromSocket &&
              c.to.nodeId === to &&
              c.to.socketId === e.toSocket
          )
          if (conn) useEditorStore.getState().disconnect(conn.id)
          else skipped.push({ edit: e, reason: 'there was no such cable' })
          break
        }
      }
    }
  } finally {
    // Even if something throws, the transaction must close — otherwise the
    // next unrelated edit joins this undo step forever.
    store.endTransaction()
  }

  return { addedNodeIds, skipped }
}
