/**
 * Synthesis node catalog — 8 extra source / utility kinds added in parallel.
 * Merged into `NODE_DEFINITIONS` in `src/nodes/definitions.ts` in the main
 * thread; do not import this file from anywhere else.
 */

import type { NodeDefinition, ParamDef } from './definitions'
import type { NodeKind } from '@/types/graph'

// Re-export to keep the import live for tooling and to allow downstream
// consumers to pull types from one spot.
export type { NodeDefinition, ParamDef }

export const SYNTHESIS_DEFS: Partial<Record<NodeKind, NodeDefinition>> = {
  karplus: {
    kind: 'karplus',
    label: 'Karplus',
    category: 'source',
    description: 'Karplus-Strong plucked string — noise-burst fed delay loop.',
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 2000, step: 1, default: 220, unit: 'Hz' },
      { id: 'damping', label: 'Damp', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'feedback', label: 'FB', kind: 'number', min: 0.9, max: 0.999, step: 0.001, default: 0.99 },
      {
        id: 'retrigger',
        label: 'Retrig',
        kind: 'enum',
        default: 'manual',
        options: [
          { value: 'manual', label: 'Manual' },
          { value: '1s', label: '1 s' },
          { value: '500ms', label: '500 ms' },
          { value: '250ms', label: '250 ms' }
        ]
      }
    ]
  },

  fm_op: {
    kind: 'fm_op',
    label: 'FM Op',
    category: 'source',
    description: 'Single FM operator — sine with phase-mod input and feedback.',
    inputs: [
      { id: 'mod', label: 'mod', signal: 'audio' },
      { id: 'pitch_cv', label: 'pitch', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 20000, step: 1, default: 220, unit: 'Hz' },
      { id: 'ratio', label: 'Ratio', kind: 'number', min: 0.125, max: 16, step: 0.125, default: 1 },
      { id: 'amplitude', label: 'Amp', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: 'feedback', label: 'FB', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 }
    ]
  },

  fm2: {
    kind: 'fm2',
    label: 'FM 2-Op',
    category: 'source',
    description: '2-operator FM — modulator drives carrier, DX7-style voice.',
    inputs: [
      { id: 'pitch_cv', label: 'pitch', signal: 'cv' },
      { id: 'amp_cv', label: 'amp', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 8000, step: 1, default: 220, unit: 'Hz' },
      { id: 'mod_ratio', label: 'M:C', kind: 'number', min: 0.125, max: 16, step: 0.125, default: 2 },
      { id: 'mod_index', label: 'Index', kind: 'number', min: 0, max: 20, step: 0.01, default: 3 },
      { id: 'carrier_amp', label: 'Amp', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.7 }
    ]
  },

  wavetable: {
    kind: 'wavetable',
    label: 'Wavetable',
    category: 'source',
    description: '4-wavetable morph oscillator (sine → harmonic → odd → complex).',
    inputs: [
      { id: 'pitch_cv', label: 'pitch', signal: 'cv' },
      { id: 'morph_cv', label: 'morph', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 20000, step: 1, default: 220, unit: 'Hz' },
      { id: 'amplitude', label: 'Amp', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'morph', label: 'Morph', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 }
    ]
  },

  wavefolder: {
    kind: 'wavefolder',
    label: 'Wavefolder',
    category: 'process',
    description: 'West-coast sinusoidal wavefolder, y = sin(π·(x+bias)·fold).',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'fold_cv', label: 'fold', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'fold', label: 'Fold', kind: 'number', min: 0, max: 8, step: 0.01, default: 1 },
      { id: 'bias', label: 'Bias', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 }
    ]
  },

  drum_kick: {
    kind: 'drum_kick',
    label: 'Kick',
    category: 'source',
    description: 'Kick drum — sweeping sine with amp/pitch envelopes.',
    inputs: [{ id: 'trigger', label: 'trig', signal: 'gate' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'tune', label: 'Tune', kind: 'number', min: 30, max: 200, step: 1, default: 60, unit: 'Hz' },
      { id: 'decay', label: 'Decay', kind: 'number', min: 0.05, max: 2, step: 0.01, default: 0.35, unit: 's' },
      { id: 'punch', label: 'Punch', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'sweep', label: 'Sweep', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.6 }
    ]
  },

  drum_snare: {
    kind: 'drum_snare',
    label: 'Snare',
    category: 'source',
    description: 'Snare — two detuned tri bodies plus HP-filtered noise.',
    inputs: [{ id: 'trigger', label: 'trig', signal: 'gate' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'tune', label: 'Tune', kind: 'number', min: 100, max: 400, step: 1, default: 200, unit: 'Hz' },
      { id: 'decay', label: 'Decay', kind: 'number', min: 0.05, max: 1, step: 0.01, default: 0.2, unit: 's' },
      { id: 'tone', label: 'Tone', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  },

  drum_hat: {
    kind: 'drum_hat',
    label: 'Hat',
    category: 'source',
    description: 'Hi-hat — six inharmonic squares through a bandpass.',
    inputs: [{ id: 'trigger', label: 'trig', signal: 'gate' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'decay', label: 'Decay', kind: 'number', min: 0.01, max: 0.5, step: 0.01, default: 0.08, unit: 's' },
      { id: 'tone', label: 'Tone', kind: 'number', min: 0.3, max: 1, step: 0.01, default: 0.7 }
    ]
  }
}
