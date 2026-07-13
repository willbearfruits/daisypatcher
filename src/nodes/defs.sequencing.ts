/**
 * Sequencing / modulation node catalog — 10 extra source / process kinds
 * added in parallel. Merged into `NODE_DEFINITIONS` in
 * `src/nodes/definitions.ts` in the main thread; do not import this file
 * from anywhere else.
 */

import type { NodeDefinition, ParamDef } from './definitions'
import type { NodeKind } from '@/types/graph'

// Re-export to keep the import live for tooling and to allow downstream
// consumers to pull types from one spot.
export type { NodeDefinition, ParamDef }

const ON_OFF_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
]

function stepValueParam(i: number): ParamDef {
  return {
    id: `s${i}`,
    label: `S${i}`,
    kind: 'number',
    min: -1,
    max: 1,
    step: 0.01,
    default: 0
  }
}

function stepGateParam(i: number, defaultOn: boolean): ParamDef {
  return {
    id: `g${i}`,
    label: `G${i}`,
    kind: 'enum',
    default: defaultOn ? 'on' : 'off',
    options: ON_OFF_OPTIONS
  }
}

export const SEQUENCING_DEFS: Partial<Record<NodeKind, NodeDefinition>> = {
  clock: {
    kind: 'clock',
    label: 'Clock',
    category: 'source',
    description: 'Master clock — tempo-based gate pulses.',
    inputs: [
      { id: 'cv_bpm', label: 'bpm', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      { id: 'bpm', label: 'BPM', kind: 'number', min: 20, max: 300, step: 1, default: 120 },
      { id: 'pulse_width', label: 'PW', kind: 'number', min: 0.05, max: 0.5, step: 0.01, default: 0.1 }
    ]
  },

  clock_divider: {
    kind: 'clock_divider',
    label: 'Clock ÷',
    category: 'process',
    description: 'Clock divider — /2, /4, /8, /16 square outputs.',
    inputs: [{ id: 'in', label: 'in', signal: 'gate' }],
    outputs: [
      { id: 'd2', label: '/2', signal: 'gate' },
      { id: 'd4', label: '/4', signal: 'gate' },
      { id: 'd8', label: '/8', signal: 'gate' },
      { id: 'd16', label: '/16', signal: 'gate' }
    ],
    params: []
  },

  step_seq: {
    kind: 'step_seq',
    label: 'Step Seq 8',
    category: 'source',
    description: '8-step sequencer — CV + gate per step.',
    inputs: [
      { id: 'clock', label: 'clk', signal: 'gate' },
      { id: 'reset', label: 'rst', signal: 'gate' }
    ],
    outputs: [
      { id: 'cv', label: 'cv', signal: 'cv' },
      { id: 'gate', label: 'gate', signal: 'gate' }
    ],
    params: [
      stepValueParam(1),
      stepValueParam(2),
      stepValueParam(3),
      stepValueParam(4),
      stepValueParam(5),
      stepValueParam(6),
      stepValueParam(7),
      stepValueParam(8),
      stepGateParam(1, true),
      stepGateParam(2, true),
      stepGateParam(3, true),
      stepGateParam(4, true),
      stepGateParam(5, false),
      stepGateParam(6, false),
      stepGateParam(7, false),
      stepGateParam(8, false)
    ]
  },

  euclidean: {
    kind: 'euclidean',
    label: 'Euclidean',
    category: 'source',
    description: 'Euclidean rhythm — Bjorklund-distributed pulses over steps.',
    inputs: [
      { id: 'clock', label: 'clk', signal: 'gate' },
      { id: 'reset', label: 'rst', signal: 'gate' },
      { id: 'cv_pulses', label: 'pulses', signal: 'cv' },
      { id: 'cv_rotate', label: 'rot', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      { id: 'steps', label: 'Steps', kind: 'number', min: 2, max: 32, step: 1, default: 16 },
      { id: 'pulses', label: 'Pulses', kind: 'number', min: 0, max: 32, step: 1, default: 4 },
      { id: 'rotate', label: 'Rot', kind: 'number', min: 0, max: 31, step: 1, default: 0 }
    ]
  },

  random: {
    kind: 'random',
    label: 'Random',
    category: 'source',
    description: 'Random CV stepper — free-run or clocked, with slew.',
    inputs: [
      { id: 'clock', label: 'clk', signal: 'gate' },
      { id: 'cv_rate', label: 'rate', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'rate', label: 'Rate', kind: 'number', min: 0.1, max: 20, step: 0.1, default: 2, unit: 'Hz' },
      { id: 'range', label: 'Range', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 },
      { id: 'smooth', label: 'Smooth', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 }
    ]
  },

  dust: {
    kind: 'dust',
    label: 'Dust',
    category: 'source',
    description: 'Random impulse generator — Poisson-distributed gate pulses.',
    inputs: [
      { id: 'cv_density', label: 'dens', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      { id: 'density', label: 'Dens', kind: 'number', min: 0.1, max: 50, step: 0.1, default: 5, unit: 'Hz' },
      { id: 'width', label: 'Width', kind: 'number', min: 0.001, max: 0.05, step: 0.001, default: 0.005, unit: 's' }
    ]
  },

  arp: {
    kind: 'arp',
    label: 'Arp',
    category: 'process',
    description: 'Arpeggiator — walks a scale pattern while gate_in is high.',
    inputs: [
      { id: 'clock', label: 'clk', signal: 'gate' },
      { id: 'gate_in', label: 'gate', signal: 'gate' }
    ],
    outputs: [
      { id: 'cv', label: 'cv', signal: 'cv' },
      { id: 'gate_out', label: 'gate', signal: 'gate' }
    ],
    params: [
      {
        id: 'pattern',
        label: 'Pat',
        kind: 'enum',
        default: 'up',
        options: [
          { value: 'up', label: 'Up' },
          { value: 'down', label: 'Down' },
          { value: 'up_down', label: 'Up/Dn' },
          { value: 'random', label: 'Rand' }
        ]
      },
      { id: 'octaves', label: 'Oct', kind: 'number', min: 1, max: 4, step: 1, default: 1 },
      { id: 'root', label: 'Root', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 },
      {
        id: 'scale',
        label: 'Scale',
        kind: 'enum',
        default: 'major',
        options: [
          { value: 'major', label: 'Maj' },
          { value: 'minor', label: 'Min' },
          { value: 'pentatonic', label: 'Pent' },
          { value: 'chromatic', label: 'Chr' }
        ]
      }
    ]
  },

  ring_mod: {
    kind: 'ring_mod',
    label: 'Ring Mod',
    category: 'process',
    description: 'Ring modulator — dry A blended with A*B product.',
    inputs: [
      { id: 'a', label: 'a', signal: 'audio' },
      { id: 'b', label: 'b', signal: 'audio' },
      { id: 'cv_mix', label: 'mix', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 }
    ]
  },

  tremolo: {
    kind: 'tremolo',
    label: 'Tremolo',
    category: 'process',
    description: 'Amplitude modulation — internal LFO, CV-modulated rate.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'rate_cv', label: 'rate', signal: 'cv' },
      { id: 'cv_rate', label: 'rate*', signal: 'cv' },
      { id: 'cv_depth', label: 'depth', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'rate', label: 'Rate', kind: 'number', min: 0.1, max: 20, step: 0.01, default: 4, unit: 'Hz' },
      { id: 'depth', label: 'Depth', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      {
        id: 'shape',
        label: 'Shape',
        kind: 'enum',
        default: 'sine',
        options: [
          { value: 'sine', label: 'Sine' },
          { value: 'triangle', label: 'Tri' },
          { value: 'square', label: 'Sqr' }
        ]
      }
    ]
  },

  vibrato: {
    kind: 'vibrato',
    label: 'Vibrato',
    category: 'process',
    description: 'Pitch modulation — short modulated delay line.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv_rate', label: 'rate', signal: 'cv' },
      { id: 'cv_depth', label: 'depth', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'rate', label: 'Rate', kind: 'number', min: 0.1, max: 15, step: 0.01, default: 6, unit: 'Hz' },
      { id: 'depth', label: 'Depth', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 }
    ]
  }
}
