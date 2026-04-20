/**
 * Effects / dynamics node catalog — 12 additional process kinds added in
 * parallel. Merged into `NODE_DEFINITIONS` in `src/nodes/definitions.ts` in
 * the main thread; do not import this file from anywhere else.
 */

import type { NodeDefinition, ParamDef } from './definitions'
import type { NodeKind } from '@/types/graph'

// Re-export to keep the import live for tooling.
export type { NodeDefinition, ParamDef }

export const EFFECTS_DEFS: Partial<Record<NodeKind, NodeDefinition>> = {
  phaser: {
    kind: 'phaser',
    label: 'Phaser',
    category: 'process',
    description: 'Cascaded allpass phaser with LFO sweep and feedback.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'rate', label: 'Rate', kind: 'number', min: 0.05, max: 8, step: 0.01, default: 0.5, unit: 'Hz' },
      { id: 'depth', label: 'Depth', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: 'feedback', label: 'FB', kind: 'number', min: 0, max: 0.9, step: 0.01, default: 0.5 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      {
        id: 'stages',
        label: 'Stages',
        kind: 'enum',
        default: '4',
        options: [
          { value: '4', label: '4' },
          { value: '6', label: '6' },
          { value: '8', label: '8' }
        ]
      }
    ]
  },

  flanger: {
    kind: 'flanger',
    label: 'Flanger',
    category: 'process',
    description: 'Short modulated delay with signed feedback — metallic shimmer.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'rate', label: 'Rate', kind: 'number', min: 0.05, max: 5, step: 0.01, default: 0.3, unit: 'Hz' },
      { id: 'depth', label: 'Depth', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
      { id: 'feedback', label: 'FB', kind: 'number', min: -0.95, max: 0.95, step: 0.01, default: 0.5 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  },

  ping_pong: {
    kind: 'ping_pong',
    label: 'Ping-Pong',
    category: 'process',
    description: 'Stereo ping-pong delay with cross-feedback.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [
      { id: 'left', label: 'L', signal: 'audio' },
      { id: 'right', label: 'R', signal: 'audio' }
    ],
    params: [
      { id: 'time', label: 'Time', kind: 'number', min: 0.02, max: 2, step: 0.001, default: 0.3, unit: 's' },
      { id: 'feedback', label: 'FB', kind: 'number', min: 0, max: 0.95, step: 0.01, default: 0.45 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
      { id: 'width', label: 'Width', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 }
    ]
  },

  stereo_widener: {
    kind: 'stereo_widener',
    label: 'Widener',
    category: 'process',
    description: 'Haas stereo widener with mid/side boost.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [
      { id: 'left', label: 'L', signal: 'audio' },
      { id: 'right', label: 'R', signal: 'audio' }
    ],
    params: [
      { id: 'width', label: 'Width', kind: 'number', min: 0, max: 2, step: 0.01, default: 1.2 },
      { id: 'haas_ms', label: 'Haas', kind: 'number', min: 0, max: 30, step: 0.1, default: 8, unit: 'ms' }
    ]
  },

  freeze: {
    kind: 'freeze',
    label: 'Freeze',
    category: 'process',
    description: 'Grab a buffer on gate and loop it; passthrough otherwise.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'gate', label: 'gate', signal: 'gate' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'buffer_ms', label: 'Buf', kind: 'number', min: 20, max: 500, step: 1, default: 120, unit: 'ms' }
    ]
  },

  granulator: {
    kind: 'granulator',
    label: 'Granulator',
    category: 'process',
    description: 'Granular texture — spawns Hann-windowed grains from a 4s buffer.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'grain_size', label: 'Size', kind: 'number', min: 10, max: 200, step: 1, default: 80, unit: 'ms' },
      { id: 'density', label: 'Dens', kind: 'number', min: 1, max: 30, step: 0.1, default: 8, unit: 'Hz' },
      { id: 'pitch', label: 'Pitch', kind: 'number', min: -12, max: 12, step: 0.1, default: 0 },
      { id: 'jitter', label: 'Jitter', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 }
    ]
  },

  pitch_shifter: {
    kind: 'pitch_shifter',
    label: 'Pitch Shift',
    category: 'process',
    description: 'Granular 2-tap overlap-add pitch shifter.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'semitones', label: 'St', kind: 'number', min: -24, max: 24, step: 0.1, default: 0 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 }
    ]
  },

  formant: {
    kind: 'formant',
    label: 'Formant',
    category: 'process',
    description: 'Three parallel bandpass filters tuned to vowel formants.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      {
        id: 'vowel',
        label: 'Vowel',
        kind: 'enum',
        default: 'a',
        options: [
          { value: 'a', label: 'A' },
          { value: 'e', label: 'E' },
          { value: 'i', label: 'I' },
          { value: 'o', label: 'O' },
          { value: 'u', label: 'U' }
        ]
      },
      { id: 'morph', label: 'Morph', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
      { id: 'q', label: 'Q', kind: 'number', min: 1, max: 20, step: 0.1, default: 5 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.6 }
    ]
  },

  compressor: {
    kind: 'compressor',
    label: 'Compressor',
    category: 'process',
    description: 'Peak-detector feedforward compressor with makeup gain.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'threshold', label: 'Thr', kind: 'number', min: -60, max: 0, step: 0.1, default: -20, unit: 'dB' },
      { id: 'ratio', label: 'Ratio', kind: 'number', min: 1, max: 20, step: 0.1, default: 4 },
      { id: 'attack', label: 'Atk', kind: 'number', min: 0.001, max: 0.5, step: 0.001, default: 0.01, unit: 's' },
      { id: 'release', label: 'Rel', kind: 'number', min: 0.01, max: 3, step: 0.001, default: 0.1, unit: 's' },
      { id: 'makeup', label: 'Make', kind: 'number', min: 0, max: 24, step: 0.1, default: 0, unit: 'dB' }
    ]
  },

  limiter: {
    kind: 'limiter',
    label: 'Limiter',
    category: 'process',
    description: 'Fast-attack brickwall limiter with soft knee at ceiling.',
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'ceiling', label: 'Ceil', kind: 'number', min: -12, max: 0, step: 0.1, default: -0.3, unit: 'dB' },
      { id: 'release', label: 'Rel', kind: 'number', min: 0.01, max: 2, step: 0.001, default: 0.05, unit: 's' }
    ]
  },

  noise_gate: {
    kind: 'noise_gate',
    label: 'Noise Gate',
    category: 'process',
    description: 'Envelope-driven gate with hold time and optional sidechain key.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'key', label: 'key', signal: 'audio' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'threshold', label: 'Thr', kind: 'number', min: -80, max: 0, step: 0.1, default: -40, unit: 'dB' },
      { id: 'attack', label: 'Atk', kind: 'number', min: 0.001, max: 0.1, step: 0.001, default: 0.005, unit: 's' },
      { id: 'hold', label: 'Hold', kind: 'number', min: 0, max: 0.5, step: 0.001, default: 0.05, unit: 's' },
      { id: 'release', label: 'Rel', kind: 'number', min: 0.01, max: 2, step: 0.001, default: 0.1, unit: 's' }
    ]
  }
}
