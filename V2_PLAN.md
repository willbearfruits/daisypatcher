# Daisypatcher v2 — Plan

Everything asked for across the v1 conversation, organized into phases with effort estimates (**S** = hours, **M** = day, **L** = multi-day, **XL** = week+) and honest prerequisites. Order within a phase is rough priority, top first.

This document is a target to aim at — not a promise to ship all of it. Strike-throughs and reorders are expected as we go.

---

## v2 vision in one paragraph

v1 made a modular synth. v2 turns it into a full instrument workshop — stage-ready performance mode, polyphony, recording, MIDI learn, a theme switcher that actually has three themes, a scripting node worth the name, a CLI for headless builds, reverse-import of existing Daisy projects, and a 3D/CAD path from hardware layout to a flashable *and* 3D-printable device. Plus fixing the honest-status gaps from v1 (ESP32 DSP parity, OLED hardware wiring, full MIDI).

---

## Phase 1 — Close the v1 gaps

Ship what we promised in v1 but didn't finish.

- **Studio Rack theme** — brushed-aluminum panels, analog-amber LEDs, knob textures with subtle shading, physical cable sag. **M**. Token system is ready; just a new skin + a few texture SVGs.
- **CRT Patchbay theme** — phosphor greens and ambers, subtle scanlines on the canvas background only (not UI chrome), pixel-ish display font, faint CRT-glow on node edges, cables that crackle. **M**. Same.
- **Theme switcher in TopBar** — dropdown next to target selector. **S**.
- **ESP32 DSP parity** — port the ~50 DaisySP-backed kinds (karplus, FM2, reverb, chorus, phaser, flanger, pitch_shifter, granulator, etc.) to inline C++ in the ESP32 emitter. **L**. Math is in the worklets already; translate, verify on a devkit.
- **OLED hardware draw wiring** — activate the emitted `DrawFrame()` body from the `while(1)` loop, gate to ~30 Hz via `System::GetNow()`. **S**. Codegen already emits it as commented guidance.
- **MIDI USB decl centralization** — so `midi_in_cc` and `midi_out_note` compile standalone, not only alongside `midi_in_note`. **S**.
- **Audio_in on ESP32** — real I2S input path, currently silence. **S**.
- **Rename `scripts.build`** in package.json or move electron-builder config to `electron-builder.yml` if the combined field ever misfires on dist. **S**.

---

## Phase 2 — Performance & live use

The layer that makes it usable on stage or for serious playing, not just sketching.

- **Patch bank / snapshots** — save 8 snapshots of the current parameter values; switch between them with number keys 1–8. Visual indicator in the top bar. **M**.
- **Live mode** — fullscreen, graph hidden, generates a custom control-surface page with oversized knobs/meters mapped from the patch's hardware bindings or named "controls". Optimized for stage. **M**.
- **Polyphony / voice allocator** — a special "Voice" node that takes a subgraph and an N count; at compile time it duplicates the subgraph N times and routes MIDI note allocation automatically. Emulator uses a JS-side allocator. **L**. Touches codegen architecture.
- **Subpatches / macros** — group N nodes into one reusable block with exposed I/O and params. Save to a personal library folder. **L**.
- **MIDI Learn** — right-click a param → "MIDI learn" → wiggle a knob on the controller → stored binding. Web MIDI in emulator; codegen emits the Daisy MIDI handler routing. **M**.
- **Keyboard play mode** — computer keyboard as a piano; QWERTY-to-note grid; gate + pitch CV out of a `keyboard_in` node. **S**.
- **Recording** — record emulator output to `.wav` with tag-based chunk breaks. **S**.
- **Patch bank on-device for Seed** — snapshots stored in QSPI flash; foot-switch or button cycles them on hardware. **M**.

---

## Phase 3 — Expansion

Things that extend the reach of the tool rather than polishing what's there.

- **Sketch import** — reverse path. If `project.json` is present next to a `main.cpp`, restore the graph exactly (trivial, we already emit it). For hand-written projects, pattern-match common DaisySP class init calls and the AudioCallback body into nodes; expect partial fidelity. **L**. Plain-C++ imports will always be best-effort.
- **Proper scripting node** (`script`) — a richer sibling to `expression`. Full JS body evaluated in a Worker for emulation, transpiled to C++ for hardware. Exposes a small API: `process(a, b, c, d, dt) -> { out }` with internal state in `this.state`. Compiled-mode would require a JS→C++ transpiler for a safe subset. Start with emulator-only and skip codegen; codegen comes in Phase 4 when the subset is nailed down. **L**.
- **Wavetable / sample import** — drop a `.wav` on the canvas → creates a `sample_player` or `wavetable` node whose table is the file's contents. Stored as a base64 blob in `.dpatch`. Codegen emits the samples as a `const float[]` in flash. **M**.
- **Starter patch gallery** — a "New from template" dropdown: 808 kit, acid bass, FM keys, karplus harp, drone, stereo pad. Each a `.dpatch` checked into the repo under `templates/`. **S**.
- **CLI** — `dp-cli build patch.dpatch --target daisy_seed` / `dp-cli flash patch.dpatch`. `generateProject` is already pure; wrap the build/flash services in a standalone Node entry point. Enables CI, headless machines, and batch flashing. **M**.
- **USB-host MIDI on Daisy** — plug a MIDI controller into the Seed itself via USB-A, not just MIDI TRS. libDaisy supports it; our emitters need to learn to select host vs device mode. **M**.
- **Convolver reverb** — full convolution reverb node with IR file loader. Heavy but worth it for hall/plate simulation. **M**.
- **Granular sampler** — upgrade `granulator` from texture-over-live-input to a full sampler that loads a `.wav` and granulates regions with position/density/pitch/spray. **M**.
- **Full SDK bundling option** — optional packaged AppImage that ships libDaisy/DaisySP pre-built so there's no first-run install. Adds ~100MB but removes a class of onboarding failures. **M**.

---

## Phase 4 — 2D / 3D / Fabrication

The biggest new axis. The hardware view already has placed-component positions and pin bindings; v2 turns that data into physical objects.

- **3D preview in hardware view** — Three.js canvas rendering the Seed (or ESP32 dev-kit) + placed components in approximate 3D. Drag to orbit. No CAD-grade precision, just a "does the pot fit next to the jack" check. **M**.
- **OpenSCAD enclosure export** — given the placed components and the target board, emit an `.scad` file that produces a parametric enclosure: cutouts for knobs/jacks/OLEDs/buttons, mounting posts for the PCB, optional lid. User tweaks parameters (wall thickness, tolerance) and runs OpenSCAD to get an `.stl`. **L**. Each hardware `kind` needs a "cutout footprint" library entry (the hole size for a pot, the bezel for an OLED, etc).
- **Direct STL export** — skip OpenSCAD and emit `.stl` triangles directly from the same footprint library. No external tool needed. **L**.
- **Front-panel SVG export** — 2D laser-cutter / PCB-silkscreen template with labeled holes in the right places. **M**.
- **3D print-readiness checks** — warn if placed components overlap, if a cutout is too close to an edge, if an OLED window clips a knob. **S**, ride on the footprint library.
- **Panel graphics designer** — 2D canvas at enclosure scale for painting labels, knob indicators, artwork; exports as SVG overlay for silk-screen or laser-engraving. **M**.

---

## Phase 5 — Developer experience

Small quality-of-life things that make patching feel good.

- **Cable signal animation** — audio cables bloom with amplitude; gate cables pulse on rising edge; clock cables show tempo as moving dots. Reads from the same engine analyser system as visual nodes. **S**.
- **Cable probe** — shift-click a cable to pin a live value readout to the status bar. **S**.
- **Minimap** — small overview of the whole graph in a corner, viewport indicator, click to jump. **M**.
- **In-palette node preview** — hover a palette card, a ~100ms animated mini-preview plays on the side. **M**. Reuse the visual-node tap system against a hidden pre-rolled context.
- **CPU profiler** — after running, show actual per-node CPU cost (via performance.measure inside the worklet) instead of our static estimate table. **M**.
- **Signal-type color legend** — a small always-visible swatch at the corner of the canvas so people remember cyan = audio, magenta = CV, amber = gate, lime = clock. **S**.
- **Inline node-body mini-controls** — for common params, drag-to-adjust right on the node without opening the Inspector. **M**. Extend the in-node-programming pattern we used for the OLED designer.
- **Export standalone project** — zip up `main.cpp` + `Makefile` / `platformio.ini` + `project.json` for sharing with non-Daisypatcher users. **S**.
- **"Help" mode** — toggle in TopBar; click any node and see its description, param explanations, and a two-line example patch. **M**.

---

## Cross-cutting — the background work

- **License decision** — still TBD in v1. Candidates: MIT (maximum reuse), Apache-2.0 (patent grant), AGPL (force derivatives open, good match for the "creative tool" ethos). Pick before going public.
- **Real tests** — at minimum, snapshot tests for codegen on 10 canonical patches per target, so refactoring emitters doesn't silently break output.
- **Mac + Windows packaging** — hit every platform-specific path we flagged in the v1 audit (native module rebuild, which→where, path separators, dfu-util locations). **M** per platform to actually test.
- **Onboarding** — at the very least, a 90-second tour video embedded in the first-run modal. Makes or breaks whether people stick around.
- **Docs site** — Astro/Docusaurus, auto-generated node reference from `NODE_DEFINITIONS`, Getting Started, Recipe book. **L**.
- **Accessibility pass** — keyboard navigation of the graph, ARIA labels on Inspector controls, contrast ratios checked per theme. **M**.

---

## What's explicitly NOT in v2

- **Cloud-hosted patch sharing / account system.** Out of scope for an offline creative tool.
- **Multi-user collaborative editing.** Not an instrument-shaped feature.
- **In-browser-only build.** We're desktop-first because compile+flash requires native tools; browser-only means no flash.

---

## Rough ordering

Phase 1 and the Phase 5 cable-animation + minimap pieces are the fastest to add visible value and are good next moves. Phase 2's patch bank + MIDI learn + live mode is the big "real instrument" upgrade. Phase 3 import + scripting + CLI is the one that turns this into a platform other people build on. Phase 4 is the moonshot that differentiates Daisypatcher from every other modular visual synth.
