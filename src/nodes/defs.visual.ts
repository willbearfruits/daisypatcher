/**
 * Visual node catalog — oscilloscope, VU meter, spectrum analyzer. Merged
 * into `NODE_DEFINITIONS` in `src/nodes/definitions.ts` by the main thread;
 * do not import anywhere else.
 *
 * Each visual kind is a pass-through in audio terms: `in` -> `thru` so users
 * can chain a scope into the signal path without branching. The actual
 * display is driven by `AudioEngine.tap()`, not by DSP inside the worklet.
 */

import type { NodeDefinition, ParamDef } from './definitions'
import type { NodeKind } from '@/types/graph'

export type { NodeDefinition, ParamDef }

export const VISUAL_DEFS: Partial<Record<NodeKind, NodeDefinition>> = {
  scope: {
    kind: 'scope',
    label: 'Scope',
    category: 'process',
    description: 'Oscilloscope — time-domain view of incoming audio.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'thru', signal: 'audio' }],
    params: [
      {
        id: 'timebase',
        label: 'Time',
        kind: 'enum',
        default: '20',
        options: [
          { value: '5', label: '5 ms' },
          { value: '10', label: '10 ms' },
          { value: '20', label: '20 ms' },
          { value: '50', label: '50 ms' },
          { value: '100', label: '100 ms' }
        ]
      },
      { id: 'gain', label: 'Gain', kind: 'number', min: 0.5, max: 4, step: 0.01, default: 1 }
    ]
  },

  vu: {
    kind: 'vu',
    label: 'VU',
    category: 'process',
    description: 'Peak + RMS meter.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'thru', signal: 'audio' }],
    params: []
  },

  spectrum_scope: {
    kind: 'spectrum_scope',
    label: 'Spectrum',
    category: 'process',
    description: 'FFT spectrum analyzer.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'thru', signal: 'audio' }],
    params: [
      {
        id: 'scale',
        label: 'Scale',
        kind: 'enum',
        default: 'log',
        options: [
          { value: 'linear', label: 'Linear' },
          { value: 'log', label: 'Log' }
        ]
      }
    ]
  },

  oled: {
    kind: 'oled',
    label: 'OLED',
    category: 'io',
    description: 'SSD1306 0.96" display — compose its contents inside the node.',
    inputs: [
      { id: 'a', label: 'A', signal: 'cv' },
      { id: 'b', label: 'B', signal: 'cv' },
      { id: 'c', label: 'C', signal: 'cv' },
      { id: 'd', label: 'D', signal: 'cv' },
      { id: 'e', label: 'E', signal: 'cv' },
      { id: 'f', label: 'F', signal: 'cv' }
    ],
    outputs: [],
    params: [
      {
        id: 'bindingId',
        label: 'Binding',
        kind: 'enum',
        default: '',
        options: [{ value: '', label: '(unbound)' }]
      },
      // Not editable via the standard inspector — the in-node designer owns it.
      { id: 'elements', label: 'Elements', kind: 'enum', default: '[]', options: [{ value: '[]', label: '(designed in-node)' }] }
    ]
  }
}
