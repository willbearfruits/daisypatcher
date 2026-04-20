/**
 * Static CPU estimator for the Daisy Seed. Each NodeKind has a rough
 * "cost point" based on its DSP weight; summed across the graph and
 * divided by a conservative budget, we get a 0..1 estimate shown in the
 * status bar. This is a guide, not a measurement — the goal is to warn
 * before the user flashes a patch that will glitch.
 */

import type { AudioGraph, NodeKind } from '@/types/graph'

export const KIND_COST: Partial<Record<NodeKind, number>> = {
  oscillator: 1.2,
  noise: 0.5,
  lfo: 0.6,
  constant: 0.05,
  gain: 0.1,
  vca: 0.4,
  mixer4: 0.6,
  pan: 0.4,
  clip: 0.4,
  sum: 0.3,
  multiply: 0.2,
  crossfade: 0.4,
  ring_mod: 0.3,
  wavefolder: 0.5,
  filter_svf: 1.8,
  filter_moog: 2.4,
  formant: 2.2,
  adsr: 0.5,
  ar: 0.3,
  envelope_follower: 0.4,
  slew: 0.2,
  sample_hold: 0.2,
  inverter: 0.1,
  scale: 0.1,
  comparator: 0.2,
  clock: 0.3,
  clock_divider: 0.2,
  step_seq: 0.4,
  euclidean: 0.3,
  random: 0.4,
  dust: 0.3,
  arp: 0.8,
  delay: 2.0,
  reverb: 4.5,
  overdrive: 0.8,
  chorus: 2.0,
  bitcrush: 0.5,
  phaser: 2.2,
  flanger: 1.8,
  ping_pong: 2.5,
  stereo_widener: 0.8,
  freeze: 1.0,
  granulator: 4.0,
  pitch_shifter: 3.0,
  tremolo: 0.4,
  vibrato: 0.8,
  compressor: 1.5,
  limiter: 1.2,
  noise_gate: 0.8,
  scope: 0.5,
  vu: 0.4,
  spectrum_scope: 1.5,
  karplus: 2.5,
  fm_op: 1.5,
  fm2: 2.2,
  wavetable: 1.8,
  drum_kick: 1.2,
  drum_snare: 1.6,
  drum_hat: 1.8,
  audio_in: 0.3,
  audio_output: 0.3,
  knob_in: 0.2,
  gate_in: 0.2,
  button: 0.1,
  led: 0.1,
  switch_3way: 0.1,
  i2s_in: 0.4,
  i2s_out: 0.4,
  midi_in_note: 0.3,
  midi_in_cc: 0.2,
  midi_out_note: 0.3,
  oled: 1.5,
  expression: 0.6,
  print: 0.1
}

/** Fallback cost for kinds not in the table. */
export const FALLBACK_COST = 1.0

/** Budget in cost points. ~60 is Seed's rough ceiling before glitches. */
export const CPU_BUDGET = 60

/** Returns 0..1 estimate of Daisy Seed's ~100% budget. */
export function estimateCpu(graph: AudioGraph): number {
  const sum = graph.nodes.reduce((n, node) => n + (KIND_COST[node.kind] ?? FALLBACK_COST), 0)
  return Math.min(1, sum / CPU_BUDGET)
}

/** Top N nodes by cost, for the status-bar tooltip. */
export function topCostNodes(
  graph: AudioGraph,
  limit = 5
): { kind: NodeKind; cost: number }[] {
  const sorted = graph.nodes
    .map((n) => ({ kind: n.kind, cost: KIND_COST[n.kind] ?? FALLBACK_COST }))
    .sort((a, b) => b.cost - a.cost)
  return sorted.slice(0, limit)
}
