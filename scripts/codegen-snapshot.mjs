#!/usr/bin/env node
// Codegen snapshot tests for Daisypatcher.
//
// Loads the TS codegen the same way scripts/codegen-compile-harness.mjs does
// (esbuild-bundle to CJS, then require), runs `generateProject` for every
// canonical patch fixture in scripts/snapshot-patches/ against every target
// backend, and compares the emitted files against the stored snapshots in
// scripts/__snapshots__/<patch>/<target>/.
//
// Usage:
//   node scripts/codegen-snapshot.mjs            # check mode (exit 1 on drift)
//   node scripts/codegen-snapshot.mjs --update   # (re)write snapshots
//   node scripts/codegen-snapshot.mjs --only bare-osc-out,drums-kit
//
// Fixture format (scripts/snapshot-patches/*.json):
//   { "graph": AudioGraph, "hardware"?: HardwareLayout }
//
// This file is *test scaffolding* — not a runtime part of the app.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PATCH_DIR = path.join(PROJECT_ROOT, 'scripts', 'snapshot-patches')
const SNAP_ROOT = path.join(PROJECT_ROOT, 'scripts', '__snapshots__')

// ---- CLI ----
const args = process.argv.slice(2)
const updateMode = args.includes('--update')
let onlyFilter = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only' && args[i + 1]) {
    onlyFilter = new Set(args[i + 1].split(','))
    i++
  }
}

// ---- Step 1: bundle codegen with esbuild (same loader as the compile harness) ----
const require_ = createRequire(import.meta.url)
const esbuild = require_(path.join(PROJECT_ROOT, 'node_modules/esbuild'))

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dp-snapshot-'))
const ENTRY = path.join(tmpDir, '_entry.ts')
const BUNDLE_PATH = path.join(tmpDir, 'codegen-bundle.cjs')

writeFileSync(
  ENTRY,
  [
    `export { generateProject } from '${path.join(PROJECT_ROOT, 'src/codegen/generateProject').replace(/\\/g, '/')}'`,
    `export { TARGETS } from '${path.join(PROJECT_ROOT, 'src/codegen/targets/index').replace(/\\/g, '/')}'`,
    `export { emptyHardwareLayout } from '${path.join(PROJECT_ROOT, 'src/types/hardware').replace(/\\/g, '/')}'`
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

const { generateProject, TARGETS } = require_(BUNDLE_PATH)
const targetIds = Object.keys(TARGETS)

// ---- Step 2: load fixtures ----
if (!existsSync(PATCH_DIR)) {
  console.error(`[snapshot] fixture dir missing: ${PATCH_DIR}`)
  process.exit(1)
}

let fixtureNames = readdirSync(PATCH_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => f.slice(0, -'.json'.length))
if (onlyFilter) fixtureNames = fixtureNames.filter((n) => onlyFilter.has(n))

if (fixtureNames.length === 0) {
  console.error('[snapshot] no fixtures matched')
  process.exit(1)
}

function loadFixture(name) {
  const raw = readFileSync(path.join(PATCH_DIR, `${name}.json`), 'utf8')
  const data = JSON.parse(raw)
  if (!data.graph || !Array.isArray(data.graph.nodes)) {
    throw new Error(`fixture ${name} has no valid "graph"`)
  }
  return data
}

// ---- Step 3: helpers ----
function listFilesRecursive(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...listFilesRecursive(p, base))
    // Generated file keys are always `/`-separated (`src/main.cpp`); on
    // Windows `path.relative` gives `src\main.cpp` and every nested file
    // read as removed-and-added. Normalise here, once.
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out.sort()
}

/**
 * Readable diff summary: trim common prefix/suffix lines, then show the
 * differing middle block (truncated). Enough to see *what* drifted without
 * pulling in a diff library.
 */
function diffSummary(expected, actual, maxLines = 12) {
  const a = expected.split('\n')
  const b = actual.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const lines = []
  lines.push(`    first divergence at line ${start + 1} (snapshot ${a.length} lines, generated ${b.length} lines)`)
  const expBlock = a.slice(start, Math.min(endA + 1, start + maxLines))
  const actBlock = b.slice(start, Math.min(endB + 1, start + maxLines))
  for (const l of expBlock) lines.push(`    - ${l}`)
  if (endA + 1 - start > maxLines) lines.push(`    - … (${endA + 1 - start - maxLines} more snapshot lines)`)
  for (const l of actBlock) lines.push(`    + ${l}`)
  if (endB + 1 - start > maxLines) lines.push(`    + … (${endB + 1 - start - maxLines} more generated lines)`)
  return lines.join('\n')
}

// ---- Step 4: run ----
let failures = 0
let checked = 0
let written = 0

for (const name of fixtureNames) {
  let fixture
  try {
    fixture = loadFixture(name)
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`)
    failures++
    continue
  }

  for (const target of targetIds) {
    const label = `${name} × ${target}`
    let proj
    try {
      proj = generateProject(
        fixture.graph,
        fixture.hardware ?? undefined,
        fixture.graph.meta?.name,
        target,
        // `presets` is store state, not part of the graph, so a fixture
        // that wants preset codegen covered carries its own list.
        { daisyFlashMode: 'qspi', presets: fixture.presets ?? [] }
      )
    } catch (err) {
      console.error(`[FAIL] ${label}: generateProject threw — fixture is broken`)
      console.error(`       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : String(err)}`)
      failures++
      continue
    }

    const snapDir = path.join(SNAP_ROOT, name, target)

    if (updateMode) {
      rmSync(snapDir, { recursive: true, force: true })
      mkdirSync(snapDir, { recursive: true })
      for (const [rel, content] of Object.entries(proj.files)) {
        const dest = path.join(snapDir, rel)
        mkdirSync(path.dirname(dest), { recursive: true })
        writeFileSync(dest, content, 'utf8')
        written++
      }
      console.log(`[WROTE] ${label} (${Object.keys(proj.files).length} files)`)
      continue
    }

    // Check mode
    if (!existsSync(snapDir)) {
      console.error(`[FAIL] ${label}: no stored snapshot — run \`node scripts/codegen-snapshot.mjs --update\``)
      failures++
      continue
    }

    const storedFiles = listFilesRecursive(snapDir)
    const generatedFiles = Object.keys(proj.files).sort()
    const problems = []

    for (const f of storedFiles) {
      if (!generatedFiles.includes(f)) problems.push(`  file removed from output: ${f}`)
    }
    for (const f of generatedFiles) {
      if (!storedFiles.includes(f)) problems.push(`  new file in output (not in snapshot): ${f}`)
    }

    for (const f of generatedFiles) {
      if (!storedFiles.includes(f)) continue
      // Normalise line endings: a Windows checkout with autocrlf turns the
      // stored snapshot into CRLF while the generator emits LF, and every
      // file "differed at line 1". `.gitattributes` pins LF too; this is
      // the belt to that suspenders.
      const expected = readFileSync(path.join(snapDir, f), 'utf8').replace(/\r\n/g, '\n')
      const actual = proj.files[f]
      if (expected !== actual) {
        problems.push(`  ${f} differs:\n${diffSummary(expected, actual)}`)
      }
      checked++
    }

    if (problems.length > 0) {
      console.error(`[FAIL] ${label}`)
      for (const p of problems) console.error(p)
      failures++
    } else {
      console.log(`[OK]   ${label} (${generatedFiles.length} files)`)
    }
  }
}

// ---- Step 5: report + cleanup ----
try {
  rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* nop */
}

if (updateMode) {
  console.log(`\n[snapshot] wrote ${written} files across ${fixtureNames.length} patches × ${targetIds.length} targets`)
  process.exit(failures > 0 ? 1 : 0)
}

if (failures > 0) {
  console.error(`\n[snapshot] FAILED — ${failures} patch×target combination(s) drifted (${checked} files compared)`)
  console.error('[snapshot] if the change is intentional, re-run with --update and commit the snapshots')
  process.exit(1)
}
console.log(`\n[snapshot] PASS — ${fixtureNames.length} patches × ${targetIds.length} targets, ${checked} files compared, no drift`)
process.exit(0)
