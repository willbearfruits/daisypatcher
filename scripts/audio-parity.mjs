#!/usr/bin/env node
// Does the emulator sound like the firmware?
//
// Nothing checked this. The app plays AudioWorklets; the device runs
// generated C++ against DaisySP; the two are separate implementations of
// the same node catalog and could drift apart silently forever. The
// snapshot tests compare generated TEXT, the contract test compares
// STRUCTURE, and the compile harness proves it BUILDS — none of them
// listens.
//
// This does. For each fixture:
//   1. render it through the real emulator worklets, headlessly (Node with
//      the five AudioWorklet globals shimmed — see lib/renderEmulator.mjs),
//   2. compile the generated Daisy firmware for THIS machine and render the
//      same length (DaisySP is portable C++, so its DSP is the device's
//      DSP; only libDaisy's hardware half is stubbed — see host/),
//   3. compare peak, RMS and the sample-wise difference.
//
// Usage:
//   node scripts/audio-parity.mjs
//   node scripts/audio-parity.mjs --only bare-osc-out --seconds 2
//   node scripts/audio-parity.mjs --write-wav /tmp/parity   (both sides, to listen)
//
// SCOPE, stated rather than implied: Daisy only, and only patches with no
// hardware bindings. A knob reads a real potentiometer on the device and a
// slider in the app; there is no comparison to make, so those are skipped
// with a reason rather than silently passed.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { renderGraph, compare } from './lib/renderEmulator.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DAISYSP = path.resolve(process.env.HOME, '.config/daisypatcher/sdk/DaisySP')
const HOST_DIR = path.join(ROOT, 'scripts', 'host')
const BUILD_DIR = '/tmp/dp-parity'

/* ---- CLI ---- */
const argv = process.argv.slice(2)
let only = null
let seconds = 1
let wavDir = null
let kindsMode = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only' && argv[i + 1]) only = new Set(argv[++i].split(','))
  else if (argv[i] === '--seconds' && argv[i + 1]) seconds = Number(argv[++i])
  else if (argv[i] === '--write-wav' && argv[i + 1]) wavDir = argv[++i]
  else if (argv[i] === '--kinds') kindsMode = true
}

/*
 * How close is close enough.
 *
 * Not zero. The emulator runs 128-sample quanta and the device 48, and any
 * node holding per-block state (envelope segments, LFO phase increments,
 * the granulator's spawn counter) lands its transitions on a different
 * grid. That is a real and acceptable difference. What is NOT acceptable is
 * a different waveform, a different level, or silence on one side — which
 * is what these thresholds catch.
 */
const RMS_RATIO_TOL = 0.08 // 8% level difference
const RMS_DIFF_TOL = 0.35 // sample-wise divergence, relative to signal

/**
 * Kinds whose output is random by construction.
 *
 * The device draws from the STM32's hardware RNG (or an LCG on ESP32) and
 * the emulator from `Math.random()`. There is no seed that makes those
 * agree, and there should not be — a noise source that produced the same
 * noise every run would be the bug.
 *
 * So these are compared statistically, on a band wide enough to absorb the
 * sampling error of a short render. That is a genuinely weaker check, and
 * it is labelled as one in the output rather than being quietly folded in
 * with the exact matches. What it still catches is the failure that
 * actually happened here: `dust` firing a one-sample impulse on the device
 * against a 5 ms gate in the app, which is a 240x energy difference no
 * amount of sampling error explains.
 */
const STOCHASTIC_KINDS = new Set(['random', 'dust', 'noise', 'drum_snare', 'drum_hat', 'sample_hold', 'karplus', 'granulator'])
const STOCHASTIC_RMS_TOL = 0.35

/* ---- load the catalog (ESM: the worklet registry uses import.meta) ---- */
const require_ = createRequire(import.meta.url)
const esbuild = require_(path.join(ROOT, 'node_modules/esbuild'))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dp-parity-'))
const ENTRY = path.join(tmp, 'e.ts')
const BUNDLE = path.join(tmp, 'b.mjs')
const p = (rel) => path.join(ROOT, rel).replace(/\\/g, '/')

writeFileSync(
  ENTRY,
  [
    `export { NODE_DEFINITIONS } from '${p('src/nodes/definitions')}'`,
    `export { WORKLET_REGISTRY } from '${p('src/audio/worklets/registry')}'`,
    `export { generateProject } from '${p('src/codegen/generateProject')}'`,
    `export { tryParseCode } from '${p('src/codegen/codeNode/lang')}'`
  ].join('\n'),
  'utf8'
)
await esbuild.build({
  entryPoints: [ENTRY],
  outfile: BUNDLE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'error',
  alias: { '@': path.join(ROOT, 'src') },
  external: ['react', 'react-dom']
})
const { NODE_DEFINITIONS, WORKLET_REGISTRY, generateProject, tryParseCode } = await import(
  pathToFileURL(BUNDLE).href
)

/**
 * Mirrors `AudioEngine.postCodeAst`. A `code` node's worklet runs a parsed
 * AST, not source text, so a renderer that posts only the raw params gets
 * silence — which would read as a DSP bug rather than a harness gap.
 */
/**
 * A deterministic stand-in sample.
 *
 * `sample_player` would otherwise compare silence to silence — the test rig
 * has no library to pick from, so both sides would play nothing and the row
 * would go green having proved nothing. This is a fixed 0.25 s tone with a
 * short fade, generated identically here and handed to BOTH the emulator
 * (over the port) and codegen (as the sample bank), which is exactly the
 * arrangement the app uses.
 */
const PARITY_SAMPLE_ID = 'parity-tone'
function paritySample(sampleRate) {
  const n = Math.round(sampleRate * 0.25)
  const pcm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, (n - i) / (sampleRate * 0.05))
    pcm[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.8 * fade
  }
  return { channels: [pcm], sampleRate, frames: n }
}

const postExtras = (node, post, postRaw) => {
  if (node.kind === 'code') {
    const parsed = tryParseCode(String(node.params.source ?? ''))
    if ('program' in parsed) post('ast', parsed.program)
    return
  }
  if (node.kind === 'sample_player') {
    const s = paritySample(48000)
    postRaw({ type: 'sample', pcm: s.channels[0], sampleRate: s.sampleRate })
  }
}

/* ---- DaisySP sources, compiled once into objects we reuse ---- */
function daisyspSources() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.cpp')) out.push(full)
    }
  }
  walk(path.join(DAISYSP, 'Source'))
  // ReverbSc and MoogLadder live in the LGPL half, which the generated
  // Makefile opts into with USE_DAISYSP_LGPL=1. Same here or a reverb
  // patch does not link.
  const lgpl = path.join(DAISYSP, 'DaisySP-LGPL', 'Source')
  if (existsSync(lgpl)) walk(lgpl)
  return out
}

/* ---- per-kind fixtures ---------------------------------------------------
 *
 * A whole-patch disagreement tells you a patch is wrong; it does not tell
 * you which node. `--kinds` builds the smallest graph that can make each
 * kind audible and compares those, so a failure names the emitter to fix.
 * The shapes mirror the compile harness's test graphs so the two tools
 * disagree about as little as possible.
 */
function kindFixtures() {
  const out = []
  let uid = 0
  const mk = (kind, extra = {}) => {
    const params = {}
    for (const q of NODE_DEFINITIONS[kind].params) params[q.id] = q.default
    Object.assign(params, extra)
    return { id: `n${++uid}_${kind}`, kind, position: { x: 0, y: 0 }, params }
  }

  for (const kind of Object.keys(NODE_DEFINITIONS)) {
    if (only && !only.has(kind)) continue
    const def = NODE_DEFINITIONS[kind]
    // Hardware-bound and sink kinds have nothing to compare headlessly.
    if (def.category === 'hardware' || def.params.some((p) => p.id === 'bindingId')) continue
    if (kind === 'audio_output' || kind === 'audio_in') continue
    const outSock =
      def.outputs.find((s) => s.signal === 'audio') ??
      def.outputs.find((s) => s.signal === 'cv') ??
      def.outputs.find((s) => s.signal === 'gate')
    if (!outSock) continue

    uid = 0
    /*
     * A sample player with no sample selected is silent on both sides,
     * which would bank a green row proving nothing. Point it at the
     * synthetic tone that `postExtras` and the sample bank both supply.
     */
    const node = mk(kind, kind === 'sample_player' ? { sampleId: PARITY_SAMPLE_ID } : {})
    const sink = mk('audio_output')
    const nodes = [node, sink]
    const conns = []
    let c = 0
    const wire = (a, as, b, bs) =>
      conns.push({ id: `c${++c}`, from: { nodeId: a, socketId: as }, to: { nodeId: b, socketId: bs } })

    // Feed the first audio input, so processors have something to chew on.
    const audioIn = def.inputs.find((s) => s.signal === 'audio')
    if (audioIn) {
      const osc = mk('oscillator', { frequency: 220, amplitude: 0.5, waveform: 'sawtooth' })
      nodes.push(osc)
      wire(osc.id, 'out', node.id, audioIn.id)
    }
    /*
     * EVERY gate input gets its own clock, each slower than the last.
     *
     * Feeding only the first one made whole nodes compare silence to
     * silence and bank a green row: a `logic` node with `a` clocked and `b`
     * dangling is an AND against zero, which is a correct implementation of
     * nothing. Distinct rates also mean the inputs interact — `inc` against
     * a slower `reset` on a counter is the case where an off-by-one shows
     * up — while keeping the later inputs (conventionally `reset`) rare
     * enough not to hold the node in its initial state forever.
     */
    const gateIns = def.inputs.filter((s) => s.signal === 'gate')
    gateIns.forEach((sock, gi) => {
      /*
       * A reset gets a MUCH slower clock than everything else. A reset
       * firing every other step is not a test of a sequencer, it is a test
       * of reset — the node never advances far enough to reach a pattern
       * hit and both sides go silent, which reads as agreement. One reset
       * per 16 steps lets the node run and still exercises the path.
       */
      const isReset = /^(reset|rst)$/.test(sock.id)
      const bpm = isReset ? 15 : 240 / (gi + 1)
      const clk = mk('clock', { bpm, pulse_width: 0.2 })
      nodes.push(clk)
      wire(clk.id, 'out', node.id, sock.id)
    })

    /*
     * The node's output goes STRAIGHT to the sink, whatever its signal
     * kind. Routing a CV through a VCA or a gate through an envelope, the
     * way the compile harness does, measures the node plus the scaffolding
     * — and when they disagree you cannot tell which one moved. The editor
     * would refuse a gate-to-audio cable and is right to, but this is a
     * measurement rig, and both codegen paths simply read the upstream
     * variable, so the comparison is exact.
     */
    wire(node.id, outSock.id, sink.id, 'left')
    wire(node.id, outSock.id, sink.id, 'right')

    out.push({
      name: kind,
      graph: { nodes, connections: conns, meta: { name: kind, sampleRate: 48000, blockSize: 48 } },
      hardware: undefined
    })
  }
  return out
}

/* ---- fixtures ---- */
function loadFixtures() {
  const out = []
  const dir = path.join(ROOT, 'scripts', 'snapshot-patches')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const name = f.slice(0, -5)
    if (only && !only.has(name)) continue
    const data = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    out.push({ name, graph: data.graph, hardware: data.hardware })
  }
  return out
}

/** Anything bound to physical hardware cannot be compared headlessly. */
function hardwareReason(fixture) {
  const bound = fixture.graph.nodes.filter(
    (n) => typeof n.params?.bindingId === 'string' && n.params.bindingId
  )
  if (bound.length > 0) {
    return `reads hardware (${[...new Set(bound.map((n) => n.kind))].join(', ')})`
  }
  const comps = fixture.hardware?.components?.length ?? 0
  if (comps > 0) return `hardware layout has ${comps} component(s)`
  return null
}

/* ---- render the firmware on this machine ---- */

/**
 * DaisySP + the harness, compiled once into a cached archive.
 *
 * Forty-one sources per fixture is a minute of pointless work; they never
 * change between fixtures. Keyed on nothing clever — delete /tmp/dp-parity
 * to force a rebuild after an SDK update.
 */
let cachedLib = null
function buildDaisyspArchive() {
  if (cachedLib) return cachedLib
  const objDir = path.join(BUILD_DIR, '_lib')
  const archive = path.join(objDir, 'libdaisysp.a')
  const hostObj = path.join(objDir, 'dp_host_main.o')
  if (existsSync(archive) && existsSync(hostObj)) {
    cachedLib = { archive, hostObj }
    return cachedLib
  }
  mkdirSync(objDir, { recursive: true })
  console.log('[parity] compiling DaisySP for the host (cached after this run)…')

  const objs = []
  for (const src of DAISYSP_SOURCES) {
    const o = path.join(objDir, path.basename(src).replace(/\.cpp$/, '.o'))
    const r = spawnSync('g++', [...COMMON_FLAGS, '-c', src, '-o', o], { encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`DaisySP source failed to compile: ${src}\n${r.stderr?.slice(0, 400)}`)
    }
    objs.push(o)
  }
  const ar = spawnSync('ar', ['rcs', archive, ...objs], { encoding: 'utf8' })
  if (ar.status !== 0) throw new Error(`ar failed: ${ar.stderr}`)

  const h = spawnSync('g++', [...COMMON_FLAGS, '-c', path.join(HOST_DIR, 'dp_host_main.cpp'), '-o', hostObj], {
    encoding: 'utf8'
  })
  if (h.status !== 0) throw new Error(`harness failed to compile:\n${h.stderr?.slice(0, 800)}`)

  cachedLib = { archive, hostObj }
  return cachedLib
}

function renderFirmware(name, files, totalSamples, blockSize) {
  const dir = path.join(BUILD_DIR, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const srcFile = path.join(dir, 'patch.cpp')
  writeFileSync(srcFile, files['main.cpp'], 'utf8')

  const lib = buildDaisyspArchive()
  const obj = path.join(dir, 'patch.o')
  const bin = path.join(dir, 'patch')

  /*
   * `-Dmain=` is applied ONLY to the patch, never to the harness — the
   * harness needs to keep its own `main`, and a project-wide define
   * renamed both and left nothing for the linker to start from.
   */
  const c = spawnSync('g++', [...COMMON_FLAGS, '-Dmain=dp_patch_main', '-c', srcFile, '-o', obj], {
    encoding: 'utf8',
    timeout: 300000
  })
  if (c.status !== 0) {
    return { error: firstErrors(c) }
  }
  const l = spawnSync('g++', [obj, lib.hostObj, lib.archive, '-o', bin, '-lm'], {
    encoding: 'utf8',
    timeout: 300000
  })
  if (l.status !== 0) {
    return { error: firstErrors(l) }
  }

  const r = spawnSync(bin, [String(totalSamples), String(blockSize)], {
    encoding: 'buffer',
    maxBuffer: 1 << 28,
    timeout: 120000
  })
  if (r.status !== 0) {
    return { error: `run failed: ${(r.stderr?.toString() ?? '').slice(0, 200)}` }
  }
  const buf = r.stdout
  const n = Math.floor(buf.length / 4 / 2)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    left[i] = buf.readFloatLE(i * 2 * 4)
    right[i] = buf.readFloatLE((i * 2 + 1) * 4)
  }
  return { left, right }
}

function firstErrors(r) {
  return (
    (r.stderr || r.stdout || '')
      .split('\n')
      .filter((l) => /error|undefined reference|No such file/i.test(l))
      .slice(0, 4)
      .join(' | ') || 'build failed'
  )
}

/* ---- 32-bit float WAV, for listening to a disagreement ---- */
function writeWav(file, left, right, sampleRate) {
  const n = left.length
  const dataBytes = n * 2 * 4
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(3, 20) // IEEE float
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2 * 4, 28)
  buf.writeUInt16LE(8, 32)
  buf.writeUInt16LE(32, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(left[i], 44 + i * 8)
    buf.writeFloatLE(right[i], 44 + i * 8 + 4)
  }
  writeFileSync(file, buf)
}

/* ---- run ---- */

if (!existsSync(DAISYSP)) {
  console.error(`[parity] DaisySP not found at ${DAISYSP} — run the app once to install the SDK`)
  process.exit(1)
}
const gxx = spawnSync('g++', ['--version'], { encoding: 'utf8' })
if (gxx.status !== 0) {
  console.error('[parity] g++ not found on PATH')
  process.exit(1)
}

const DAISYSP_SOURCES = daisyspSources()
const COMMON_FLAGS = [
  '-std=c++17',
  '-O2',
  '-w', // multi-output nodes legitimately leave some taps unused
  // Matches `USE_DAISYSP_LGPL = 1` in the generated Makefile — without it
  // daisysp.h hides ReverbSc and MoogLadder behind an #ifdef and a reverb
  // patch fails to compile for a reason that has nothing to do with the patch.
  '-DUSE_DAISYSP_LGPL=1',
  `-I${HOST_DIR}`,
  `-I${path.join(DAISYSP, 'Source')}`,
  `-I${path.join(DAISYSP, 'Source', 'Utility')}`,
  `-I${path.join(DAISYSP, 'DaisySP-LGPL', 'Source')}`
]
console.log(`[parity] DaisySP: ${DAISYSP_SOURCES.length} sources`)
mkdirSync(BUILD_DIR, { recursive: true })
if (wavDir) mkdirSync(wavDir, { recursive: true })

const fixtures = kindsMode ? kindFixtures() : loadFixtures()
let failures = 0
let compared = 0
const rows = []

for (const fx of fixtures) {
  const skip = hardwareReason(fx)
  if (skip) {
    rows.push({ name: fx.name, status: 'skipped', note: skip })
    continue
  }

  const blockSize = fx.graph.meta?.blockSize ?? 48
  const sampleRate = fx.graph.meta?.sampleRate ?? 48000

  /*
   * Random sources get a longer render.
   *
   * `random` free-runs at 2 Hz, so a one-second capture draws TWO values
   * on each side and then compares their RMS — which is sampling noise
   * with a number printed next to it, not a measurement. Four seconds is
   * enough draws for the statistics to mean something, and the cost is
   * only paid by the handful of kinds that need it.
   */
  const stochasticKind = fx.kind ? STOCHASTIC_KINDS.has(fx.kind) : STOCHASTIC_KINDS.has(fx.name)
  const renderSeconds = stochasticKind ? Math.max(seconds, 4) : seconds
  const totalSamples = Math.round(renderSeconds * sampleRate)

  const emu = await renderGraph({
    graph: fx.graph,
    definitions: NODE_DEFINITIONS,
    registry: WORKLET_REGISTRY,
    workletDir: path.join(ROOT, 'src/audio/worklets'),
    sampleRate,
    seconds: renderSeconds,
    postExtras
  })

  /*
   * The same synthetic sample the emulator is handed above. A parity run
   * where one side has audio and the other does not is not a comparison.
   */
  const usesSample = fx.graph.nodes.some((n) => n.kind === 'sample_player')
  const proj = generateProject(fx.graph, fx.hardware, fx.name, 'daisy_seed', {
    daisyFlashMode: 'qspi',
    samples: usesSample ? { [PARITY_SAMPLE_ID]: paritySample(sampleRate) } : {}
  })
  const fw = renderFirmware(fx.name, proj.files, totalSamples, blockSize)
  if (fw.error) {
    rows.push({ name: fx.name, status: 'build', note: fw.error })
    failures++
    continue
  }

  const cmp = compare(emu.left, fw.left)
  compared++

  if (wavDir) {
    writeWav(path.join(wavDir, `${fx.name}.emulator.wav`), emu.left, emu.right, sampleRate)
    writeWav(path.join(wavDir, `${fx.name}.firmware.wav`), fw.left, fw.right, sampleRate)
  }

  // Both silent is agreement, not a division by zero.
  const bothSilent = cmp.rmsA < 1e-6 && cmp.rmsB < 1e-6
  const oneSilent = !bothSilent && (cmp.rmsA < 1e-6 || cmp.rmsB < 1e-6)
  const levelRatio = Math.abs(cmp.rmsA - cmp.rmsB) / Math.max(1e-9, Math.max(cmp.rmsA, cmp.rmsB))

  const stochastic = stochasticKind

  let status = 'ok'
  let note = ''
  if (bothSilent) {
    // Agreement, but vacuous — say so rather than banking a green row that
    // proves only that neither side made a sound.
    note = 'both silent'
  }
  if (oneSilent) {
    status = 'FAIL'
    note = cmp.rmsA < 1e-6 ? 'emulator is silent, firmware is not' : 'firmware is silent, emulator is not'
  } else if (!bothSilent && levelRatio > (stochastic ? STOCHASTIC_RMS_TOL : RMS_RATIO_TOL)) {
    status = 'FAIL'
    note = `level differs by ${(levelRatio * 100).toFixed(1)}%`
  } else if (stochastic) {
    // Sample-wise comparison is meaningless for these; say so instead of
    // emitting a warning that can never be cleared.
    note = note || `level only (random source, +/-${Math.round(STOCHASTIC_RMS_TOL * 100)}%)`
  } else if (!bothSilent && cmp.rmsDiffRelative > RMS_DIFF_TOL) {
    status = 'WARN'
    note = `waveform differs (rel rms diff ${cmp.rmsDiffRelative.toFixed(2)})`
  }
  if (status === 'FAIL') failures++

  rows.push({
    name: fx.name,
    status,
    note,
    emuRms: cmp.rmsA,
    fwRms: cmp.rmsB,
    emuPeak: cmp.peakA,
    fwPeak: cmp.peakB,
    rel: cmp.rmsDiffRelative
  })
}

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* nop */
}

console.log('')
console.log('patch                      emu rms   fw rms  emu pk   fw pk   rel diff  status')
console.log('---------------------------------------------------------------------------')
for (const r of rows) {
  if (r.status === 'skipped' || r.status === 'build') {
    console.log(`${r.name.padEnd(26)} ${'—'.padStart(8)} ${'—'.padStart(8)} ${'—'.padStart(7)} ${'—'.padStart(7)} ${'—'.padStart(9)}  ${r.status} (${r.note})`)
  } else {
    console.log(
      `${r.name.padEnd(26)} ${r.emuRms.toFixed(4).padStart(8)} ${r.fwRms.toFixed(4).padStart(8)} ` +
        `${r.emuPeak.toFixed(3).padStart(7)} ${r.fwPeak.toFixed(3).padStart(7)} ` +
        `${r.rel.toFixed(3).padStart(9)}  ${r.status}${r.note ? ' — ' + r.note : ''}`
    )
  }
}
console.log('')
if (wavDir) console.log(`[parity] wrote wavs to ${wavDir}`)
console.log(`[parity] compared ${compared} patch(es), ${failures} failure(s)`)
process.exit(failures > 0 ? 1 : 0)
