/**
 * Daisy emitter table — the assembly point.
 *
 * The per-kind emitters used to live here in one 3,600-line file. They now
 * sit in `emitters/`, split along the SAME thematic lines as the node
 * definitions in `nodes/defs.<group>.ts`, so parallel work on two unrelated
 * groups no longer collides on one file and finding an emitter no longer
 * means scrolling past sixty others.
 *
 * This module keeps three things:
 *   - the `EmitContext` / `NodeEmitter` contract, re-exported so the ~15
 *     existing importers do not move,
 *   - `setParamOverrides`, the hook that lets a menu leaf drive a param,
 *   - the dispatch table itself, which is the one place that has to know
 *     every kind and is therefore worth reading top to bottom.
 *
 * Adding a kind: write the emitter in the matching `emitters/<group>.ts`,
 * export it, and add a line below. See CLAUDE.md for the other four places.
 */

export type { EmitContext, NodeEmitter } from './emitters/shared'
export { setParamOverrides, setSampleInfo } from './emitters/shared'

import type { NodeKind } from '@/types/graph'
import type { NodeEmitter } from './emitters/shared'

import {
  bitcrush,
  chorus,
  compressor,
  delay,
  flanger,
  freezeClean,
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
} from './emitters/effects'
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
} from './emitters/envelopes'
import {
  filter_moog,
  filter_svf,
  formant
} from './emitters/filters'
import {
  audio_in,
  audio_output,
  button,
  compass_in,
  distance_in,
  encoder_in,
  gate_in,
  i2s_in,
  i2s_out,
  imu_in,
  knob_in,
  led,
  menu,
  midi_in_cc,
  midi_in_note,
  midi_out_note,
  switch_3way
} from './emitters/hardware'
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
} from './emitters/math'
import {
  code,
  expression,
  poly,
  preset_recall,
  printNode,
  sub_in,
  sub_out,
  subpatch,
  voice_id
} from './emitters/scripting'
import {
  arp,
  clockNode,
  clock_divider,
  dust,
  euclidean,
  randomNode,
  step_seq
} from './emitters/sequencing'
import {
} from './emitters/shared'
import {
  constant,
  drum_hat,
  drum_kick,
  drum_snare,
  fm2,
  fm_op_clean,
  karplus,
  lfo,
  noise,
  oscillator,
  sample_player,
  wavetable
} from './emitters/synthesis'
import {
  oled,
  visualPassthrough
} from './emitters/visual'
import {
  logic,
  toggle,
  counter,
  timer,
  state_machine,
  select,
  edge
} from './emitters/logic'

export const NODE_EMITTERS: Partial<Record<NodeKind, NodeEmitter>> = {
  // Sources
  oscillator,
  noise,
  lfo,
  constant,
  karplus,
  fm_op: fm_op_clean,
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
  // Sequencing
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
  freeze: freezeClean,
  granulator,
  pitch_shifter,
  tremolo,
  vibrato,
  // Dynamics
  compressor,
  limiter,
  noise_gate,
  // Visual
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
  i2s_in,
  i2s_out,
  // MIDI
  midi_in_note,
  midi_in_cc,
  midi_out_note,
  // Scripting / debug
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
  expression,
  print: printNode
}
