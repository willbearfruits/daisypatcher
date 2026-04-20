/**
 * Generic Rete node class used for every kind in the Daisypatcher editor.
 *
 * The node's sockets (inputs/outputs) are derived from `NODE_DEFINITIONS[kind]`
 * so adding a new kind is purely a definition-file concern — no per-kind Rete
 * subclass required.
 *
 * If `kind` has no definition (e.g. a parallel agent is still wiring it up),
 * we log a warning and return a bare node with no sockets rather than crash.
 */

import { ClassicPreset } from 'rete'
import type { NodeKind } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { socketFor, type SignalSocket } from '../sockets'

export type Sockets = Record<string, SignalSocket | undefined>

export class DaisyNode extends ClassicPreset.Node<Sockets, Sockets, Record<string, never>> {
  /** Stable id from the store. Rete's internal id is kept in sync with this. */
  readonly storeId: string
  readonly kind: NodeKind

  constructor(kind: NodeKind, storeId: string) {
    const def = NODE_DEFINITIONS[kind]
    super(def?.label ?? kind)
    this.kind = kind
    this.storeId = storeId
    this.id = storeId

    if (!def) {
      console.warn(`[DaisyNode] no NODE_DEFINITIONS entry for kind "${kind}" — rendering with no sockets`)
      return
    }

    for (const inp of def.inputs) {
      this.addInput(inp.id, new ClassicPreset.Input(socketFor(inp.signal), inp.label))
    }
    for (const out of def.outputs) {
      this.addOutput(out.id, new ClassicPreset.Output(socketFor(out.signal), out.label))
    }
  }
}
