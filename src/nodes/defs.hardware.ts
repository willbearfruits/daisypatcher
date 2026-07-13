/**
 * Hardware-bound + MIDI + scripting/debug node catalog — 10 extra kinds.
 * Merged into `NODE_DEFINITIONS` in `src/nodes/definitions.ts`; do not
 * import this file anywhere else.
 *
 * Hardware-bound kinds (`button`, `led`, `switch_3way`, `i2s_in`,
 * `i2s_out`) expose a `bindingId` param that references a
 * `PlacedComponent` in the `HardwareLayout`. The hardware view is the
 * authoritative editor for that binding; the inspector treats it as an
 * opaque string.
 */

import type { NodeDefinition, ParamDef } from './definitions'
import type { NodeKind } from '@/types/graph'

// Re-export to keep the import live for tooling.
export type { NodeDefinition, ParamDef }

/** "(unbound)" placeholder enum used for bindingId params. The hardware view
 *  populates this list dynamically with the layout's placed components; the
 *  inspector falls back to this stub when it can't enumerate live. */
const BINDING_UNBOUND_OPTIONS = [{ value: '', label: '(unbound)' }]

function bindingParam(): ParamDef {
  return {
    id: 'bindingId',
    label: 'Binding',
    kind: 'enum',
    default: '',
    options: BINDING_UNBOUND_OPTIONS
  }
}

const CHANNEL_1_TO_16_ALL = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
  { value: '6', label: '6' },
  { value: '7', label: '7' },
  { value: '8', label: '8' },
  { value: '9', label: '9' },
  { value: '10', label: '10' },
  { value: '11', label: '11' },
  { value: '12', label: '12' },
  { value: '13', label: '13' },
  { value: '14', label: '14' },
  { value: '15', label: '15' },
  { value: '16', label: '16' },
  { value: 'all', label: 'All' }
]

const CHANNEL_1_TO_16 = CHANNEL_1_TO_16_ALL.filter((o) => o.value !== 'all')

const TEST_NOTE_OPTIONS = [
  { value: 'none', label: '(none)' },
  { value: '60', label: 'C4' },
  { value: '62', label: 'D4' },
  { value: '64', label: 'E4' },
  { value: '65', label: 'F4' },
  { value: '67', label: 'G4' },
  { value: '69', label: 'A4' },
  { value: '71', label: 'B4' },
  { value: '72', label: 'C5' }
]

export const HARDWARE_DEFS: Partial<Record<NodeKind, NodeDefinition>> = {
  // ---------- Hardware digital ----------
  button: {
    kind: 'button',
    label: 'Button',
    category: 'hardware',
    description: 'Hardware pushbutton → gate (emulator: value param drives output).',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      bindingParam(),
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        default: 'momentary',
        options: [
          { value: 'momentary', label: 'Momentary' },
          { value: 'toggle', label: 'Toggle' },
          { value: 'latch', label: 'Latch' }
        ]
      },
      // Emulator-only: click target in the inspector. Tracks the
      // physical press on hardware — the codegen ignores it.
      { id: 'value', label: 'Val', kind: 'number', min: 0, max: 1, step: 1, default: 0 }
    ]
  },

  led: {
    kind: 'led',
    label: 'LED',
    category: 'hardware',
    description: 'Digital LED sink (emulator: silent, hardware: GPIO/PWM out).',
    // cv accepts cv/gate/audio from the store perspective via signal-kind
    // matching; the worklet just ignores the value (no audible output).
    inputs: [{ id: 'in', label: 'in', signal: 'cv' }],
    outputs: [],
    params: [
      bindingParam(),
      { id: 'threshold', label: 'Thr', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        default: 'gate',
        options: [
          { value: 'gate', label: 'Gate' },
          { value: 'pwm', label: 'PWM' },
          { value: 'follow', label: 'Follow' }
        ]
      }
    ]
  },

  switch_3way: {
    kind: 'switch_3way',
    label: 'Switch 3-way',
    category: 'hardware',
    description: '3-position toggle → discrete CV (-1 / 0 / +1).',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      bindingParam(),
      {
        id: 'position',
        label: 'Pos',
        kind: 'enum',
        default: '0',
        options: [
          { value: '-1', label: '-1' },
          { value: '0', label: '0' },
          { value: '1', label: '+1' }
        ]
      }
    ]
  },

  // ---------- I2S audio I/O ----------
  i2s_in: {
    kind: 'i2s_in',
    label: 'I2S In',
    category: 'hardware',
    description: 'External I2S codec stereo input (emulator: silence).',
    inputs: [],
    outputs: [
      { id: 'left', label: 'L', signal: 'audio' },
      { id: 'right', label: 'R', signal: 'audio' }
    ],
    params: [bindingParam()]
  },

  i2s_out: {
    kind: 'i2s_out',
    label: 'I2S Out',
    category: 'hardware',
    description: 'External I2S codec stereo output (emulator: silent tap).',
    inputs: [
      { id: 'left', label: 'L', signal: 'audio' },
      { id: 'right', label: 'R', signal: 'audio' }
    ],
    outputs: [],
    params: [bindingParam()]
  },

  // ---------- MIDI ----------
  midi_in_note: {
    kind: 'midi_in_note',
    label: 'MIDI Note In',
    category: 'hardware',
    description: 'Web MIDI note-on/off → pitch (v/oct) + gate + velocity CV.',
    inputs: [],
    outputs: [
      { id: 'pitch', label: 'pitch', signal: 'cv' },
      { id: 'gate', label: 'gate', signal: 'gate' },
      { id: 'velocity', label: 'vel', signal: 'cv' }
    ],
    params: [
      {
        id: 'channel',
        label: 'Ch',
        kind: 'enum',
        default: '1',
        options: CHANNEL_1_TO_16_ALL
      },
      {
        id: 'test_note',
        label: 'Test',
        kind: 'enum',
        default: 'none',
        options: TEST_NOTE_OPTIONS
      }
    ]
  },

  midi_in_cc: {
    kind: 'midi_in_cc',
    label: 'MIDI CC In',
    category: 'hardware',
    description: 'Web MIDI CC → normalized CV (0..1).',
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      {
        id: 'channel',
        label: 'Ch',
        kind: 'enum',
        default: '1',
        options: CHANNEL_1_TO_16_ALL
      },
      { id: 'cc', label: 'CC', kind: 'number', min: 0, max: 127, step: 1, default: 1 },
      { id: 'test_value', label: 'Test', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 }
    ]
  },

  midi_out_note: {
    kind: 'midi_out_note',
    label: 'MIDI Note Out',
    category: 'hardware',
    description: 'CV/gate/velocity → Web MIDI note-on/off on gate rising edge.',
    inputs: [
      { id: 'pitch', label: 'pitch', signal: 'cv' },
      { id: 'gate', label: 'gate', signal: 'gate' },
      { id: 'velocity', label: 'vel', signal: 'cv' }
    ],
    outputs: [],
    params: [
      {
        id: 'channel',
        label: 'Ch',
        kind: 'enum',
        default: '1',
        options: CHANNEL_1_TO_16
      }
    ]
  },

  // ---------- Expression + debug ----------
  expression: {
    kind: 'expression',
    label: 'Expression',
    category: 'process',
    description: 'Math expression on a..d (sin/cos/pow/abs/PI/E, etc.).',
    inputs: [
      { id: 'a', label: 'a', signal: 'cv' },
      { id: 'b', label: 'b', signal: 'cv' },
      { id: 'c', label: 'c', signal: 'cv' },
      { id: 'd', label: 'd', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'cv' }],
    params: [
      // Stored as a raw string. The worklet reparses on every change.
      { id: 'expr', label: 'Expr', kind: 'enum', default: 'a', options: [{ value: 'a', label: 'a' }] }
    ]
  },

  print: {
    kind: 'print',
    label: 'Print',
    category: 'process',
    description: 'Debug print value on rising trigger edge (console/USB serial).',
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'value', label: 'val', signal: 'cv' }
    ],
    outputs: [],
    params: [
      { id: 'label', label: 'Label', kind: 'enum', default: 'val', options: [{ value: 'val', label: 'val' }] }
    ]
  }
}
