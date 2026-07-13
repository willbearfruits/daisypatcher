/**
 * Test-rig graph generator — builds a tiny, self-contained `AudioGraph`
 * that exercises a single node kind on real Daisy Seed hardware. The
 * inspector's "Test" button runs this, pipes the result through the
 * existing compile/flash pipeline, and asks the user to listen and vote
 * pass / fail / skip.
 *
 * Strategy: look at `NODE_DEFINITIONS[kind]` — category + IO socket shape
 * — and pick a template. For each node kind we hand-tune a stimulus
 * (noise / sine / gate / clock / lfo / impulse / none) plus a minimal
 * observation point (audio_output for ears, scope for eyes).
 *
 * Returning `null` means "no test template for this node yet" — the
 * inspector disables the button with a tooltip. We return `null` for
 * anything that's UI-only (scope/vu/spectrum) or hardware-only
 * (knob_in/button/led/midi/i2s/oled/etc.) since those test themselves
 * when the physical component is present.
 *
 * All generated graphs target daisy_seed via `emptyHardwareLayout()` —
 * the pipeline writes those through codegen unchanged.
 */

import { nanoid } from 'nanoid'
import type {
  AudioGraph,
  Connection,
  NodeInstance,
  NodeKind,
  Socket
} from '@/types/graph'
import { emptyGraph } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import { emptyHardwareLayout } from '@/types/hardware'
import { NODE_DEFINITIONS } from '@/nodes/definitions'

export type StimulusKind =
  | 'noise'
  | 'sine'
  | 'gate'
  | 'impulse'
  | 'clock'
  | 'lfo'
  | 'none'

export interface TestGraph {
  graph: AudioGraph
  hardware: HardwareLayout
  stimulus: StimulusKind
  description: string
}

/**
 * Kinds that are either UI-only visualisers or hardware-bound. The
 * inspector disables the Test button for these (they'd either produce
 * nothing audible OR they test themselves when the physical thing is
 * wired).
 */
const UI_ONLY_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'scope',
  'vu',
  'spectrum_scope'
])

const HARDWARE_BOUND_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'knob_in',
  'button',
  'led',
  'switch_3way',
  'gate_in',
  'i2s_in',
  'i2s_out',
  'oled',
  'midi_in_note',
  'midi_in_cc',
  'midi_out_note',
  'audio_in',
  'audio_output'
])

/**
 * Public predicate — the inspector uses this to enable/disable the
 * "Test" button without actually generating a graph. If this returns
 * false, `buildTestGraph(kind)` returns null.
 */
export function hasTestTemplate(kind: NodeKind): boolean {
  if (UI_ONLY_KINDS.has(kind)) return false
  if (HARDWARE_BOUND_KINDS.has(kind)) return false
  return NODE_DEFINITIONS[kind] !== undefined
}

/**
 * Reason string for the tooltip on disabled Test buttons. Surfaced by
 * the inspector so the user understands WHY they can't test a kind.
 */
export function disabledReasonFor(kind: NodeKind): string {
  if (UI_ONLY_KINDS.has(kind)) {
    return 'Visual-only node — no hardware test needed'
  }
  if (HARDWARE_BOUND_KINDS.has(kind)) {
    return 'Hardware-bound node — tests itself when the physical component is wired'
  }
  if (!NODE_DEFINITIONS[kind]) {
    return 'Unknown node kind'
  }
  return 'No test template for this node yet — please verify manually'
}

/* ---------- small helpers used by every template ---------- */

function paramDefaults(kind: NodeKind): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const p of NODE_DEFINITIONS[kind].params) out[p.id] = p.default
  return out
}

function makeNode(
  kind: NodeKind,
  position: { x: number; y: number },
  overrides?: Record<string, number | string>
): NodeInstance {
  const params = paramDefaults(kind)
  if (overrides) Object.assign(params, overrides)
  return { id: nanoid(8), kind, position, params }
}

function makeConn(
  from: { nodeId: string; socketId: string },
  to: { nodeId: string; socketId: string }
): Connection {
  return { id: nanoid(8), from, to }
}

/** First input socket matching the requested signal kind. */
function findInput(def: NodeKind, signal: Socket['signal']): Socket | null {
  const sockets = NODE_DEFINITIONS[def].inputs
  return sockets.find((s) => s.signal === signal) ?? null
}

function findOutput(def: NodeKind, signal: Socket['signal']): Socket | null {
  const sockets = NODE_DEFINITIONS[def].outputs
  return sockets.find((s) => s.signal === signal) ?? null
}

/**
 * Find an interesting cv input to sweep. Preferred ids are cutoff, rate,
 * drive, time, depth, fold, morph — in that order. Falls back to the
 * first `cv` input. Returns null if the node has no cv input.
 */
function findSweepCvInput(kind: NodeKind): Socket | null {
  const prefer = [
    'cv_cutoff',
    'freq_cv',
    'cv_rate',
    'rate_cv',
    'cv_drive',
    'cv_time',
    'time_cv',
    'cv_depth',
    'cv_fold',
    'fold_cv',
    'cv_morph',
    'morph_cv',
    'cv_mix',
    'cv_feedback',
    'cv_bits',
    'cv_pitch',
    'cv_size',
    'cv_damp',
    'cv_threshold',
    'cv_grain_size',
    'cv_density'
  ]
  const inputs = NODE_DEFINITIONS[kind].inputs
  for (const id of prefer) {
    const hit = inputs.find((s) => s.id === id && s.signal === 'cv')
    if (hit) return hit
  }
  return inputs.find((s) => s.signal === 'cv') ?? null
}

/**
 * Shape summary — used to pick a template when category is ambiguous.
 */
interface Shape {
  audioIn: number
  cvIn: number
  gateIn: number
  audioOut: number
  cvOut: number
  gateOut: number
  hasTrigger: boolean
  hasGate: boolean
  hasClock: boolean
}

function shapeOf(kind: NodeKind): Shape {
  const def = NODE_DEFINITIONS[kind]
  const shape: Shape = {
    audioIn: 0,
    cvIn: 0,
    gateIn: 0,
    audioOut: 0,
    cvOut: 0,
    gateOut: 0,
    hasTrigger: false,
    hasGate: false,
    hasClock: false
  }
  for (const s of def.inputs) {
    if (s.signal === 'audio') shape.audioIn++
    else if (s.signal === 'cv') shape.cvIn++
    else if (s.signal === 'gate') shape.gateIn++
    if (s.id === 'trigger') shape.hasTrigger = true
    if (s.id === 'gate' || s.id === 'gate_in') shape.hasGate = true
    if (s.id === 'clock' || s.id === 'clk') shape.hasClock = true
  }
  for (const s of def.outputs) {
    if (s.signal === 'audio') shape.audioOut++
    else if (s.signal === 'cv') shape.cvOut++
    else if (s.signal === 'gate') shape.gateOut++
  }
  return shape
}

/* ---------- template builders ----------
 *
 * Each builder returns a ready-to-compile `TestGraph`. They share a
 * "scene" idiom: allocate nodes, wire them, return the assembled graph.
 * Layout positions are cosmetic only — codegen ignores them, but we
 * lay them out left-to-right so any debug dump is readable.
 */

function audioOutput(position: { x: number; y: number }): NodeInstance {
  return makeNode('audio_output', position)
}

/** Source-kind: node → audio_output (mono → stereo-duplicated). */
function templateSourceAudio(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const src = makeNode(kind, { x: 100, y: 200 })
  nodes.push(src)

  // For drum/karplus that need a trigger, spawn a ~2Hz clock.
  let stimulus: StimulusKind = 'none'
  const triggerSocket = NODE_DEFINITIONS[kind].inputs.find(
    (s) => s.id === 'trigger' && s.signal === 'gate'
  )
  if (triggerSocket) {
    const clock = makeNode('clock', { x: -120, y: 200 }, { bpm: 120 })
    nodes.push(clock)
    connections.push(
      makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: src.id, socketId: triggerSocket.id })
    )
    stimulus = 'clock'
  }

  const out = audioOutput({ x: 400, y: 200 })
  nodes.push(out)

  const audioOutSocket = findOutput(kind, 'audio')
  if (audioOutSocket) {
    // stereo-duplicate the mono source
    connections.push(
      makeConn(
        { nodeId: src.id, socketId: audioOutSocket.id },
        { nodeId: out.id, socketId: 'left' }
      )
    )
    connections.push(
      makeConn(
        { nodeId: src.id, socketId: audioOutSocket.id },
        { nodeId: out.id, socketId: 'right' }
      )
    )
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus,
    description:
      stimulus === 'clock'
        ? `Clock at 120 BPM triggers ${labelFor(kind)} into the audio output.`
        : `${labelFor(kind)} runs into the audio output.`
  }
}

/** Source-CV-only — route into scope for visual verification. */
function templateSourceCv(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const src = makeNode(kind, { x: 100, y: 200 })
  nodes.push(src)

  let stimulus: StimulusKind = 'none'
  const clockInput = NODE_DEFINITIONS[kind].inputs.find(
    (s) => s.id === 'clock' || s.id === 'clk'
  )
  if (clockInput) {
    const clock = makeNode('clock', { x: -120, y: 200 }, { bpm: 120 })
    nodes.push(clock)
    connections.push(
      makeConn(
        { nodeId: clock.id, socketId: 'out' },
        { nodeId: src.id, socketId: clockInput.id }
      )
    )
    stimulus = 'clock'
  }

  const scope = makeNode('scope', { x: 400, y: 200 })
  nodes.push(scope)

  const cvOut = findOutput(kind, 'cv') ?? findOutput(kind, 'gate')
  if (cvOut) {
    // scope's input is audio-typed but the store-level type check lets
    // cv/gate flow through it as long as signal-kind matches; scope
    // expects audio so we skip the connection on mismatch — the test
    // will still build, just without a visual. To avoid rejection we
    // hand-craft a gain/vca-into-output path when the node is gate-only.
    // For now, if types mismatch, the generated graph won't wire to the
    // scope; the user still hears silence + sees no output which fails
    // gracefully.
  }

  // For gate outputs we can't connect to scope (audio-in only). Instead
  // route into a sine-oscillator's amp CV so gate pulses become audible
  // clicks at the output — keeps the test audible AND the graph valid.
  const gateOut = findOutput(kind, 'gate')
  if (gateOut && !findOutput(kind, 'cv')) {
    const osc = makeNode('oscillator', { x: 400, y: 200 }, { frequency: 440, amplitude: 0.5 })
    const vca = makeNode('vca', { x: 600, y: 200 })
    const out = audioOutput({ x: 800, y: 200 })
    nodes.splice(nodes.indexOf(scope), 1) // drop scope — replaced
    nodes.push(osc, vca, out)

    connections.push(
      makeConn({ nodeId: osc.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
    )
    connections.push(
      makeConn({ nodeId: src.id, socketId: gateOut.id }, { nodeId: vca.id, socketId: 'cv' })
    )
    connections.push(
      makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
    )

    return {
      graph: assembleGraph(nodes, connections, `test-${kind}`),
      hardware: emptyHardwareLayout('daisy_seed'),
      stimulus: stimulus === 'none' ? 'none' : stimulus,
      description: `${labelFor(kind)} gate output keyed into a VCA(sine) — pulses become audible clicks.`
    }
  }

  const cvOutput = findOutput(kind, 'cv')
  if (cvOutput) {
    connections.push(
      makeConn(
        { nodeId: src.id, socketId: cvOutput.id },
        { nodeId: scope.id, socketId: 'in' }
      )
    )
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus,
    description:
      stimulus === 'clock'
        ? `Clock drives ${labelFor(kind)}, output displayed on scope.`
        : `${labelFor(kind)} CV output displayed on scope.`
  }
}

/** Audio-process: noise → node → out; LFO sweeping an interesting CV. */
function templateAudioProcess(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const noise = makeNode('noise', { x: -100, y: 200 }, { amplitude: 0.3 })
  const node = makeNode(kind, { x: 200, y: 200 })
  const out = audioOutput({ x: 500, y: 200 })
  nodes.push(noise, node, out)

  const audioIn = findInput(kind, 'audio')
  const audioOut = findOutput(kind, 'audio')

  if (audioIn) {
    connections.push(
      makeConn({ nodeId: noise.id, socketId: 'out' }, { nodeId: node.id, socketId: audioIn.id })
    )
  }
  if (audioOut) {
    // Stereo-duplicate. Nodes with stereo L/R outputs handled by the
    // stereo variant below.
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'right' })
    )
  }

  // Optional: LFO → range → sweep-CV to make behavior audible without the
  // user touching knobs.
  let stimulus: StimulusKind = 'noise'
  const sweepIn = findSweepCvInput(kind)
  let sweepNote = ''
  if (sweepIn) {
    const lfo = makeNode('lfo', { x: -100, y: 380 }, { frequency: 0.5, depth: 1, offset: 0 })
    const range = makeNode('range', { x: 100, y: 380 }, {
      in_min: -1,
      in_max: 1,
      out_min: 0,
      out_max: 1
    })
    nodes.push(lfo, range)
    connections.push(
      makeConn({ nodeId: lfo.id, socketId: 'out' }, { nodeId: range.id, socketId: 'in' })
    )
    connections.push(
      makeConn(
        { nodeId: range.id, socketId: 'out' },
        { nodeId: node.id, socketId: sweepIn.id }
      )
    )
    stimulus = 'lfo'
    sweepNote = `, LFO sweeping ${sweepIn.label}`
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus,
    description: `Noise → ${labelFor(kind)} → output${sweepNote}.`
  }
}

/** Stereo L/R audio-out process (ping_pong, stereo_widener, pan). */
function templateStereoProcess(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const noise = makeNode('noise', { x: -100, y: 200 }, { amplitude: 0.3 })
  const node = makeNode(kind, { x: 200, y: 200 })
  const out = audioOutput({ x: 500, y: 200 })
  nodes.push(noise, node, out)

  const audioIn = findInput(kind, 'audio')
  if (audioIn) {
    connections.push(
      makeConn({ nodeId: noise.id, socketId: 'out' }, { nodeId: node.id, socketId: audioIn.id })
    )
  }

  // Stereo L/R outputs — wire them directly.
  const lOut = NODE_DEFINITIONS[kind].outputs.find((s) => s.id === 'left')
  const rOut = NODE_DEFINITIONS[kind].outputs.find((s) => s.id === 'right')
  if (lOut && rOut) {
    connections.push(
      makeConn({ nodeId: node.id, socketId: lOut.id }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: node.id, socketId: rOut.id }, { nodeId: out.id, socketId: 'right' })
    )
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'noise',
    description: `Noise → ${labelFor(kind)} → stereo output.`
  }
}

/** VCA / gain kinds: sine osc → node → output; optional AR if node has CV. */
function templateVca(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const sine = makeNode(
    'oscillator',
    { x: -200, y: 200 },
    { frequency: 220, amplitude: 0.5, waveform: 'sine' }
  )
  const node = makeNode(kind, { x: 150, y: 200 })
  const out = audioOutput({ x: 500, y: 200 })
  nodes.push(sine, node, out)

  const audioIn = findInput(kind, 'audio')
  const audioOut = findOutput(kind, 'audio')

  if (audioIn) {
    connections.push(
      makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: node.id, socketId: audioIn.id })
    )
  }
  if (audioOut) {
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'right' })
    )
  }

  // VCA-flavoured kinds accept a CV to modulate amplitude. Wire an AR
  // envelope so the output pulses audibly at ~1 Hz — no knob twiddling.
  let stimulus: StimulusKind = 'sine'
  let extra = ''
  const cvIn = findInput(kind, 'cv')
  if (cvIn && (kind === 'vca' || kind === 'gain')) {
    const clock = makeNode('clock', { x: -400, y: 360 }, { bpm: 60 })
    const ar = makeNode(
      'ar',
      { x: -200, y: 360 },
      { attack: 0.01, release: 0.4 }
    )
    nodes.push(clock, ar)
    connections.push(
      makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: ar.id, socketId: 'gate' })
    )
    connections.push(
      makeConn({ nodeId: ar.id, socketId: 'out' }, { nodeId: node.id, socketId: cvIn.id })
    )
    stimulus = 'gate'
    extra = ', AR envelope pulses the amplitude'
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus,
    description: `Sine 220 Hz → ${labelFor(kind)} → output${extra}.`
  }
}

/** clip / wavefolder / ring_mod-audio / overdrive — audio-in, audio-out. */
function templateSaturator(kind: NodeKind): TestGraph {
  // Basically the audio-process template but with a sine source (so the
  // waveform shape change is audible against a pure tone).
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const sine = makeNode(
    'oscillator',
    { x: -200, y: 200 },
    { frequency: 220, amplitude: 0.7, waveform: 'sine' }
  )
  const node = makeNode(kind, { x: 150, y: 200 })
  const out = audioOutput({ x: 500, y: 200 })
  nodes.push(sine, node, out)

  const audioIn = findInput(kind, 'audio')
  const audioOut = findOutput(kind, 'audio')
  if (audioIn) {
    connections.push(
      makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: node.id, socketId: audioIn.id })
    )
  }
  if (audioOut) {
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'right' })
    )
  }

  // Sweep the drive/fold CV if present.
  let stimulus: StimulusKind = 'sine'
  let extra = ''
  const sweepIn = findSweepCvInput(kind)
  if (sweepIn) {
    const lfo = makeNode('lfo', { x: -200, y: 380 }, { frequency: 0.3, depth: 1 })
    const range = makeNode(
      'range',
      { x: -20, y: 380 },
      { in_min: -1, in_max: 1, out_min: 0, out_max: 1 }
    )
    nodes.push(lfo, range)
    connections.push(
      makeConn({ nodeId: lfo.id, socketId: 'out' }, { nodeId: range.id, socketId: 'in' })
    )
    connections.push(
      makeConn({ nodeId: range.id, socketId: 'out' }, { nodeId: node.id, socketId: sweepIn.id })
    )
    stimulus = 'lfo'
    extra = `, LFO sweeping ${sweepIn.label}`
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus,
    description: `Sine → ${labelFor(kind)} → output${extra}.`
  }
}

/** Sum/multiply/crossfade/mixer — 2+ audio inputs, 1 audio output. */
function templateMixerLike(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const sine1 = makeNode(
    'oscillator',
    { x: -200, y: 120 },
    { frequency: 220, amplitude: 0.3, waveform: 'sine' }
  )
  const sine2 = makeNode(
    'oscillator',
    { x: -200, y: 280 },
    { frequency: 330, amplitude: 0.3, waveform: 'sine' }
  )
  const node = makeNode(kind, { x: 150, y: 200 })
  const out = audioOutput({ x: 500, y: 200 })
  nodes.push(sine1, sine2, node, out)

  const audioIns = NODE_DEFINITIONS[kind].inputs.filter((s) => s.signal === 'audio')
  if (audioIns[0]) {
    connections.push(
      makeConn({ nodeId: sine1.id, socketId: 'out' }, { nodeId: node.id, socketId: audioIns[0].id })
    )
  }
  if (audioIns[1]) {
    connections.push(
      makeConn({ nodeId: sine2.id, socketId: 'out' }, { nodeId: node.id, socketId: audioIns[1].id })
    )
  }

  const audioOut = findOutput(kind, 'audio')
  if (audioOut) {
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: node.id, socketId: audioOut.id }, { nodeId: out.id, socketId: 'right' })
    )
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'sine',
    description: `Two sines (220 Hz + 330 Hz) → ${labelFor(kind)} → output.`
  }
}

/** Envelope (gate-driven): clock → node → VCA(sine) → output. */
function templateEnvelope(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const clock = makeNode('clock', { x: -300, y: 200 }, { bpm: 120 })
  const env = makeNode(kind, { x: -50, y: 200 })
  const sine = makeNode(
    'oscillator',
    { x: -300, y: 360 },
    { frequency: 440, amplitude: 0.5, waveform: 'sine' }
  )
  const vca = makeNode('vca', { x: 150, y: 280 })
  const out = audioOutput({ x: 450, y: 280 })
  nodes.push(clock, env, sine, vca, out)

  // Clock → env.gate
  const gateIn = NODE_DEFINITIONS[kind].inputs.find((s) => s.id === 'gate' && s.signal === 'gate')
  if (gateIn) {
    connections.push(
      makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: env.id, socketId: gateIn.id })
    )
  }
  // Sine → vca.in, env.out → vca.cv, vca.out → output
  connections.push(
    makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
  )
  const envOut = findOutput(kind, 'cv')
  if (envOut) {
    connections.push(
      makeConn({ nodeId: env.id, socketId: envOut.id }, { nodeId: vca.id, socketId: 'cv' })
    )
  }
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
  )

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'gate',
    description: `Clock (120 BPM) → ${labelFor(kind)} → VCA(sine 440) → output.`
  }
}

/** envelope_follower — audio in, CV out; sweep VCA(sine) amp from noise. */
function templateEnvelopeFollower(): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const noise = makeNode('noise', { x: -300, y: 200 }, { amplitude: 0.4 })
  const env = makeNode('envelope_follower', { x: -50, y: 200 })
  const sine = makeNode(
    'oscillator',
    { x: -300, y: 360 },
    { frequency: 330, amplitude: 0.5, waveform: 'sine' }
  )
  const vca = makeNode('vca', { x: 200, y: 280 })
  const out = audioOutput({ x: 450, y: 280 })
  nodes.push(noise, env, sine, vca, out)

  connections.push(
    makeConn({ nodeId: noise.id, socketId: 'out' }, { nodeId: env.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: env.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'cv' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
  )

  return {
    graph: assembleGraph(nodes, connections, 'test-envelope_follower'),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'noise',
    description: 'Noise → envelope follower → VCA(sine 330) → output.'
  }
}

/** pan — audio in, L/R out. Sine in, LFO sweeping pan CV. */
function templatePan(): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const sine = makeNode(
    'oscillator',
    { x: -200, y: 200 },
    { frequency: 440, amplitude: 0.4, waveform: 'sine' }
  )
  const lfo = makeNode('lfo', { x: -200, y: 360 }, { frequency: 0.5, depth: 1, offset: 0 })
  const pan = makeNode('pan', { x: 150, y: 200 })
  const out = audioOutput({ x: 500, y: 200 })
  nodes.push(sine, lfo, pan, out)

  connections.push(
    makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: pan.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: lfo.id, socketId: 'out' }, { nodeId: pan.id, socketId: 'cv_pan' })
  )
  connections.push(
    makeConn({ nodeId: pan.id, socketId: 'left' }, { nodeId: out.id, socketId: 'left' })
  )
  connections.push(
    makeConn({ nodeId: pan.id, socketId: 'right' }, { nodeId: out.id, socketId: 'right' })
  )

  return {
    graph: assembleGraph(nodes, connections, 'test-pan'),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'lfo',
    description: 'Sine 440 → pan → stereo out, LFO 0.5 Hz sweeping pan.'
  }
}

/** CV-tool templates (slew, sample_hold, inverter, scale, range, comparator). */
function templateCvTool(kind: NodeKind): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const lfo = makeNode('lfo', { x: -200, y: 200 }, { frequency: 1, depth: 1, offset: 0 })
  const node = makeNode(kind, { x: 100, y: 200 })
  nodes.push(lfo, node)

  const cvIn = findInput(kind, 'cv')
  if (cvIn) {
    connections.push(
      makeConn({ nodeId: lfo.id, socketId: 'out' }, { nodeId: node.id, socketId: cvIn.id })
    )
  }

  // S&H needs a trigger — add a 3Hz clock.
  let stimulus: StimulusKind = 'lfo'
  const trig = NODE_DEFINITIONS[kind].inputs.find(
    (s) => s.id === 'trigger' && s.signal === 'gate'
  )
  if (trig) {
    const clock = makeNode('clock', { x: -200, y: 360 }, { bpm: 180 })
    nodes.push(clock)
    connections.push(
      makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: node.id, socketId: trig.id })
    )
    stimulus = 'clock'
  }

  // Comparator emits gate — observe by keying a VCA(sine) and listening.
  const gateOut = findOutput(kind, 'gate')
  if (gateOut) {
    const sine = makeNode(
      'oscillator',
      { x: 350, y: 360 },
      { frequency: 440, amplitude: 0.5, waveform: 'sine' }
    )
    const vca = makeNode('vca', { x: 500, y: 200 })
    const out = audioOutput({ x: 700, y: 200 })
    nodes.push(sine, vca, out)
    connections.push(
      makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
    )
    connections.push(
      makeConn({ nodeId: node.id, socketId: gateOut.id }, { nodeId: vca.id, socketId: 'cv' })
    )
    connections.push(
      makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
    )
    return {
      graph: assembleGraph(nodes, connections, `test-${kind}`),
      hardware: emptyHardwareLayout('daisy_seed'),
      stimulus,
      description: `LFO → ${labelFor(kind)}; gate out keys VCA(sine) to make activity audible.`
    }
  }

  // CV-output: scope it.
  const cvOut = findOutput(kind, 'cv')
  if (cvOut) {
    const scope = makeNode('scope', { x: 350, y: 200 })
    // scope's input is audio-typed in the def; signal-kind mismatch
    // would fail the connect() gate. We use a VCA(sine) path instead
    // to make the modulation audible.
    const sine = makeNode(
      'oscillator',
      { x: 350, y: 360 },
      { frequency: 220, amplitude: 0.5, waveform: 'sine' }
    )
    const vca = makeNode('vca', { x: 500, y: 280 })
    const out = audioOutput({ x: 700, y: 280 })
    nodes.push(scope, sine, vca, out)
    // don't wire scope — signal mismatch; we used it as a tap point but
    // the audible path below is what the user judges.
    connections.push(
      makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
    )
    connections.push(
      makeConn({ nodeId: node.id, socketId: cvOut.id }, { nodeId: vca.id, socketId: 'cv' })
    )
    connections.push(
      makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
    )
    connections.push(
      makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
    )
    // drop scope — kept only to enforce intent; remove from final list
    nodes.splice(nodes.indexOf(scope), 1)
    return {
      graph: assembleGraph(nodes, connections, `test-${kind}`),
      hardware: emptyHardwareLayout('daisy_seed'),
      stimulus,
      description: `LFO → ${labelFor(kind)} → VCA(sine 220) → output — modulation heard on the carrier.`
    }
  }

  return {
    graph: assembleGraph(nodes, connections, `test-${kind}`),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus,
    description: `LFO → ${labelFor(kind)}.`
  }
}

/** Sequencer — produces CV + gate; drive oscillator freq + VCA. */
function templateStepSeq(): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const clock = makeNode('clock', { x: -200, y: 200 }, { bpm: 240 })
  const seq = makeNode('step_seq', { x: 0, y: 200 }, {
    s1: -0.5,
    s2: -0.25,
    s3: 0,
    s4: 0.25,
    s5: 0.5,
    s6: 0.25,
    s7: 0,
    s8: -0.25
  })
  const osc = makeNode(
    'oscillator',
    { x: 250, y: 200 },
    { frequency: 220, amplitude: 0.5, waveform: 'saw' }
  )
  const vca = makeNode('vca', { x: 500, y: 280 })
  const out = audioOutput({ x: 750, y: 280 })
  nodes.push(clock, seq, osc, vca, out)

  connections.push(
    makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: seq.id, socketId: 'clock' })
  )
  connections.push(
    makeConn({ nodeId: seq.id, socketId: 'cv' }, { nodeId: osc.id, socketId: 'pitch_cv' })
  )
  connections.push(
    makeConn({ nodeId: osc.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: seq.id, socketId: 'gate' }, { nodeId: vca.id, socketId: 'cv' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
  )

  return {
    graph: assembleGraph(nodes, connections, 'test-step_seq'),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'clock',
    description: 'Clock (240 BPM) → step_seq → osc freq + VCA gate → output.'
  }
}

/** Arp — clock + gate in, cv + gate out. */
function templateArp(): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const clock = makeNode('clock', { x: -400, y: 200 }, { bpm: 240 })
  const constHi = makeNode('constant', { x: -400, y: 360 }, { value: 1 })
  const arp = makeNode('arp', { x: -150, y: 200 })
  const osc = makeNode(
    'oscillator',
    { x: 100, y: 200 },
    { frequency: 220, amplitude: 0.5, waveform: 'saw' }
  )
  const vca = makeNode('vca', { x: 350, y: 280 })
  const out = audioOutput({ x: 600, y: 280 })
  nodes.push(clock, constHi, arp, osc, vca, out)

  connections.push(
    makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: arp.id, socketId: 'clock' })
  )
  // constant is CV-typed but gate_in is gate-typed; skip the gate feed
  // (arp will still run its pattern if the worklet handles unconnected
  // gate as "always on", which it does per the kind's description).
  void constHi
  connections.push(
    makeConn({ nodeId: arp.id, socketId: 'cv' }, { nodeId: osc.id, socketId: 'pitch_cv' })
  )
  connections.push(
    makeConn({ nodeId: osc.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: arp.id, socketId: 'gate_out' }, { nodeId: vca.id, socketId: 'cv' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
  )

  return {
    graph: assembleGraph(nodes, connections, 'test-arp'),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'clock',
    description: 'Clock (240 BPM) → arp → osc freq + VCA gate → output.'
  }
}

/** clock_divider — clock in → divided gates; observe /4 through a VCA. */
function templateClockDivider(): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const clock = makeNode('clock', { x: -300, y: 200 }, { bpm: 240 })
  const div = makeNode('clock_divider', { x: -50, y: 200 })
  const sine = makeNode(
    'oscillator',
    { x: -300, y: 360 },
    { frequency: 440, amplitude: 0.5, waveform: 'sine' }
  )
  const vca = makeNode('vca', { x: 200, y: 280 })
  const out = audioOutput({ x: 450, y: 280 })
  nodes.push(clock, div, sine, vca, out)

  connections.push(
    makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: div.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: div.id, socketId: 'd4' }, { nodeId: vca.id, socketId: 'cv' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
  )

  return {
    graph: assembleGraph(nodes, connections, 'test-clock_divider'),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'clock',
    description: 'Clock (240 BPM) → ÷4 → VCA(sine) → output — slow pulses.'
  }
}

/** print — trigger on gate rising edge; just a sanity scaffolding. */
function templatePrint(): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const clock = makeNode('clock', { x: -200, y: 200 }, { bpm: 60 })
  const lfo = makeNode('lfo', { x: -200, y: 360 }, { frequency: 0.5, depth: 1 })
  const print = makeNode('print', { x: 50, y: 280 })
  nodes.push(clock, lfo, print)

  connections.push(
    makeConn({ nodeId: clock.id, socketId: 'out' }, { nodeId: print.id, socketId: 'trigger' })
  )
  connections.push(
    makeConn({ nodeId: lfo.id, socketId: 'out' }, { nodeId: print.id, socketId: 'value' })
  )

  return {
    graph: assembleGraph(nodes, connections, 'test-print'),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'clock',
    description: 'Clock fires print(lfo) once per second — watch the USB serial monitor.'
  }
}

/** expression — lfo→expression.a, expression.out→VCA(sine) amp. */
function templateExpression(): TestGraph {
  const nodes: NodeInstance[] = []
  const connections: Connection[] = []

  const lfo = makeNode('lfo', { x: -200, y: 200 }, { frequency: 0.5, depth: 1 })
  const expr = makeNode('expression', { x: 0, y: 200 }, { expr: 'a' })
  const sine = makeNode(
    'oscillator',
    { x: -200, y: 360 },
    { frequency: 330, amplitude: 0.5, waveform: 'sine' }
  )
  const vca = makeNode('vca', { x: 200, y: 280 })
  const out = audioOutput({ x: 450, y: 280 })
  nodes.push(lfo, expr, sine, vca, out)

  connections.push(
    makeConn({ nodeId: lfo.id, socketId: 'out' }, { nodeId: expr.id, socketId: 'a' })
  )
  connections.push(
    makeConn({ nodeId: sine.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'in' })
  )
  connections.push(
    makeConn({ nodeId: expr.id, socketId: 'out' }, { nodeId: vca.id, socketId: 'cv' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'left' })
  )
  connections.push(
    makeConn({ nodeId: vca.id, socketId: 'out' }, { nodeId: out.id, socketId: 'right' })
  )

  return {
    graph: assembleGraph(nodes, connections, 'test-expression'),
    hardware: emptyHardwareLayout('daisy_seed'),
    stimulus: 'lfo',
    description: 'LFO → expression(a) → VCA(sine 330) amp → output.'
  }
}

/* ---------- final helpers ---------- */

function assembleGraph(
  nodes: NodeInstance[],
  connections: Connection[],
  name: string
): AudioGraph {
  const base = emptyGraph()
  return {
    ...base,
    nodes,
    connections,
    meta: { ...base.meta, name }
  }
}

function labelFor(kind: NodeKind): string {
  return NODE_DEFINITIONS[kind]?.label ?? kind
}

/* ---------- dispatcher ---------- */

/**
 * Kinds that naturally emit stereo L/R — wire them directly to the
 * audio_output's left/right sockets.
 */
const STEREO_AUDIO_OUT: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'ping_pong',
  'stereo_widener'
])

const MIXER_LIKE: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'sum',
  'multiply',
  'crossfade',
  'mixer4',
  'ring_mod'
])

const SATURATORS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'clip',
  'wavefolder',
  'overdrive'
])

const VCA_LIKE: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'vca',
  'gain'
])

const ENVELOPES_GATED: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'adsr',
  'ar'
])

const CV_TOOLS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'slew',
  'sample_hold',
  'inverter',
  'scale',
  'range',
  'comparator'
])

export function buildTestGraph(kind: NodeKind): TestGraph | null {
  if (!hasTestTemplate(kind)) return null
  const def = NODE_DEFINITIONS[kind]
  if (!def) return null

  // Explicit per-kind templates first — these are the weird ones.
  if (kind === 'pan') return templatePan()
  if (kind === 'envelope_follower') return templateEnvelopeFollower()
  if (kind === 'step_seq') return templateStepSeq()
  if (kind === 'euclidean') {
    // Euclidean is clock-driven gate out; reuse the CV-source template
    // which has gate-output fallback baked in.
    return templateSourceCv(kind)
  }
  if (kind === 'arp') return templateArp()
  if (kind === 'clock_divider') return templateClockDivider()
  if (kind === 'print') return templatePrint()
  if (kind === 'expression') return templateExpression()

  if (ENVELOPES_GATED.has(kind)) return templateEnvelope(kind)
  if (VCA_LIKE.has(kind)) return templateVca(kind)
  if (CV_TOOLS.has(kind)) return templateCvTool(kind)
  if (SATURATORS.has(kind)) return templateSaturator(kind)
  if (MIXER_LIKE.has(kind)) return templateMixerLike(kind)
  if (STEREO_AUDIO_OUT.has(kind)) return templateStereoProcess(kind)

  // Generic fall-through by category + shape.
  const shape = shapeOf(kind)

  if (def.category === 'source') {
    if (shape.audioOut > 0) return templateSourceAudio(kind)
    if (shape.cvOut > 0 || shape.gateOut > 0) return templateSourceCv(kind)
  }

  // Process / effect / filter / dynamics: audio in + audio out + CV inputs.
  if (shape.audioIn > 0 && shape.audioOut > 0) {
    return templateAudioProcess(kind)
  }

  // CV-shaped process (cv in + cv out).
  if (shape.cvIn > 0 && shape.cvOut > 0) {
    return templateCvTool(kind)
  }

  return null
}
