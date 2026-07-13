#!/usr/bin/env node
// Per-node compile harness for Daisypatcher.
//
// Bundles the TS codegen (src/codegen/generateProject.ts + node definitions)
// into a CJS file via esbuild, then for each NodeKind:
//   1. Builds a minimal test graph that routes the node into audio_output.
//   2. Calls generateProject() to emit main.cpp + Makefile.
//   3. Writes the files to /tmp/dp-harness/<kind>/ and runs `make`.
//   4. Records status (ok / codegen_error / compile_error / link_error / timeout).
//
// Prints a Markdown report to stdout and writes /tmp/dp-harness/REPORT.md.
//
// Usage: node scripts/codegen-compile-harness.mjs [--only kind1,kind2]
//
// This file is *diagnostic scaffolding* — not a runtime part of the app.

import { spawn } from 'node:child_process'
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
const PER_BUILD_TIMEOUT_MS = 60_000
const CONCURRENCY = 4

// ---- CLI ----
const args = process.argv.slice(2)
let onlyFilter = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only' && args[i + 1]) {
    onlyFilter = new Set(args[i + 1].split(','))
    i++
  }
}

mkdirSync(TMP_ROOT, { recursive: true })

// ---- Step 1: bundle codegen with esbuild (programmatic API) ----
console.log('[harness] bundling codegen via esbuild…')
const require_ = createRequire(import.meta.url)
const esbuild = require_(path.join(PROJECT_ROOT, 'node_modules/esbuild'))

// Tiny entry file that re-exports what we need.
const ENTRY = path.join(TMP_ROOT, '_entry.ts')
writeFileSync(
  ENTRY,
  [
    `export { generateProject } from '${path.join(PROJECT_ROOT, 'src/codegen/generateProject').replace(/\\/g, '/')}'`,
    `export { NODE_DEFINITIONS } from '${path.join(PROJECT_ROOT, 'src/nodes/definitions').replace(/\\/g, '/')}'`,
    `export { emptyHardwareLayout } from '${path.join(PROJECT_ROOT, 'src/types/hardware').replace(/\\/g, '/')}'`,
    `export { emptyGraph } from '${path.join(PROJECT_ROOT, 'src/types/graph').replace(/\\/g, '/')}'`
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
const { generateProject, NODE_DEFINITIONS, emptyHardwareLayout } = mod

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

  // oled — include with 6 dummy constants on its inputs; no audio path expected.
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

  const target = makeNode(kind)
  nodes.push(target)

  // If the target has a gate input (trigger), wire a gate_in to it so drums,
  // karplus, adsr, etc. have a gate source present.
  for (const inSock of def.inputs) {
    if (inSock.signal === 'gate') {
      const g = makeNode('gate_in')
      nodes.push(g)
      connections.push(conn(socketRef(g, 'out'), socketRef(target, inSock.id)))
    } else if (inSock.signal === 'audio' && (kind === 'gain' || kind === 'vca' || kind === 'delay' || kind === 'reverb' || kind === 'filter_svf' || kind === 'filter_moog' || kind === 'chorus' || kind === 'overdrive' || kind === 'bitcrush' || kind === 'phaser' || kind === 'flanger' || kind === 'ping_pong' || kind === 'stereo_widener' || kind === 'freeze' || kind === 'granulator' || kind === 'pitch_shifter' || kind === 'tremolo' || kind === 'vibrato' || kind === 'compressor' || kind === 'limiter' || kind === 'noise_gate' || kind === 'wavefolder' || kind === 'clip' || kind === 'ring_mod' || kind === 'envelope_follower' || kind === 'formant' || kind === 'pan' || kind === 'mixer4' || kind === 'sum' || kind === 'multiply' || kind === 'crossfade' || kind === 'scope' || kind === 'vu' || kind === 'spectrum_scope' || kind === 'i2s_out')) {
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

// ---- Step 3: per-kind runner ----
function runMake(cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('make', [], {
      cwd,
      env: {
        ...process.env,
        LIBDAISY_DIR,
        DAISYSP_DIR
      },
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
    child.on('error', () => {
      clearTimeout(t)
      resolve({ code: -1, stdout, stderr, timedOut })
    })
  })
}

function classifyFailure(stdout, stderr, timedOut) {
  if (timedOut) return { status: 'timeout', firstError: '[timeout]' }
  const combined = `${stdout}\n${stderr}`
  // Linker errors usually say "undefined reference", "multiple definition",
  // "ld returned", "cannot find -l".
  const lines = combined.split('\n')
  const firstErr =
    lines.find((l) => /error: |undefined reference|multiple definition|cannot find -l|No such file or directory/.test(l)) ??
    lines.find((l) => /Error \d+|\*\*\* /.test(l)) ??
    lines.slice(-3).join(' | ').trim()

  const looksLikeLink =
    /undefined reference|multiple definition|ld returned|cannot find -l/.test(combined)

  return {
    status: looksLikeLink ? 'link_error' : 'compile_error',
    firstError: (firstErr || '(no error line found)').slice(0, 240)
  }
}

async function runOneKind(kind) {
  const t0 = performance.now()
  const rec = { kind, status: 'ok', durationMs: 0, warnings: [], firstError: undefined, binarySize: undefined }

  // 1. Codegen
  let proj
  try {
    const graph = buildTestGraph(kind)
    proj = generateProject(graph, emptyHardwareLayout('daisy_seed'), `${kind}_test`, 'daisy_seed', { daisyFlashMode: 'qspi' })
    rec.warnings = proj.warnings
  } catch (err) {
    rec.status = 'codegen_error'
    rec.firstError = (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)).slice(0, 240)
    rec.durationMs = Math.round(performance.now() - t0)
    return rec
  }

  // 2. Write project dir
  const dir = path.join(TMP_ROOT, kind)
  // mtime skip: if main.cpp already has identical contents, skip the build
  const existingMain = path.join(dir, 'main.cpp')
  const prevStatusFile = path.join(dir, '.harness-status.json')
  const mainNext = proj.files['main.cpp']
  if (existsSync(existingMain) && existsSync(prevStatusFile)) {
    try {
      const prev = readFileSync(existingMain, 'utf8')
      if (prev === mainNext) {
        const prevRec = JSON.parse(readFileSync(prevStatusFile, 'utf8'))
        prevRec.cached = true
        return prevRec
      }
    } catch { /* fall through */ }
  }

  // fresh build dir
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* nop */ }
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(proj.files)) {
    const dest = path.join(dir, rel)
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, content, 'utf8')
  }

  // 3. make
  const { code, stdout, stderr, timedOut } = await runMake(dir, PER_BUILD_TIMEOUT_MS)
  rec.durationMs = Math.round(performance.now() - t0)

  const binPath = path.join(dir, 'build', `${kind}_test.bin`)
  if (code === 0 && existsSync(binPath)) {
    rec.status = 'ok'
    try { rec.binarySize = statSync(binPath).size } catch { /* nop */ }
  } else {
    const klass = classifyFailure(stdout, stderr, timedOut)
    rec.status = klass.status
    rec.firstError = klass.firstError
    // Save combined log for inspection
    writeFileSync(path.join(dir, 'build.log'), `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`, 'utf8')
  }

  writeFileSync(prevStatusFile, JSON.stringify(rec, null, 2), 'utf8')
  return rec
}

// ---- Step 4: orchestrate ----
const allKinds = Object.keys(NODE_DEFINITIONS)
const targetKinds = onlyFilter ? allKinds.filter((k) => onlyFilter.has(k)) : allKinds

console.log(`[harness] running ${targetKinds.length} kinds (concurrency=${CONCURRENCY})`)
console.log(`[harness] LIBDAISY_DIR=${LIBDAISY_DIR}`)
console.log(`[harness] DAISYSP_DIR=${DAISYSP_DIR}`)

const results = []
let cursor = 0
async function worker(id) {
  while (cursor < targetKinds.length) {
    const myIdx = cursor++
    const kind = targetKinds[myIdx]
    const rec = await runOneKind(kind)
    results.push(rec)
    const tag = rec.status === 'ok' ? 'OK  ' : rec.status === 'codegen_error' ? 'CGEN' : rec.status === 'timeout' ? 'TIME' : rec.status === 'link_error' ? 'LINK' : 'CERR'
    const extra = rec.status === 'ok' ? `${rec.binarySize} B` : (rec.firstError ?? '').slice(0, 80)
    console.log(`[${tag}] ${kind.padEnd(24)} ${rec.durationMs}ms  ${extra}`)
  }
}

const t0 = performance.now()
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
const totalMs = Math.round(performance.now() - t0)

// ---- Step 5: report ----
results.sort((a, b) => a.kind.localeCompare(b.kind))

const groups = {
  ok: [],
  codegen_error: [],
  compile_error: [],
  link_error: [],
  timeout: []
}
for (const r of results) groups[r.status].push(r)

const sizes = groups.ok.map((r) => r.binarySize ?? 0).filter((n) => n > 0)
const mean = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0
const min = sizes.length ? Math.min(...sizes) : 0
const max = sizes.length ? Math.max(...sizes) : 0

let md = ''
md += `# Daisypatcher per-node compile harness\n\n`
md += `Generated: ${new Date().toISOString()}\n\n`
md += `Total kinds: **${results.length}** | `
md += `ok: **${groups.ok.length}** | `
md += `codegen: **${groups.codegen_error.length}** | `
md += `compile: **${groups.compile_error.length}** | `
md += `link: **${groups.link_error.length}** | `
md += `timeout: **${groups.timeout.length}**\n\n`
md += `Total wall-clock: ${totalMs}ms\n\n`

md += `## Binary size (ok builds)\n\n`
md += `- count: ${sizes.length}\n- min: ${min} B\n- max: ${max} B\n- mean: ${mean} B\n\n`

for (const status of ['codegen_error', 'compile_error', 'link_error', 'timeout', 'ok']) {
  const rows = groups[status]
  if (!rows.length) continue
  md += `## ${status} (${rows.length})\n\n`
  if (status === 'ok') {
    md += `| kind | size (B) | ms |\n|---|---:|---:|\n`
    for (const r of rows) md += `| \`${r.kind}\` | ${r.binarySize ?? '?'} | ${r.durationMs} |\n`
  } else {
    md += `| kind | ms | first error |\n|---|---:|---|\n`
    for (const r of rows) {
      const err = (r.firstError ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
      md += `| \`${r.kind}\` | ${r.durationMs} | ${err} |\n`
    }
  }
  md += '\n'
}

const reportPath = path.join(TMP_ROOT, 'REPORT.md')
writeFileSync(reportPath, md, 'utf8')
console.log(`\n[harness] report written to ${reportPath}\n`)
process.stdout.write(md)
