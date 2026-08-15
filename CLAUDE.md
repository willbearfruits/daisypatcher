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
npm run test           # typecheck + snapshots + cross-target contract (the pre-commit gate)
npm run test:codegen   # codegen snapshot tests (see below); --update rewrites, --only patch1,patch2 filters
npm run test:contract  # cross-target emitter contract — no compiler needed, seconds to run
npm run test:compile   # REAL per-node compiles for all four boards; --targets/--only/--clean
npm run test:audio     # does the emulator SOUND like the firmware? --only/--seconds/--write-wav
npm run test:features  # behavioural tests: poly, presets-on-device, samples, logic, assistant
npm run dist:linux     # AppImage x64+arm64 via electron-builder (flatpak dropped — sandbox can't reach host toolchains)
npm run dist:win       # NSIS installer + portable exe
npm run publish        # build + upload to GitHub Releases (feeds the auto-updater)
```

Pre-hooks `predev` and `prebuild` run `build:worklets` automatically — don't run a bare `electron-vite` without it or HMR serves stale worklets.

Diagnostic: `node scripts/codegen-compile-harness.mjs [--only kind1,kind2]` runs codegen + make per-node against a minimal test graph and writes `/tmp/dp-harness/REPORT.md`. Requires the libDaisy/DaisySP clones at `~/.config/daisypatcher/sdk/`.

**Testing story** — five layers, cheapest first. Run at least the first two after ANY emitter/target edit.

1. **`test:codegen`** (snapshots, seconds). Runs `generateProject` for every fixture in `scripts/snapshot-patches/*.json` against every target and diffs the emitted C++ against `scripts/__snapshots__/<patch>/<target>/`. After an intentional codegen change, re-run with `--update` and **review the diff** before considering the change done. Catches unintended drift; proves nothing about correctness — the text can be stable and wrong.
2. **`test:contract`** (cross-target, seconds). Asserts the properties that must hold on every target a kind claims to support: the support matrix is honest (no silent fall-through to the passthrough stub), every output the emitter assigns is **declared at block scope**, every declared output is produced, and all supporting targets agree on which outputs exist. This is what catches "wrapped the body in braces, so the output variable dies at the closing brace" — the bug class that shipped inside thirteen ESP32 emitters and stayed green in the snapshots for months.
3. **`test:compile`** (real compilers, minutes). Per-node `make` / `pio run` for all four boards. Needs the libDaisy/DaisySP clones at `~/.config/daisypatcher/sdk/` and `pio` on PATH; a missing toolchain is reported as a skipped target rather than 80 failures. Warm PlatformIO project dirs are shared per `platformio.ini` hash, and builds are cached on the hash of the generated `main.cpp`, so a re-run only rebuilds what actually changed. Writes a kind × target matrix to `/tmp/dp-harness/REPORT.md`.

4. **`test:audio`** (parity, minutes). The only layer that listens. Renders a patch through the REAL emulator worklets headlessly (Node with the five `AudioWorkletGlobalScope` names shimmed — `scripts/lib/renderEmulator.mjs`), compiles the SAME patch's generated Daisy firmware for this machine, renders the same length, and compares level and waveform. DaisySP is portable C++ so its DSP is the device's DSP bit for bit; only libDaisy's hardware half is stubbed (`scripts/host/`). The generated source is compiled **untouched** — `main` is renamed with `-Dmain=`, `StartAudio` stores the callback, and `System::Delay` throws to unwind the `while(1)` after init. Patches with hardware bindings are skipped with a reason, because a knob reads a pot on one side and a slider on the other and there is no comparison to make.

5. **`test:features`** (behavioural, seconds). The other four ask "did the output change", "do the targets agree", "does it build", "does it sound the same". None asks **"does the feature work"**. A `poly` node that expands to three voices instead of four emits perfectly stable text; an assistant that accepts an invented node kind compiles fine right until it does not. This exercises those directly, in-process, with no compiler or device: voice expansion, the preset table reaching the live param globals, samples landing in flash as `const int16_t`, the counter visiting every step, and — the one that matters most — the assistant's validator rejecting every class of malformed edit.

The in-app Test Rig + Verification Panel (see below) are the hardware-loop runtime checks on top of all five.

**`test:audio` drives every gate input, not just the first.** This is worth knowing because it is how three real bugs were found: driving only the first gate left `logic` ANDing against a dangling input (silence on both sides, banked as a pass), and once `reset` was driven it exposed that `euclidean` and `step_seq` treated reset and clock as independent on the device but mutually exclusive in the app — a patch whose reset ran at 1:2 against its clock played nothing on hardware. Reset inputs get a deliberately slow clock, because a reset firing every other step tests reset and nothing else.

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
2. `src/nodes/defs.<group>.ts` — add a `NodeDefinition`. Partial files are grouped thematically (`effects`, `sequencing`, `synthesis`, `visual`, `hardware`, `logic`) so parallel work doesn't collide on one giant file; the `category` field is a separate axis (`'source' | 'process' | 'io' | 'hardware'`) — use `'hardware'` for anything that should auto-link to a `PlacedComponent` on drop. Final `NODE_DEFINITIONS` is spread from `CORE_DEFS` + partials in `src/nodes/definitions.ts`.
3. `src/audio/worklets/<kind>.worklet.ts` — `AudioWorkletProcessor` registered as `'dp-<kind>'`. Module-scope constants like `const TWO_PI = ...` WILL cause duplicate-declaration errors across worklets; inline `Math.PI * 2` or make them class fields.
4. `src/audio/worklets/registry.<group>.ts` — add to the matching registry partial. Final `WORKLET_REGISTRY` merges them in `src/audio/worklets/registry.ts`. URL resolution uses `new URL('./x.worklet.js', import.meta.url)` (**compiled** .js — see worklet build pipeline below).
5. `src/codegen/emitters/<group>.ts` (Daisy) and/or `src/codegen/emittersEsp32/<group>.ts` — add an exported emitter `{ declare, init, process, loop? }` producing C++ for that kind, then add a line to the dispatch table in `src/codegen/nodeEmitters.ts` / `nodeEmittersEsp32.ts`. Both directories are split along the SAME thematic lines as `nodes/defs.<group>.ts` (`shared`, `synthesis`, `math`, `filters`, `envelopes`, `sequencing`, `effects`, `visual`, `hardware`, `scripting`), so the two targets' versions of a kind sit in matching files and can be read side by side. The two `nodeEmitters*.ts` files are now nothing but the contract, the param-override hook and the table.
6. `src/nodes/targetSupport.ts` — ONLY if the kind is not fully implemented on some target: declare it `'stub'` or `'unsupported'` there (a missing entry means `'native'`). This table drives the palette's target filter and the amber/red support dots; the exceptions are enumerated with their reasons in `ESP32_STUBS`, `PSRAM_DEGRADED`, `NEEDS_TINYUSB` and `ESP32_ONLY`. Get this wrong in the optimistic direction and `test:contract` fails — a kind the matrix does not call 'unsupported' must have a real emitter.
7. `src/state/store.ts` — ONLY if the kind is `category: 'hardware'`: add it to BOTH `hardwareKindForNodeKind` (node → component, so dropping the node places a component) and `NODE_KIND_FOR_HARDWARE_KIND` (component → node, so placing a component creates the node). The second is `satisfies Record<HardwareKind, …>`, so a new *hardware* kind is a compile error there; a new *node* kind is not, and a missing entry means the auto-link works in one direction only.

After touching emitters or targets, run `npm run test` (typecheck + snapshots + contract); a new kind used by a snapshot fixture needs `test:codegen --update`. Before trusting a new emitter on hardware, `npm run test:compile -- --only <kind>`.

### CV-modulation socket convention
Most nodes expose their modulatable params as explicit `cv_<paramId>` input sockets (signal kind `'cv'`) alongside the sidebar slider. Contract:
- When disconnected → the sidebar `params[paramId]` value is used.
- When connected → the CV value **replaces** the param directly, clamped to the param's `ParamDef.min` / `max`.
- Legacy sockets with names like `pitch_cv` / `freq_cv` / `fold_cv` that predate this convention keep their **offset/additive** semantics — don't rename them. When both a legacy offset-CV and a replace-CV exist (e.g. oscillator has both `pitch_cv` and `cv_pitch`), code should handle "replace takes priority" — see the `ctx.inputExpr(..., '__NC__')` sentinel pattern in `emitters/` for the emitter-side connect-detection.

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

### Subpatches — flattened at the boundary

`state/subpatch.ts`. A `subpatch` node holds another graph in its `graph`
param; `sub_in` / `sub_out` are its inlets and outlets.

**Nothing downstream knows nesting exists.** `generateProject` calls
`flattenGraph` before dispatching to a backend, and `App.tsx` flattens
before `engine.setGraph`. Those are the only two consumers of an
`AudioGraph`, so the emitters, the topological sort, the connection index
and the audio engine are all untouched. Verified rather than assumed: a
collapsed patch renders **bit-identical** audio to the flat one it came
from (`maxDiff = 0`) and generates identical C++ modulo the id prefix.

Inner ids are prefixed with the subpatch's id, which is what lets the same
body appear twice without colliding — and is the hook polyphony needs.

`state.graph` is always the level you are LOOKING at, so the editor,
inspector, selection and undo work unchanged inside a subpatch.
`subpatchStack` holds the outer levels and `rootGraphOf(state)` re-embeds
them; the engine and codegen ask for THAT, because editing inside a box
must not silence the rest of the instrument. Saving uses the root too.

Structural kinds never reach an emitter, so `scripts/codegen-contract.mjs`
excludes them by name — they have stray-port emitters that warn and emit
silence, for the case where one ends up at the root with no parent.

### Presets — parameters, not topology

`state/presets.ts`. A preset captures every node's params and nothing else:
recalling one must never add, remove or rewire a node, because that is the
one thing you cannot do smoothly while a patch is making sound. Excludes
`bindingId` (recall must not repoint a knob at a different pot) and the
opaque design blobs (`source`, `tree`, `elements` — that is structure).
Simulation params are skipped on hardware-bound nodes, where the pot wins.

Morph interpolates numbers and SNAPS choices at the midpoint — there is no
value between `sine` and `square`. A recall or a whole morph drag is one
undo entry; `activePresetId` clears on any param move.

### Perform — the surface is not the panel

`PerformPlacement` on `PlacedComponent` (x/y/size/hidden/label) is separate
from `position`. Conflating them was the original flaw: arranging for
playability moved the drill holes. A panel wants the pot where the shaft
fits; a surface wants what you reach for most under your hand. Absent
placement inherits the panel position, so existing patches are unchanged.

### Code node — the escape hatch

`src/codegen/codeNode/lang.ts` parses a small C-shaped language into an AST.
That AST feeds TWO backends and is never re-parsed: `toCpp.ts` emits
firmware, and `code.worklet.ts` compiles it to a tree of closures for the
emulator. One parse, two backends, so the two cannot drift — verified by
`npm run test:audio --kinds --only code`.

**No eval, and that is a constraint not a preference.** The built app's CSP
is `script-src 'self'`, so `new Function` is blocked, and a worklet cannot
import a compiler. Hence: parse on the main thread, post the AST over the
port (`AudioEngine.postCodeAst`, re-posted whenever `source` changes),
compile to closures inside the worklet. Any headless renderer must do the
same — `scripts/lib/renderEmulator.mjs` takes a `postExtras` hook for
exactly this, and without it a code node renders silence.

**Four inputs, two outputs, four params — fixed.** Sockets live on the node
DEFINITION, which is per-kind and shared by every instance. Per-instance
sockets would mean threading an instance-specific definition through the
editor, the audio engine, the connection index and both emitters. Not worth
it; an unconnected input reads 0 so the unused ones are free.

The language deliberately has no loops, arrays, pointers or functions —
every one is either unbounded (a `while` in an audio callback is a dropout)
or needs memory management a node body has no business doing. Division,
modulo, `log` and `sqrt` are guarded identically on both sides: one inf in a
buffer poisons every node downstream for the rest of the session.

### Menu: one state machine, five consumers

`src/editor/menu/{tree,machine,render}.ts` are pure and dependency-free —
no DOM, no store, no worklet — because the same behaviour has to run in the
in-node designer, the OLED bitmap renderer, the Perform view, and BOTH
firmware emitters. `src/codegen/menuCodegen.ts` transliterates `machine.ts`
into C++ (`MENU_RUNTIME_CPP`) and `render.ts`'s row layout into two drawing
back-ends, one per display API. Every function in the C++ has a
same-named counterpart in the TS; **change one, change both** — that
equivalence is the only thing making the emulator a faithful preview.

A menu leaf reaches the patch two ways, and both are in `menuCodegen.ts`:
- **CV outputs A–D** — ordinary sockets.
- **Param targets** — no cable. `menuParamOverrides()` emits a mutable
  global per targeted param and `numParam()` resolves to it instead of the
  literal, which is a two-line hook per emitter table rather than a rewrite
  of both. `menuOrderingEdges()` hands `topoSort` a synthetic edge on a
  socket id no emitter reads, so the menu is emitted before its target.
  Params that some emitter bakes in via `rawNum()` cannot be made live;
  `makeOverrideAudit()` greps the emitted text and warns rather than
  leaving the user to wonder why the knob does nothing on the device.

### Sensors are polled from the main loop, never the audio callback

`imu_in` / `compass_in` / `distance_in` read I²C from the `loop` hook — the
Daisy's `while(1)` and, since this work, the ESP32's `loop()` (node `loop`
hooks land above `render_block()`). A blocking 14-byte burst at 400 kHz is
~400 µs and an audio block at 48 kHz / 48 samples is 1 ms. Reads go into
`volatile` globals at 100 Hz and `process` slews toward them per sample, so
the audio-rate output is a ramp rather than a staircase. Register maps live
in `src/codegen/sensorCodegen.ts`, shared by both targets so a chip cannot
be initialised two different ways on two boards.

### Patch-canvas gestures

Left-drag on empty canvas draws a marquee; panning moves to middle-drag and
space-drag. That split is installed by replacing the area plugin's drag
guard (`area.area.setDragHandler(new Drag({ down }))`) — the guard only sees
background drags, because node and connection views stop propagation first.
`layout.marqueeSelect` puts the old behaviour back. Snap rewrites
`nodetranslate` (the cancellable event) rather than correcting afterwards,
so the store only ever sees snapped coordinates. Grid pitch and phase are
CSS custom properties written from the area transform on every
translate/zoom, so the grid tracks pan and zoom instead of drifting.

### Logic layer — state is a signal

`src/nodes/defs.logic.ts` holds the seven nodes that give a patch memory: `logic` (boolean ops on gates), `toggle` (T flip-flop — the node that makes a momentary button latch), `counter`, `timer` (delay / pulse / gate-off, the last being a **debounce**, which every patch that counts button presses needs), `state_machine`, `select` (4-way router) and `edge`.

The design rule is that **state is a signal**. A counter has no hidden mode you inspect in a sidebar; it emits its count as CV, and you patch that wherever should care. That is why `counter.count` and `state_machine.state` are normalised by `n - 1` (so the last step reads exactly 1.0) — they drop straight into a `select`'s `sel` input or an LED with no `scale` in between.

It is also why **no node here has a variable number of outputs**. Sockets are declared per kind and reordering them breaks saved patches, so "one gate per state" is not available; `state_machine` emits a number and `select` routes on it. Two static nodes that compose beat one node whose shape changes underneath you.

These emitters use no DaisySP and no platform API, so `emitters/logic.ts` and `emittersEsp32/logic.ts` are the same code with a different sample-rate token — deliberately, since the whole class of bugs `test:audio` exists to catch comes from two implementations of one node drifting.

### Samples — compiled into the firmware

Three files: `electron/main/sampleService.ts` (content-addressed library on disk), `src/state/sampleStore.ts` (decode + cache), `src/codegen/sampleCodegen.ts` (PCM → `static const int16_t`).

- **Decoding happens in the RENDERER.** `AudioContext.decodeAudioData` handles wav/mp3/flac/ogg/m4a and resamples to the engine rate via `OfflineAudioContext`; the main process only ever sees raw interleaved Float32 and never has to know what a container is. A 44.1 kHz sample played at 48 kHz without resampling is a semitone sharp, and that gets blamed on the oscillator.
- **Content-addressed.** The id is a hash of the PCM, so re-importing costs nothing, two patches share one copy, and a sample can never change under a patch that was tuned against it.
- **`static const int16_t`, not float, not stereo.** `const` lands it in `.rodata` and therefore flash; `static float` would put megabytes in a 512 KB SRAM and fail to link with an error that never mentions samples. Multi-channel is downmixed at emit time.
- The length cap (`MAX_SAMPLE_SECONDS`) is enforced **at import**, in the picker, so you find out while choosing the file rather than at the end of a build.
- Samples are NOT in the `.dpatch` — a patch shared without its library warns per node at codegen and stays silent, rather than failing to build.

### Presets on the device

`src/codegen/presetCodegen.ts`. The mechanism is **borrowed from the menu**, deliberately: `menuCodegen.ts` already emits a mutable global per (node, param) and teaches `numParam()` to resolve to it. A preset recall is the same operation with a different trigger, so it writes the same globals and the two maps merge. Consequences worth knowing: a param driven by both a menu leaf and a preset shares one variable (recall moves the knob, the knob moves it back — which is what you want), and anything the menu path cannot reach this cannot either (a few emitters read params through `rawNum()` to size a buffer at codegen time; the audit warns).

Presets reach codegen through `GenerateOptions.presets` because they are store state, not patch topology. Enum params cannot come along — `Oscillator::WAVE_SIN` is a symbol chosen at codegen time, not a number in a variable — and the caller warns rather than pretending. `preset_recall` is the node that fires them; `EXCLUDED_KINDS` in `state/presets.ts` stops a preset from capturing that node's own params, or recalling preset 2 could set the slot to 5.

### Assistant — graph edits, never code

`src/assistant/` + `electron/main/assistantService.ts`. **The safety boundary is the whole feature.** The obvious build — have the model write C++ — bypasses the node catalog (so the emulator cannot preview it), bypasses `test:audio` (so nothing checks the two sides agree), and is unreviewable. Instead the model emits a closed set of operations (`add_node`, `remove_node`, `set_param`, `connect`, `disconnect`), every one validated against `NODE_DEFINITIONS` **before anything is applied**, and the batch is rejected as a whole — half-applying an edit list leaves the patch worse than not applying it. Worst case is a bad patch you can undo.

- `add_node` uses a local `ref`, not an id, so a hallucinated id can never resolve to a real node.
- `applyPlan` brackets everything in one transaction: the whole suggestion is **one undo entry**, which is what makes trying one cheap.
- Nothing auto-applies. Proposed edits are listed in plain language and wait.
- The catalog in the prompt is generated from `NODE_DEFINITIONS` and filtered by `supportLevel` for the active board — every hand-maintained copy of a catalog in this codebase has drifted.
- **Providers live in the main process** because the built app's CSP is `default-src 'self'` (loosening it to reach an API is the same change that would let an XSS exfiltrate patches) and because API keys must never enter a React tree or a heap snapshot. Ollama is listed first and needs no key.

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
