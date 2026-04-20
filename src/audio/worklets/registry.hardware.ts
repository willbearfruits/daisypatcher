/**
 * Worklet registry partial for hardware-bound, MIDI, expression and debug
 * kinds. Merged into `WORKLET_REGISTRY` in
 * `src/audio/worklets/registry.ts` by the main thread; do not import this
 * file anywhere else.
 */

import type { NodeKind } from '@/types/graph'
import type { WorkletEntry } from './registry'

export const HARDWARE_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  button: {
    processorName: 'dp-button',
    moduleUrl: new URL('./button.worklet.ts', import.meta.url)
  },
  led: {
    processorName: 'dp-led',
    moduleUrl: new URL('./led.worklet.ts', import.meta.url)
  },
  switch_3way: {
    processorName: 'dp-switch-3way',
    moduleUrl: new URL('./switch_3way.worklet.ts', import.meta.url)
  },
  i2s_in: {
    processorName: 'dp-i2s-in',
    moduleUrl: new URL('./i2s_in.worklet.ts', import.meta.url)
  },
  i2s_out: {
    processorName: 'dp-i2s-out',
    moduleUrl: new URL('./i2s_out.worklet.ts', import.meta.url)
  },
  midi_in_note: {
    processorName: 'dp-midi-in-note',
    moduleUrl: new URL('./midi_in_note.worklet.ts', import.meta.url)
  },
  midi_in_cc: {
    processorName: 'dp-midi-in-cc',
    moduleUrl: new URL('./midi_in_cc.worklet.ts', import.meta.url)
  },
  midi_out_note: {
    processorName: 'dp-midi-out-note',
    moduleUrl: new URL('./midi_out_note.worklet.ts', import.meta.url)
  },
  expression: {
    processorName: 'dp-expression',
    moduleUrl: new URL('./expression.worklet.ts', import.meta.url)
  },
  print: {
    processorName: 'dp-print',
    moduleUrl: new URL('./print.worklet.ts', import.meta.url)
  }
}
