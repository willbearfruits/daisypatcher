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
import { bindingParam } from './bindingParam'
import type { NodeKind } from '@/types/graph'
import { CODE_DEFAULT_SOURCE } from '@/codegen/codeNode/lang'

// Re-export to keep the import live for tooling.
export type { NodeDefinition, ParamDef }


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

  /*
   * Rotary encoder → CV.
   *
   * Unlike a pot, an encoder reports RELATIVE motion: a quadrature A/B
   * pair yields +1 / -1 per detent, with no absolute position to read.
   * So the node integrates those detents into a position itself, which is
   * why it carries `value` (the running position) rather than reading a
   * pin directly. `step` is how far one detent moves it.
   *
   * Three outputs because the three are genuinely different signals and
   * patching only the integrated one throws away what an encoder is good
   * at: `out` for a knob-like sweep, `delta` for "nudge this by N" into a
   * sample+hold or counter, `sw` for the push switch.
   */
  encoder_in: {
    kind: 'encoder_in',
    label: 'Encoder',
    category: 'hardware',
    description:
      'Rotary encoder → CV. Detents integrate into `out` (scaled to min..max, ' +
      'clamped or wrapped); `delta` pulses +/- step on each detent; `sw` is the ' +
      'push switch as a gate. In the emulator, drag `value` to simulate turning it.',
    inputs: [],
    outputs: [
      { id: 'out', label: 'out', signal: 'cv' },
      { id: 'delta', label: 'delta', signal: 'cv' },
      { id: 'sw', label: 'sw', signal: 'gate' }
    ],
    params: [
      bindingParam(),
      { id: 'value', label: 'Val',  kind: 'number', min: 0, max: 1, step: 0.001, default: 0.5 },
      { id: 'step',  label: 'Step', kind: 'number', min: 0.001, max: 0.5, step: 0.001, default: 0.02 },
      { id: 'min',   label: 'Min',  kind: 'number', min: -48000, max: 48000, step: 0.01, default: 0 },
      { id: 'max',   label: 'Max',  kind: 'number', min: -48000, max: 48000, step: 0.01, default: 1 },
      {
        id: 'wrap',
        label: 'Wrap',
        kind: 'enum',
        default: 'clamp',
        options: [
          { value: 'clamp', label: 'Clamp' },
          { value: 'wrap', label: 'Wrap' }
        ]
      },
      { id: 'sw_value', label: 'Sw', kind: 'number', min: 0, max: 1, step: 1, default: 0 }
    ]
  },

  /*
   * Encoder-driven menu.
   *
   * Patch an `encoder_in`'s `delta` and `sw` into this and the tree becomes
   * navigable: turn to move, click to enter a submenu or edit a value,
   * click again to confirm. Long-press and double-click are assignable in
   * the in-node editor.
   *
   * Leaves reach the rest of the patch two ways, and can use both at once:
   * a leaf can name a target node + param directly (no cable — which is
   * what makes 6 oscillators x 3 params practical), and/or mirror onto one
   * of the four CV outputs for things that aren't params.
   *
   * `tree` is opaque to the inspector exactly like the OLED's `elements`;
   * the in-node designer owns it.
   */
  menu: {
    kind: 'menu',
    label: 'Menu',
    category: 'hardware',
    description:
      'Encoder-driven menu — build a tree in the node, drive it from an encoder, ' +
      'show it on an OLED. Leaves write node params directly and/or mirror to A-D.',
    inputs: [
      { id: 'delta', label: 'delta', signal: 'cv' },
      { id: 'click', label: 'click', signal: 'gate' }
    ],
    outputs: [
      { id: 'a', label: 'A', signal: 'cv' },
      { id: 'b', label: 'B', signal: 'cv' },
      { id: 'c', label: 'C', signal: 'cv' },
      { id: 'd', label: 'D', signal: 'cv' }
    ],
    params: [
      // Not editable via the standard inspector — the in-node designer owns
      // it, including the long-press / double-click assignments.
      {
        id: 'tree',
        label: 'Tree',
        kind: 'enum',
        default: '{"root":[],"longPress":"back","doubleClick":"home","longMs":500,"doubleMs":300}',
        options: [{ value: '', label: '(designed in-node)' }]
      }
    ]
  },

  /*
   * ---------- I2C sensors ----------
   *
   * One node per placed sensor, fanning its axes out as separate CV
   * outputs. Splitting them into an `imu_x` / `imu_y` / `imu_z` trio would
   * mean three nodes bound to one physical device and three chances for
   * them to disagree about which device that is.
   *
   * In the emulator the axis params ARE the sensor, exactly as `knob_in`'s
   * `value` param stands in for a physical pot — you can build and hear a
   * patch that responds to tilt without owning an IMU. On hardware the
   * params become the read's starting value and the device takes over.
   */
  imu_in: {
    kind: 'imu_in',
    label: 'IMU',
    category: 'hardware',
    description:
      'MPU-6050 accelerometer + gyroscope over I2C. Six CV outputs: acceleration ' +
      'in g and rotation in degrees/second, each normalised to the selected range. ' +
      'In the emulator the sliders stand in for tilting the board.',
    inputs: [],
    outputs: [
      { id: 'ax', label: 'aX', signal: 'cv' },
      { id: 'ay', label: 'aY', signal: 'cv' },
      { id: 'az', label: 'aZ', signal: 'cv' },
      { id: 'gx', label: 'gX', signal: 'cv' },
      { id: 'gy', label: 'gY', signal: 'cv' },
      { id: 'gz', label: 'gZ', signal: 'cv' }
    ],
    params: [
      bindingParam(),
      {
        id: 'accel_range',
        label: 'Accel',
        kind: 'enum',
        default: '2',
        options: [
          { value: '2', label: '±2 g' },
          { value: '4', label: '±4 g' },
          { value: '8', label: '±8 g' },
          { value: '16', label: '±16 g' }
        ]
      },
      {
        id: 'gyro_range',
        label: 'Gyro',
        kind: 'enum',
        default: '250',
        options: [
          { value: '250', label: '±250 °/s' },
          { value: '500', label: '±500 °/s' },
          { value: '1000', label: '±1000 °/s' },
          { value: '2000', label: '±2000 °/s' }
        ]
      },
      { id: 'smooth', label: 'Smooth', kind: 'number', min: 0, max: 200, step: 1, default: 20, unit: 'ms' },
      // Emulator stand-ins. az defaults to 1: a board lying flat reads 1 g
      // downward, and starting at zero would suggest freefall.
      { id: 'ax', label: 'aX', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'ay', label: 'aY', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'az', label: 'aZ', kind: 'number', min: -1, max: 1, step: 0.01, default: 1 },
      { id: 'gx', label: 'gX', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'gy', label: 'gY', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 },
      { id: 'gz', label: 'gZ', kind: 'number', min: -1, max: 1, step: 0.01, default: 0 }
    ]
  },

  compass_in: {
    kind: 'compass_in',
    label: 'Compass',
    category: 'hardware',
    description:
      'QMC5883L / HMC5883L magnetometer over I2C. Three normalised axes plus a ' +
      '0..1 heading. The two chips ship on identical-looking blue boards and are ' +
      'NOT register-compatible — pick the one you actually have.',
    inputs: [],
    outputs: [
      { id: 'x', label: 'X', signal: 'cv' },
      { id: 'y', label: 'Y', signal: 'cv' },
      { id: 'z', label: 'Z', signal: 'cv' },
      { id: 'heading', label: 'head', signal: 'cv' }
    ],
    params: [
      bindingParam(),
      {
        id: 'chip',
        label: 'Chip',
        kind: 'enum',
        default: 'qmc5883l',
        options: [
          { value: 'qmc5883l', label: 'QMC5883L' },
          { value: 'hmc5883l', label: 'HMC5883L' }
        ]
      },
      { id: 'smooth', label: 'Smooth', kind: 'number', min: 0, max: 200, step: 1, default: 30, unit: 'ms' },
      { id: 'heading', label: 'Head', kind: 'number', min: 0, max: 1, step: 0.001, default: 0 }
    ]
  },

  distance_in: {
    kind: 'distance_in',
    label: 'Distance',
    category: 'hardware',
    description:
      'VL53L0X time-of-flight ranger over I2C. `dist` is 0..1 across the configured ' +
      'range, `mm` is the raw millimetre reading. Out-of-range reads hold the last ' +
      'good value rather than snapping to zero.',
    inputs: [],
    outputs: [
      { id: 'dist', label: 'dist', signal: 'cv' },
      { id: 'mm', label: 'mm', signal: 'cv' }
    ],
    params: [
      bindingParam(),
      { id: 'min_mm', label: 'Near', kind: 'number', min: 0, max: 2000, step: 10, default: 50, unit: 'mm' },
      { id: 'max_mm', label: 'Far', kind: 'number', min: 20, max: 4000, step: 10, default: 800, unit: 'mm' },
      { id: 'smooth', label: 'Smooth', kind: 'number', min: 0, max: 200, step: 1, default: 40, unit: 'ms' },
      { id: 'dist', label: 'Dist', kind: 'number', min: 0, max: 1, step: 0.001, default: 0.5 }
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
      // Runtime already writes params.bindingId for this kind (addNode's
      // auto-link, and codegen reads it) — it just wasn't declared, so the
      // Inspector rendered no binding control. Declaring it is the whole fix.
      bindingParam(),
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
      // Runtime already writes params.bindingId for this kind (addNode's
      // auto-link, and codegen reads it) — it just wasn't declared, so the
      // Inspector rendered no binding control. Declaring it is the whole fix.
      bindingParam(),
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
      // Runtime already writes params.bindingId for this kind (addNode's
      // auto-link, and codegen reads it) — it just wasn't declared, so the
      // Inspector rendered no binding control. Declaring it is the whole fix.
      bindingParam(),
      {
        id: 'channel',
        label: 'Ch',
        kind: 'enum',
        default: '1',
        options: CHANNEL_1_TO_16
      }
    ]
  },

  /*
   * ---------- The escape hatch ----------
   *
   * A node whose body the user writes, in the small C-shaped language in
   * `codegen/codeNode/lang.ts`. Runs in the emulator (the worklet compiles
   * the AST to closures — no eval, the CSP forbids it) and compiles to
   * firmware from the same AST, so the two cannot drift.
   *
   * FOUR INPUTS AND TWO OUTPUTS, FIXED. Sockets live on the node
   * DEFINITION, which is per-kind and shared by every instance; making them
   * per-instance would mean threading an instance-specific definition
   * through the editor, the audio engine, the connection index and both
   * emitters. Four in / two out covers almost everything a node body wants,
   * and an unconnected input reads 0, so the unused ones cost nothing.
   */
  code: {
    kind: 'code',
    label: 'Code',
    category: 'process',
    description:
      'Write the DSP yourself. Inputs a-d, params p1-p4, outputs out/out2, ' +
      '`state` variables that persist between samples. Runs in the emulator and ' +
      'compiles to firmware from the same source.',
    inputs: [
      { id: 'a', label: 'a', signal: 'audio' },
      { id: 'b', label: 'b', signal: 'audio' },
      { id: 'c', label: 'c', signal: 'audio' },
      { id: 'd', label: 'd', signal: 'audio' }
    ],
    outputs: [
      { id: 'out', label: 'out', signal: 'audio' },
      { id: 'out2', label: 'out2', signal: 'audio' }
    ],
    params: [
      // The body itself. Opaque to the inspector — the in-node editor owns
      // it, the same arrangement the OLED's `elements` and the menu's
      // `tree` use.
      {
        id: 'source',
        label: 'Source',
        kind: 'enum',
        default: CODE_DEFAULT_SOURCE,
        options: [{ value: '', label: '(written in-node)' }]
      },
      { id: 'p1', label: 'P1', kind: 'number', min: -1000, max: 1000, step: 0.001, default: 0.5 },
      { id: 'p2', label: 'P2', kind: 'number', min: -1000, max: 1000, step: 0.001, default: 0.5 },
      { id: 'p3', label: 'P3', kind: 'number', min: -1000, max: 1000, step: 0.001, default: 0 },
      { id: 'p4', label: 'P4', kind: 'number', min: -1000, max: 1000, step: 0.001, default: 0 }
    ]
  },

  /*
   * ---------- Nesting ----------
   *
   * A `subpatch` holds another graph in its `graph` param; `sub_in` and
   * `sub_out` are its inlets and outlets, the same idea Max and Pure Data
   * use. None of the three survives to codegen: `flattenGraph` splices them
   * away first, so the emitters, the scheduler and the audio engine never
   * learn that nesting exists. That is why a subpatch costs nothing at
   * runtime and cannot introduce a bug class the flat path does not have.
   */
  subpatch: {
    kind: 'subpatch',
    label: 'Subpatch',
    category: 'process',
    description:
      'A patch inside a node. Collapse a working chunk into one box with named ' +
      'ports; expand it again to edit. Flattened before compiling, so it is free.',
    inputs: [
      { id: 'a', label: 'a', signal: 'audio' },
      { id: 'b', label: 'b', signal: 'audio' },
      { id: 'c', label: 'c', signal: 'audio' },
      { id: 'd', label: 'd', signal: 'audio' }
    ],
    outputs: [
      { id: 'out', label: 'out', signal: 'audio' },
      { id: 'out2', label: 'out2', signal: 'audio' }
    ],
    params: [
      {
        id: 'graph',
        label: 'Body',
        kind: 'enum',
        default: '{"nodes":[],"connections":[],"meta":{"name":"subpatch","sampleRate":48000,"blockSize":48}}',
        options: [{ value: '', label: '(edited by entering it)' }]
      },
      {
        id: 'label',
        label: 'Name',
        kind: 'enum',
        default: 'Subpatch',
        options: [{ value: 'Subpatch', label: 'Subpatch' }]
      }
    ]
  },

  sub_in: {
    kind: 'sub_in',
    label: 'Inlet',
    category: 'io',
    description: "One of the parent subpatch's inputs, inside the body.",
    inputs: [],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'index', label: 'Port', kind: 'number', min: 0, max: 3, step: 1, default: 0 },
      { id: 'label', label: 'Name', kind: 'enum', default: 'a', options: [{ value: 'a', label: 'a' }] }
    ]
  },

  sub_out: {
    kind: 'sub_out',
    label: 'Outlet',
    category: 'io',
    description: "One of the parent subpatch's outputs, inside the body.",
    inputs: [{ id: 'in', label: 'in', signal: 'audio' }],
    outputs: [],
    params: [
      { id: 'index', label: 'Port', kind: 'number', min: 0, max: 1, step: 1, default: 0 },
      { id: 'label', label: 'Name', kind: 'enum', default: 'out', options: [{ value: 'out', label: 'out' }] }
    ]
  },

  /*
   * Preset recall on the device.
   *
   * Presets were an app-only feature: you could capture eight variations
   * and none of them survived a flash. This is the thing that fires them,
   * and it is a NODE rather than a hidden runtime service so that what
   * triggers a recall is patched, visible, and yours to choose — a button,
   * a clock division, a CV from anywhere.
   *
   * In `morph` mode the CV walks between two slots continuously, which is
   * the same operation the morph slider performs in the app.
   */
  preset_recall: {
    kind: 'preset_recall',
    label: 'Preset',
    category: 'io',
    description:
      "Recalls or morphs between this patch's presets on the device. Trigger to " +
      'recall a slot; in morph mode the CV walks between two slots the way the ' +
      'morph slider does in the app. Numeric params only.',
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'cv_slot', label: 'slot', signal: 'cv' },
      { id: 'cv_morph', label: 'morph', signal: 'cv' }
    ],
    outputs: [{ id: 'changed', label: 'chg', signal: 'gate' }],
    params: [
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        default: 'recall',
        options: [
          { value: 'recall', label: 'Recall' },
          { value: 'morph', label: 'Morph' }
        ]
      },
      { id: 'slot', label: 'Slot', kind: 'number', min: 0, max: 31, step: 1, default: 0 },
      { id: 'morph_a', label: 'From', kind: 'number', min: 0, max: 31, step: 1, default: 0 },
      { id: 'morph_b', label: 'To', kind: 'number', min: 0, max: 31, step: 1, default: 1 }
    ]
  },

  /*
   * Voice stacking. `poly` holds a body like `subpatch` does and emits N
   * copies of it, summed — which needs no new emitter and no runtime voice
   * manager, because "the same body, N times" is already solved by the id
   * prefixing that makes subpatches work.
   *
   * Every voice runs all the time and hears the same inputs; `voice_id` is
   * what differs, and flattening bakes it to a constant per copy. That is
   * detune stacks and choruses, not note allocation — assigning incoming
   * notes to free voices needs runtime state and is a separate feature.
   */
  poly: {
    kind: 'poly',
    label: 'Poly',
    category: 'process',
    description:
      'N copies of a body, summed. Every voice hears the same inputs; `voice_id` ' +
      'inside tells each copy which one it is, for detune and spread.',
    inputs: [
      { id: 'a', label: 'a', signal: 'audio' },
      { id: 'b', label: 'b', signal: 'audio' },
      { id: 'c', label: 'c', signal: 'audio' },
      { id: 'd', label: 'd', signal: 'audio' }
    ],
    outputs: [
      { id: 'out', label: 'out', signal: 'audio' },
      { id: 'out2', label: 'out2', signal: 'audio' }
    ],
    params: [
      {
        id: 'graph',
        label: 'Body',
        kind: 'enum',
        default: '{"nodes":[],"connections":[],"meta":{"name":"voice","sampleRate":48000,"blockSize":48}}',
        options: [{ value: '', label: '(edited by entering it)' }]
      },
      { id: 'voices', label: 'Voices', kind: 'number', min: 1, max: 8, step: 1, default: 4 },
      {
        id: 'label',
        label: 'Name',
        kind: 'enum',
        default: 'Poly',
        options: [{ value: 'Poly', label: 'Poly' }]
      }
    ]
  },

  voice_id: {
    kind: 'voice_id',
    label: 'Voice',
    category: 'source',
    description:
      'Which voice this copy is, inside a Poly body. `norm` spreads 0..1 across ' +
      'the stack (0 when there is one voice); `index` counts 0, 1, 2…',
    inputs: [],
    outputs: [
      { id: 'norm', label: 'norm', signal: 'cv' },
      { id: 'index', label: 'idx', signal: 'cv' }
    ],
    params: []
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
