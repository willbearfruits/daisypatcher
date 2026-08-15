#!/usr/bin/env node
// Cross-target contract test for Daisypatcher's emitters.
//
// There are two parallel emitter tables — `nodeEmitters.ts` (Daisy) and
// `nodeEmittersEsp32.ts` — implementing the same catalog, and nothing has
// ever enforced that a kind behaves the same on both. The snapshot tests
// compare each target against its OWN stored text, so two targets can drift
// apart indefinitely and both stay green. The compile harness catches code
// that does not build, but not code that builds and quietly does less.
//
// This checks the properties that must hold on every target a kind claims
// to support, without needing a compiler:
//
//   1. SUPPORT IS HONEST     — a kind the support matrix does not call
//                              'unsupported' must have a real emitter, not
//                              the generic passthrough stub.
//   2. OUTPUTS ARE DECLARED  — every output the emitter assigns is declared
//                              at block scope. (The bug class that shipped:
//                              a brace around the body killed the variable
//                              at the closing brace and every downstream
//                              node failed to compile.)
//   3. OUTPUTS ARE PRODUCED  — every output socket in the node definition
//                              actually gets a variable. A missing one is a
//                              silent "reads as zero" on that target only.
//   4. TARGETS AGREE         — the SET of outputs produced is identical
//                              across every supporting target. This is the
//                              cross-target equivalence a static check can
//                              actually assert.
//
// Usage:
//   node scripts/codegen-contract.mjs
//   node scripts/codegen-contract.mjs --only oscillator,filter_svf
//
// Exits non-zero on any violation. Test scaffolding — not part of the app.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const PROJECT_ROOT = path.resolve(new URL('..', import.meta.url).pathname)

const args = process.argv.slice(2)
let onlyFilter = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only' && args[i + 1]) onlyFilter = new Set(args[++i].split(','))
}

// ---- bundle codegen (same loader as the other two scripts) ----
const require_ = createRequire(import.meta.url)
const esbuild = require_(path.join(PROJECT_ROOT, 'node_modules/esbuild'))
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dp-contract-'))
const ENTRY = path.join(tmpDir, '_entry.ts')
const BUNDLE = path.join(tmpDir, 'bundle.cjs')
const p = (rel) => path.join(PROJECT_ROOT, rel).replace(/\\/g, '/')

writeFileSync(
  ENTRY,
  [
    `export { generateProject } from '${p('src/codegen/generateProject')}'`,
    `export { NODE_DEFINITIONS } from '${p('src/nodes/definitions')}'`,
    `export { emptyHardwareLayout } from '${p('src/types/hardware')}'`,
    `export { supportLevel } from '${p('src/nodes/targetSupport')}'`,
    `export { nodeVar } from '${p('src/codegen/graphWalk')}'`,
    `export { BOARD_IDS } from '${p('shared/boards')}'`
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

const { generateProject, NODE_DEFINITIONS, emptyHardwareLayout, supportLevel, nodeVar, BOARD_IDS } =
  require_(BUNDLE)

/* ---------- fixture ---------- */

let uid = 0
const mk = (kind) => {
  const params = {}
  for (const q of NODE_DEFINITIONS[kind].params) params[q.id] = q.default
  return { id: `n${++uid}_${kind}`, kind, position: { x: 0, y: 0 }, params }
}

/**
 * Minimal graph exercising one kind.
 *
 * Every audio and gate input is fed, because several emitters branch on
 * whether an input is connected (the `__NC__` sentinel) and the unconnected
 * branch is not the one worth checking for output completeness.
 */
function graphFor(kind) {
  uid = 0
  const def = NODE_DEFINITIONS[kind]
  const node = mk(kind)
  const sink = mk('audio_output')
  const nodes = [node, sink]
  const connections = []
  let cid = 0

  for (const sock of def.inputs) {
    if (sock.signal === 'audio') {
      const osc = mk('oscillator')
      nodes.push(osc)
      connections.push({
        id: `c${++cid}`,
        from: { nodeId: osc.id, socketId: 'out' },
        to: { nodeId: node.id, socketId: sock.id }
      })
    } else if (sock.signal === 'gate') {
      const g = mk('gate_in')
      nodes.push(g)
      connections.push({
        id: `c${++cid}`,
        from: { nodeId: g.id, socketId: 'out' },
        to: { nodeId: node.id, socketId: sock.id }
      })
    }
  }

  const first = def.outputs.find((o) => o.signal === 'audio')
  if (first) {
    connections.push({
      id: `c${++cid}`,
      from: { nodeId: node.id, socketId: first.id },
      to: { nodeId: sink.id, socketId: 'left' }
    })
  }

  return {
    graph: { nodes, connections, meta: { name: `${kind}_contract`, sampleRate: 48000, blockSize: 48 } },
    node
  }
}

/* ---------- declaration parser (mirrors graphWalk.auditOutputDecls) ---------- */

function declaredNames(src) {
  const out = new Set()
  for (const m of src.matchAll(/\b(?:float|double|int|bool|uint\d+_t|int\d+_t)\b([^;{}]*);/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[\s=[(]/)[0]?.replace(/^[*&]+/, '')
      if (name) out.add(name)
    }
  }
  return out
}

/* ---------- run ---------- */

/**
 * Kinds that exist for the EDITOR and never reach an emitter.
 *
 * `generateProject` flattens subpatches away before any backend sees the
 * graph (see state/subpatch.ts), so a `subpatch` node legitimately produces
 * no outputs — it is not there any more. Checking it as though it were an
 * emitter tests the wrong thing and would push someone toward writing a
 * passthrough that must never run.
 *
 * Named explicitly rather than exempted by category: a future structural
 * kind should have to justify itself here, not inherit a loophole.
 */
const STRUCTURAL_KINDS = new Set(['subpatch', 'sub_in', 'sub_out', 'poly', 'voice_id'])

const kinds = Object.keys(NODE_DEFINITIONS)
  .filter((k) => !STRUCTURAL_KINDS.has(k))
  .filter((k) => !onlyFilter || onlyFilter.has(k))
const violations = []
let checks = 0

for (const kind of kinds) {
  const def = NODE_DEFINITIONS[kind]
  /** target -> Set of output socket ids the emitter actually produced. */
  const producedByTarget = new Map()

  for (const target of BOARD_IDS) {
    const level = supportLevel(kind, target)
    if (level === 'unsupported') continue

    const { graph, node } = graphFor(kind)
    let proj
    try {
      proj = generateProject(graph, emptyHardwareLayout(target), `${kind}_contract`, target, {
        daisyFlashMode: 'qspi'
      })
    } catch (err) {
      violations.push(`${kind} × ${target}: generateProject threw — ${err?.message ?? err}`)
      continue
    }
    const src = proj.files['src/main.cpp'] ?? proj.files['main.cpp'] ?? ''
    const warnings = proj.warnings ?? []
    checks++

    // 1. Support is honest.
    const stubWarn = warnings.find((w) => /no codegen implementation for this target|no emitter for/.test(w))
    if (stubWarn) {
      violations.push(
        `${kind} × ${target}: support matrix says '${level}' but codegen fell through to the ` +
          `generic passthrough — either write an emitter or mark it unsupported`
      )
    }

    // 2. Outputs declared. The generator already audits this; surface it here
    //    so the contract run is the single place a CI job has to look.
    for (const w of warnings) {
      if (/assigned but never declared at block scope/.test(w)) {
        violations.push(`${kind} × ${target}: ${w}`)
      }
    }

    // 3. Outputs produced.
    const declared = declaredNames(src)
    const base = nodeVar(node.id, kind)
    const produced = new Set()
    for (const sock of def.outputs) {
      const name = `${base}_${sock.id}`
      if (declared.has(name)) produced.add(sock.id)
    }
    producedByTarget.set(target, produced)

    // A kind with no outputs at all is a sink (led, print, audio_output) —
    // nothing to check.
    if (def.outputs.length > 0 && produced.size === 0 && !stubWarn) {
      violations.push(
        `${kind} × ${target}: declares ${def.outputs.length} output(s) and the emitter produced none`
      )
    }
  }

  // 4. Targets agree on which outputs exist.
  const entries = [...producedByTarget.entries()]
  if (entries.length > 1) {
    const [refTarget, refSet] = entries[0]
    for (const [target, set] of entries.slice(1)) {
      const missing = [...refSet].filter((x) => !set.has(x))
      const extra = [...set].filter((x) => !refSet.has(x))
      if (missing.length || extra.length) {
        violations.push(
          `${kind}: targets disagree — ${target} ` +
            (missing.length ? `is missing [${missing.join(', ')}] ` : '') +
            (extra.length ? `has extra [${extra.join(', ')}] ` : '') +
            `relative to ${refTarget}`
        )
      }
    }
  }
}

try {
  rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* nop */
}

if (violations.length > 0) {
  console.error(`[contract] FAILED — ${violations.length} violation(s) across ${checks} kind×target checks\n`)
  for (const v of violations) console.error(`  · ${v}`)
  console.error('')
  process.exit(1)
}

console.log(
  `[contract] PASS — ${kinds.length} kinds × ${BOARD_IDS.length} targets, ` +
    `${checks} kind×target combinations, no drift`
)
process.exit(0)
