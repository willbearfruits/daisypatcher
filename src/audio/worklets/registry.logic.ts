/**
 * Worklet registry partial for the logic kinds. Merged into
 * `WORKLET_REGISTRY` in `src/audio/worklets/registry.ts` by the main
 * thread; do not import this file anywhere else.
 */

import type { NodeKind } from '@/types/graph'
import type { WorkletEntry } from './registry'

/**
 * Logic worklets. See `nodes/defs.logic.ts` — these are the nodes that give
 * a patch memory, and they are grouped separately for the same reason the
 * definitions are.
 */
export const LOGIC_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  logic: {
    processorName: 'dp-logic',
    moduleUrl: new URL('./logic.worklet.js', import.meta.url)
  },
  toggle: {
    processorName: 'dp-toggle',
    moduleUrl: new URL('./toggle.worklet.js', import.meta.url)
  },
  counter: {
    processorName: 'dp-counter',
    moduleUrl: new URL('./counter.worklet.js', import.meta.url)
  },
  timer: {
    processorName: 'dp-timer',
    moduleUrl: new URL('./timer.worklet.js', import.meta.url)
  },
  state_machine: {
    processorName: 'dp-state-machine',
    moduleUrl: new URL('./state_machine.worklet.js', import.meta.url)
  },
  select: {
    processorName: 'dp-select',
    moduleUrl: new URL('./select.worklet.js', import.meta.url)
  },
  edge: {
    processorName: 'dp-edge',
    moduleUrl: new URL('./edge.worklet.js', import.meta.url)
  }
}
