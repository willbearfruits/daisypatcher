/**
 * Worklet registry partial for the sequencing / modulation nodes. Merged
 * into `WORKLET_REGISTRY` in `src/audio/worklets/registry.ts` by the main
 * thread; do not import anywhere else.
 */

import type { NodeKind } from '@/types/graph'
import type { WorkletEntry } from './registry'

export const SEQUENCING_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  clock:         { processorName: 'dp-clock',          moduleUrl: new URL('./clock.worklet.ts',          import.meta.url) },
  clock_divider: { processorName: 'dp-clock-divider',  moduleUrl: new URL('./clock_divider.worklet.ts',  import.meta.url) },
  step_seq:      { processorName: 'dp-step-seq',       moduleUrl: new URL('./step_seq.worklet.ts',       import.meta.url) },
  euclidean:     { processorName: 'dp-euclidean',      moduleUrl: new URL('./euclidean.worklet.ts',      import.meta.url) },
  random:        { processorName: 'dp-random',         moduleUrl: new URL('./random.worklet.ts',         import.meta.url) },
  dust:          { processorName: 'dp-dust',           moduleUrl: new URL('./dust.worklet.ts',           import.meta.url) },
  arp:           { processorName: 'dp-arp',            moduleUrl: new URL('./arp.worklet.ts',            import.meta.url) },
  ring_mod:      { processorName: 'dp-ring-mod',       moduleUrl: new URL('./ring_mod.worklet.ts',       import.meta.url) },
  tremolo:       { processorName: 'dp-tremolo',        moduleUrl: new URL('./tremolo.worklet.ts',        import.meta.url) },
  vibrato:       { processorName: 'dp-vibrato',        moduleUrl: new URL('./vibrato.worklet.ts',        import.meta.url) }
}
