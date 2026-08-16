/**
 * Canonical graph representation. Source of truth for the store, the Rete
 * editor, and the audio engine. Keep it serializable — no class instances,
 * no functions — so it round-trips through JSON.
 *
 * Adding a new node kind: extend `NodeKind`, add a `NodeDefinition` to
 * the matching partial in `src/nodes/defs.*.ts` (or directly to
 * `src/nodes/definitions.ts` for the core set), add a worklet module to
 * `src/audio/worklets/`, and register it in the matching registry partial.
 */

import type { SignalKind } from '@/theme'

export type NodeKind =
  // ---- Sources ----
  | 'oscillator'
  | 'noise'
  | 'lfo'
  | 'constant'
  | 'karplus'
  | 'fm_op'
  | 'fm2'
  | 'wavetable'
  | 'drum_kick'
  | 'drum_snare'
  | 'drum_hat'
  // ---- Amp / utility ----
  | 'gain'
  | 'vca'
  | 'mixer4'
  | 'pan'
  | 'clip'
  | 'sum'
  | 'multiply'
  | 'crossfade'
  | 'ring_mod'
  | 'wavefolder'
  // ---- Filters ----
  | 'filter_svf'
  | 'filter_moog'
  | 'formant'
  // ---- Envelopes ----
  | 'adsr'
  | 'ar'
  | 'envelope_follower'
  // ---- CV tools ----
  | 'slew'
  | 'sample_hold'
  | 'inverter'
  | 'scale'
  | 'range'
  | 'comparator'
  // ---- Sequencing / clock ----
  | 'clock'
  | 'clock_divider'
  | 'step_seq'
  | 'euclidean'
  | 'random'
  | 'dust'
  | 'arp'
  // ---- Effects ----
  | 'delay'
  | 'reverb'
  | 'overdrive'
  | 'chorus'
  | 'bitcrush'
  | 'phaser'
  | 'flanger'
  | 'ping_pong'
  | 'stereo_widener'
  | 'freeze'
  | 'granulator'
  | 'pitch_shifter'
  | 'tremolo'
  | 'vibrato'
  // ---- Dynamics ----
  | 'compressor'
  | 'limiter'
  | 'noise_gate'
  // ---- Visual ----
  | 'scope'
  | 'vu'
  | 'spectrum_scope'
  // ---- Hardware I/O ----
  | 'audio_in'
  | 'audio_output'
  | 'knob_in'
  | 'gate_in'
  | 'button'
  | 'led'
  | 'switch_3way'
  | 'encoder_in'
  | 'menu'
  // I2C sensors. One node per placed sensor component; each fans its axes
  // out as separate CV outputs rather than making you place three nodes.
  | 'imu_in'
  | 'compass_in'
  | 'distance_in'
  | 'i2s_in'
  | 'i2s_out'
  | 'midi_in_note'
  | 'midi_in_cc'
  | 'midi_out_note'
  | 'oled'
  // ---- Logic / debug / scripting ----
  // The escape hatch: a node whose body the user writes. Runs in the
  // emulator AND compiles to firmware — see codegen/codeNode/.
  | 'code'
  // Nesting. Flattened away before codegen or the engine ever see them —
  // see state/subpatch.ts.
  | 'subpatch'
  | 'sub_in'
  | 'sub_out'
  // Voice stacking: N copies of a body, summed. Also flattened away.
  | 'poly'
  | 'preset_recall'
  | 'sample_player'
  // Logic layer — see nodes/defs.logic.ts.
  | 'logic'
  | 'toggle'
  | 'counter'
  | 'timer'
  | 'state_machine'
  | 'select'
  | 'edge'
  | 'voice_id'
  | 'expression'
  | 'print'

export interface Socket {
  id: string
  label: string
  signal: SignalKind
}

export interface NodeInstance {
  id: string
  kind: NodeKind
  position: { x: number; y: number }
  params: Record<string, number | string>
  /**
   * Per-node view flag — true when the node is rendered in its compact
   * header-only form. Optional so older patches load as expanded (the
   * default). Pure view state, but still a property of the graph so
   * undo/redo can restore it alongside other edits.
   */
  collapsed?: boolean
}

export interface Connection {
  id: string
  from: { nodeId: string; socketId: string }
  to: { nodeId: string; socketId: string }
}

export interface AudioGraph {
  nodes: NodeInstance[]
  connections: Connection[]
  meta: {
    name: string
    sampleRate: number
    blockSize: number
    /** One line on what the patch is. Optional; shown in the examples picker. */
    description?: string
  }
}

export function emptyGraph(): AudioGraph {
  return {
    nodes: [],
    connections: [],
    meta: { name: 'untitled', sampleRate: 48000, blockSize: 48 }
  }
}
