/**
 * ESP32 emitter table — the assembly point.
 *
 * Mirrors `nodeEmitters.ts` exactly: the per-kind emitters live in
 * `emittersEsp32/`, split along the same thematic lines as the Daisy ones
 * and as `nodes/defs.<group>.ts`, so the two targets stay easy to compare
 * group by group. That comparability is the point — `scripts/codegen-contract.mjs`
 * asserts the two tables agree on what each kind produces, and a reviewer
 * checking why they differ should be able to open the two matching files
 * side by side rather than scroll two 3,000-line ones.
 *
 * Adding a kind: write the emitter in the matching `emittersEsp32/<group>.ts`,
 * export it, and add a line below.
 */

export { setParamOverridesEsp32, setSampleInfo as setSampleInfoEsp32 } from './emittersEsp32/shared'

import type { NodeKind } from '@/types/graph'
import type { NodeEmitter } from './nodeEmitters'

import {
  bitcrush,
  chorus,
  compressor,
  delay,
  flanger,
  freeze,
  granulator,
  limiter,
  noise_gate,
  overdrive,
  phaser,
  ping_pong,
  pitch_shifter,
  reverb,
  stereo_widener,
  tremolo,
  vibrato
} from './emittersEsp32/effects'
import {
  adsr,
  ar,
  comparator,
  envelope_follower,
  inverter,
  rangeNode,
  sample_hold,
  scaleNode,
  slew
} from './emittersEsp32/envelopes'
import {
  filter_moog,
  filter_svf,
  formant
} from './emittersEsp32/filters'
import {
  audio_in,
  audio_output,
  button,
  compass_in,
  distance_in,
  encoder_in,
  gate_in,
  imu_in,
  knob_in,
  led,
  menu,
  midi_in_cc,
  midi_in_note,
  midi_out_note,
  switch_3way
} from './emittersEsp32/hardware'
import {
  clip,
  crossfade,
  gain,
  mixer4,
  multiplyNode,
  pan,
  ring_mod,
  sumNode,
  vca,
  wavefolder
} from './emittersEsp32/math'
import {
  code,
  poly,
  preset_recall,
  printNode,
  sub_in,
  sub_out,
  subpatch,
  voice_id
} from './emittersEsp32/scripting'
import {
  arp,
  clockNode,
  clock_divider,
  dust,
  euclidean,
  randomNode,
  step_seq
} from './emittersEsp32/sequencing'
import {
  unsupported
} from './emittersEsp32/shared'
import {
  constant,
  drum_hat,
  drum_kick,
  drum_snare,
  fm2,
  fm_op,
  karplus,
  lfo,
  noise,
  oscillator,
  sample_player,
  wavetable
} from './emittersEsp32/synthesis'
import {
  oled,
  visualPassthrough
} from './emittersEsp32/visual'
import {
  logic,
  toggle,
  counter,
  timer,
  state_machine,
  select,
  edge
} from './emittersEsp32/logic'

export const ESP32_NODE_EMITTERS: Partial<Record<NodeKind, NodeEmitter>> = {
  // Sources
  oscillator,
  noise,
  lfo,
  constant,
  karplus,
  fm_op,
  fm2,
  wavetable,
  drum_kick,
  drum_snare,
  drum_hat,
  // Utility
  gain,
  vca,
  mixer4,
  pan,
  clip,
  sum: sumNode,
  multiply: multiplyNode,
  crossfade,
  ring_mod,
  wavefolder,
  // Filters
  filter_svf,
  filter_moog,
  formant,
  // Envelopes
  adsr,
  ar,
  envelope_follower,
  // CV
  slew,
  sample_hold,
  inverter,
  scale: scaleNode,
  range: rangeNode,
  comparator,
  // Sequencing / clock
  clock: clockNode,
  clock_divider,
  step_seq,
  euclidean,
  random: randomNode,
  dust,
  arp,
  // Effects
  delay,
  reverb,
  overdrive,
  chorus,
  bitcrush,
  phaser,
  flanger,
  ping_pong,
  stereo_widener,
  freeze,
  granulator,
  pitch_shifter,
  tremolo,
  vibrato,
  // Dynamics
  compressor,
  limiter,
  noise_gate,
  // Visual — no-op
  scope: visualPassthrough,
  vu: visualPassthrough,
  spectrum_scope: visualPassthrough,
  oled,
  // Hardware I/O
  audio_in,
  audio_output,
  knob_in,
  gate_in,
  button,
  led,
  switch_3way,
  encoder_in,
  menu,
  imu_in,
  compass_in,
  distance_in,
  i2s_in: unsupported('i2s_in', 'use audio_in / I2S codec binding instead'),
  i2s_out: unsupported('i2s_out', 'use audio_output — I2S is the default sink'),
  // MIDI
  midi_in_note,
  midi_in_cc,
  midi_out_note,
  // Scripting
  code,
  // Structural — flattened away before codegen; see subpatch.ts.
  subpatch,
  sub_in,
  sub_out,
  poly,
  voice_id,
  preset_recall,
  sample_player,
  logic,
  toggle,
  counter,
  timer,
  state_machine,
  select,
  edge,
  expression: unsupported(
    'expression',
    'expression parser reuses Daisy emitter; port pending'
  ),
  print: printNode
}

