/**
 * Worklet registry partial for the synthesis nodes. Merged into
 * `WORKLET_REGISTRY` in `src/audio/worklets/registry.ts` by the main thread;
 * do not import anywhere else.
 */

import type { NodeKind } from '@/types/graph'
import type { WorkletEntry } from './registry'

export const SYNTHESIS_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  karplus:     { processorName: 'dp-karplus',     moduleUrl: new URL('./karplus.worklet.js',     import.meta.url) },
  fm_op:       { processorName: 'dp-fm-op',       moduleUrl: new URL('./fm_op.worklet.js',       import.meta.url) },
  fm2:         { processorName: 'dp-fm2',         moduleUrl: new URL('./fm2.worklet.js',         import.meta.url) },
  wavetable:   { processorName: 'dp-wavetable',   moduleUrl: new URL('./wavetable.worklet.js',   import.meta.url) },
  wavefolder:  { processorName: 'dp-wavefolder',  moduleUrl: new URL('./wavefolder.worklet.js',  import.meta.url) },
  drum_kick:   { processorName: 'dp-drum-kick',   moduleUrl: new URL('./drum_kick.worklet.js',   import.meta.url) },
  drum_snare:  { processorName: 'dp-drum-snare',  moduleUrl: new URL('./drum_snare.worklet.js',  import.meta.url) },
  drum_hat:    { processorName: 'dp-drum-hat',    moduleUrl: new URL('./drum_hat.worklet.js',    import.meta.url) }
}
