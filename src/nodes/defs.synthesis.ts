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
  /*
   * Sample playback.
   *
   * `sampleId` is a content hash into the app's sample library, not a file
   * path — see `state/sampleStore.ts`. A path would break the moment the
   * patch moved machines, and would let a sample change under a patch that
   * had already been tuned against it.
   *
   * The sample is compiled INTO the firmware as a const array, which is
   * why the library caps length: this is for drum hits, one-shots and short
   * loops, not for playing a record. Streaming from an SD card is a
   * different node with different hardware requirements.
   */
  sample_player: {
    kind: 'sample_player',
    label: 'Sample',
    category: 'source',
    description:
      'Plays a sample from the library. Compiled into the firmware, so keep ' +
      'them short — one-shots, drum hits and loops rather than whole tracks.',
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'cv_speed', label: 'speed', signal: 'cv' },
      { id: 'cv_start', label: 'start', signal: 'cv' },
      { id: 'cv_level', label: 'level', signal: 'cv' }
    ],
    outputs: [
      { id: 'out', label: 'out', signal: 'audio' },
      { id: 'eoc', label: 'eoc', signal: 'gate' }
    ],
    params: [
      /*
       * `sampleId` is an enum with a single placeholder option because the
       * real choices are a runtime library, not a compile-time list. The
       * Inspector renders a picker for it specially; the option here keeps
       * the generic control from rendering an empty dropdown.
       */
      {
        id: 'sampleId',
        label: 'Sample',
        kind: 'enum',
        default: '',
        options: [{ value: '', label: '(none — pick one)' }]
      },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        default: 'oneshot',
        options: [
          { value: 'oneshot', label: 'One-shot' },
          { value: 'loop', label: 'Loop' },
          { value: 'gate', label: 'Gate' }
        ]
      },
      { id: 'speed', label: 'Speed', kind: 'number', min: 0.25, max: 4, step: 0.01, default: 1 },
      { id: 'start', label: 'Start', kind: 'number', min: 0, max: 1, step: 0.001, default: 0 },
      { id: 'end', label: 'End', kind: 'number', min: 0, max: 1, step: 0.001, default: 1 },
      { id: 'level', label: 'Level', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.8 }
    ]
  },

  karplus: {
    kind: 'karplus',
    label: 'Karplus',
    category: 'source',
    description: 'Karplus-Strong plucked string — noise-burst fed delay loop.',
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'cv_pitch', label: 'pitch', signal: 'cv' },
      { id: 'cv_decay', label: 'decay', signal: 'cv' },
      { id: 'cv_damp', label: 'damp', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      // 50 Hz floor, not 20: DaisySP's String has a 1024-sample delay line
      // and cannot render below ~47 Hz at 48 kHz. Offering a note the device
      // answers with silence is worse than not offering it.
      { id: 'frequency', label: 'Freq', kind: 'number', min: 50, max: 2000, step: 1, default: 220, unit: 'Hz', taper: 'log' },
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
      { id: 'pitch_cv', label: 'pitch', signal: 'cv' },
      { id: 'cv_amp', label: 'amp', signal: 'cv' },
      { id: 'cv_mod_index', label: 'idx', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 20000, step: 1, default: 220, unit: 'Hz', taper: 'log' },
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
      { id: 'amp_cv', label: 'amp', signal: 'cv' },
      { id: 'cv_mod_index', label: 'idx', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 8000, step: 1, default: 220, unit: 'Hz', taper: 'log' },
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
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 20000, step: 1, default: 220, unit: 'Hz', taper: 'log' },
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
      { id: 'fold_cv', label: 'fold', signal: 'cv' },
      { id: 'cv_bias', label: 'bias', signal: 'cv' }
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
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'cv_tune', label: 'tune', signal: 'cv' },
      { id: 'cv_decay', label: 'decay', signal: 'cv' },
      { id: 'cv_punch', label: 'punch', signal: 'cv' }
    ],
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
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'cv_tune', label: 'tune', signal: 'cv' },
      { id: 'cv_decay', label: 'decay', signal: 'cv' },
      { id: 'cv_noise', label: 'noise', signal: 'cv' }
    ],
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
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'cv_decay', label: 'decay', signal: 'cv' },
      { id: 'cv_tone', label: 'tone', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'decay', label: 'Decay', kind: 'number', min: 0.01, max: 0.5, step: 0.01, default: 0.08, unit: 's' },
      { id: 'tone', label: 'Tone', kind: 'number', min: 0.3, max: 1, step: 0.01, default: 0.7 }
    ]
  }
}
