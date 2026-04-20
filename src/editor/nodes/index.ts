import type { NodeKind } from '@/types/graph'
import { DaisyNode } from './base'

export { DaisyNode }

/**
 * Factory used by the store->Rete sync layer. Trivial wrapper over
 * `DaisyNode`'s constructor; kept as a separate symbol so the call sites
 * remain decoupled from the specific class.
 */
export function createNode(kind: NodeKind, storeId: string): DaisyNode {
  return new DaisyNode(kind, storeId)
}
