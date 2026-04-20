/**
 * Worklet registry partial for the three visual nodes — scope, VU, spectrum.
 * Merged into `WORKLET_REGISTRY` in `src/audio/worklets/registry.ts` by the
 * main thread; do not import anywhere else.
 *
 * The worklets are DSP pass-throughs; the visualisation is driven by a
 * main-thread `AudioEngine.tap()` that forks the node's output into an
 * `AnalyserNode`.
 */

import type { NodeKind } from '@/types/graph'
import type { WorkletEntry } from './registry'

export const VISUAL_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  scope: {
    processorName: 'dp-scope',
    moduleUrl: new URL('./scope.worklet.ts', import.meta.url)
  },
  vu: {
    processorName: 'dp-vu',
    moduleUrl: new URL('./vu.worklet.ts', import.meta.url)
  },
  spectrum_scope: {
    processorName: 'dp-spectrum-scope',
    moduleUrl: new URL('./spectrum_scope.worklet.ts', import.meta.url)
  },
  oled: {
    processorName: 'dp-oled',
    moduleUrl: new URL('./oled.worklet.ts', import.meta.url)
  }
}
