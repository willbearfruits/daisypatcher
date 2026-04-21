#!/usr/bin/env node
/**
 * Compile every `src/audio/worklets/*.worklet.ts` → sibling `*.worklet.js`.
 *
 * Why this script exists
 * ----------------------
 * The worklet registry points at files via `new URL('./x.worklet.ts', import.meta.url)`.
 * Vite treats that as an **asset reference** (not a module import), so it
 * emits the raw `.ts` file as-is. In `npm run dev` this still works because
 * Vite's middleware transpiles TS on the fly; in the production AppImage the
 * browser receives raw TypeScript, `AudioWorklet.addModule()` rejects with a
 * syntax error, and every worklet silently fails to register — resulting in
 * zero audio from emulated nodes.
 *
 * The fix: pre-compile `.worklet.ts` → `.worklet.js` and change the registry
 * to reference `.js`. Worklets are self-contained (AudioWorkletGlobalScope
 * prevents imports anyway), so we can use `bundle: false` and keep one file
 * in, one file out.
 *
 * Run as a `predev` / `prebuild` npm hook. Also used by the Vite plugin
 * below for rebuilds during development.
 */

import { build } from 'esbuild'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKLET_DIR = resolve(__dirname, '../src/audio/worklets')

const entryPoints = readdirSync(WORKLET_DIR)
  .filter((f) => f.endsWith('.worklet.ts'))
  .map((f) => join(WORKLET_DIR, f))

await build({
  entryPoints,
  outdir: WORKLET_DIR,
  // AudioWorklet.addModule() loads the target as an ES module — keep it ESM.
  format: 'esm',
  // Worklets never import from the app runtime (AudioWorkletGlobalScope has
  // no `window`, no shared singletons). No bundling needed; each file is
  // independently valid output.
  bundle: false,
  platform: 'browser',
  // Electron 33 ships a recent Chromium; modern syntax is safe.
  target: 'chrome120',
  // Strip internal comments / the /// <reference ... /> TS directive from output.
  legalComments: 'none',
  logLevel: 'warning'
})

console.log(`[build-worklets] compiled ${entryPoints.length} worklets`)
