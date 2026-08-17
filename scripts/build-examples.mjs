#!/usr/bin/env node
// Build the example patches in `examples/`.
//
// The `.dpatch` files are GENERATED, not hand-written, and this script is
// why. A patch is a graph of socket ids and param names, and hand-editing
// JSON against a 80-kind catalog produces files that load with half their
// cables missing and no error anywhere — the store drops an unknown socket
// silently. Building them here means every node kind, socket id and param
// name is checked against `NODE_DEFINITIONS` as it is written, every cable
// is checked for signal-kind compatibility (the editor would refuse a
// mismatched one, so a file containing one is a file that lies), and every
// hardware pin comes from the real board pinout with the same collision
// rules the app's auto-assign uses.
//
// It also means the examples cannot rot: rename a socket and this fails
// loudly next run instead of shipping five broken demos.
//
// Usage:
//   node scripts/build-examples.mjs           # write examples/*.dpatch
//   node scripts/build-examples.mjs --check    # verify only, write nothing
//
// After writing, each patch is put through `generateProject` for its own
// target and any warning that indicates a real problem is reported.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT_DIR = path.join(PROJECT_ROOT, 'examples')
const checkOnly = process.argv.includes('--check')

/* ---------------- load the real catalog ---------------- */

const require_ = createRequire(import.meta.url)
const esbuild = require_(path.join(PROJECT_ROOT, 'node_modules/esbuild'))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dp-examples-'))
const ENTRY = path.join(tmp, '_entry.ts')
const BUNDLE = path.join(tmp, 'bundle.cjs')
const p = (rel) => path.join(PROJECT_ROOT, rel).replace(/\\/g, '/')

writeFileSync(
  ENTRY,
  [
    `export { NODE_DEFINITIONS } from '${p('src/nodes/definitions')}'`,
    `export { KIND_ROLES, emptyHardwareLayout } from '${p('src/types/hardware')}'`,
    `export { getBoardPinout } from '${p('src/hardware/boardPinout')}'`,
    `export { generateProject } from '${p('src/codegen/generateProject')}'`,
    `export { supportLevel } from '${p('src/nodes/targetSupport')}'`,
    `export { defaultHardwareConfig } from '${p('src/hardware/defaultConfig')}'`
  ].join('\n'),
  'utf8'
)
await esbuild.build({
  entryPoints: [ENTRY],
  outfile: BUNDLE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  alias: { '@': path.join(PROJECT_ROOT, 'src') },
  external: ['react', 'react-dom']
})
const { NODE_DEFINITIONS, KIND_ROLES, getBoardPinout, generateProject, supportLevel, defaultHardwareConfig } =
  require_(BUNDLE)

/* ---------------- builder ---------------- */

/**
 * Roles that legitimately share a pin with another component — a bus.
 * Mirrors `SHARED_BUS_ROLES` in the store; an OLED, an IMU and a ToF
 * sensor all sitting on the same two I2C wires is the normal case, not a
 * collision.
 */
const SHARED_BUS_ROLES = new Set(['sda', 'scl', 'sck', 'ws', 'mclk'])

class Patch {
  constructor(name, board, description) {
    this.name = name
    this.board = board
    this.description = description
    this.nodes = []
    this.connections = []
    this.components = []
    this.pinout = getBoardPinout(board)
    /** pin -> role, for shared-bus reuse and collision detection. */
    this.taken = new Map()
    this.n = 0
    this.c = 0
  }

  /** Add a node. Unknown params/kinds throw rather than landing in the file. */
  node(kind, params = {}, position = { x: 0, y: 0 }) {
    const def = NODE_DEFINITIONS[kind]
    if (!def) throw new Error(`${this.name}: unknown node kind "${kind}"`)
    const level = supportLevel(kind, this.board)
    if (level === 'unsupported') {
      throw new Error(`${this.name}: ${kind} is unsupported on ${this.board}`)
    }
    const full = {}
    for (const q of def.params) full[q.id] = q.default
    for (const [k, v] of Object.entries(params)) {
      if (!def.params.some((q) => q.id === k)) {
        throw new Error(`${this.name}: ${kind} has no param "${k}"`)
      }
      full[k] = v
    }
    const id = `${this.name}-${kind}_${++this.n}`
    this.nodes.push({ id, kind, position, params: full })
    return id
  }

  /**
   * Wire two sockets. Both ends are checked to exist AND to carry the same
   * signal kind, because `canConnectSockets` would refuse a mismatch in the
   * editor — a file containing one describes a patch that cannot be drawn.
   */
  wire(fromId, fromSocket, toId, toSocket) {
    const from = this.nodes.find((x) => x.id === fromId)
    const to = this.nodes.find((x) => x.id === toId)
    if (!from) throw new Error(`${this.name}: no such node ${fromId}`)
    if (!to) throw new Error(`${this.name}: no such node ${toId}`)
    const o = NODE_DEFINITIONS[from.kind].outputs.find((s) => s.id === fromSocket)
    const i = NODE_DEFINITIONS[to.kind].inputs.find((s) => s.id === toSocket)
    if (!o) throw new Error(`${this.name}: ${from.kind} has no output "${fromSocket}"`)
    if (!i) throw new Error(`${this.name}: ${to.kind} has no input "${toSocket}"`)
    if (o.signal !== i.signal) {
      throw new Error(
        `${this.name}: cannot wire ${from.kind}.${fromSocket} (${o.signal}) -> ` +
          `${to.kind}.${toSocket} (${i.signal}) — the editor rejects cross-kind cables`
      )
    }
    if (this.connections.some((c) => c.to.nodeId === toId && c.to.socketId === toSocket)) {
      throw new Error(`${this.name}: ${to.kind}.${toSocket} already has a cable`)
    }
    this.connections.push({
      // Prefixed with the patch name so no two examples share a cable id.
      // Rete diffs by (id + endpoints) now, but ids that never collide is
      // the cheaper guarantee, and a saved patch is forever.
      id: `${this.name}-c${++this.c}`,
      from: { nodeId: fromId, socketId: fromSocket },
      to: { nodeId: toId, socketId: toSocket }
    })
  }

  /**
   * Place a hardware component and bind it to `nodeId` (if given).
   *
   * Pins come from the board's own `pinsForRole`, first free wins, with
   * bus roles allowed to reuse a pin already carrying the same role. Same
   * rules as the app's auto-assign, so an example never contains a pin
   * combination the app itself would not produce.
   */
  place(kind, label, nodeId, position, config = {}) {
    const roles = KIND_ROLES[kind]
    if (!roles) throw new Error(`${this.name}: unknown hardware kind "${kind}"`)
    const pins = {}
    for (const role of roles) {
      const shared = SHARED_BUS_ROLES.has(role)
      if (shared) {
        const reuse = [...this.taken].find(([, r]) => r === role)
        if (reuse) {
          pins[role] = reuse[0]
          continue
        }
      }
      const candidates = this.pinout.pinsForRole(role, kind)
      const free = candidates.find((pin) => !this.taken.has(pin))
      if (!free) {
        throw new Error(
          `${this.name}: no free pin for ${kind}.${role} on ${this.board} ` +
            `(${candidates.length} candidates, all taken)`
        )
      }
      pins[role] = free
      this.taken.set(free, role)
    }
    const id = `hw_${kind}_${this.components.length + 1}`
    this.components.push({ id, kind, label, position, pins, config: { ...defaultHardwareConfig(kind), ...config } })
    if (nodeId) {
      const node = this.nodes.find((x) => x.id === nodeId)
      if (!node) throw new Error(`${this.name}: no such node ${nodeId}`)
      if (!('bindingId' in node.params)) {
        throw new Error(`${this.name}: ${node.kind} has no bindingId param to bind`)
      }
      node.params.bindingId = id
    }
    return id
  }

  toJSON() {
    return {
      dpatch: 2,
      graph: {
        nodes: this.nodes,
        connections: this.connections,
        meta: { name: this.name, sampleRate: 48000, blockSize: 48, description: this.description }
      },
      hardware: {
        board: this.board,
        components: this.components,
        meta: { name: this.name }
      },
      layout: { daisyFlashMode: 'qspi' }
    }
  }
}

/** Shorthand for an OLED element list. */
const el = (kind, rest) => ({ id: `el_${Math.abs(hash(JSON.stringify(rest)))}`, kind, ...rest })
function hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/* =====================================================================
 * 1. Daisy sampler
 * ===================================================================== */

function daisySampler() {
  const q = new Patch(
    'daisy-sampler',
    'daisy_seed',
    'Live-input sampler: hold a slice, smear it with grains, filter and reverb.'
  )

  // Capture chain. `freeze` holds whatever is at its input while its gate is
  // high, which is the closest thing the catalog has to "record"; the
  // granulator then reads that held buffer, so the two together behave like
  // a sampler with scrub and stretch rather than a plain looper.
  const inp = q.node('audio_in', {}, { x: -700, y: 0 })
  const capture = q.node('gate_in', {}, { x: -700, y: 160 })
  const freeze = q.node('freeze', { buffer_ms: 2000 }, { x: -460, y: 40 })
  const gran = q.node(
    'granulator',
    { grain_size: 120, density: 12, pitch: 0, jitter: 0.4, mix: 1 },
    { x: -200, y: 40 }
  )

  q.wire(inp, 'left', freeze, 'in')
  q.wire(capture, 'out', freeze, 'gate')
  q.wire(freeze, 'out', gran, 'in')

  // Four knobs, each scaled to the range its destination actually wants —
  // a raw 0..1 into cv_grain_size would clamp to the 10 ms floor and the
  // knob would appear dead over its whole travel.
  const kSize = q.node('knob_in', { channel: '1', min: 20, max: 200, value: 0.4 }, { x: -700, y: 300 })
  const kDens = q.node('knob_in', { channel: '2', min: 1, max: 28, value: 0.35 }, { x: -700, y: 420 })
  const kPitch = q.node('knob_in', { channel: '3', min: -12, max: 12, value: 0.5 }, { x: -700, y: 540 })
  const kCut = q.node('knob_in', { channel: '4', min: 120, max: 9000, value: 0.6 }, { x: -700, y: 660 })

  q.wire(kSize, 'out', gran, 'cv_grain_size')
  q.wire(kDens, 'out', gran, 'cv_density')
  q.wire(kPitch, 'out', gran, 'cv_pitch')

  const filt = q.node('filter_svf', { frequency: 2200, resonance: 0.25 }, { x: 60, y: 40 })
  q.wire(gran, 'out', filt, 'in')
  q.wire(kCut, 'out', filt, 'cv_cutoff')

  const verb = q.node('reverb', { size: 0.6, damp: 0.4, mix: 0.35 }, { x: 320, y: 40 })
  q.wire(filt, 'lp', verb, 'in')

  const out = q.node('audio_output', {}, { x: 600, y: 40 })
  q.wire(verb, 'out', out, 'left')
  q.wire(verb, 'out', out, 'right')

  // Level LED. The LED input is CV, so it is driven by an envelope
  // follower rather than the capture gate — which also makes it useful:
  // it shows signal present, not button held.
  const env = q.node('envelope_follower', {}, { x: 320, y: 220 })
  const led = q.node('led', { mode: 'pwm' }, { x: 600, y: 220 })
  q.wire(verb, 'out', env, 'in')
  q.wire(env, 'out', led, 'in')

  const oled = q.node(
    'oled',
    {
      elements: JSON.stringify([
        el('text', { x: 0, y: 0, text: 'SAMPLER', size: 1 }),
        el('value', { x: 0, y: 14, binding: 'a', decimals: 0, unit: 'ms' }),
        el('value', { x: 64, y: 14, binding: 'b', decimals: 1, unit: '/s' }),
        el('value', { x: 0, y: 26, binding: 'c', decimals: 1, unit: 'st' }),
        el('meter', { x: 0, y: 40, width: 128, height: 10, binding: 'd' }),
        el('line', { x: 0, y: 11, x2: 127, y2: 11 })
      ])
    },
    { x: 60, y: 300 }
  )
  q.wire(kSize, 'out', oled, 'a')
  q.wire(kDens, 'out', oled, 'b')
  q.wire(kPitch, 'out', oled, 'c')
  q.wire(env, 'out', oled, 'd')

  q.place('pot', 'Grain', kSize, { x: 120, y: 620 })
  q.place('pot', 'Density', kDens, { x: 220, y: 620 })
  q.place('pot', 'Pitch', kPitch, { x: 320, y: 620 })
  q.place('pot', 'Cutoff', kCut, { x: 420, y: 620 })
  q.place('gate_jack', 'Capture', capture, { x: 120, y: 740 })
  q.place('led', 'Level', led, { x: 520, y: 620 })
  q.place('oled_ssd1306', 'Display', oled, { x: 260, y: 460 })
  return q
}

/* =====================================================================
 * 2. ESP32 sequencer
 * ===================================================================== */

function esp32Sequencer() {
  const q = new Patch(
    'esp32-sequencer',
    'esp32_s3_devkitc',
    'Eight-step melodic sequencer with a Euclidean drum track, encoder menu and OLED.'
  )

  const clk = q.node('clock', { bpm: 112, pulse_width: 0.12 }, { x: -760, y: 0 })
  const div = q.node('clock_divider', {}, { x: -540, y: 0 })
  q.wire(clk, 'out', div, 'in')

  // Melody: eight steps of pitch CV into an oscillator, gated by an ADSR.
  const seq = q.node(
    'step_seq',
    {
      s1: 0, s2: 0.25, s3: 0.42, s4: 0.25,
      s5: 0.58, s6: 0.42, s7: 0.75, s8: 0.33,
      g5: 'on', g6: 'on', g7: 'on', g8: 'on'
    },
    { x: -540, y: -220 }
  )
  q.wire(clk, 'out', seq, 'clock')

  // `pitch_cv` is octave-scaled and additive, so the sequencer's 0..1 is
  // remapped to a musical two-octave span rather than fed in raw.
  const pitch = q.node('range', { in_min: 0, in_max: 1, out_min: -1, out_max: 1 }, { x: -300, y: -260 })
  q.wire(seq, 'cv', pitch, 'in')

  const osc = q.node('oscillator', { frequency: 220, amplitude: 0.6, waveform: 'sawtooth' }, { x: -60, y: -300 })
  q.wire(pitch, 'out', osc, 'pitch_cv')

  const env = q.node('adsr', { attack: 0.005, decay: 0.14, sustain: 0.25, release: 0.18 }, { x: -300, y: -140 })
  q.wire(seq, 'gate', env, 'gate')

  const vca = q.node('vca', {}, { x: 180, y: -280 })
  q.wire(osc, 'out', vca, 'in')
  q.wire(env, 'out', vca, 'cv')

  const filt = q.node('filter_moog', { frequency: 1800, resonance: 0.35 }, { x: 420, y: -280 })
  q.wire(vca, 'out', filt, 'in')

  // Drums off clock divisions — a separate rhythmic layer that stays locked
  // to the same clock without sharing the melody's step count.
  const euc = q.node('euclidean', { steps: 16, pulses: 7, rotate: 0 }, { x: -540, y: 200 })
  q.wire(clk, 'out', euc, 'clock')

  const kick = q.node('drum_kick', { tune: 52, decay: 0.4, punch: 0.6 }, { x: -300, y: 140 })
  const hat = q.node('drum_hat', { decay: 0.06, tone: 0.8 }, { x: -300, y: 280 })
  q.wire(div, 'd4', kick, 'trigger')
  q.wire(euc, 'out', hat, 'trigger')

  const snare = q.node('drum_snare', { tune: 190, decay: 0.18, tone: 0.55 }, { x: -300, y: 420 })
  q.wire(div, 'd8', snare, 'trigger')

  const mix = q.node('mixer4', { gain1: 0.9, gain2: 0.8, gain3: 0.5, gain4: 0.35 }, { x: 660, y: 0 })
  q.wire(filt, 'out', mix, 'in1')
  q.wire(kick, 'out', mix, 'in2')
  q.wire(snare, 'out', mix, 'in3')
  q.wire(hat, 'out', mix, 'in4')

  const dly = q.node('delay', { time: 0.24, feedback: 0.32, mix: 0.28 }, { x: 900, y: 0 })
  q.wire(mix, 'out', dly, 'in')
  const out = q.node('audio_output', {}, { x: 1140, y: 0 })
  q.wire(dly, 'out', out, 'left')
  q.wire(dly, 'out', out, 'right')

  // Encoder-driven menu. Leaves target node params directly, which is what
  // makes this practical: eleven parameters over one encoder and no cables.
  const enc = q.node('encoder_in', { step: 0.02 }, { x: -1020, y: 320 })
  const menu = q.node(
    'menu',
    {
      tree: JSON.stringify({
        root: [
          {
            id: 'tempo', kind: 'value', label: 'TEMPO', type: 'number',
            min: 40, max: 200, step: 1, value: 112, defaultValue: 112, unit: 'bpm',
            target: { nodeId: clk, paramId: 'bpm' }, out: 'a'
          },
          {
            id: 'voice', kind: 'submenu', label: 'VOICE',
            children: [
              {
                id: 'wave', kind: 'value', label: 'WAVE', type: 'enum',
                min: 0, max: 3, step: 1,
                options: ['SINE', 'SAW', 'SQR', 'TRI'],
                value: 1, defaultValue: 1, out: 'none'
              },
              {
                id: 'cutoff', kind: 'value', label: 'CUTOFF', type: 'number',
                min: 120, max: 9000, step: 20, value: 1800, defaultValue: 1800, unit: 'Hz',
                target: { nodeId: filt, paramId: 'frequency' }, out: 'b'
              },
              {
                id: 'reso', kind: 'value', label: 'RESO', type: 'number',
                min: 0, max: 0.9, step: 0.02, value: 0.35, defaultValue: 0.35,
                target: { nodeId: filt, paramId: 'resonance' }, out: 'none'
              },
              {
                id: 'decay', kind: 'value', label: 'DECAY', type: 'number',
                min: 0.02, max: 1, step: 0.01, value: 0.14, defaultValue: 0.14, unit: 's',
                target: { nodeId: env, paramId: 'decay' }, out: 'none'
              }
            ]
          },
          {
            id: 'rhythm', kind: 'submenu', label: 'RHYTHM',
            children: [
              {
                id: 'pulses', kind: 'value', label: 'PULSES', type: 'number',
                min: 1, max: 16, step: 1, value: 7, defaultValue: 7,
                target: { nodeId: euc, paramId: 'pulses' }, out: 'c'
              },
              {
                id: 'rotate', kind: 'value', label: 'ROTATE', type: 'number',
                min: 0, max: 15, step: 1, value: 0, defaultValue: 0,
                target: { nodeId: euc, paramId: 'rotate' }, out: 'none'
              },
              {
                id: 'kicklvl', kind: 'value', label: 'KICK', type: 'number',
                min: 0, max: 1.5, step: 0.05, value: 0.8, defaultValue: 0.8,
                target: { nodeId: mix, paramId: 'gain2' }, out: 'none'
              }
            ]
          },
          {
            id: 'space', kind: 'submenu', label: 'SPACE',
            children: [
              {
                id: 'dtime', kind: 'value', label: 'TIME', type: 'number',
                min: 0.02, max: 0.9, step: 0.01, value: 0.24, defaultValue: 0.24, unit: 's',
                target: { nodeId: dly, paramId: 'time' }, out: 'none'
              },
              {
                id: 'dfb', kind: 'value', label: 'FBACK', type: 'number',
                min: 0, max: 0.85, step: 0.02, value: 0.32, defaultValue: 0.32,
                target: { nodeId: dly, paramId: 'feedback' }, out: 'none'
              },
              {
                id: 'dmix', kind: 'value', label: 'MIX', type: 'number',
                min: 0, max: 1, step: 0.02, value: 0.28, defaultValue: 0.28,
                target: { nodeId: dly, paramId: 'mix' }, out: 'd'
              }
            ]
          }
        ],
        longPress: 'back',
        doubleClick: 'home',
        longMs: 500,
        doubleMs: 300
      })
    },
    { x: -760, y: 320 }
  )
  q.wire(enc, 'delta', menu, 'delta')
  q.wire(enc, 'sw', menu, 'click')

  const oled = q.node(
    'oled',
    { elements: JSON.stringify([el('menu', { x: 0, y: 0, width: 128, height: 64, rows: 6, menuNodeId: menu })]) },
    { x: -460, y: 320 }
  )

  q.place('encoder', 'Nav', enc, { x: 140, y: 560 })
  q.place('oled_ssd1306', 'Display', oled, { x: 300, y: 420 })
  q.place('pcm5102a', 'Line out', null, { x: 300, y: 700 }, { jumper: 'i2s' })
  return q
}

/* =====================================================================
 * 3. Daisy tracker
 * ===================================================================== */

function daisyTracker() {
  const q = new Patch(
    'daisy-tracker',
    'daisy_seed',
    'Four-track pattern sequencer with per-track faders — a tracker laid out as a patch.'
  )

  const clk = q.node('clock', { bpm: 128, pulse_width: 0.08 }, { x: -900, y: 0 })
  const div = q.node('clock_divider', {}, { x: -700, y: 0 })
  q.wire(clk, 'out', div, 'in')

  /*
   * Four tracks, each a pattern plus a voice, exactly like a tracker's
   * columns. What a tracker calls a "pattern" is a `step_seq` here; what it
   * calls an "instrument" is whichever source the track feeds.
   */
  // Track 1 — lead.
  const p1 = q.node(
    'step_seq',
    { s1: 0.5, s2: 0.58, s3: 0.66, s4: 0.58, s5: 0.75, s6: 0.66, s7: 0.5, s8: 0.42,
      g5: 'on', g6: 'on', g7: 'on', g8: 'on' },
    { x: -700, y: -420 }
  )
  q.wire(clk, 'out', p1, 'clock')
  const r1 = q.node('range', { in_min: 0, in_max: 1, out_min: -1, out_max: 1 }, { x: -460, y: -460 })
  q.wire(p1, 'cv', r1, 'in')
  const v1 = q.node('oscillator', { frequency: 330, amplitude: 0.5, waveform: 'square' }, { x: -240, y: -500 })
  q.wire(r1, 'out', v1, 'pitch_cv')
  const e1 = q.node('adsr', { attack: 0.004, decay: 0.1, sustain: 0.2, release: 0.12 }, { x: -460, y: -340 })
  q.wire(p1, 'gate', e1, 'gate')
  const a1 = q.node('vca', {}, { x: -20, y: -480 })
  q.wire(v1, 'out', a1, 'in')
  q.wire(e1, 'out', a1, 'cv')

  // Track 2 — plucked bass.
  const p2 = q.node(
    'step_seq',
    { s1: 0.2, s2: 0.2, s3: 0.28, s4: 0.2, s5: 0.12, s6: 0.2, s7: 0.28, s8: 0.36,
      g5: 'on', g7: 'on' },
    { x: -700, y: -160 }
  )
  q.wire(clk, 'out', p2, 'clock')
  const r2 = q.node('range', { in_min: 0, in_max: 1, out_min: -2, out_max: 0 }, { x: -460, y: -180 })
  q.wire(p2, 'cv', r2, 'in')
  const v2 = q.node('karplus', { frequency: 110, damping: 0.4, feedback: 0.985 }, { x: -240, y: -200 })
  q.wire(p2, 'gate', v2, 'trigger')
  q.wire(r2, 'out', v2, 'cv_pitch')

  // Tracks 3 and 4 — drums, on clock divisions.
  const v3 = q.node('drum_kick', { tune: 48, decay: 0.42, punch: 0.7 }, { x: -240, y: 60 })
  q.wire(div, 'd4', v3, 'trigger')
  const v4 = q.node('drum_hat', { decay: 0.05, tone: 0.75 }, { x: -240, y: 220 })
  q.wire(div, 'd2', v4, 'trigger')

  // Per-track faders into the mixer — a tracker's channel volumes. Faders
  // rather than buttons because `mixer4`'s level inputs are CV, and a
  // gate-to-CV cable is refused by the editor for good reason.
  const mix = q.node('mixer4', { gain1: 0.8, gain2: 0.9, gain3: 1, gain4: 0.5 }, { x: 240, y: -140 })
  q.wire(a1, 'out', mix, 'in1')
  q.wire(v2, 'out', mix, 'in2')
  q.wire(v3, 'out', mix, 'in3')
  q.wire(v4, 'out', mix, 'in4')

  const f1 = q.node('knob_in', { channel: '1', min: 0, max: 1.4, value: 0.6 }, { x: -900, y: 420 })
  const f2 = q.node('knob_in', { channel: '2', min: 0, max: 1.4, value: 0.65 }, { x: -900, y: 520 })
  const f3 = q.node('knob_in', { channel: '3', min: 0, max: 1.4, value: 0.7 }, { x: -900, y: 620 })
  const f4 = q.node('knob_in', { channel: '4', min: 0, max: 1.4, value: 0.4 }, { x: -900, y: 720 })
  q.wire(f1, 'out', mix, 'cv_level1')
  q.wire(f2, 'out', mix, 'cv_level2')
  q.wire(f3, 'out', mix, 'cv_level3')
  q.wire(f4, 'out', mix, 'cv_level4')

  const filt = q.node('filter_svf', { frequency: 6000, resonance: 0.12 }, { x: 480, y: -140 })
  q.wire(mix, 'out', filt, 'in')
  const verb = q.node('reverb', { size: 0.45, damp: 0.55, mix: 0.22 }, { x: 700, y: -140 })
  q.wire(filt, 'lp', verb, 'in')
  const out = q.node('audio_output', {}, { x: 940, y: -140 })
  q.wire(verb, 'out', out, 'left')
  q.wire(verb, 'out', out, 'right')

  // Transport + pattern editing over one encoder, which is how a tracker
  // on a box with no keyboard has to work.
  const enc = q.node('encoder_in', { step: 0.02 }, { x: -1180, y: 300 })
  const menu = q.node(
    'menu',
    {
      tree: JSON.stringify({
        root: [
          {
            id: 'tempo', kind: 'value', label: 'TEMPO', type: 'number',
            min: 50, max: 220, step: 1, value: 128, defaultValue: 128, unit: 'bpm',
            target: { nodeId: clk, paramId: 'bpm' }, out: 'a'
          },
          {
            id: 't1', kind: 'submenu', label: 'TRK1 LEAD',
            children: [
              { id: 't1w', kind: 'value', label: 'WAVE', type: 'enum', min: 0, max: 3, step: 1,
                options: ['SINE', 'SAW', 'SQR', 'TRI'], value: 2, defaultValue: 2, out: 'none' },
              { id: 't1d', kind: 'value', label: 'DECAY', type: 'number', min: 0.02, max: 0.8, step: 0.01,
                value: 0.1, defaultValue: 0.1, unit: 's',
                target: { nodeId: e1, paramId: 'decay' }, out: 'none' },
              { id: 't1s', kind: 'value', label: 'SUSTAIN', type: 'number', min: 0, max: 1, step: 0.02,
                value: 0.2, defaultValue: 0.2,
                target: { nodeId: e1, paramId: 'sustain' }, out: 'none' }
            ]
          },
          {
            id: 't2', kind: 'submenu', label: 'TRK2 BASS',
            children: [
              { id: 't2d', kind: 'value', label: 'DAMP', type: 'number', min: 0, max: 1, step: 0.02,
                value: 0.4, defaultValue: 0.4,
                target: { nodeId: v2, paramId: 'damping' }, out: 'none' },
              { id: 't2f', kind: 'value', label: 'SUSTAIN', type: 'number', min: 0.9, max: 0.999, step: 0.002,
                value: 0.985, defaultValue: 0.985,
                target: { nodeId: v2, paramId: 'feedback' }, out: 'none' }
            ]
          },
          {
            id: 't3', kind: 'submenu', label: 'TRK3 KICK',
            children: [
              { id: 't3t', kind: 'value', label: 'TUNE', type: 'number', min: 30, max: 90, step: 1,
                value: 48, defaultValue: 48, unit: 'Hz',
                target: { nodeId: v3, paramId: 'tune' }, out: 'none' },
              { id: 't3d', kind: 'value', label: 'DECAY', type: 'number', min: 0.05, max: 1, step: 0.01,
                value: 0.42, defaultValue: 0.42, unit: 's',
                target: { nodeId: v3, paramId: 'decay' }, out: 'none' }
            ]
          },
          {
            id: 'mst', kind: 'submenu', label: 'MASTER',
            children: [
              { id: 'mcut', kind: 'value', label: 'TONE', type: 'number', min: 400, max: 12000, step: 50,
                value: 6000, defaultValue: 6000, unit: 'Hz',
                target: { nodeId: filt, paramId: 'frequency' }, out: 'b' },
              { id: 'mrev', kind: 'value', label: 'REVERB', type: 'number', min: 0, max: 0.8, step: 0.02,
                value: 0.22, defaultValue: 0.22,
                target: { nodeId: verb, paramId: 'mix' }, out: 'c' }
            ]
          }
        ],
        longPress: 'back',
        doubleClick: 'home',
        longMs: 480,
        doubleMs: 280
      })
    },
    { x: -900, y: 300 }
  )
  q.wire(enc, 'delta', menu, 'delta')
  q.wire(enc, 'sw', menu, 'click')

  const oled = q.node(
    'oled',
    { elements: JSON.stringify([el('menu', { x: 0, y: 0, width: 128, height: 64, rows: 6, menuNodeId: menu })]) },
    { x: -620, y: 300 }
  )

  q.place('slider', 'Trk 1', f1, { x: 120, y: 560 })
  q.place('slider', 'Trk 2', f2, { x: 200, y: 560 })
  q.place('slider', 'Trk 3', f3, { x: 280, y: 560 })
  q.place('slider', 'Trk 4', f4, { x: 360, y: 560 })
  q.place('encoder', 'Nav', enc, { x: 480, y: 560 })
  q.place('oled_ssd1306', 'Display', oled, { x: 240, y: 400 })
  return q
}

/* =====================================================================
 * 4. ESP32 drone box
 * ===================================================================== */

function esp32Drone() {
  const q = new Patch(
    'esp32-drone-box',
    'esp32_c3_supermini',
    'Four detuned voices drifting against each other, on the smallest board that fits.'
  )

  /*
   * The C3 SuperMini exposes thirteen usable pins, so the budget is the
   * design constraint: four pots and a three-wire I2S line-out and that is
   * the board full. Everything else is modulation generated on-chip.
   */
  const root = q.node('knob_in', { channel: '1', min: -1, max: 1, value: 0.55 }, { x: -820, y: -220 })
  const spread = q.node('knob_in', { channel: '2', min: 0, max: 0.4, value: 0.3 }, { x: -820, y: -80 })
  const tone = q.node('knob_in', { channel: '3', min: 120, max: 5000, value: 0.45 }, { x: -820, y: 60 })
  const air = q.node('knob_in', { channel: '4', min: 0.1, max: 0.85, value: 0.5 }, { x: -820, y: 200 })

  /*
   * Three slow LFOs at deliberately non-integer ratios. A drone that
   * repeats is a loop; the point is that these never line up, so the beat
   * pattern between the voices keeps evolving.
   *
   * Note what the two knobs are wired to. An LFO emits
   * `wave * depth + offset`, so feeding the root knob into `cv_offset` and
   * the spread knob into `cv_depth` makes each LFO output "root pitch,
   * drifting by this much" in one cable. Building the same thing out of a
   * multiply and an adder is not possible here and should not be: `sum`
   * and `multiply` are audio-rate nodes, and the editor is right to refuse
   * a CV cable into them.
   */
  const voices = []
  const osc0 = q.node('oscillator', { frequency: 55, amplitude: 0.32, waveform: 'sawtooth' }, { x: -60, y: -380 })
  q.wire(root, 'out', osc0, 'pitch_cv')
  voices.push(osc0)

  const RATES = [0.037, 0.053, 0.017]
  const WAVES = ['sine', 'tri', 'sine']
  RATES.forEach((rate, i) => {
    const lfo = q.node(
      'lfo',
      { frequency: rate, depth: 0.3, offset: 0, waveform: WAVES[i] },
      { x: -420, y: -260 + i * 130 }
    )
    q.wire(root, 'out', lfo, 'cv_offset')
    q.wire(spread, 'out', lfo, 'cv_depth')
    const osc = q.node(
      'oscillator',
      {
        frequency: 55 * (1 + 0.004 * (i + 1)),
        amplitude: 0.28,
        waveform: i === 1 ? 'triangle' : 'sawtooth'
      },
      { x: -60, y: -260 + i * 130 }
    )
    q.wire(lfo, 'out', osc, 'pitch_cv')
    voices.push(osc)
  })

  const mix = q.node('mixer4', { gain1: 0.9, gain2: 0.85, gain3: 0.8, gain4: 0.75 }, { x: 340, y: -160 })
  voices.forEach((v, i) => q.wire(v, 'out', mix, `in${i + 1}`))

  const filt = q.node('filter_moog', { frequency: 1400, resonance: 0.22 }, { x: 580, y: -160 })
  q.wire(mix, 'out', filt, 'in')
  q.wire(tone, 'out', filt, 'cv_cutoff')

  const cho = q.node('chorus', { rate: 0.19, depth: 0.7, mix: 0.55 }, { x: 800, y: -160 })
  q.wire(filt, 'out', cho, 'in')

  const verb = q.node('reverb', { size: 0.85, damp: 0.3, mix: 0.55 }, { x: 1020, y: -160 })
  q.wire(cho, 'out', verb, 'in')
  q.wire(air, 'out', verb, 'cv_size')

  const lim = q.node('limiter', { ceiling: -0.5 }, { x: 1240, y: -160 })
  q.wire(verb, 'out', lim, 'in')
  const out = q.node('audio_output', {}, { x: 1460, y: -160 })
  q.wire(lim, 'out', out, 'left')
  q.wire(lim, 'out', out, 'right')

  q.place('pot', 'Root', root, { x: 120, y: 520 })
  q.place('pot', 'Spread', spread, { x: 210, y: 520 })
  q.place('pot', 'Tone', tone, { x: 300, y: 520 })
  q.place('pot', 'Air', air, { x: 390, y: 520 })
  q.place('pcm5102a', 'Line out', null, { x: 260, y: 660 }, { jumper: 'i2s' })
  return q
}

/* =====================================================================
 * 5. Gesture box — my pick, because it exercises the sensors
 * ===================================================================== */

function esp32Gesture() {
  const q = new Patch(
    'esp32-gesture-box',
    'esp32_s3_devkitc',
    'A resonator you play by tilting the box and waving at it — IMU and time-of-flight as controllers.'
  )

  /*
   * Chosen to exercise the two sensor kinds that could previously be
   * placed, pinned and saved while generating no firmware at all. Tilt is
   * a genuinely good controller for a resonator: it is absolute, so the
   * sound has a resting position you can return to, unlike an encoder.
   */
  const imu = q.node('imu_in', { accel_range: '2', smooth: 35 }, { x: -900, y: -120 })
  const tof = q.node('distance_in', { min_mm: 40, max_mm: 600, smooth: 45 }, { x: -900, y: 120 })

  // Tilt front/back -> pitch, left/right -> damping.
  const tilt = q.node('range', { in_min: -1, in_max: 1, out_min: -1.5, out_max: 1.5 }, { x: -660, y: -180 })
  q.wire(imu, 'ax', tilt, 'in')
  const damp = q.node('range', { in_min: -1, in_max: 1, out_min: 0.05, out_max: 0.95 }, { x: -660, y: -60 })
  q.wire(imu, 'ay', damp, 'in')

  // Hand distance -> how much space the sound sits in.
  const space = q.node('range', { in_min: 0, in_max: 1, out_min: 0.05, out_max: 0.8 }, { x: -660, y: 120 })
  q.wire(tof, 'dist', space, 'in')

  // Struck string. A steady clock keeps it sounding without anything to
  // press, so the box is playable the moment it powers up.
  const clk = q.node('clock', { bpm: 96, pulse_width: 0.05 }, { x: -900, y: 320 })
  const rnd = q.node('random', { rate: 2, range: 1, smooth: 0 }, { x: -660, y: 320 })
  q.wire(clk, 'out', rnd, 'clock')

  const string = q.node('karplus', { frequency: 196, damping: 0.35, feedback: 0.99 }, { x: -380, y: -80 })
  q.wire(clk, 'out', string, 'trigger')
  q.wire(tilt, 'out', string, 'cv_pitch')
  q.wire(damp, 'out', string, 'cv_damp')

  // A second, quieter voice whose pitch wanders — keeps a still box from
  // sounding static.
  const drift = q.node('slew', { rise: 0.6, fall: 0.6 }, { x: -380, y: 320 })
  q.wire(rnd, 'out', drift, 'in')
  const pad = q.node('oscillator', { frequency: 98, amplitude: 0.18, waveform: 'triangle' }, { x: -140, y: 300 })
  q.wire(drift, 'out', pad, 'pitch_cv')

  const mix = q.node('mixer4', { gain1: 1, gain2: 0.5, gain3: 0, gain4: 0 }, { x: 120, y: 40 })
  q.wire(string, 'out', mix, 'in1')
  q.wire(pad, 'out', mix, 'in2')

  const filt = q.node('filter_svf', { frequency: 2600, resonance: 0.3 }, { x: 360, y: 40 })
  q.wire(mix, 'out', filt, 'in')

  const dly = q.node('delay', { time: 0.33, feedback: 0.45, mix: 0.3 }, { x: 600, y: 40 })
  q.wire(filt, 'lp', dly, 'in')
  q.wire(space, 'out', dly, 'cv_mix')

  const verb = q.node('reverb', { size: 0.7, damp: 0.4, mix: 0.4 }, { x: 840, y: 40 })
  q.wire(dly, 'out', verb, 'in')
  const out = q.node('audio_output', {}, { x: 1080, y: 40 })
  q.wire(verb, 'out', out, 'left')
  q.wire(verb, 'out', out, 'right')

  const oled = q.node(
    'oled',
    {
      elements: JSON.stringify([
        el('text', { x: 0, y: 0, text: 'GESTURE', size: 1 }),
        el('line', { x: 0, y: 11, x2: 127, y2: 11 }),
        el('text', { x: 0, y: 16, text: 'TILT', size: 1 }),
        el('meter', { x: 34, y: 16, width: 92, height: 8, binding: 'a' }),
        el('text', { x: 0, y: 30, text: 'DAMP', size: 1 }),
        el('meter', { x: 34, y: 30, width: 92, height: 8, binding: 'b' }),
        el('text', { x: 0, y: 44, text: 'HAND', size: 1 }),
        el('meter', { x: 34, y: 44, width: 92, height: 8, binding: 'c' }),
        el('scope', { x: 0, y: 56, width: 128, height: 8, binding: 'd' })
      ])
    },
    { x: 360, y: 320 }
  )
  q.wire(imu, 'ax', oled, 'a')
  q.wire(imu, 'ay', oled, 'b')
  q.wire(tof, 'dist', oled, 'c')
  q.wire(rnd, 'out', oled, 'd')

  q.place('gyroscope', 'Motion', imu, { x: 140, y: 480 })
  q.place('tof', 'Ranger', tof, { x: 260, y: 480 })
  q.place('oled_ssd1306', 'Display', oled, { x: 380, y: 480 })
  q.place('pcm5102a', 'Line out', null, { x: 200, y: 640 }, { jumper: 'i2s' })
  return q
}


/* =====================================================================
 * 6. Code node — the escape hatch
 * ===================================================================== */

function daisyCodeDemo() {
  const q = new Patch(
    'daisy-code-node',
    'daisy_seed',
    'A wavefolder and a bitcrusher written by hand, in the patch, running on both sides.'
  )

  /*
   * Two nodes the catalog does not have, written in the node body. Both
   * run in the emulator (the worklet compiles the AST to closures) and
   * compile to firmware from the SAME AST, so what you hear is what the
   * device plays — verified by `npm run test:audio`.
   */
  const osc = q.node(
    'oscillator',
    { frequency: 110, amplitude: 0.7, waveform: 'triangle' },
    { x: -720, y: 0 }
  )

  // A folder: reflect the signal back on itself each time it passes ±1.
  // Three folds is enough to sound like one and cheap enough to run per
  // sample; a `while` would be unbounded and is not in the language.
  const folder = q.node(
    'code',
    {
      p1: 3.2,
      p2: 0.6,
      source: `// Wavefolder — reflect at +/-1, three times.
// p1 = drive, p2 = output level
float x = a * p1;
if (x > 1) { x = 2 - x; }
if (x < -1) { x = -2 - x; }
if (x > 1) { x = 2 - x; }
if (x < -1) { x = -2 - x; }
if (x > 1) { x = 2 - x; }
if (x < -1) { x = -2 - x; }
out = x * p2;`
    },
    { x: -440, y: -60 }
  )
  q.wire(osc, 'out', folder, 'a')

  // A crusher: quantise amplitude and hold every Nth sample. `state`
  // is what makes the sample-and-hold possible at all.
  const crusher = q.node(
    'code',
    {
      p1: 6,
      p2: 8,
      source: `// Bitcrush + downsample.
// p1 = bit depth, p2 = hold length in samples
state float held = 0;
state float count = 0;

count = count + 1;
if (count >= p2) {
  count = 0;
  float steps = pow(2, p1);
  held = round(a * steps) / steps;
}
out = held;`
    },
    { x: -180, y: -60 }
  )
  q.wire(folder, 'out', crusher, 'a')

  const filt = q.node('filter_svf', { frequency: 3200, resonance: 0.2 }, { x: 80, y: -60 })
  q.wire(crusher, 'out', filt, 'in')

  const verb = q.node('reverb', { size: 0.5, damp: 0.5, mix: 0.25 }, { x: 340, y: -60 })
  q.wire(filt, 'lp', verb, 'in')

  const out = q.node('audio_output', {}, { x: 600, y: -60 })
  q.wire(verb, 'out', out, 'left')
  q.wire(verb, 'out', out, 'right')

  // Knobs on the parameters that matter, so it is playable rather than
  // just readable.
  const kDrive = q.node('knob_in', { channel: '1', min: 1, max: 8, value: 0.35 }, { x: -720, y: 220 })
  const kFold = q.node('knob_in', { channel: '2', min: 0.1, max: 1, value: 0.6 }, { x: -720, y: 320 })
  const kBits = q.node('knob_in', { channel: '3', min: 1, max: 12, value: 0.45 }, { x: -720, y: 420 })
  const kCut = q.node('knob_in', { channel: '4', min: 200, max: 9000, value: 0.5 }, { x: -720, y: 520 })
  q.wire(kCut, 'out', filt, 'cv_cutoff')

  q.place('pot', 'Drive', kDrive, { x: 120, y: 600 })
  q.place('pot', 'Fold', kFold, { x: 220, y: 600 })
  q.place('pot', 'Bits', kBits, { x: 320, y: 600 })
  q.place('pot', 'Tone', kCut, { x: 420, y: 600 })
  return q
}

/* =====================================================================
 * build + verify
 * ===================================================================== */


function daisyStateBox() {
  const q = new Patch(
    'daisy-state-box',
    'daisy_seed',
    'One button, four modes. A state machine picks which voice the knobs and ' +
      'the output belong to — the logic layer doing what it is for.'
  )

  /*
   * THE POINT OF THIS EXAMPLE. Every other patch here is a signal chain:
   * audio in at the left, audio out at the right, knobs modulating things
   * in between. This one has BEHAVIOUR. A single button walks a state
   * machine, the state selects which of four voices reaches the output, and
   * the same button held long enough resets to the first mode.
   *
   * The state is a CV, not a hidden setting, which is the whole design rule
   * of the logic layer — so it can drive the LED brightness at the same
   * time as it drives the router, with no special support for either.
   */
  const btn = q.node('button', { mode: 'momentary' }, { x: -900, y: 160 })

  // Debounce. A mechanical button on a GPIO chatters; without this the
  // state machine advances three modes per press and it looks broken.
  const debounce = q.node('timer', { time: 25, mode: 'gateoff' }, { x: -700, y: 160 })
  const press = q.node('edge', { mode: 'rising' }, { x: -520, y: 160 })

  // Hold the button for a second and it resets to mode 0 instead of
  // advancing — the same control doing two things, told apart by time.
  const hold = q.node('timer', { time: 1000, mode: 'delay', retrigger: 'restart' }, { x: -700, y: 300 })

  const state = q.node('state_machine', { states: 4, mode: 'wrap' }, { x: -320, y: 200 })

  q.wire(btn, 'out', debounce, 'trigger')
  q.wire(debounce, 'out', press, 'in')
  q.wire(press, 'out', state, 'next')
  q.wire(debounce, 'out', hold, 'trigger')
  q.wire(hold, 'out', state, 'reset')

  // Four voices, one per mode. Deliberately different in character so the
  // mode change is obvious without looking at anything.
  const clk = q.node('clock', { bpm: 110 }, { x: -900, y: -420 })

  const v0 = q.node('oscillator', { frequency: 110, amplitude: 0.5, waveform: 'sawtooth' }, { x: -320, y: -520 })
  const v1 = q.node('karplus', { frequency: 220, damping: 0.4, feedback: 0.99 }, { x: -320, y: -380 })
  const v2 = q.node('drum_kick', { tune: 55, decay: 0.5, punch: 0.6 }, { x: -320, y: -240 })
  const v3 = q.node('fm2', { frequency: 220, mod_ratio: 2.5, mod_index: 4, carrier_amp: 0.5 }, { x: -320, y: -100 })

  q.wire(clk, 'out', v1, 'trigger')
  q.wire(clk, 'out', v2, 'trigger')

  // The router. `sel` takes the state machine's normalised CV directly —
  // that is why `state` is 0..1 rather than a raw index.
  const sel = q.node('select', { mode: 'switch' }, { x: -60, y: -300 })
  q.wire(v0, 'out', sel, 'in0')
  q.wire(v1, 'out', sel, 'in1')
  q.wire(v2, 'out', sel, 'in2')
  q.wire(v3, 'out', sel, 'in3')
  q.wire(state, 'state', sel, 'sel')

  // Two knobs whose meaning is the same in every mode: tone and space.
  const kTone = q.node('knob_in', {}, { x: -900, y: -180 })
  const kSpace = q.node('knob_in', {}, { x: -900, y: -40 })
  const toneScaled = q.node('scale', { scale: 5800, offset: 200 }, { x: -700, y: -180 })
  const filt = q.node('filter_svf', { frequency: 2000, resonance: 0.25 }, { x: 160, y: -300 })
  const verb = q.node('reverb', { size: 0.6, damp: 0.4, mix: 0.25 }, { x: 380, y: -300 })

  q.wire(kTone, 'out', toneScaled, 'in')
  q.wire(toneScaled, 'out', filt, 'cv_cutoff')
  q.wire(sel, 'out', filt, 'in')
  q.wire(filt, 'lp', verb, 'in')
  q.wire(kSpace, 'out', verb, 'cv_mix')

  const out = q.node('audio_output', {}, { x: 620, y: -300 })
  q.wire(verb, 'out', out, 'left')
  q.wire(verb, 'out', out, 'right')

  /*
   * The mode LED. `state` is 0..1 across four modes, so the LED gets
   * brighter as you advance — a readout that costs one cable because the
   * state was a signal all along.
   */
  const led = q.node('led', {}, { x: -60, y: 200 })
  q.wire(state, 'state', led, 'in')

  q.place('button', 'MODE', btn, { x: 40, y: 250 })
  q.place('pot', 'TONE', kTone, { x: 40, y: 60 })
  q.place('pot', 'SPACE', kSpace, { x: 130, y: 60 })
  q.place('led', 'MODE', led, { x: 130, y: 250 })

  return q
}

/** Warnings that are expected and fine; anything else is reported. */
const BENIGN = [
  /oled draw is approximate/,
  /using default I2C1 pins/,
  /unbound — bind/,
  /not bound to a pinned sensor/,
  /is not a numeric param/
]

const builders = [
  daisySampler,
  esp32Sequencer,
  daisyTracker,
  esp32Drone,
  esp32Gesture,
  daisyCodeDemo,
  daisyStateBox
]

mkdirSync(OUT_DIR, { recursive: true })
let problems = 0

for (const build of builders) {
  let q
  try {
    q = build()
  } catch (err) {
    console.error(`[FAIL] ${build.name}: ${err.message}`)
    problems++
    continue
  }

  const json = JSON.stringify(q.toJSON(), null, 2) + '\n'
  const file = path.join(OUT_DIR, `${q.name}.dpatch`)

  if (checkOnly) {
    let prev = ''
    try {
      prev = readFileSync(file, 'utf8')
    } catch {
      /* missing */
    }
    if (prev !== json) {
      console.error(`[DRIFT] ${q.name}.dpatch differs from the builder — re-run without --check`)
      problems++
    }
  } else {
    writeFileSync(file, json, 'utf8')
  }

  // Does it actually generate firmware?
  let proj
  try {
    proj = generateProject(q.toJSON().graph, q.toJSON().hardware, q.name, q.board, {
      daisyFlashMode: 'qspi'
    })
  } catch (err) {
    console.error(`[FAIL] ${q.name}: generateProject threw — ${err.message}`)
    problems++
    continue
  }
  const notable = (proj.warnings ?? []).filter((w) => !BENIGN.some((re) => re.test(w)))
  const pinCount = q.components.reduce((n, c) => n + Object.keys(c.pins).length, 0)
  console.log(
    `[OK]   ${q.name.padEnd(20)} ${String(q.board).padEnd(19)} ` +
      `${String(q.nodes.length).padStart(2)} nodes, ${String(q.connections.length).padStart(2)} cables, ` +
      `${q.components.length} components / ${pinCount} pins`
  )
  for (const w of notable) {
    console.error(`       ! ${w}`)
    problems++
  }
}

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* nop */
}

if (problems > 0) {
  console.error(`\n[examples] ${problems} problem(s)`)
  process.exit(1)
}
console.log(`\n[examples] ${builders.length} patches ${checkOnly ? 'verified' : 'written'} to examples/`)
