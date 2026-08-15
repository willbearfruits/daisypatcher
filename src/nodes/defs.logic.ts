/**
 * Logic — the nodes that give a patch memory and behaviour.
 *
 * Everything else in this catalog is a function of its inputs at this
 * instant: an oscillator at 440 Hz is always an oscillator at 440 Hz. That
 * is the right model for DSP and the wrong one for an instrument. A box
 * with a button that latches, a sequencer that counts bars, a mode that
 * changes what the knobs mean — those need to remember something, and
 * until now the only node that remembered anything was the sequencer.
 *
 * The design rule that shapes all of these: STATE IS A SIGNAL. A counter
 * does not have a hidden mode you inspect in a sidebar; it emits its count
 * as CV, and you patch that CV at whatever should care. That keeps the
 * whole layer composable with the DSP layer instead of being a parallel
 * system with its own rules — a `state_machine`'s output can sweep a filter
 * as easily as it can pick a menu page.
 *
 * Which is also why there is no node with a variable number of outputs.
 * Sockets are declared per kind and reordering them breaks saved patches
 * (see CLAUDE.md), so "one gate per state" is not available. `state_machine`
 * emits its state as a number and `select` routes on it — two static nodes
 * that compose, rather than one node whose shape changes underneath you.
 */

import type { NodeDefinition } from './definitions'
import type { NodeKind } from '@/types/graph'

export const LOGIC_DEFS: Partial<Record<NodeKind, NodeDefinition>> = {
  /*
   * Boolean logic on gates.
   *
   * `not` ignores `b` — kept as one node rather than split into six because
   * the op is the thing you change while patching, and swapping AND for OR
   * should not mean deleting a node and rewiring it.
   */
  logic: {
    kind: 'logic',
    label: 'Logic',
    category: 'process',
    description:
      'Boolean op on two gates. NOT ignores the B input. Threshold is 0.5, ' +
      'matching every other gate in the catalog.',
    inputs: [
      { id: 'a', label: 'a', signal: 'gate' },
      { id: 'b', label: 'b', signal: 'gate' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      {
        id: 'op',
        label: 'Op',
        kind: 'enum',
        default: 'and',
        options: [
          { value: 'and', label: 'AND' },
          { value: 'or', label: 'OR' },
          { value: 'xor', label: 'XOR' },
          { value: 'nand', label: 'NAND' },
          { value: 'nor', label: 'NOR' },
          { value: 'not', label: 'NOT (a)' }
        ]
      }
    ]
  },

  /*
   * T flip-flop. The node that makes a momentary button behave like a
   * switch, which is most of what a hardware panel needs and what people
   * reach for first when a button "does not stay on".
   */
  toggle: {
    kind: 'toggle',
    label: 'Toggle',
    category: 'process',
    description:
      'Flips between high and low on each rising edge. Turns a momentary ' +
      'button into a latching switch.',
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'reset', label: 'rst', signal: 'gate' }
    ],
    outputs: [
      { id: 'out', label: 'out', signal: 'gate' },
      { id: 'inv', label: 'inv', signal: 'gate' }
    ],
    params: [
      {
        id: 'initial',
        label: 'Starts',
        kind: 'enum',
        default: 'low',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ]
  },

  /*
   * Counter.
   *
   * `count` is normalised 0..1 so it drops straight into any CV input
   * without a `scale` in between; `index` is the raw integer for the cases
   * that need it (a `select`, a comparator testing for step 3). Emitting
   * both costs one variable and saves a node in most patches.
   */
  counter: {
    kind: 'counter',
    label: 'Counter',
    category: 'process',
    description:
      'Counts rising edges. `count` is 0..1 across the range for patching ' +
      'into CV inputs; `index` is the raw number. `carry` fires on wrap.',
    inputs: [
      { id: 'inc', label: 'inc', signal: 'gate' },
      { id: 'dec', label: 'dec', signal: 'gate' },
      { id: 'reset', label: 'rst', signal: 'gate' }
    ],
    outputs: [
      { id: 'count', label: 'cv', signal: 'cv' },
      { id: 'index', label: 'n', signal: 'cv' },
      { id: 'carry', label: 'carry', signal: 'gate' }
    ],
    params: [
      { id: 'max', label: 'Count', kind: 'number', min: 2, max: 64, step: 1, default: 8 },
      {
        id: 'mode',
        label: 'At end',
        kind: 'enum',
        default: 'wrap',
        options: [
          { value: 'wrap', label: 'Wrap to 0' },
          { value: 'clamp', label: 'Stop at max' }
        ]
      }
    ]
  },

  /*
   * Timer.
   *
   * Three modes because "wait, then fire" and "fire, then stay high for a
   * while" are different needs that both get called a timer, and picking
   * one would send people to the code node for the other.
   */
  timer: {
    kind: 'timer',
    label: 'Timer',
    category: 'process',
    description:
      'Delay fires once after the set time. Pulse goes high for that long ' +
      'immediately. Gate-off holds high until the input has been low for ' +
      'that long — a debounce.',
    inputs: [
      { id: 'trigger', label: 'trig', signal: 'gate' },
      { id: 'cv_time', label: 'time', signal: 'cv' }
    ],
    outputs: [
      { id: 'out', label: 'out', signal: 'gate' },
      { id: 'running', label: 'run', signal: 'gate' }
    ],
    params: [
      { id: 'time', label: 'Time', kind: 'number', min: 1, max: 10000, step: 1, default: 250, unit: 'ms', taper: 'log' },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        default: 'delay',
        options: [
          { value: 'delay', label: 'Delay' },
          { value: 'pulse', label: 'Pulse' },
          { value: 'gateoff', label: 'Gate-off' }
        ]
      },
      {
        id: 'retrigger',
        label: 'Retrigger',
        kind: 'enum',
        default: 'restart',
        options: [
          { value: 'restart', label: 'Restart' },
          { value: 'ignore', label: 'Ignore while running' }
        ]
      }
    ]
  },

  /*
   * State machine.
   *
   * Deliberately the smallest thing that deserves the name: N states, and
   * inputs to move between them. Transition CONDITIONS are patched — a
   * `logic` node feeding `next` is a guard — rather than configured in a
   * table nobody can see from the canvas.
   */
  state_machine: {
    kind: 'state_machine',
    label: 'State',
    category: 'process',
    description:
      'Holds one of N states. Patch gates to move between them; the state ' +
      'comes out as CV, so anything can read it. Use Select to route on it.',
    inputs: [
      { id: 'next', label: 'next', signal: 'gate' },
      { id: 'prev', label: 'prev', signal: 'gate' },
      { id: 'reset', label: 'rst', signal: 'gate' },
      { id: 'cv_goto', label: 'goto', signal: 'cv' }
    ],
    outputs: [
      { id: 'state', label: 'cv', signal: 'cv' },
      { id: 'index', label: 'n', signal: 'cv' },
      { id: 'changed', label: 'chg', signal: 'gate' }
    ],
    params: [
      { id: 'states', label: 'States', kind: 'number', min: 2, max: 16, step: 1, default: 4 },
      {
        id: 'mode',
        label: 'At end',
        kind: 'enum',
        default: 'wrap',
        options: [
          { value: 'wrap', label: 'Wrap' },
          { value: 'clamp', label: 'Clamp' }
        ]
      }
    ]
  },

  /*
   * Four-way router.
   *
   * The companion to `state_machine` and `counter`: they emit a number,
   * this turns a number into a choice. Four inputs because that covers the
   * overwhelming majority of mode switches, and because a node with a
   * variable socket count is not something this editor can offer (see the
   * file header).
   */
  select: {
    kind: 'select',
    label: 'Select',
    category: 'process',
    description:
      'Passes one of four inputs, chosen by the `sel` CV. Crossfade mode ' +
      'blends between neighbours instead of switching, for clickless changes.',
    inputs: [
      { id: 'in0', label: '0', signal: 'audio' },
      { id: 'in1', label: '1', signal: 'audio' },
      { id: 'in2', label: '2', signal: 'audio' },
      { id: 'in3', label: '3', signal: 'audio' },
      { id: 'sel', label: 'sel', signal: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'out', signal: 'audio' }],
    params: [
      { id: 'index', label: 'Index', kind: 'number', min: 0, max: 3, step: 1, default: 0 },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        default: 'switch',
        options: [
          { value: 'switch', label: 'Switch' },
          { value: 'crossfade', label: 'Crossfade' }
        ]
      }
    ]
  },

  /*
   * Edge detector.
   *
   * A gate that is high for a bar and a trigger that is high for a sample
   * are the same signal kind here, and most nodes that take a `trigger`
   * only look at the rising edge anyway. This exists for the ones that do
   * not — and for turning a falling edge into something you can patch,
   * which is otherwise impossible without the code node.
   */
  edge: {
    kind: 'edge',
    label: 'Edge',
    category: 'process',
    description:
      'Emits a one-sample trigger on the rising edge, the falling edge, or ' +
      'both. Turns a long gate into something that fires once.',
    inputs: [{ id: 'in', label: 'in', signal: 'gate' }],
    outputs: [{ id: 'out', label: 'out', signal: 'gate' }],
    params: [
      {
        id: 'mode',
        label: 'On',
        kind: 'enum',
        default: 'rising',
        options: [
          { value: 'rising', label: 'Rising' },
          { value: 'falling', label: 'Falling' },
          { value: 'both', label: 'Both' }
        ]
      }
    ]
  }
}
