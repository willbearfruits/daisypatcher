#!/usr/bin/env node
// Behavioural tests for the features that codegen snapshots cannot check.
//
// The other four layers each answer a narrow question:
//   test:codegen   — did the emitted TEXT change?
//   test:contract  — do the targets agree on a node's shape?
//   test:compile   — does it build?
//   test:audio     — does the emulator sound like the firmware?
//
// None of them answers "does this FEATURE work". A poly node that expands
// to the wrong number of voices emits perfectly stable text; an assistant
// that accepts an invented node kind compiles fine right up until it does
// not. Those are behaviours, and this file exercises them directly.
//
// Everything here runs in-process against the real modules — no compiler,
// no device, no network. It should stay fast enough to run on every change.
//
// Usage:
//   node scripts/feature-tests.mjs
//   node scripts/feature-tests.mjs --only poly,assistant

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require_ = createRequire(import.meta.url)
const esbuild = require_(path.join(ROOT, 'node_modules/esbuild'))

const argv = process.argv.slice(2)
let only = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only' && argv[i + 1]) only = new Set(argv[++i].split(','))
}

/* ---- load the app's modules ---- */
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dp-feat-'))
const ENTRY = path.join(tmp, 'entry.ts')
const BUNDLE = path.join(tmp, 'bundle.mjs')
const p = (rel) => path.join(ROOT, rel).replace(/\\/g, '/')

writeFileSync(
  ENTRY,
  [
    `export { NODE_DEFINITIONS } from '${p('src/nodes/definitions')}'`,
    `export { WORKLET_REGISTRY } from '${p('src/audio/worklets/registry')}'`,
    `export { generateProject } from '${p('src/codegen/generateProject')}'`,
    `export { flattenGraph } from '${p('src/state/subpatch')}'`,
    `export { captureFrom } from '${p('src/state/presets')}'`,
    `export * from '${p('src/assistant/editSchema')}'`,
    `export { diffConnections } from '${p('src/editor/sync')}'`,
    `export { systemPrompt, userPrompt } from '${p('src/assistant/prompt')}'`,
    `export { parseDpatch, serializePatch, applyLoadedPatch } from '${p('src/state/patchFile')}'`,
    `export { useEditorStore, rootGraphOf } from '${p('src/state/store')}'`,
    `export { getBoardPinout } from '${p('src/hardware/boardPinout')}'`
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
  alias: { '@': path.join(ROOT, 'src') }
})

const M = await import(pathToFileURL(BUNDLE).href)
const { NODE_DEFINITIONS, WORKLET_REGISTRY, generateProject, flattenGraph, captureFrom } = M
const { parseEditPlan, validatePlan, describePlan, systemPrompt, userPrompt, diffConnections } = M
const { parseDpatch, serializePatch, applyLoadedPatch, useEditorStore, rootGraphOf, getBoardPinout } = M

const { renderGraph } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/renderEmulator.mjs')).href)

/* ---- helpers ---- */
const mk = (id, kind, extra = {}) => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  params: {
    ...Object.fromEntries((NODE_DEFINITIONS[kind].params ?? []).map((q) => [q.id, q.default])),
    ...extra
  }
})
const w = (id, a, as, b, bs) => ({
  id,
  from: { nodeId: a, socketId: as },
  to: { nodeId: b, socketId: bs }
})

let failures = 0
let checks = 0
let group = ''
const g = (name) => {
  group = name
  console.log(`\n— ${name}`)
}
const chk = (name, cond, detail = '') => {
  checks++
  if (cond) {
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`)
  }
}
const want = (n) => !only || only.has(n)

/* =====================================================================
 * Polyphony
 * ===================================================================== */
if (want('poly')) {
  g('poly')
  const body = {
    nodes: [
      mk('vid', 'voice_id'),
      mk('sc', 'scale', { scale: 0.06, offset: -0.03 }),
      mk('osc', 'oscillator', { frequency: 220, amplitude: 0.25, waveform: 'sawtooth' }),
      mk('po', 'sub_out', { index: 0 })
    ],
    connections: [
      w('b1', 'vid', 'norm', 'sc', 'in'),
      w('b2', 'sc', 'out', 'osc', 'pitch_cv'),
      w('b3', 'osc', 'out', 'po', 'in')
    ],
    meta: { name: 'voice', sampleRate: 48000, blockSize: 48 }
  }

  for (const voices of [1, 2, 4, 8]) {
    const graph = {
      nodes: [mk('p', 'poly', { graph: JSON.stringify(body), voices }), mk('out', 'audio_output')],
      connections: [w('c1', 'p', 'out', 'out', 'left')],
      meta: { name: 'poly', sampleRate: 48000, blockSize: 48 }
    }
    const flat = flattenGraph(graph)
    const oscs = flat.nodes.filter((n) => n.kind === 'oscillator').length
    const dangling = flat.connections.filter(
      (c) =>
        !flat.nodes.some((n) => n.id === c.from.nodeId) ||
        !flat.nodes.some((n) => n.id === c.to.nodeId)
    )
    chk(`${voices} voices expand to ${voices} oscillators`, oscs === voices, `got ${oscs}`)
    chk(`${voices} voices leave no dangling cables`, dangling.length === 0)
  }

  const g4 = {
    nodes: [mk('p', 'poly', { graph: JSON.stringify(body), voices: 4 }), mk('out', 'audio_output')],
    connections: [w('c1', 'p', 'out', 'out', 'left')],
    meta: { name: 'poly', sampleRate: 48000, blockSize: 48 }
  }
  const proj = generateProject(g4, undefined, 'poly', 'daisy_seed', { daisyFlashMode: 'qspi' })
  const src = proj.files['main.cpp']
  chk(
    'firmware declares one Oscillator per voice',
    (src.match(/^Oscillator /gm) || []).length === 4,
    String((src.match(/^Oscillator /gm) || []).length)
  )
  chk(
    'poly never reaches codegen unflattened',
    !proj.warnings.some((x) => /reached codegen unflattened/.test(x))
  )
}

/* =====================================================================
 * Firmware presets
 * ===================================================================== */
if (want('presets')) {
  g('presets')
  const graph = {
    nodes: [
      mk('osc', 'oscillator', { frequency: 220, amplitude: 0.3 }),
      mk('flt', 'filter_svf', { frequency: 800, resonance: 0.2 }),
      mk('btn', 'button'),
      mk('pr', 'preset_recall', { mode: 'recall', slot: 1 }),
      mk('out', 'audio_output')
    ],
    connections: [
      w('c1', 'osc', 'out', 'flt', 'in'),
      w('c2', 'flt', 'lp', 'out', 'left'),
      w('c3', 'btn', 'out', 'pr', 'trigger')
    ],
    meta: { name: 'presets', sampleRate: 48000, blockSize: 48 }
  }
  const bright = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === 'flt' ? { ...n, params: { ...n.params, frequency: 5000 } } : n
    )
  }
  const dark = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === 'flt' ? { ...n, params: { ...n.params, frequency: 200 } } : n
    )
  }
  const presets = [captureFrom(bright, 'Bright', 'p1'), captureFrom(dark, 'Dark', 'p2')]

  chk(
    'a preset never captures the recall node that selects it',
    presets[0].values['pr'] === undefined
  )

  for (const target of ['daisy_seed', 'esp32_s3_devkitc']) {
    const proj = generateProject(graph, undefined, 'presets', target, {
      daisyFlashMode: 'qspi',
      presets
    })
    const src = proj.files['main.cpp'] ?? proj.files['src/main.cpp']
    chk(`${target}: table emitted`, /dp_preset_table\[/.test(src))
    chk(`${target}: both presets are in it`, /5000\.f/.test(src) && /\b200\.f/.test(src))
    chk(`${target}: apply and morph emitted`, /dp_preset_apply/.test(src) && /dp_preset_morph/.test(src))
    chk(`${target}: slots point at the live globals`, /&dp_mp_/.test(src))
    chk(`${target}: the recall node calls apply`, /if \(\w+_edge\) dp_preset_apply/.test(src))
    const globalName = (src.match(/float (dp_mp_\w*frequency\w*) =/) || [])[1]
    chk(`${target}: the filter reads the global, not a literal`,
      Boolean(globalName) && (src.match(new RegExp(globalName, 'g')) || []).length >= 3)
  }

  const noDriver = {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== 'pr'),
    connections: graph.connections.filter((c) => c.id !== 'c3')
  }
  chk(
    'warns when presets are compiled in but nothing can fire them',
    generateProject(noDriver, undefined, 'nd', 'daisy_seed', {
      daisyFlashMode: 'qspi',
      presets
    }).warnings.some((x) => /nothing can fire them/.test(x))
  )
  chk(
    'no presets means no table',
    !/dp_preset_table/.test(
      generateProject(graph, undefined, 'np', 'daisy_seed', { daisyFlashMode: 'qspi', presets: [] })
        .files['main.cpp']
    )
  )
}

/* =====================================================================
 * Samples
 * ===================================================================== */
if (want('samples')) {
  g('samples')
  const SR = 48000
  const N = Math.round(SR * 0.25)
  const tone = new Float32Array(N)
  for (let i = 0; i < N; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.8
  const bank = { abc123: { channels: [tone], sampleRate: SR, frames: N } }

  const graph = {
    nodes: [
      mk('clk', 'clock', { bpm: 120 }),
      mk('sp', 'sample_player', { sampleId: 'abc123', mode: 'oneshot' }),
      mk('out', 'audio_output')
    ],
    connections: [w('c1', 'clk', 'out', 'sp', 'trigger'), w('c2', 'sp', 'out', 'out', 'left')],
    meta: { name: 'smp', sampleRate: 48000, blockSize: 48 }
  }

  for (const target of ['daisy_seed', 'esp32_s3_devkitc']) {
    const proj = generateProject(graph, undefined, 'smp', target, {
      daisyFlashMode: 'qspi',
      samples: bank
    })
    const src = proj.files['main.cpp'] ?? proj.files['src/main.cpp']
    const m = src.match(/static const int16_t dp_smp_\w+\[(\d+)\]/)
    chk(`${target}: PCM emitted as const int16 (flash, not RAM)`, Boolean(m))
    chk(`${target}: full length preserved`, m && Number(m[1]) === N, m ? m[1] : 'none')
    chk(`${target}: the player reads the array`, /dp_smp_\w+\[\w+_i0\]/.test(src))
    chk(`${target}: flash cost is reported`, proj.warnings.some((x) => /KB of flash/.test(x)))
  }

  const twoPlayers = {
    nodes: [
      mk('clk', 'clock'),
      mk('a', 'sample_player', { sampleId: 'abc123' }),
      mk('b', 'sample_player', { sampleId: 'abc123' }),
      mk('out', 'audio_output')
    ],
    connections: [
      w('x1', 'clk', 'out', 'a', 'trigger'),
      w('x2', 'clk', 'out', 'b', 'trigger'),
      w('x3', 'a', 'out', 'out', 'left'),
      w('x4', 'b', 'out', 'out', 'right')
    ],
    meta: { name: 'dup', sampleRate: 48000, blockSize: 48 }
  }
  const dup = generateProject(twoPlayers, undefined, 'dup', 'daisy_seed', {
    daisyFlashMode: 'qspi',
    samples: bank
  })
  chk(
    'two players sharing one sample emit ONE array',
    (dup.files['main.cpp'].match(/static const int16_t dp_smp_/g) || []).length === 1
  )

  const empty = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === 'sp' ? { ...n, params: { ...n.params, sampleId: '' } } : n
    )
  }
  const ep = generateProject(empty, undefined, 'smp', 'daisy_seed', {
    daisyFlashMode: 'qspi',
    samples: {}
  })
  chk('an unassigned slot warns but still builds', ep.warnings.some((x) => /no sample selected/.test(x)) && Boolean(ep.files['main.cpp']))
  chk(
    'a sample missing from the library warns by name',
    generateProject(graph, undefined, 'smp', 'daisy_seed', {
      daisyFlashMode: 'qspi',
      samples: {}
    }).warnings.some((x) => /not in the library/.test(x))
  )
}

/* =====================================================================
 * Logic layer
 * ===================================================================== */
if (want('logic')) {
  g('logic')

  // A counter driven by a clock should reach every step and wrap.
  const graph = {
    nodes: [
      mk('clk', 'clock', { bpm: 600, pulse_width: 0.4 }),
      mk('cnt', 'counter', { max: 4, mode: 'wrap' }),
      mk('out', 'audio_output')
    ],
    connections: [w('c1', 'clk', 'out', 'cnt', 'inc'), w('c2', 'cnt', 'index', 'out', 'left')],
    meta: { name: 'cnt', sampleRate: 48000, blockSize: 48 }
  }
  const r = await renderGraph({
    graph,
    definitions: NODE_DEFINITIONS,
    registry: WORKLET_REGISTRY,
    workletDir: path.join(ROOT, 'src/audio/worklets'),
    seconds: 2
  })
  const seen = new Set()
  for (const v of r.left) seen.add(Math.round(v))
  chk('a 4-step counter visits every step', [0, 1, 2, 3].every((k) => seen.has(k)), [...seen].join(','))
  chk('and never exceeds its range', ![...seen].some((k) => k > 3 || k < 0), [...seen].join(','))

  // Toggle: one flip per clock pulse, so half the time high over many cycles.
  const tg = {
    nodes: [
      mk('clk', 'clock', { bpm: 600, pulse_width: 0.4 }),
      mk('t', 'toggle', { initial: 'low' }),
      mk('out', 'audio_output')
    ],
    connections: [w('c1', 'clk', 'out', 't', 'trigger'), w('c2', 't', 'out', 'out', 'left')],
    meta: { name: 'tg', sampleRate: 48000, blockSize: 48 }
  }
  const rt = await renderGraph({
    graph: tg,
    definitions: NODE_DEFINITIONS,
    registry: WORKLET_REGISTRY,
    workletDir: path.join(ROOT, 'src/audio/worklets'),
    seconds: 2
  })
  const highFrac = rt.left.reduce((a, v) => a + (v >= 0.5 ? 1 : 0), 0) / rt.left.length
  chk('a toggle spends about half its time high', Math.abs(highFrac - 0.5) < 0.1, highFrac.toFixed(3))

  // Every logic kind must emit for every target — the contract test proves
  // the shape, this proves the group was actually registered everywhere.
  for (const kind of ['logic', 'toggle', 'counter', 'timer', 'state_machine', 'select', 'edge']) {
    chk(`${kind} has a definition and a worklet`,
      Boolean(NODE_DEFINITIONS[kind]) && Boolean(WORKLET_REGISTRY[kind]))
  }
}


/* =====================================================================
 * Editor sync — the diff that drives Rete
 * ===================================================================== */
if (want('sync')) {
  g('sync')
  /*
   * Two patches that reuse connection ids for different cables. Diffing by
   * id alone called these "unchanged" and left the FIRST patch's cables
   * mounted after opening the second — frozen in place, pointing at nodes
   * that no longer existed. Every bundled example collided this way.
   */
  const a = [w('c1', 'button_1', 'out', 'timer_2', 'trigger'), w('c2', 'timer_2', 'out', 'edge_3', 'in')]
  const b = [w('c1', 'clock_1', 'out', 'div_2', 'in'), w('c2', 'timer_2', 'out', 'edge_3', 'in')]
  const d = diffConnections(a, b)
  chk('a reused id with different ends is REMOVED', d.removed.some((c) => c.id === 'c1'))
  chk('…and ADDED', d.added.some((c) => c.id === 'c1'))
  chk('a genuinely unchanged cable is neither', !d.removed.some((c) => c.id === 'c2') && !d.added.some((c) => c.id === 'c2'))
  const same = diffConnections(a, a)
  chk('identical lists produce an empty diff', same.added.length === 0 && same.removed.length === 0)
  const fromEmpty = diffConnections([], b)
  chk('first load adds everything', fromEmpty.added.length === 2 && fromEmpty.removed.length === 0)
}

/* =====================================================================
 * .dpatch round-trip — does a patch survive its own file format?
 * ===================================================================== */
if (want('roundtrip')) {
  g('roundtrip')
  /*
   * Build a deliberately awkward state through the REAL store actions —
   * a subpatch, a poly with a voice body, hardware with pins and a perform
   * placement, two presets, a collapsed node, non-default canvas prefs and
   * flash mode — serialise it exactly as Save does, parse it exactly as
   * Open does, push it through `loadGraph`, and compare. Every field that
   * differs is a field a user loses on reopen. Snapshots cannot catch this
   * (they never load anything back) and neither can the app (the loss is
   * silent).
   */
  const S = useEditorStore
  S.getState().resetGraph()
  const st = () => S.getState()

  const osc = st().addNode('oscillator', { x: 100, y: 100 })
  const filt = st().addNode('filter_svf', { x: 300, y: 100 })
  const out = st().addNode('audio_output', { x: 500, y: 100 })
  st().setParam(osc, 'frequency', 330)
  st().setParam(osc, 'waveform', 'sawtooth')
  st().connect({ nodeId: osc, socketId: 'out' }, { nodeId: filt, socketId: 'in' })
  st().connect({ nodeId: filt, socketId: 'lp' }, { nodeId: out, socketId: 'left' })

  // A knob from the patch side (auto-links a component with pins)…
  const knob = st().addNode('knob_in', { x: 100, y: 300 })
  st().connect({ nodeId: knob, socketId: 'out' }, { nodeId: filt, socketId: 'cv_frequency' })
  // …and an LED from the hardware side (auto-links a node).
  const ledComp = st().addHardware('led', { x: 40, y: 40 })
  st().renameHardware(ledComp, 'blink')
  st().setPerformPlacement(ledComp, { x: 12, y: 34, size: 1.5, hidden: false, label: 'GO' })

  // Two presets, one edited afterwards so recall has something to do.
  const p1 = st().capturePreset('bright')
  st().setParam(osc, 'frequency', 55)
  const p2 = st().capturePreset('dark')
  st().renamePreset(p2, 'sub')

  // Collapse the oscillator + filter into a subpatch, collapse the box.
  st().select([osc, filt])
  const sub = st().collapseSelectionToSubpatch()
  chk('fixture: subpatch created', typeof sub === 'string')
  if (sub) st().toggleCollapsed(sub)

  // A poly node whose voice body is a real graph.
  const poly = st().addNode('poly', { x: 100, y: 500 })
  st().setParam(poly, 'voices', 3)

  st().setCanvasPrefs({ gridSnap: true, gridSize: 25, gridShow: false, marqueeSelect: false })
  st().setLayout({ paletteW: 301, inspectorW: 333, codePanelH: 222 })
  st().setDaisyFlashMode('sram')

  const before = st()
  const env = serializePatch(before, 'roundtrip')
  const text = JSON.stringify(env, null, 2)
  chk('the file is plain JSON with the v2 marker', /"dpatch": 2/.test(text))
  chk('the file has no undefined-shaped holes', !/undefined|NaN/.test(text))

  const parsed = parseDpatch(JSON.parse(text))
  chk('the file parses', parsed !== null)
  if (parsed) {
    const keep = {
      graph: rootGraphOf(before),
      hardware: before.hardware,
      presets: before.presets,
      layout: before.layout,
      flash: before.daisyFlashMode
    }
    // Reset the store hard, then load the way Open does.
    S.getState().resetGraph()
    S.getState().setLayout({ paletteW: 1, gridSnap: false, gridSize: 20, gridShow: true, marqueeSelect: true, codePanelH: 1 })
    S.getState().setDaisyFlashMode('qspi')
    applyLoadedPatch(parsed, '/tmp/roundtrip.dpatch', S)
    const after = st()

    const strip = (o) => JSON.parse(JSON.stringify(o))
    const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b))
    const diffKeys = (a, b) => {
      const ks = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
      return [...ks].filter((k) => !same(a?.[k], b?.[k]))
    }

    chk('graph: nodes identical', same(keep.graph.nodes, after.graph.nodes),
      `differs in nodes: ${keep.graph.nodes.map((n, i) => diffKeys(n, after.graph.nodes[i]).map((k) => `${n.id}.${k}`)).flat().join(', ')}`)
    chk('graph: connections identical', same(keep.graph.connections, after.graph.connections))
    chk('graph: subpatch body survives', same(
      keep.graph.nodes.find((n) => n.id === sub)?.params.graph,
      after.graph.nodes.find((n) => n.id === sub)?.params.graph))
    chk('graph: collapsed flag survives', after.graph.nodes.find((n) => n.id === sub)?.collapsed === true)
    chk('graph: poly voice count survives', after.graph.nodes.find((n) => n.id === poly)?.params.voices === 3)
    chk('hardware: components identical', same(keep.hardware.components, after.hardware.components),
      `differs: ${keep.hardware.components.map((c, i) => diffKeys(c, after.hardware.components[i]).map((k) => `${c.id}.${k}`)).flat().join(', ')}`)
    chk('hardware: board survives', after.hardware.board === keep.hardware.board)
    chk('hardware: perform placement survives',
      same(after.hardware.components.find((c) => c.id === ledComp)?.perform,
           keep.hardware.components.find((c) => c.id === ledComp)?.perform))
    chk('hardware: pins survive', Object.keys(after.hardware.components.find((c) => c.id === ledComp)?.pins ?? {}).length > 0)
    chk('hardware: label survives', after.hardware.components.find((c) => c.id === ledComp)?.label === 'blink')
    chk('binding: node still points at its component',
      after.graph.nodes.find((n) => n.id === knob)?.params.bindingId === keep.graph.nodes.find((n) => n.id === knob)?.params.bindingId)
    chk('presets: identical', same(keep.presets, after.presets),
      `${JSON.stringify(keep.presets).length} vs ${JSON.stringify(after.presets).length} bytes`)
    chk('presets: two of them, renamed one kept its name', after.presets.length === 2 && after.presets[1].name === 'sub')
    chk('presets: recall still finds its nodes', (() => {
      // presets store per-node params; every node id it names must exist
      const ids = new Set(after.graph.nodes.map((n) => n.id))
      const inner = new Set()
      for (const n of after.graph.nodes) if (n.kind === 'subpatch' && typeof n.params.graph === 'string') {
        for (const m of JSON.parse(n.params.graph).nodes) inner.add(m.id)
      }
      return after.presets.every((pr) => Object.keys(pr.params ?? pr.values ?? {}).every((id) => ids.has(id) || inner.has(id)))
    })())
    const lk = diffKeys(keep.layout, after.layout)
    chk('layout: every field survives', lk.length === 0, `lost: ${lk.join(', ')}`)
    chk('layout: canvas prefs survive', after.layout.gridSnap === true && after.layout.gridSize === 25 && after.layout.gridShow === false && after.layout.marqueeSelect === false)
    chk('flash mode survives', after.daisyFlashMode === 'sram')
    chk('filePath is set and the patch is clean', after.filePath === '/tmp/roundtrip.dpatch' && after.isDirty === false)
    chk('target follows the loaded board', after.target === 'daisy_seed')

    // Second generation: save what we loaded and compare the two files.
    const env2 = serializePatch(after, 'roundtrip')
    chk('save→load→save is a fixed point', same(env, env2),
      `top-level: ${diffKeys(env, env2).join(', ')}`)
  }

  // Legacy and hostile inputs.
  const v1 = { nodes: [mk('o', 'oscillator'), mk('x', 'audio_output')], connections: [w('c', 'o', 'out', 'x', 'left')], meta: { name: 'v1', sampleRate: 48000, blockSize: 48 } }
  const l1 = parseDpatch(v1)
  chk('v1 bare graph loads with an empty layout', l1 !== null && l1.hardware.components.length === 0 && l1.presets.length === 0)
  const legacyBoard = parseDpatch({ dpatch: 2, graph: v1, hardware: { board: 'esp32_s3', components: [], meta: { name: 'x' } } })
  chk("legacy board id 'esp32_s3' is coerced", legacyBoard !== null && legacyBoard.hardware.board !== 'esp32_s3')
  chk('garbage is rejected, not thrown', parseDpatch('nope') === null && parseDpatch(null) === null && parseDpatch({ dpatch: 2 }) === null && parseDpatch({ graph: { nodes: 'x' } }) === null)
  const badPresets = parseDpatch({ dpatch: 2, graph: v1, hardware: { board: 'daisy_seed', components: [], meta: { name: 'x' } }, presets: [{ id: 1 }, 'x', null] })
  chk('malformed presets are dropped, the patch still loads', badPresets !== null && badPresets.presets.length === 0)
  const badLayout = parseDpatch({ dpatch: 2, graph: v1, hardware: { board: 'daisy_seed', components: [], meta: { name: 'x' } }, layout: { paletteW: 'wide', gridSize: -5, daisyFlashMode: 'floppy' } })
  chk('malformed layout fields are dropped individually', badLayout !== null && badLayout.layout === undefined)
  S.getState().resetGraph()
}

/* =====================================================================
 * Board pinouts — the physical truth the hardware view draws
 * ===================================================================== */
if (want('pinouts')) {
  g('pinouts')
  /*
   * Transcribed from boards in hand on 2026-08-17, after both SuperMini
   * tables shipped wrong (C3: columns mirrored, GPIO0–4 reversed; S3: a
   * guessed 11-per-side layout for a board that has 9). A pin drawn on
   * the wrong side is a wire soldered to the wrong pad, so the header
   * order is pinned here exactly, not just counted.
   */
  const col = (id, side) => getBoardPinout(id).physicalLayout
    .filter((p) => p.side === side).sort((a, b) => a.index - b.index).map((p) => p.pin)

  const c3L = col('esp32_c3_supermini', 'left'), c3R = col('esp32_c3_supermini', 'right')
  chk('C3 SuperMini: 8 + 8 header pins', c3L.length === 8 && c3R.length === 8)
  chk('C3 SuperMini: left column, USB end first, is 5 6 7 8 9 10 20 21',
    c3L.join(' ') === 'GPIO5 GPIO6 GPIO7 GPIO8 GPIO9 GPIO10 GPIO20 GPIO21', c3L.join(' '))
  chk('C3 SuperMini: right column is 5V GND 3V3 4 3 2 1 0',
    c3R.join(' ') === '5V GND 3V3 GPIO4 GPIO3 GPIO2 GPIO1 GPIO0', c3R.join(' '))

  const s3L = col('esp32_s3_supermini', 'left'), s3R = col('esp32_s3_supermini', 'right'), s3B = col('esp32_s3_supermini', 'bottom')
  chk('S3 SuperMini (S3-Zero): 9 + 9 header pins', s3L.length === 9 && s3R.length === 9, `${s3L.length}+${s3R.length}`)
  chk('S3 SuperMini: left column is 5V GND 3V3 1 2 3 4 5 6',
    s3L.join(' ') === '5V GND 3V3 GPIO1 GPIO2 GPIO3 GPIO4 GPIO5 GPIO6', s3L.join(' '))
  chk('S3 SuperMini: right column is TX RX 13 12 11 10 9 8 7',
    s3R.join(' ') === 'GPIO43 GPIO44 GPIO13 GPIO12 GPIO11 GPIO10 GPIO9 GPIO8 GPIO7', s3R.join(' '))
  chk('S3 SuperMini: the 11 pads are listed off-header, GPIO21 (RGB LED) and 19/20 (USB) are not',
    s3B.length === 11 && !s3B.includes('GPIO21') && !getBoardPinout('esp32_s3_supermini').pinCaps['GPIO21'] && !getBoardPinout('esp32_s3_supermini').pinCaps['GPIO19'])

  for (const id of ['daisy_seed', 'esp32_s3_devkitc', 'esp32_c3_supermini', 'esp32_s3_supermini']) {
    const p = getBoardPinout(id)
    const header = new Set(p.physicalLayout.filter((x) => x.side !== 'bottom').map((x) => x.pin))
    const caps = Object.keys(p.pinCaps)
    chk(`${id}: every capability pin is on the header or an explicit pad`,
      caps.every((c) => header.has(c) || p.physicalLayout.some((x) => x.pin === c)),
      caps.filter((c) => !p.physicalLayout.some((x) => x.pin === c)).join(','))
    const gpioOnHeader = p.physicalLayout.filter((x) => x.pin.startsWith('GPIO') || /^D\d+$/.test(x.pin)).map((x) => x.pin)
    chk(`${id}: every drawn GPIO has a capability row`, gpioOnHeader.every((x) => p.pinCaps[x]),
      gpioOnHeader.filter((x) => !p.pinCaps[x]).join(','))
    chk(`${id}: no pin drawn twice`, new Set(p.physicalLayout.map((x) => x.pin)).size === p.physicalLayout.length)
  }

  // Auto-assignment reaches for the silkscreened bus pins first.
  chk('C3 SuperMini: first sda/scl candidates are GPIO8/GPIO9',
    getBoardPinout('esp32_c3_supermini').pinsForRole('sda', 'oled_ssd1306')[0] === 'GPIO8' &&
    getBoardPinout('esp32_c3_supermini').pinsForRole('scl', 'oled_ssd1306')[0] === 'GPIO9')
  chk('S3 SuperMini: first sda/scl candidates are GPIO8/GPIO9, first UART rx is GPIO44',
    getBoardPinout('esp32_s3_supermini').pinsForRole('sda', 'oled_ssd1306')[0] === 'GPIO8' &&
    getBoardPinout('esp32_s3_supermini').pinsForRole('scl', 'oled_ssd1306')[0] === 'GPIO9' &&
    getBoardPinout('esp32_s3_supermini').pinsForRole('rx', 'midi_jack')[0] === 'GPIO44')
  const seedSda = getBoardPinout('daisy_seed').pinsForRole('sda', 'oled_ssd1306')
  const seedScl = getBoardPinout('daisy_seed').pinsForRole('scl', 'oled_ssd1306')
  chk('Seed: I2C candidates are I2C1 pins only (the emitter inits I2C_1)',
    seedSda.every((x) => x === 'D12' || x === 'D14') && seedScl.every((x) => x === 'D11' || x === 'D13') && seedSda[0] === 'D12' && seedScl[0] === 'D11',
    `sda ${seedSda.join(',')} scl ${seedScl.join(',')}`)
  chk('DevKitC: USB D-/D+ (GPIO19/20) are never offered for a knob or a button',
    !getBoardPinout('esp32_s3_devkitc').pinsForRole('wiper', 'pot').some((x) => x === 'GPIO19' || x === 'GPIO20') &&
    !getBoardPinout('esp32_s3_devkitc').pinsForRole('io', 'button').some((x) => x === 'GPIO19' || x === 'GPIO20'))
  const dkL = col('esp32_s3_devkitc', 'left'), dkR = col('esp32_s3_devkitc', 'right')
  chk('DevKitC: 22 + 22, J1 top→bottom is 3V3 3V3 RST 4 5 6 7 15 16 17 18 8 3 46 9 10 11 12 13 14 5V GND',
    dkL.length === 22 && dkL.join(' ') === '3V3 3V3_2 EN GPIO4 GPIO5 GPIO6 GPIO7 GPIO15 GPIO16 GPIO17 GPIO18 GPIO8 GPIO3 GPIO46 GPIO9 GPIO10 GPIO11 GPIO12 GPIO13 GPIO14 5V GND', dkL.join(' '))
  chk('DevKitC: J3 top→bottom is GND TX RX 1 2 42 41 40 39 38 37 36 35 0 45 48 47 21 20 19 GND GND',
    dkR.length === 22 && dkR.join(' ') === 'GND_2 GPIO43 GPIO44 GPIO1 GPIO2 GPIO42 GPIO41 GPIO40 GPIO39 GPIO38 GPIO37 GPIO36 GPIO35 GPIO0 GPIO45 GPIO48 GPIO47 GPIO21 GPIO20 GPIO19 GND_3 GND_4', dkR.join(' '))
  chk('DevKitC: left column is drawn top-down (index 0 at the top), like the figure',
    getBoardPinout('esp32_s3_devkitc').geometry.leftColumnBottomUp === false)
  const seedBtn = getBoardPinout('daisy_seed').pinsForRole('io', 'button')
  chk('Seed: a button is never auto-assigned to the D0 underside pad first', seedBtn[0] !== 'D0' && seedBtn.includes('D0'))
}

/* =====================================================================
 * Assistant — the safety boundary
 * ===================================================================== */
if (want('assistant')) {
  g('assistant')
  const graph = {
    nodes: [mk('osc1', 'oscillator'), mk('out1', 'audio_output')],
    connections: [w('c1', 'osc1', 'out', 'out1', 'left')],
    meta: { name: 't', sampleRate: 48000, blockSize: 48 }
  }

  chk('parses bare JSON', !('error' in parseEditPlan('{"summary":"x","edits":[]}')))
  chk('parses fenced JSON', !('error' in parseEditPlan('```json\n{"summary":"x","edits":[]}\n```')))
  chk('parses prose-then-JSON', !('error' in parseEditPlan('Sure!\n{"summary":"x","edits":[]}')))
  chk('rejects prose only', 'error' in parseEditPlan('I cannot do that'))
  chk('rejects JSON with no edits array', 'error' in parseEditPlan('{"summary":"x"}'))

  const mustReject = [
    ['a node kind that does not exist', [{ op: 'add_node', ref: 'a', kind: 'reverb_hall' }]],
    ['a node id that does not exist', [{ op: 'set_param', id: 'ghost', param: 'frequency', value: 1 }]],
    ['a param the node does not have', [{ op: 'set_param', id: 'osc1', param: 'resonance', value: 1 }]],
    ['a socket that does not exist', [{ op: 'connect', from: 'osc1', fromSocket: 'nope', to: 'out1', toSocket: 'left' }]],
    ['an enum value outside the options', [{ op: 'set_param', id: 'osc1', param: 'waveform', value: 'supersaw' }]],
    ['an operation that is not in the schema', [{ op: 'eval', code: 'whatever' }]],
    ['removing a node that is not there', [{ op: 'remove_node', id: 'ghost' }]],
    ['a string where a number belongs', [{ op: 'set_param', id: 'osc1', param: 'frequency', value: 'loud' }]],
    ['a cable between different signal kinds', [
      { op: 'add_node', ref: 'gt', kind: 'gate_in' },
      { op: 'connect', from: 'gt', fromSocket: 'out', to: 'out1', toSocket: 'left' }
    ]]
  ]
  for (const [name, edits] of mustReject) {
    chk(`rejects ${name}`, !validatePlan({ summary: '', edits }, graph).ok)
  }

  const good = {
    summary: 'add a filter',
    edits: [
      { op: 'add_node', ref: 'f', kind: 'filter_svf', params: { frequency: 800 } },
      { op: 'disconnect', from: 'osc1', fromSocket: 'out', to: 'out1', toSocket: 'left' },
      { op: 'connect', from: 'osc1', fromSocket: 'out', to: 'f', toSocket: 'in' },
      { op: 'connect', from: 'f', fromSocket: 'lp', to: 'out1', toSocket: 'left' }
    ]
  }
  const okRes = validatePlan(good, graph)
  chk('accepts a valid plan, including forward refs', okRes.ok, JSON.stringify(okRes.errors))
  chk('describes the plan in words', /^add /.test(describePlan(good, graph)[0]))

  const oor = validatePlan(
    { summary: '', edits: [{ op: 'set_param', id: 'osc1', param: 'frequency', value: 99999 }] },
    graph
  )
  chk('an out-of-range value warns rather than rejecting', oor.ok && oor.warnings.length === 1)

  const sp = systemPrompt('daisy_seed')
  chk('the prompt carries the catalog', /oscillator \| in:/.test(sp))
  chk('the prompt hides structural kinds', !/^subpatch \|/m.test(sp))
  chk('the prompt hides hardware kinds', !/^knob_in \|/m.test(sp))
  chk('the prompt is target-filtered', sp.length !== systemPrompt('esp32_c3_supermini').length)
  chk('the request carries the current patch', /osc1 : oscillator/.test(userPrompt(graph, 'hi')))
}

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* nop */
}

console.log('')
if (failures > 0) {
  console.error(`[features] FAILED — ${failures} of ${checks} checks`)
  process.exit(1)
}
console.log(`[features] PASS — ${checks} checks`)
process.exit(0)
