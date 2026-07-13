# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Daisypatcher is an Electron desktop app: a visual node-based patcher for the Electro-Smith Daisy Seed and ESP32-S3. Users drop DSP nodes on a canvas, hear the patch in-app via WebAudio emulation, optionally wire up physical hardware in a separate "Hardware" view (knobs, LEDs, OLEDs, MIDI/I2S jacks) mapped to board pins, then compile the graph to a C++ project (libDaisy/DaisySP for Seed, Arduino/PlatformIO for ESP32) and flash the device.

## Commands

```bash
npm run dev            # electron-vite dev: builds main+preload+renderer, opens the app, HMR on renderer
npm run build          # production build of all three bundles
npm run typecheck      # tsc --noEmit against both tsconfigs (node + web, run both)
npm run typecheck:node # electron main + preload only
npm run typecheck:web  # renderer only
npm run build:worklets # compiles src/audio/worklets/*.worklet.ts → *.worklet.js via esbuild
npm run test:codegen   # codegen snapshot tests (see below); --update rewrites, --only patch1,patch2 filters
npm run dist:linux     # AppImage x64+arm64 via electron-builder (flatpak dropped — sandbox can't reach host toolchains)
npm run dist:win       # NSIS installer + portable exe
npm run publish        # build + upload to GitHub Releases (feeds the auto-updater)
```

Pre-hooks `predev` and `prebuild` run `build:worklets` automatically — don't run a bare `electron-vite` without it or HMR serves stale worklets.

Diagnostic: `node scripts/codegen-compile-harness.mjs [--only kind1,kind2]` runs codegen + make per-node against a minimal test graph and writes `/tmp/dp-harness/REPORT.md`. Requires the libDaisy/DaisySP clones at `~/.config/daisypatcher/sdk/`.

**Testing story**: `typecheck` + `build` + `test:codegen` are the safety net; the in-app Test Rig + Verification Panel (see below) are the hardware-loop runtime checks. `test:codegen` runs `generateProject` for every fixture in `scripts/snapshot-patches/*.json` against every target and diffs the emitted C++ against `scripts/__snapshots__/<patch>/<target>/`. After an intentional codegen change, re-run with `--update` and review the snapshot diff before considering the change done. No compile step involved — snapshot drift is cheap to check, so run it after ANY emitter/target edit.

## Architecture

### Three-process layout
- **Electron main** (`electron/main/*.ts`) — IPC handlers, `buildService` (runs make / pio), `flashService` (dfu-util / pio upload), `serialService` (node-serialport), `sdk` (first-run libDaisy+DaisySP clone+build), `updater` (electron-updater against GitHub Releases; only initialized when `app.isPackaged` — it throws on unsigned dev runs — and inert until the repo is public with a release containing `latest.yml`).
- **Preload** (`electron/preload/index.ts`) — `contextBridge.exposeInMainWorld('daisy', api)`. **Must compile to CommonJS `.js`** (forced in `electron.vite.config.ts`) because the window uses `sandbox: true`; ESM preload silently fails to load and every IPC call becomes a no-op.
- **Renderer** (`src/*.tsx`) — React 19 + Vite + TS, Zustand state, Rete.js node graph, WebAudio AudioWorklets for DSP emulation.

### Two parallel data models in one store
- `AudioGraph` (`src/types/graph.ts`) — the DSP patch: nodes + connections.
- `HardwareLayout` (`src/types/hardware.ts`) — placed physical components + pin bindings.

They are linked by reference only: hardware-bound nodes (`knob_in`, `button`, `led`, `oled`, etc.) carry a `bindingId` param pointing to a `PlacedComponent.id`. Codegen dereferences via `src/codegen/hardwareBindings.ts`. Both halves round-trip through `.dpatch` JSON (`src/state/patchFile.ts`) and both participate in undo history (`HistorySnapshot = { graph, hardware }`).

### Store transactions for history coalescing
`useEditorStore.beginTransaction()` / `endTransaction()` brackets a drag gesture (node move, slider sweep) so N intermediate mutations become one undo entry. Rete's drag pipes and the Inspector's slider pointer handlers both call these. History is capped at 50.

### Node catalog assembled from partials
Adding a new DSP node requires edits in **five** places (plus a sixth conditional):
1. `src/types/graph.ts` — add to the `NodeKind` union.
2. `src/nodes/defs.<group>.ts` — add a `NodeDefinition`. Partial files are grouped thematically (`effects`, `sequencing`, `synthesis`, `visual`, `hardware`) so parallel work doesn't collide on one giant file; the `category` field is a separate axis (`'source' | 'process' | 'io' | 'hardware'`) — use `'hardware'` for anything that should auto-link to a `PlacedComponent` on drop. Final `NODE_DEFINITIONS` is spread from `CORE_DEFS` + partials in `src/nodes/definitions.ts`.
3. `src/audio/worklets/<kind>.worklet.ts` — `AudioWorkletProcessor` registered as `'dp-<kind>'`. Module-scope constants like `const TWO_PI = ...` WILL cause duplicate-declaration errors across worklets; inline `Math.PI * 2` or make them class fields.
4. `src/audio/worklets/registry.<group>.ts` — add to the matching registry partial. Final `WORKLET_REGISTRY` merges them in `src/audio/worklets/registry.ts`. URL resolution uses `new URL('./x.worklet.js', import.meta.url)` (**compiled** .js — see worklet build pipeline below).
5. `src/codegen/nodeEmitters.ts` (Daisy) and/or `src/codegen/nodeEmittersEsp32.ts` (ESP32) — add an emitter `{ declare, init, process }` producing C++ for that kind.
6. `src/nodes/targetSupport.ts` — ONLY if the kind is not fully implemented on some target: declare it `'stub'` or `'unsupported'` there (a missing entry means `'native'`). This table drives the palette's target filter and the amber/red support dots; the remaining ESP32 stubs are enumerated in `ESP32_STUBS` with reasons.

After touching emitters or targets, run `npm run test:codegen`; a new kind used by a snapshot fixture needs `--update`.

### CV-modulation socket convention
Most nodes expose their modulatable params as explicit `cv_<paramId>` input sockets (signal kind `'cv'`) alongside the sidebar slider. Contract:
- When disconnected → the sidebar `params[paramId]` value is used.
- When connected → the CV value **replaces** the param directly, clamped to the param's `ParamDef.min` / `max`.
- Legacy sockets with names like `pitch_cv` / `freq_cv` / `fold_cv` that predate this convention keep their **offset/additive** semantics — don't rename them. When both a legacy offset-CV and a replace-CV exist (e.g. oscillator has both `pitch_cv` and `cv_pitch`), code should handle "replace takes priority" — see `nodeEmitters.ts` `ctx.inputExpr(..., '__NC__')` sentinel pattern for the emitter-side connect-detection.

### Worklet build pipeline
`scripts/build-worklets.mjs` (via esbuild, `bundle: false`) compiles every `src/audio/worklets/*.worklet.ts` → sibling `*.worklet.js` as `predev`/`prebuild`/`dist:*` hooks. Three reasons this indirection exists, all of which have bitten the app before:
1. Vite treats `new URL('./x.worklet.ts', import.meta.url)` as a static asset and emits the raw `.ts` — Chromium rejects TypeScript at `audioWorklet.addModule()`. Dev masks this because Vite transpiles on the fly.
2. The built bundle's CSP has `script-src 'self'`. Chromium's `AudioWorklet.addModule` enforces `script-src`, not `worker-src`. If Vite inlines a small worklet as a `data:text/javascript;base64,...` URL (default for assets under 4 KB), it's blocked. `electron.vite.config.ts` sets `build.assetsInlineLimit` to reject inlining for `*.worklet.js` specifically — every worklet ships as a hashed sibling file.
3. Worklets are self-contained by contract (`AudioWorkletGlobalScope` has no `window`, no shared singletons). `bundle: false` + single-file-in/out is correct.

Consequences: registries reference `.worklet.js`. The .ts files are the source of truth and are gitignored-compiled output. If a worklet feels "stuck" in dev, `npm run build:worklets` fixes it.

### Target abstraction (multi-board codegen)
`src/codegen/targets/` contains one `TargetBackend` per board (`daisySeed.ts`, `esp32s3.ts`). Each exposes `generate()`, `buildCommand()`, `flashCommand()`, `toolchainCheck()`, `binaryArtifact()`. `generateProject` is a thin dispatcher. The store's `target` field drives the active backend; the hardware view swaps its pinout via `src/hardware/boardPinout.ts`. Workspaces are per-target: `~/.config/daisypatcher/workspace/seed/<name>/` vs `.../esp32/<name>/`.

### Rete.js renderer dispatch
`src/editor/ReteEditor.tsx` registers one React preset with `customize.node` that routes by kind:
- `oled` → `OledNode.tsx` (in-body display designer, 128×64 canvas, live element editor)
- `scope` / `vu` / `spectrum_scope` → `VisualNode.tsx` (live canvas fed by `AudioEngine.tap()`)
- everything else → `CustomNode.tsx`
- `socket` always → `CustomSocket.tsx` (single element, IS the drag target — do not wrap `<RefSocket>` inside a pill or you get double-rendered sockets)
- `connection` → `CustomConnection.tsx`

All three custom node renderers share a collapse pattern: when `NodeInstance.collapsed === true`, the body is unmounted and sockets are re-positioned on the header via absolutely-positioned stacks so Rete cables stay anchored.

### Hardware view is SVG-only
`src/hardware/HardwareView.tsx` renders the board silhouette, pin rows, placed components, and wires all inside one `<svg>` with `viewBox`-based pan/zoom. No HTML DOM overlay for cards — that approach accumulated anchor-alignment bugs between the SVG (wires) and DOM (cards). Since everything lives in the same coordinate system, wire anchors cannot drift from the visible shape by construction. Shape geometry comes from `src/hardware/componentShapes.tsx` (mm-scaled, `MM_PER_UNIT = 3`) and rotations pivot on the shape's natural center. `toCanvas(clientX, clientY)` exists only for **input** (drag start, palette drop) — never used for rendering.

### Auto-link patch ↔ hardware
When a patch-side node from the `'hardware'` category is dropped, `store.addNode()` also creates a paired `PlacedComponent` in the same `mutate()` transaction, points the node's `params.bindingId` at it, and auto-assigns each required role to the first free compatible pin on the current board (via `pinout.pinsForRole`). `SHARED_BUS_ROLES` in `store.ts` (`sda`/`scl`/`sck`/`mclk`) lets I²C devices share one bus. Symmetric: `removeNode` drops the paired `PlacedComponent` unless another graph node still references it. Undo reverts the pair atomically because both live in one `HistorySnapshot`.

### AudioEngine tap system
`src/audio/AudioEngine.ts` implements an interface in `src/types/store.ts`. Visual nodes call `engine.tap(nodeId, onFrame, { wantFrequency? })` to fork a node's output through a hidden `AnalyserNode`. A single global `requestAnimationFrame` loop pulls `getFloatTimeDomainData` / `getFloatFrequencyData` into reusable typed arrays and dispatches to all active taps. The visual renderers (scope/VU/spectrum/OLED) and hardware-view activity overlays (LED glow, button flash) consume these frames. To tap a node's INPUT (like OLED elements bound to input sockets), walk the graph to find the connection's source and tap THAT source node — see `tapInput()` in `OledNode.tsx`.

### Test rig + verification store
`src/state/testRig.ts` generates a minimal test `AudioGraph` for any node kind (source → output, filter with noise + LFO-swept cutoff, envelope triggered by clock → VCA, etc.). `src/state/verificationStore.ts` persists per-`(kind, target)` pass/fail status via a dual tier: `localStorage` always, plus IPC mirror to `~/.config/daisypatcher/verified.json`. The Inspector's "TEST" button opens `TestRigModal.tsx` which runs `compileStore.buildTestPatch(graph)` → flash → auto-open serial monitor → pass/fail buttons. The TopBar check icon opens `VerificationPanel.tsx` — filterable table of all NodeKinds × targets with counters.

### Theme system
`src/theme/ThemeProvider.tsx` flattens a `Skin` + shared tokens into CSS custom properties on `:root`. **Every component reads from `--dp-*` vars; no hex in component code.** All three themes ship: `signal-lab` (default), `studio-rack`, `crt-patchbay` — registered in `src/theme/themes/index.ts`. Adding a theme = a new `Skin` in `src/theme/themes/`.

## Conventions

- **Tokens only.** Colors, radii, spacing, motion — always `var(--dp-*)`. A component that hardcodes a color is a bug.
- **No UI libraries.** Hand-built CSS modules (`*.module.css`). No Material, Radix, Chakra, Tailwind. An ambient `*.module.css` declaration lives in `src/css-modules.d.ts`.
- **No emoji in UI.** Inline SVGs (1.5px stroke, `stroke="currentColor"`) for icons.
- **Tokens for motion**: `var(--dp-motion-fast)` = 120ms, `normal` = 200ms, `slow` = 320ms, easing `--dp-ease`.
- **Cross-signal-kind connections are rejected by the connection plugin.** `src/editor/sockets.ts` defines `SignalSocket` per kind; `canMakeConnection` is enforced via `ClassicFlow({ canMakeConnection })` in `ReteEditor.tsx`. The store's `connect()` is the second gate.
- **Serialization uses a versioned envelope.** `.dpatch` v2 is `{ dpatch: 2, graph, hardware, layout? }`; v1 (bare `AudioGraph`) still loads with an empty hardware layout.

## Non-obvious gotchas

- **Preload extension.** electron-vite ordinarily outputs ESM because `package.json` has `"type": "module"`. The preload entry is explicitly overridden to CJS `.js` in `electron.vite.config.ts`; don't revert. `webPreferences.preload` must stay pointed at `index.js`.
- **libDaisy submodules.** `git clone --depth 1` without `--recurse-submodules` will leave STM32 HAL / CMSIS / USB Device Library empty and `make` exits with code 2. `electron/main/sdk.ts` handles this correctly — keep it that way for any future target that uses git submodules.
- **Multi-output/input worklets.** The engine configures `numberOfInputs = def.inputs.length` and `numberOfOutputs = def.outputs.length`; socket order in `NODE_DEFINITIONS[kind].inputs/outputs` is the input/output index. Reordering a node's sockets breaks existing patches. Write to `outputs[socketIndex][0]`.
- **Zustand selectors must return cached references.** Computing `new Set(...)` / `new Map(...)` / `arr.map(...)` inside a `useEditorStore((s) => ...)` selector causes `useSyncExternalStore` to loop infinitely. Select the stable field and derive in `useMemo`. This hurt us once (blank Hardware tab); don't do it again.
- **"No cable connected" in worklets.** WebAudio delivers unconnected inputs as empty channel arrays. Check `inputs[i]?.[0]?.length > 0` before reading; zero-valued arithmetic can be observably wrong (e.g. an `amp_cv` input should mean "node plays normally" when unconnected, not "silent").
- **AudioEngine context doesn't cross Rete's `createRoot`.** Rete mounts each node / connection / socket in its own React root via `createRoot`. React Context from the main app tree (including `AudioEngineProvider`) does NOT traverse that boundary. `useAudioEngine()` in `src/audio/AudioEngineContext.tsx` falls back to a module-level singleton that the provider writes on every render; that's what lets `VisualNode` / `CustomConnection` / `HardwareActivity` tap the engine. If you add another provider that inside-Rete components need, apply the same singleton pattern.
- **DFU detect latency.** `flashService.detectFlashDevices()` and `deviceDetection.probeSeedDfu()` both have Linux sysfs fast paths (`/sys/bus/usb/devices/*/idVendor`) that sidestep `dfu-util -l -v` when nothing is plugged in. When sysfs first sees `0483:df11`, `detectFlashDevices` runs dfu-util **synchronously** (one-time) to populate a module cache — sysfs sees the device ~50 ms before libusb can open it, so flagging `deviceAvailable=true` on sysfs alone races the flash command. Subsequent polls while the device stays plugged in are sysfs-only.

## Paths worth knowing

- User data / SDK clones: `~/.config/daisypatcher/sdk/{libDaisy,DaisySP}/`
- Build workspaces: `~/.config/daisypatcher/workspace/{seed,esp32}/<projectName>/`
- Roadmap: `V0_5_PLAN.md` (current milestone — landed items + next-in-line + release checklist) and `V2_PLAN.md` (long-horizon vision) at the repo root. Check these before proposing new feature work.
- DevTools auto-opens detached in dev mode (`createWindow` in `electron/main/index.ts`). Runtime errors from the renderer surface there; main-process errors go to the terminal running `npm run dev`.

## Memory

Claude's persistent memory lives in `/home/glitches/.claude/projects/-home-glitches-Projects-daisypatcher/memory/`. Read `MEMORY.md` there first — it carries user preferences (delegate aggressively, style-first, fresh-start-over-salvage, in-node visual editors, discoverable modulation on target nodes) and the project roadmap (what's shipped, what's deferred).
