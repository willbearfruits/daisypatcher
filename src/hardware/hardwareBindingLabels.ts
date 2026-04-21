/**
 * Resolve human-readable labels for placed hardware components by looking
 * up the graph node that references them via `params.bindingId`.
 *
 * The HardwareView uses this helper to render small text tags near each
 * bound pin, so the user can see at a glance which patch node a pin
 * drives — e.g. `D15 → filter cutoff`.
 *
 * Pure helpers — no React, no store subscriptions. Caller passes the
 * graph slice explicitly so the result can be memoized in a Zustand
 * selector without breaking the "no new references per selector" rule.
 */

import type { AudioGraph, NodeInstance } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { PlacedComponent } from '@/types/hardware'

/**
 * Find the graph node bound to a placed component via `params.bindingId`.
 * Returns the first match; in practice each `bindingId` is referenced by
 * at most one node (the hardware view picker enforces 1:1).
 */
export function findGraphNodeForBinding(
  graph: AudioGraph,
  componentId: string
): NodeInstance | null {
  for (const n of graph.nodes) {
    if (n.params.bindingId === componentId) return n
  }
  return null
}

/**
 * Human-readable description of what a placed component drives. Derived
 * from the linked graph node's label (user-entered or default from
 * `NodeDefinition.label`). Returns `null` if the component has no bound
 * graph node so callers can hide the label entirely.
 */
export function describeBinding(
  graph: AudioGraph,
  comp: PlacedComponent
): string | null {
  const n = findGraphNodeForBinding(graph, comp.id)
  if (!n) return null
  const def = NODE_DEFINITIONS[n.kind]
  // Rete labels default to `def.label`; user edits land on the node's
  // `params.label`-ish surface (actually the node instance label on the
  // Rete side). The store stores the DaisyNode.label via the Rete editor.
  // For our purposes the kind's human label is the most reliable source.
  const nodeLabel = def?.label ?? n.kind
  const compLabel = comp.label
  if (!compLabel || compLabel.toLowerCase() === nodeLabel.toLowerCase()) {
    return nodeLabel
  }
  return `${compLabel} · ${nodeLabel}`
}

/**
 * Lookup map: placed-component id → graph node reference. Built once per
 * graph change and passed down to avoid O(n·m) scans on every render.
 */
export function buildBindingIndex(graph: AudioGraph): Map<string, NodeInstance> {
  const m = new Map<string, NodeInstance>()
  for (const n of graph.nodes) {
    const id = n.params.bindingId
    if (typeof id === 'string' && id.length > 0) m.set(id, n)
  }
  return m
}
