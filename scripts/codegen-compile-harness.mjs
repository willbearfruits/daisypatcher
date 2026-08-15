#!/usr/bin/env node
// Per-node compile harness for Daisypatcher — ALL targets.
//
// `npm run test:codegen` diffs generated text against stored text. It never
// invokes a compiler, which is why 120 green snapshots once encoded C++ that
// did not build (thirteen ESP32 emitters declared their output variable
// inside a braced scope). This harness is the other half of the safety net:
// it hands every NodeKind to a real compiler on every board.
//
// For each (target, kind):
//   1. Build a minimal test graph that routes the node into audio_output.
//   2. Call generateProject() for that target.
//   3. Write the project and run the target's real build command.
//   4. Record status (ok / skipped / codegen_error / compile_error /
//      link_error / timeout).
//
// Writes /tmp/dp-harness/REPORT.md with a per-target breakdown and a
// kind x target matrix, and prints it to stdout.
//
// Usage:
//   node scripts/codegen-compile-harness.mjs
//   node scripts/codegen-compile-harness.mjs --targets daisy_seed
//   node scripts/codegen-compile-harness.mjs --only oscillator,adsr
//   node scripts/codegen-compile-harness.mjs --targets esp32_c3_supermini --clean
//
// Requires the libDaisy/DaisySP clones at ~/.config/daisypatcher/sdk/ for the
// Daisy target, and `pio` on PATH for the ESP32 targets. A target whose
// toolchain is missing is reported as such rather than failing every kind.
//
// BUILD STRATEGY differs by family, because the two toolchains cache
// differently:
//
//   Daisy — libDaisy and DaisySP are prebuilt static libraries referenced
//     through LIBDAISY_DIR/DAISYSP_DIR, so a fresh project dir only compiles
//     main.cpp. One dir per kind, four in parallel.
//
//   ESP32 — PlatformIO builds the whole Arduino framework into
//     `.pio/build/<env>/`, which takes minutes. A dir per kind would pay
//     that ~65 times per board. So kinds are grouped by the hash of their
//     generated `platformio.ini` (which varies only with OLED lib_deps and
//     the PSRAM block) and each group shares ONE warm project dir, rebuilt
//     incrementally by overwriting `src/main.cpp`. Groups run in parallel;
//     kinds within a group run sequentially, because they share a dir.
//
// This file is *diagnostic scaffolding* — not a runtime part of the app.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

const PROJECT_ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const TMP_ROOT = '/tmp/dp-harness'
const BUNDLE_PATH = path.join(TMP_ROOT, 'codegen-bundle.cjs')
const LIBDAISY_DIR = path.resolve(process.env.HOME, '.config/daisypatcher/sdk/libDaisy')
const DAISYSP_DIR = path.resolve(process.env.HOME, '.config/daisypatcher/sdk/DaisySP')

/** A Daisy `make` only compiles main.cpp against prebuilt libs. */
const DAISY_TIMEOUT_MS = 60_000
/** First `pio run` in a dir builds the whole Arduino framework. */
const PIO_COLD_TIMEOUT_MS = 900_000
/** Subsequent runs recompile main.cpp and relink. */
const PIO_WARM_TIMEOUT_MS = 240_000

const DAISY_CONCURRENCY = 4
/** Parallel warm pio dirs. Each `pio run` is itself multi-core. */
const PIO_CONCURRENCY = 3

// ---- CLI ----
const args = process.argv.slice(2)
let onlyFilter = null
let targetFilter = null
let clean = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only' && args[i + 1]) {
    onlyFilter = new Set(args[++i].split(','))
  } else if (args[i] === '--targets' && args[i + 1]) {
    targetFilter = new Set(args[++i].split(','))
  } else if (args[i] === '--clean') {
    clean = true
  }
}

if (clean) {
  console.log('[harness] --clean: removing all cached build dirs')
  try { rmSync(TMP_ROOT, { recursive: true, force: true }) } catch { /* nop */ }
}
mkdirSync(TMP_ROOT, { recursive: true })

// ---- Step 1: bundle codegen with esbuild (programmatic API) ----
console.log('[harness] bundling codegen via esbuild…')
const require_ = createRequire(import.meta.url)
const esbuild = require_(path.join(PROJECT_ROOT, 'node_modules/esbuild'))

const p = (rel) => path.join(PROJECT_ROOT, rel).replace(/\\/g, '/')

// Tiny entry file that re-exports what we need.
const ENTRY = path.join(TMP_ROOT, '_entry.ts')
writeFileSync(
  ENTRY,
  [
    `export { generateProject } from '${p('src/codegen/generateProject')}'`,
    `export { NODE_DEFINITIONS } from '${p('src/nodes/definitions')}'`,
    `export { emptyHardwareLayout } from '${p('src/types/hardware')}'`,
    `export { emptyGraph } from '${p('src/types/graph')}'`,
    `export { TARGETS } from '${p('src/codegen/targets/index')}'`,
    `export { supportLevel } from '${p('src/nodes/targetSupport')}'`,
    `export { BOARD_IDS, BOARD_FAMILY } from '${p('shared/boards')}'`
  ].join('\n'),
  'utf8'
)

await esbuild.build({
  entryPoints: [ENTRY],
  outfile: BUNDLE_PATH,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
  alias: {
    '@': path.join(PROJECT_ROOT, 'src')
  },
  // Drop browser-only peers that might sneak in via type re-exports.
  external: ['react', 'react-dom']
})

const mod = require_(BUNDLE_PATH)
const {
  generateProject,
  NODE_DEFINITIONS,
  emptyHardwareLayout,
  TARGETS,
  supportLevel,
  BOARD_IDS,
  BOARD_FAMILY
} = mod

// ---- Step 2: graph builder ----
let uid = 0
const nid = (k) => `n${++uid}_${k}`

function pickOutputSocket(def) {
  // Prefer audio, then cv, then gate.
  const byKind = (kind) => def.outputs.find((s) => s.signal === kind)
  return byKind('audio') ?? byKind('cv') ?? byKind('gate') ?? null
}

function makeNode(kind, extraParams = {}) {
  const def = NODE_DEFINITIONS[kind]
  const params = {}
  for (const p of def.params) params[p.id] = p.default
  Object.assign(params, extraParams)
  return { id: nid(kind), kind, position: { x: 0, y: 0 }, params }
}

function conn(from, to) {
  return {
    id: `c${++uid}`,
    from: { nodeId: from.nodeId, socketId: from.socketId },
    to: { nodeId: to.nodeId, socketId: to.socketId }
  }
}

function socketRef(node, socketId) {
  return { nodeId: node.id, socketId }
}

/** Kinds that want an oscillator on their first audio input. */
const WANTS_AUDIO_SOURCE = new Set([
  'gain', 'vca', 'delay', 'reverb', 'filter_svf', 'filter_moog', 'chorus',
  'overdrive', 'bitcrush', 'phaser', 'flanger', 'ping_pong', 'stereo_widener',
  'freeze', 'granulator', 'pitch_shifter', 'tremolo', 'vibrato', 'compressor',
  'limiter', 'noise_gate', 'wavefolder', 'clip', 'ring_mod', 'envelope_follower',
  'formant', 'pan', 'mixer4', 'sum', 'multiply', 'crossfade', 'scope', 'vu',
  'spectrum_scope', 'i2s_out'
])

/**
 * Build a minimal test graph that wires `kind` into audio_output.
 * Strategy per output signal kind:
 *   - audio: <kind> -> audio_output.left+right
 *   - cv:    <kind> -> vca.cv; oscillator -> vca.in; vca -> audio_output
 *   - gate:  <kind> -> adsr.gate; adsr -> vca.cv; oscillator -> vca.in; vca -> audio_output
 *
 * Inputs on <kind> are left unconnected (default values apply); if an input
 * exists and is "required" for sane compile (e.g. a gate trigger on drum_kick),
 * a gate_in is wired in.
 */
function buildTestGraph(kind) {
  uid = 0
  const def = NODE_DEFINITIONS[kind]

  const nodes = []
  const connections = []

  // audio_output is the sink — test is "can we generate+compile a patch that
  // contains the destination alone". No meaningful DSP to verify but any static
  // issues (includes, globals) will surface.
  if (kind === 'audio_output') {
    const sink = makeNode('audio_output')
    nodes.push(sink)
    return finishGraph(nodes, connections, kind)
  }

  // audio_in → output direct pass-through.
  if (kind === 'audio_in') {
    const src = makeNode('audio_in')
    const sink = makeNode('audio_output')
    nodes.push(src, sink)
    connections.push(
      conn(socketRef(src, 'left'), socketRef(sink, 'left')),
      conn(socketRef(src, 'right'), socketRef(sink, 'right'))
    )
    return finishGraph(nodes, connections, kind)
  }

  // oled — include with dummy constants on its inputs; no audio path expected.
  if (kind === 'oled') {
    // One of every element kind, so the compile check covers the full
    // generated DrawFrame body rather than an empty frame.
    const oledNode = makeNode('oled', {
      elements: JSON.stringify([
        { kind: 'text', x: 0, y: 0, text: 'TEST', size: 1 },
        { kind: 'value', x: 40, y: 0, binding: 'a', decimals: 2, unit: 'Hz' },
        { kind: 'meter', x: 0, y: 20, width: 40, height: 8, binding: 'b' },
        { kind: 'meter', x: 46, y: 12, width: 8, height: 20, orientation: 'v', binding: 'c' },
        { kind: 'scope', x: 64, y: 8, width: 60, height: 24, binding: 'd' },
        { kind: 'rect', x: 0, y: 34, width: 20, height: 12, fill: false },
        { kind: 'rect', x: 24, y: 34, width: 20, height: 12, fill: true },
        { kind: 'circle', x: 110, y: 52, radius: 6 },
        { kind: 'line', x: 0, y: 62, x2: 100, y2: 62 },
        { kind: 'pattern', x: 56, y: 40, cols: 8, rows: 2, cellSize: 4, binding: 'e' }
      ])
    })
    const sink = makeNode('audio_output')
    nodes.push(oledNode, sink)
    // Wire constants to any inputs that exist.
    for (const inSock of def.inputs) {
      const c = makeNode('constant')
      nodes.push(c)
      connections.push(conn(socketRef(c, 'out'), socketRef(oledNode, inSock.id)))
    }
    return finishGraph(nodes, connections, kind)
  }

  // menu — a two-level tree with one submenu, one value and one action, driven
  // by an encoder. Exercises every branch of the generated state machine
  // rather than an empty root.
  if (kind === 'menu') {
    // Real MenuTree shape (see src/editor/menu/tree.ts): a submenu holding an
    // enum leaf and a number leaf, plus a top-level number leaf. Covers both
    // leaf types, both delivery paths (CV out and a node/param target) and the
    // descend-then-edit path through the state machine.
    const menuNode = makeNode('menu', {
      tree: JSON.stringify({
        root: [
          {
            id: 'osc', kind: 'submenu', label: 'OSC',
            children: [
              {
                id: 'wave', kind: 'value', label: 'WAVE', type: 'enum',
                min: 0, max: 3, step: 1, options: ['SIN', 'TRI', 'SAW', 'SQR'],
                value: 0, defaultValue: 0, out: 'a'
              },
              {
                id: 'pitch', kind: 'value', label: 'PITCH', type: 'number',
                min: 0, max: 1, step: 0.01, value: 0.5, defaultValue: 0.5,
                unit: 'Hz', out: 'b'
              }
            ]
          },
          {
            id: 'gain', kind: 'value', label: 'GAIN', type: 'number',
            min: 0, max: 1, step: 0.05, value: 0.8, defaultValue: 0.8, out: 'c'
          }
        ],
        longPress: 'back',
        doubleClick: 'home',
        longMs: 500,
        doubleMs: 300
      })
    })
    const enc = makeNode('encoder_in')
    const osc = makeNode('oscillator')
    const oledNode = makeNode('oled', {
      elements: JSON.stringify([
        { id: 'el_menu', kind: 'menu', x: 0, y: 0, width: 128, height: 64, rows: 6, menuNodeId: menuNode.id }
      ])
    })
    const sink = makeNode('audio_output')
    nodes.push(menuNode, enc, oledNode, osc, sink)

    // Point the GAIN leaf at a real node param so the direct-write path
    // (menu leaf -> node param, no cable) is compiled too.
    {
      const tree = JSON.parse(String(menuNode.params.tree))
      const gain = tree.root.find((n) => n.id === 'gain')
      if (gain) gain.target = { nodeId: osc.id, paramId: 'amplitude' }
      menuNode.params.tree = JSON.stringify(tree)
    }

    // Wire encoder -> menu on whatever sockets the definitions actually expose,
    // so this survives a socket rename.
    const encOuts = NODE_DEFINITIONS.encoder_in.outputs
    for (const inSock of def.inputs) {
      const match = encOuts.find((o) => o.id === inSock.id) ?? encOuts.find((o) => o.signal === inSock.signal)
      if (match) connections.push(conn(socketRef(enc, match.id), socketRef(menuNode, inSock.id)))
    }
    // Menu's first cv output modulates the oscillator so the value is read.
    const firstOut = def.outputs.find((o) => o.signal === 'cv') ?? def.outputs[0]
    if (firstOut) {
      const oscIn = NODE_DEFINITIONS.oscillator.inputs.find((s) => s.id === 'cv_amp')
        ?? NODE_DEFINITIONS.oscillator.inputs.find((s) => s.signal === 'cv')
      if (oscIn) connections.push(conn(socketRef(menuNode, firstOut.id), socketRef(osc, oscIn.id)))
    }
    connections.push(
      conn(socketRef(osc, 'out'), socketRef(sink, 'left')),
      conn(socketRef(osc, 'out'), socketRef(sink, 'right'))
    )
    return finishGraph(nodes, connections, kind)
  }

  const target = makeNode(kind)
  nodes.push(target)

  // If the target has a gate input (trigger), wire a gate_in to it so drums,
  // karplus, adsr, etc. have a gate source present.
  for (const inSock of def.inputs) {
    if (inSock.signal === 'gate') {
      const g = makeNode('gate_in')
      nodes.push(g)
      connections.push(conn(socketRef(g, 'out'), socketRef(target, inSock.id)))
    } else if (inSock.signal === 'audio' && WANTS_AUDIO_SOURCE.has(kind)) {
      // Provide an oscillator on the FIRST audio input only to avoid feeding
      // the same source into every socket of a multi-input node (mixer/sum).
      const alreadyWired = connections.some(
        (c) => c.to.nodeId === target.id && c.to.socketId === inSock.id
      )
      const hasAnyAudioWired = connections.some((c) => {
        if (c.to.nodeId !== target.id) return false
        const sDef = def.inputs.find((s) => s.id === c.to.socketId)
        return sDef && sDef.signal === 'audio'
      })
      if (!alreadyWired && !hasAnyAudioWired) {
        const osc = makeNode('oscillator')
        nodes.push(osc)
        connections.push(conn(socketRef(osc, 'out'), socketRef(target, inSock.id)))
      }
    }
  }

  // Now route the target's output to audio_output.
  const outSock = pickOutputSocket(def)
  const sink = makeNode('audio_output')
  nodes.push(sink)

  if (!outSock) {
    // Target has no outputs (pure sink like i2s_out, midi_out_note, led, print).
    // Just include it; codegen should still emit something.
    return finishGraph(nodes, connections, kind)
  }

  if (outSock.signal === 'audio') {
    connections.push(
      conn(socketRef(target, outSock.id), socketRef(sink, 'left')),
      conn(socketRef(target, outSock.id), socketRef(sink, 'right'))
    )
  } else if (outSock.signal === 'cv') {
    // CV -> VCA.cv, osc -> VCA.in, VCA.out -> audio_output
    const osc = makeNode('oscillator')
    const vca = makeNode('vca')
    nodes.push(osc, vca)
    connections.push(
      conn(socketRef(target, outSock.id), socketRef(vca, 'cv')),
      conn(socketRef(osc, 'out'), socketRef(vca, 'in')),
      conn(socketRef(vca, 'out'), socketRef(sink, 'left')),
      conn(socketRef(vca, 'out'), socketRef(sink, 'right'))
    )
  } else if (outSock.signal === 'gate') {
    // Gate -> ADSR.gate, ADSR -> VCA.cv, osc -> VCA.in, VCA -> output
    const adsr = makeNode('adsr')
    const osc = makeNode('oscillator')
    const vca = makeNode('vca')
    nodes.push(adsr, osc, vca)
    connections.push(
      conn(socketRef(target, outSock.id), socketRef(adsr, 'gate')),
      conn(socketRef(adsr, 'out'), socketRef(vca, 'cv')),
      conn(socketRef(osc, 'out'), socketRef(vca, 'in')),
      conn(socketRef(vca, 'out'), socketRef(sink, 'left')),
      conn(socketRef(vca, 'out'), socketRef(sink, 'right'))
    )
  }

  return finishGraph(nodes, connections, kind)
}

function finishGraph(nodes, connections, kind) {
  return {
    nodes,
    connections,
    meta: { name: `${kind}_test`, sampleRate: 48000, blockSize: 48 }
  }
}

// ---- Step 3: process runner ----
function run(bin, argv, cwd, timeoutMs, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    let timedOut = false
    const t = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(t)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut })
    })
  })
}

function classifyFailure(stdout, stderr, timedOut) {
  if (timedOut) return { status: 'timeout', firstError: '[timeout]' }
  const combined = `${stdout}\n${stderr}`
  const lines = combined.split('\n')
  const firstErr =
    lines.find((l) => /error: |undefined reference|multiple definition|cannot find -l|No such file or directory/.test(l)) ??
    lines.find((l) => /Error \d+|\*\*\* |^Error:/.test(l)) ??
    lines.slice(-3).join(' | ').trim()

  // "region `dram0_0_seg' overflowed" is the ESP32 spelling of a link failure.
  const looksLikeLink =
    /undefined reference|multiple definition|ld returned|cannot find -l|overflowed by|section .* will not fit/.test(combined)

  return {
    status: looksLikeLink ? 'link_error' : 'compile_error',
    firstError: (firstErr || '(no error line found)').slice(0, 240)
  }
}

const sha8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** Codegen only — shared by both build strategies. */
function generateFor(target, kind) {
  const graph = buildTestGraph(kind)
  return generateProject(
    graph,
    emptyHardwareLayout(target),
    `${kind}_test`,
    target,
    { daisyFlashMode: 'qspi' }
  )
}

// ---- Step 4a: Daisy runner (one dir per kind, parallel) ----
async function runDaisyKind(target, kind) {
  const t0 = performance.now()
  const rec = { target, kind, status: 'ok', durationMs: 0, warnings: [] }

  let proj
  try {
    proj = generateFor(target, kind)
    rec.warnings = proj.warnings
  } catch (err) {
    rec.status = 'codegen_error'
    rec.firstError = (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)).slice(0, 240)
    rec.durationMs = Math.round(performance.now() - t0)
    return rec
  }

  const dir = path.join(TMP_ROOT, target, kind)
  const cached = readCache(dir, proj.files['main.cpp'])
  if (cached) return cached

  try { rmSync(dir, { recursive: true, force: true }) } catch { /* nop */ }
  writeProject(dir, proj.files)

  const { code, stdout, stderr, timedOut } = await run(
    'make', [], dir, DAISY_TIMEOUT_MS, { LIBDAISY_DIR, DAISYSP_DIR }
  )
  rec.durationMs = Math.round(performance.now() - t0)

  const binPath = path.join(dir, 'build', `${kind}_test.bin`)
  if (code === 0 && existsSync(binPath)) {
    rec.status = 'ok'
    try { rec.binarySize = statSync(binPath).size } catch { /* nop */ }
  } else {
    Object.assign(rec, classifyFailure(stdout, stderr, timedOut))
    writeFileSync(path.join(dir, 'build.log'), `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, 'utf8')
  }

  writeCache(dir, proj.files['main.cpp'], rec)
  return rec
}

// ---- Step 4b: ESP32 runner (warm dir shared by an ini group, sequential) ----
async function runPioGroup(target, dir, entries) {
  const out = []
  let cold = !existsSync(path.join(dir, '.pio'))
  const env = TARGETS[target]
  const artifactRel = env.binaryArtifact(`${entries[0].kind}_test`)

  for (const { kind, proj } of entries) {
    const t0 = performance.now()
    const rec = { target, kind, status: 'ok', durationMs: 0, warnings: proj.warnings }

    const cached = readCache(dir, proj.files['src/main.cpp'], kind)
    if (cached) { out.push(cached); continue }

    writeProject(dir, proj.files)

    const { code, stdout, stderr, timedOut } = await run(
      'pio', ['run'], dir, cold ? PIO_COLD_TIMEOUT_MS : PIO_WARM_TIMEOUT_MS, {}
    )
    cold = false
    rec.durationMs = Math.round(performance.now() - t0)

    const binPath = path.join(dir, artifactRel)
    if (code === 0 && existsSync(binPath)) {
      rec.status = 'ok'
      try { rec.binarySize = statSync(binPath).size } catch { /* nop */ }
    } else {
      Object.assign(rec, classifyFailure(stdout, stderr, timedOut))
      writeFileSync(path.join(dir, `build-${kind}.log`), `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, 'utf8')
    }

    writeCache(dir, proj.files['src/main.cpp'], rec, kind)
    out.push(rec)
    report(rec)
  }
  return out
}

// ---- shared dir helpers ----
function writeProject(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel)
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, content, 'utf8')
  }
}

const cachePath = (dir, kind) =>
  path.join(dir, kind ? `.harness-${kind}.json` : '.harness-status.json')

/**
 * A build is reusable when the exact main.cpp that produced the stored
 * record is the one we would write now. Hashing the source rather than
 * comparing mtimes means an emitter edit always invalidates, and a
 * cosmetic edit that happens not to change the output never does.
 */
function readCache(dir, mainSrc, kind) {
  const f = cachePath(dir, kind)
  if (!existsSync(f)) return null
  try {
    const prev = JSON.parse(readFileSync(f, 'utf8'))
    if (prev.mainHash !== sha8(mainSrc)) return null
    prev.cached = true
    return prev
  } catch {
    return null
  }
}

function writeCache(dir, mainSrc, rec, kind) {
  try {
    writeFileSync(cachePath(dir, kind), JSON.stringify({ ...rec, mainHash: sha8(mainSrc) }, null, 2), 'utf8')
  } catch { /* nop */ }
}

// ---- Step 5: toolchain probes ----
async function haveCommand(bin) {
  const r = await run(bin, ['--version'], TMP_ROOT, 15_000, {})
  return r.code === 0
}

// ---- Step 6: orchestrate ----
const allKinds = Object.keys(NODE_DEFINITIONS)
const targetKinds = onlyFilter ? allKinds.filter((k) => onlyFilter.has(k)) : allKinds
const targets = (targetFilter ? BOARD_IDS.filter((t) => targetFilter.has(t)) : BOARD_IDS)

if (!targetKinds.length) {
  console.error('[harness] --only matched no kinds')
  process.exit(1)
}
if (!targets.length) {
  console.error(`[harness] --targets matched no boards (valid: ${BOARD_IDS.join(', ')})`)
  process.exit(1)
}

console.log(`[harness] ${targetKinds.length} kinds x ${targets.length} targets`)
console.log(`[harness] targets: ${targets.join(', ')}`)
console.log(`[harness] LIBDAISY_DIR=${LIBDAISY_DIR}`)

const results = []
const skippedTargets = []

function report(rec) {
  const tag = {
    ok: 'OK  ', skipped: 'SKIP', codegen_error: 'CGEN',
    timeout: 'TIME', link_error: 'LINK', compile_error: 'CERR'
  }[rec.status] ?? '????'
  const extra = rec.status === 'ok'
    ? `${rec.binarySize ?? '?'} B${rec.cached ? ' (cached)' : ''}`
    : (rec.firstError ?? rec.reason ?? '').slice(0, 80)
  console.log(`[${tag}] ${rec.target.padEnd(19)} ${rec.kind.padEnd(22)} ${String(rec.durationMs).padStart(6)}ms  ${extra}`)
}

/** Kinds the support matrix says can't build here — not a failure. */
function skipRecord(target, kind, reason) {
  return { target, kind, status: 'skipped', durationMs: 0, warnings: [], reason }
}

const t0 = performance.now()

for (const target of targets) {
  const family = BOARD_FAMILY[target]
  const needed = family === 'daisy' ? 'make' : 'pio'
  const ok = family === 'daisy'
    ? existsSync(LIBDAISY_DIR) && existsSync(DAISYSP_DIR) && (await haveCommand('make'))
    : await haveCommand('pio')

  if (!ok) {
    const why = family === 'daisy'
      ? `missing ${needed} or the SDK clones at ~/.config/daisypatcher/sdk/`
      : `missing ${needed} on PATH`
    console.log(`[harness] SKIPPING TARGET ${target} — ${why}`)
    skippedTargets.push({ target, why })
    for (const kind of targetKinds) results.push(skipRecord(target, kind, why))
    continue
  }

  // Kinds the support matrix rules out for this board build nothing.
  const buildable = []
  for (const kind of targetKinds) {
    const level = supportLevel(kind, target)
    if (level === 'unsupported') {
      const rec = skipRecord(target, kind, 'unsupported on this target')
      results.push(rec)
      report(rec)
    } else {
      buildable.push(kind)
    }
  }

  if (family === 'daisy') {
    let cursor = 0
    const worker = async () => {
      while (cursor < buildable.length) {
        const kind = buildable[cursor++]
        const rec = await runDaisyKind(target, kind)
        results.push(rec)
        report(rec)
      }
    }
    await Promise.all(Array.from({ length: DAISY_CONCURRENCY }, worker))
    continue
  }

  // ESP32: codegen everything first (cheap), then bucket by platformio.ini so
  // each bucket can share one warm PlatformIO project dir.
  const buckets = new Map()
  for (const kind of buildable) {
    let proj
    try {
      proj = generateFor(target, kind)
    } catch (err) {
      const rec = {
        target, kind, status: 'codegen_error', durationMs: 0, warnings: [],
        firstError: (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)).slice(0, 240)
      }
      results.push(rec)
      report(rec)
      continue
    }
    const key = sha8(proj.files['platformio.ini'])
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ kind, proj })
  }

  console.log(`[harness] ${target}: ${buildable.length} kinds in ${buckets.size} pio env group(s)`)

  const groups = [...buckets.entries()].map(([key, entries]) => ({
    dir: path.join(TMP_ROOT, target, `env-${key}`),
    entries
  }))

  let gi = 0
  const gWorker = async () => {
    while (gi < groups.length) {
      const g = groups[gi++]
      results.push(...(await runPioGroup(target, g.dir, g.entries)))
    }
  }
  await Promise.all(Array.from({ length: Math.min(PIO_CONCURRENCY, groups.length) }, gWorker))
}

const totalMs = Math.round(performance.now() - t0)

// ---- Step 7: report ----
results.sort((a, b) => a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target))

const STATUSES = ['ok', 'skipped', 'codegen_error', 'compile_error', 'link_error', 'timeout']
const MARK = {
  ok: '✓', skipped: '–', codegen_error: 'G', compile_error: 'C', link_error: 'L', timeout: 'T'
}

const byTarget = new Map(targets.map((t) => [t, []]))
for (const r of results) byTarget.get(r.target)?.push(r)

let md = ''
md += `# Daisypatcher per-node compile harness\n\n`
md += `Generated: ${new Date().toISOString()}\n\n`
md += `${targetKinds.length} kinds x ${targets.length} targets = ${results.length} builds `
md += `in ${(totalMs / 1000).toFixed(1)}s\n\n`

md += `## Summary\n\n`
md += `| target | ok | skipped | codegen | compile | link | timeout |\n`
md += `|---|---:|---:|---:|---:|---:|---:|\n`
for (const t of targets) {
  const rows = byTarget.get(t) ?? []
  const n = (s) => rows.filter((r) => r.status === s).length
  md += `| \`${t}\` | ${n('ok')} | ${n('skipped')} | ${n('codegen_error')} | ${n('compile_error')} | ${n('link_error')} | ${n('timeout')} |\n`
}
md += '\n'

if (skippedTargets.length) {
  md += `Targets not attempted: ${skippedTargets.map((s) => `\`${s.target}\` (${s.why})`).join(', ')}\n\n`
}

// Matrix — the point of the whole exercise. One row per kind, one column per
// target, so a kind that builds on Daisy and dies on the C3 is one glance.
md += `## Matrix\n\n`
md += `\`✓\` ok · \`–\` skipped (unsupported) · \`G\` codegen · \`C\` compile · \`L\` link · \`T\` timeout\n\n`
md += `| kind | ${targets.join(' | ')} |\n|---|${targets.map(() => '---').join('|')}|\n`
const at = new Map(results.map((r) => [`${r.kind} ${r.target}`, r]))
for (const kind of targetKinds) {
  const cells = targets.map((t) => MARK[at.get(`${kind} ${t}`)?.status] ?? '?')
  const bad = cells.some((c) => 'GCLT'.includes(c))
  md += `| ${bad ? `**\`${kind}\`**` : `\`${kind}\``} | ${cells.join(' | ')} |\n`
}
md += '\n'

for (const t of targets) {
  const rows = byTarget.get(t) ?? []
  const failures = rows.filter((r) => r.status !== 'ok' && r.status !== 'skipped')
  const oks = rows.filter((r) => r.status === 'ok')
  md += `## ${t}\n\n`
  const sizes = oks.map((r) => r.binarySize ?? 0).filter((n) => n > 0)
  if (sizes.length) {
    const mean = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)
    md += `${oks.length} ok — binary size min ${Math.min(...sizes)} B, max ${Math.max(...sizes)} B, mean ${mean} B\n\n`
  }
  if (!failures.length) {
    md += `No failures.\n\n`
    continue
  }
  md += `| kind | status | ms | first error |\n|---|---|---:|---|\n`
  for (const r of failures) {
    const err = (r.firstError ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
    md += `| \`${r.kind}\` | ${r.status} | ${r.durationMs} | ${err} |\n`
  }
  md += '\n'
}

const reportPath = path.join(TMP_ROOT, 'REPORT.md')
writeFileSync(reportPath, md, 'utf8')
console.log(`\n[harness] report written to ${reportPath}\n`)
process.stdout.write(md)

const anyFailed = results.some((r) => r.status !== 'ok' && r.status !== 'skipped')
process.exitCode = anyFailed ? 1 : 0
