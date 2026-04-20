/**
 * Worklet registry partial for the effects / dynamics nodes. Merged into
 * `WORKLET_REGISTRY` in `src/audio/worklets/registry.ts` by the main thread;
 * do not import anywhere else.
 */

import type { NodeKind } from '@/types/graph'
import type { WorkletEntry } from './registry'

export const EFFECTS_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  phaser:         { processorName: 'dp-phaser',         moduleUrl: new URL('./phaser.worklet.ts',         import.meta.url) },
  flanger:        { processorName: 'dp-flanger',        moduleUrl: new URL('./flanger.worklet.ts',        import.meta.url) },
  ping_pong:      { processorName: 'dp-ping-pong',      moduleUrl: new URL('./ping_pong.worklet.ts',      import.meta.url) },
  stereo_widener: { processorName: 'dp-stereo-widener', moduleUrl: new URL('./stereo_widener.worklet.ts', import.meta.url) },
  freeze:         { processorName: 'dp-freeze',         moduleUrl: new URL('./freeze.worklet.ts',         import.meta.url) },
  granulator:     { processorName: 'dp-granulator',     moduleUrl: new URL('./granulator.worklet.ts',     import.meta.url) },
  pitch_shifter:  { processorName: 'dp-pitch-shifter',  moduleUrl: new URL('./pitch_shifter.worklet.ts',  import.meta.url) },
  formant:        { processorName: 'dp-formant',        moduleUrl: new URL('./formant.worklet.ts',        import.meta.url) },
  compressor:     { processorName: 'dp-compressor',     moduleUrl: new URL('./compressor.worklet.ts',     import.meta.url) },
  limiter:        { processorName: 'dp-limiter',        moduleUrl: new URL('./limiter.worklet.ts',        import.meta.url) },
  noise_gate:     { processorName: 'dp-noise-gate',     moduleUrl: new URL('./noise_gate.worklet.ts',     import.meta.url) }
}
