/**
 * Node catalog. Each entry describes one node kind the user can drop on the
 * canvas — its IO, its parameters, its display metadata.
 *
 * The renderer (Rete.js) and the AudioEngine both consume this catalog so
 * visual and audio representations stay in sync.
 */

import type { NodeKind, Socket } from '@/types/graph'
import { SYNTHESIS_DEFS } from './defs.synthesis'
import { SEQUENCING_DEFS } from './defs.sequencing'
import { EFFECTS_DEFS } from './defs.effects'
import { VISUAL_DEFS } from './defs.visual'
import { HARDWARE_DEFS } from './defs.hardware'
import { LOGIC_DEFS } from './defs.logic'
import { bindingParam } from './bindingParam'

export interface ParamDef {
  id: string
  label: string
  kind: 'number' | 'enum'
  min?: number
  max?: number
  step?: number
  default: number | string
  unit?: string
  options?: { value: string; label: string }[]
  /**
   * Optional slider taper. `'log'` maps slider position t ∈ [0,1] to
   * value = min * (max/min)^t — the natural feel for frequency- and
   * time-ranged params spanning ≥2 decades. Purely a UI position mapping:
   * the stored value, CV clamping and codegen are unaffected. Requires
   * min > 0; controls fall back to linear when it isn't.
   */
  taper?: 'log'
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  category: 'source' | 'process' | 'io' | 'hardware'
  description: string
  inputs: Socket[]
  outputs: Socket[]
  params: ParamDef[]
}

/**
 * Core catalog. Category-grouped, 31 entries. Additional kinds live in
 * per-category partial files (`defs.*.ts`) and are spread into the final
 * `NODE_DEFINITIONS` below. When you add a new kind, pick the partial that
 * matches its category — keep this file for the canonical/core set.
 */
const CORE_DEFS: Partial<Record<NodeKind, NodeDefinition>> = {
  // ---------- Sources ----------
  oscillator: {
    kind: 'oscillator',
    label: 'Oscillator',
    category: 'source',
    description: 'Waveform generator — sine, saw, square, tri.',
    inputs: [
      { id: 'pitch_cv', label: 'pitch', signal: 'cv' },
      { id: 'amp_cv', label: 'amp', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 20000, step: 1, default: 220, unit: 'Hz', taper: 'log' },
      { id: 'amplitude', label: 'Amp', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      {
        id: 'waveform',
        label: 'Wave',
        kind: 'enum',
        default: 'sine',
        options: [
          { value: 'sine', label: 'Sine' },
          { value: 'sawtooth', label: 'Saw' },
          { value: 'square', label: 'Square' },
          { value: 'triangle', label: 'Tri' }
        ]
      }
    ]
  },

  noise: {
    kind: 'noise',
    label: 'Noise',
    category: 'source',
    description: 'White or pink noise generator.',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'amplitude', label: 'Amp', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
      {
        id: 'color',
        label: 'Color',
        kind: 'enum',
        default: 'white',
        options: [
          { value: 'white', label: 'White' },
          { value: 'pink', label: 'Pink' }
        ]
      }
    ]
  },

  lfo: {
    kind: 'lfo',
    label: 'LFO',
    category: 'source',
    description: 'Low-frequency oscillator emitting CV.',
    inputs: [
      { id: 'cv_rate', label: 'rate', signal: 'cv' },
      { id: 'cv_depth', label: 'depth', signal: 'cv' },
      { id: 'cv_offset', label: 'offset', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'frequency', label: 'Rate', kind: 'number', min: 0.01, max: 20, step: 0.01, default: 1, unit: 'Hz', taper: 'log' },
      { id: 'depth', label: 'Depth', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 },
      { id: 'offset', label: 'Offset', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 },
      {
        id: 'waveform',
        label: 'Wave',
        kind: 'enum',
        default: 'sine',
        options: [
          { value: 'sine', label: 'Sine' },
          { value: 'tri', label: 'Tri' },
          { value: 'saw', label: 'Saw' },
          { value: 'square', label: 'Square' }
        ]
      }
    ]
  },

  constant: {
    kind: 'constant',
    label: 'Constant',
    category: 'source',
    description: 'DC CV constant.',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'value', label: 'Value', kind: 'number', min: -1, max: 1, step: 0.01, default: 0.5 }
    ]
  },

  // ---------- Amp / utility ----------
  gain: {
    kind: 'gain',
    label: 'Gain',
    category: 'process',
    description: 'Linear amplifier.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv', label: 'cv', signal: 'cv' },
      { id: 'cv_gain', label: 'gain', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'gain', label: 'Gain', kind: 'number', min: 0, max: 2, step: 0.01, default: 0.8 }
    ]
  },

  vca: {
    kind: 'vca',
    label: 'VCA',
    category: 'process',
    description: 'Voltage-controlled amplifier — audio × CV.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv', label: 'cv', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'bias', label: 'Bias', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 }
    ]
  },

  mixer4: {
    kind: 'mixer4',
    label: 'Mixer 4',
    category: 'process',
    description: '4-channel audio mixer.',
    inputs: [
      { id: 'in1', label: '1', signal: 'audio' },
      { id: 'in2', label: '2', signal: 'audio' },
      { id: 'in3', label: '3', signal: 'audio' },
      { id: 'in4', label: '4', signal: 'audio' },
      { id: 'cv_level1', label: 'lvl1', signal: 'cv' },
      { id: 'cv_level2', label: 'lvl2', signal: 'cv' },
      { id: 'cv_level3', label: 'lvl3', signal: 'cv' },
      { id: 'cv_level4', label: 'lvl4', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'gain1', label: 'G1', kind: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'gain2', label: 'G2', kind: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'gain3', label: 'G3', kind: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'gain4', label: 'G4', kind: 'number', min: 0, max: 2, step: 0.01, default: 1 }
    ]
  },

  pan: {
    kind: 'pan',
    label: 'Pan',
    category: 'process',
    description: 'Stereo panner with optional CV.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv', label: 'cv', signal: 'cv' },
      { id: 'cv_pan', label: 'pan', signal: 'cv' }
    ],
    outputs: [
      { id: 'left', label: 'L', signal: 'audio' },
      { id: 'right', label: 'R', signal: 'audio' }
    ],
    params: [
      { id: 'pan', label: 'Pan', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 }
    ]
  },

  clip: {
    kind: 'clip',
    label: 'Clip',
    category: 'process',
    description: 'Hard clipper / saturator.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv_drive', label: 'drive', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'drive', label: 'Drive', kind: 'number', min: 1, max: 20, step: 0.1, default: 1 },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        default: 'hard',
        options: [
          { value: 'hard', label: 'Hard' },
          { value: 'soft', label: 'Soft' },
          { value: 'tanh', label: 'Tanh' }
        ]
      }
    ]
  },

  sum: {
    kind: 'sum',
    label: 'Sum',
    category: 'process',
    description: 'Adds up to 4 signals.',
    inputs: [
      { id: 'in1', label: '1', signal: 'audio' },
      { id: 'in2', label: '2', signal: 'audio' },
      { id: 'in3', label: '3', signal: 'audio' },
      { id: 'in4', label: '4', signal: 'audio' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: []
  },

  multiply: {
    kind: 'multiply',
    label: 'Multiply',
    category: 'process',
    description: 'A × B — ring mod / VCA.',
    inputs: [
      { id: 'a', label: 'a', signal: 'audio' },
      { id: 'b', label: 'b', signal: 'audio' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: []
  },

  crossfade: {
    kind: 'crossfade',
    label: 'Crossfade',
    category: 'process',
    description: 'Blend between A and B via CV.',
    inputs: [
      { id: 'a', label: 'a', signal: 'audio' },
      { id: 'b', label: 'b', signal: 'audio' },
      { id: 'cv', label: 'cv', signal: 'cv' },
      { id: 'cv_mix', label: 'mix', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  },

  // ---------- Filters ----------
  filter_svf: {
    kind: 'filter_svf',
    label: 'SVF',
    category: 'process',
    description: 'State-variable filter (LP/HP/BP/Notch).',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'freq_cv', label: 'freq', signal: 'cv' },
      { id: 'cv_cutoff', label: 'cutoff', signal: 'cv' },
      { id: 'cv_res', label: 'res', signal: 'cv' }
    ],
    outputs: [
      { id: 'lp', label: 'LP', signal: 'audio' },
      { id: 'hp', label: 'HP', signal: 'audio' },
      { id: 'bp', label: 'BP', signal: 'audio' },
      { id: 'notch', label: 'N', signal: 'audio' }
    ],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz', taper: 'log' },
      { id: 'resonance', label: 'Q', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.2 }
    ]
  },

  filter_moog: {
    kind: 'filter_moog',
    label: 'Moog LP',
    category: 'process',
    description: 'Moog-style ladder lowpass filter.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'freq_cv', label: 'freq', signal: 'cv' },
      { id: 'cv_cutoff', label: 'cutoff', signal: 'cv' },
      { id: 'cv_res', label: 'res', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'frequency', label: 'Freq', kind: 'number', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz', taper: 'log' },
      { id: 'resonance', label: 'Q', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 }
    ]
  },

  // ---------- Envelopes ----------
  adsr: {
    kind: 'adsr',
    label: 'ADSR',
    category: 'process',
    description: 'ADSR envelope, gated CV output.',
    inputs: [
      { id: 'gate', label: 'gate', signal: 'gate' },
      { id: 'cv_attack', label: 'atk', signal: 'cv' },
      { id: 'cv_decay', label: 'dec', signal: 'cv' },
      { id: 'cv_sustain', label: 'sus', signal: 'cv' },
      { id: 'cv_release', label: 'rel', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'attack', label: 'A', kind: 'number', min: 0.001, max: 4, step: 0.001, default: 0.01, unit: 's', taper: 'log' },
      { id: 'decay', label: 'D', kind: 'number', min: 0.001, max: 4, step: 0.001, default: 0.1, unit: 's', taper: 'log' },
      { id: 'sustain', label: 'S', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
      { id: 'release', label: 'R', kind: 'number', min: 0.001, max: 8, step: 0.001, default: 0.3, unit: 's', taper: 'log' }
    ]
  },

  ar: {
    kind: 'ar',
    label: 'AR',
    category: 'process',
    description: 'Attack-release envelope, gated CV output.',
    inputs: [
      { id: 'gate', label: 'gate', signal: 'gate' },
      { id: 'cv_attack', label: 'atk', signal: 'cv' },
      { id: 'cv_release', label: 'rel', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'attack', label: 'A', kind: 'number', min: 0.001, max: 4, step: 0.001, default: 0.01, unit: 's', taper: 'log' },
      { id: 'release', label: 'R', kind: 'number', min: 0.001, max: 8, step: 0.001, default: 0.3, unit: 's', taper: 'log' }
    ]
  },

  envelope_follower: {
    kind: 'envelope_follower',
    label: 'Env Follower',
    category: 'process',
    description: 'Audio → CV envelope of |in|.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv_attack', label: 'atk', signal: 'cv' },
      { id: 'cv_release', label: 'rel', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'attack', label: 'A', kind: 'number', min: 0.001, max: 1, step: 0.001, default: 0.01, unit: 's', taper: 'log' },
      { id: 'release', label: 'R', kind: 'number', min: 0.001, max: 2, step: 0.001, default: 0.1, unit: 's', taper: 'log' }
    ]
  },

  // ---------- CV tools ----------
  slew: {
    kind: 'slew',
    label: 'Slew',
    category: 'process',
    description: 'Asymmetric slew limiter / portamento.',
    inputs: [
      { id: 'in', label: 'in', signal: 'cv' },
      { id: 'cv_rise', label: 'rise', signal: 'cv' },
      { id: 'cv_fall', label: 'fall', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'rise', label: 'Rise', kind: 'number', min: 0, max: 2, step: 0.001, default: 0.05, unit: 's' },
      { id: 'fall', label: 'Fall', kind: 'number', min: 0, max: 2, step: 0.001, default: 0.05, unit: 's' }
    ]
  },

  sample_hold: {
    kind: 'sample_hold',
    label: 'S&H',
    category: 'process',
    description: 'Sample & hold — captures in on rising trigger edge.',
    inputs: [
      { id: 'in', label: 'in', signal: 'cv' },
      { id: 'trigger', label: 'trig', signal: 'gate' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: []
  },

  inverter: {
    kind: 'inverter',
    label: 'Invert',
    category: 'process',
    description: 'CV invert (out = -in).',
    inputs: [{ id: 'in', label: 'in', signal: 'cv' }],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: []
  },

  scale: {
    kind: 'scale',
    label: 'Scale',
    category: 'process',
    description: 'CV scale + offset (out = in * scale + offset).',
    inputs: [{ id: 'in', label: 'in', signal: 'cv' }],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'scale', label: 'Scale', kind: 'number', min: -2, max: 2, step: 0.01, default: 1 },
      { id: 'offset', label: 'Offset', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 }
    ]
  },

  range: {
    kind: 'range',
    label: 'Range',
    category: 'process',
    description:
      'Remap an input range to an output range (Max/PD-style `scale`). ' +
      'out = out_min + (in - in_min) * (out_max - out_min) / (in_max - in_min). ' +
      'Clamp toggle to keep the output in bounds.',
    inputs: [{ id: 'in', label: 'in', signal: 'cv' }],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      { id: 'in_min',  label: 'In Min',  kind: 'number', min: -48000, max: 48000, step: 0.01, default: 0 },
      { id: 'in_max',  label: 'In Max',  kind: 'number', min: -48000, max: 48000, step: 0.01, default: 1 },
      { id: 'out_min', label: 'Out Min', kind: 'number', min: -48000, max: 48000, step: 0.01, default: 0 },
      { id: 'out_max', label: 'Out Max', kind: 'number', min: -48000, max: 48000, step: 0.01, default: 1 },
      {
        id: 'clamp',
        label: 'Clamp',
        kind: 'enum',
        default: 'on',
        options: [
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' }
        ]
      }
    ]
  },

  comparator: {
    kind: 'comparator',
    label: 'Compare',
    category: 'process',
    description: 'CV → gate; high when in > ref + threshold.',
    inputs: [
      { id: 'in', label: 'in', signal: 'cv' },
      { id: 'ref', label: 'ref', signal: 'cv' },
      { id: 'cv_threshold', label: 'thr', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      { id: 'threshold', label: 'Thr', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 }
    ]
  },

  // ---------- Effects ----------
  delay: {
    kind: 'delay',
    label: 'Delay',
    category: 'process',
    description: 'Delay line with feedback.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'time_cv', label: 'time', signal: 'cv' },
      { id: 'cv_time', label: 'time*', signal: 'cv' },
      { id: 'cv_feedback', label: 'fb', signal: 'cv' },
      { id: 'cv_mix', label: 'mix', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'time', label: 'Time', kind: 'number', min: 0.001, max: 2, step: 0.001, default: 0.25, unit: 's', taper: 'log' },
      { id: 'feedback', label: 'FB', kind: 'number', min: 0, max: 0.95, step: 0.01, default: 0.4 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  },

  reverb: {
    kind: 'reverb',
    label: 'Reverb',
    category: 'process',
    description: 'Reverb — DaisySP ReverbSc on Seed, Freeverb-style combs+allpasses on ESP32.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv_size', label: 'size', signal: 'cv' },
      { id: 'cv_damp', label: 'damp', signal: 'cv' },
      { id: 'cv_mix', label: 'mix', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'size', label: 'Size', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'damp', label: 'Damp', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 }
    ]
  },

  overdrive: {
    kind: 'overdrive',
    label: 'Overdrive',
    category: 'process',
    description: 'Overdrive with tone shaping.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv_drive', label: 'drive', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'drive', label: 'Drive', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
      { id: 'tone', label: 'Tone', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  },

  chorus: {
    kind: 'chorus',
    label: 'Chorus',
    category: 'process',
    description: 'LFO-modulated short delay chorus.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv_rate', label: 'rate', signal: 'cv' },
      { id: 'cv_depth', label: 'depth', signal: 'cv' },
      { id: 'cv_mix', label: 'mix', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'rate', label: 'Rate', kind: 'number', min: 0.05, max: 8, step: 0.01, default: 0.8, unit: 'Hz', taper: 'log' },
      { id: 'depth', label: 'Depth', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  },

  bitcrush: {
    kind: 'bitcrush',
    label: 'Bitcrush',
    category: 'process',
    description: 'Bit + sample-rate reduction.',
    inputs: [
      { id: 'in', label: 'in', signal: 'audio' },
      { id: 'cv_bits', label: 'bits', signal: 'cv' },
      { id: 'cv_rate', label: 'rate', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'bits', label: 'Bits', kind: 'number', min: 1, max: 16, step: 1, default: 8 },
      { id: 'rate', label: 'Rate', kind: 'number', min: 0.01, max: 1, step: 0.01, default: 0.5, taper: 'log' },
      { id: 'mix', label: 'Mix', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 }
    ]
  },

  // ---------- Hardware I/O ----------
  audio_in: {
    kind: 'audio_in',
    label: 'Audio In',
    category: 'io',
    description: 'Hardware stereo input (emulator: silence).',
    inputs: [],
    outputs: [
      { id: 'left', label: 'L', signal: 'audio' },
      { id: 'right', label: 'R', signal: 'audio' }
    ],
    params: []
  },

  audio_output: {
    kind: 'audio_output',
    label: 'Output',
    category: 'io',
    description: 'Stereo audio output.',
    inputs: [
      { id: 'left', label: 'L', signal: 'audio' },
      { id: 'right', label: 'R', signal: 'audio' }
    ],
    outputs: [],
    params: []
  },

  knob_in: {
    kind: 'knob_in',
    label: 'Knob',
    category: 'hardware',
    description:
      'Hardware knob → CV. `min`/`max` set the output range: 0..1 normalized ' +
      '(default), 0..4095 for raw 12-bit ADC, 20..20000 for Hz, etc. In the ' +
      'emulator `value` (0..1) is linearly mapped into that range.',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      // Runtime already writes params.bindingId for this kind (addNode's
      // auto-link, and codegen reads it) — it just wasn't declared, so the
      // Inspector rendered no binding control. Declaring it is the whole fix.
      bindingParam(),
      {
        id: 'channel',
        label: 'Ch',
        kind: 'enum',
        default: '1',
        options: [
          { value: '1', label: '1' },
          { value: '2', label: '2' },
          { value: '3', label: '3' },
          { value: '4', label: '4' },
          { value: '5', label: '5' },
          { value: '6', label: '6' }
        ]
      },
      { id: 'value', label: 'Val', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: 'min',   label: 'Min', kind: 'number', min: -48000, max: 48000, step: 0.01, default: 0 },
      { id: 'max',   label: 'Max', kind: 'number', min: -48000, max: 48000, step: 0.01, default: 1 }
    ]
  },

  gate_in: {
    kind: 'gate_in',
    label: 'Gate In',
    category: 'hardware',
    description: 'Hardware gate input (emulator: value param drives output).',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      // Runtime already writes params.bindingId for this kind (addNode's
      // auto-link, and codegen reads it) — it just wasn't declared, so the
      // Inspector rendered no binding control. Declaring it is the whole fix.
      bindingParam(),
      {
        id: 'channel',
        label: 'Ch',
        kind: 'enum',
        default: '1',
        options: [
          { value: '1', label: '1' },
          { value: '2', label: '2' }
        ]
      },
      { id: 'value', label: 'Val', kind: 'number', min: 0, max: 1, step: 1, default: 0 }
    ]
  }
}

/**
 * Full catalog assembled from core + per-category partials. The `as` cast
 * asserts that every `NodeKind` has an entry; a dev-mode check below warns
 * if any are missing (so adding a kind to the union without a definition
 * shows up loudly instead of silently breaking the UI).
 */
export const NODE_DEFINITIONS: Record<NodeKind, NodeDefinition> = {
  ...CORE_DEFS,
  ...SYNTHESIS_DEFS,
  ...SEQUENCING_DEFS,
  ...EFFECTS_DEFS,
  ...VISUAL_DEFS,
  ...HARDWARE_DEFS,
  ...LOGIC_DEFS
} as Record<NodeKind, NodeDefinition>

export const NODE_KINDS: NodeKind[] = Object.keys(NODE_DEFINITIONS) as NodeKind[]
