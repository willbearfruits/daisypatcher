# Changelog

All notable changes to Daisypatcher are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Direction: MIDI learn, recording the emulator to `.wav`, tree-wide presets
(nodes inside subpatches), Silkscreen mode + drill-template export. See
`V0_5_PLAN.md` and `V2_PLAN.md`.

## [Unreleased]

### Added
- **Audio In plays your interface.** The `audio_in` node — the codec's L/R on the device — now carries a real capture device in the app. Pick it in the Inspector (any input the OS knows; the system default otherwise); the picker says which device is open, or why not. Voice processing (echo cancellation, noise suppression, AGC) is off so a steady tone stays steady. The device choice is emulator-only: it never reaches firmware or presets.
- The Compile button's tooltip names the selected board.

## [0.5.6] - 2026-08-18

### Added
- **Presets are tree-wide.** A preset now captures every node in the patch — inside subpatches and inside a poly's voice — wherever you are when you press Capture. Recall and morph reach into the boxes too, and a recall while you are inside one updates what you see. On the device a poly voice's parameter becomes one table slot per voice, all set from the one preset entry. Grouping nodes into a subpatch carries their preset entries with them.
- The ESP32-S3 SuperMini declares its 2 MB quad-SPI PSRAM: the granulator gets its full four-second buffer there (92 of 95 kinds native).
- Hardware view: **fit** frames the board, its labels and every part at whatever zoom that takes, and runs on open and on every board switch; the +/− buttons zoom about the board; a part created from the patch side lands in the free band under the board instead of on the pin labels; the empty-state hint is a small corner card.

### Fixed
- The PSRAM block in `platformio.ini` was one-size (DevKitC N8R8 octal); it is now per board, from a `psram: { bus, flash }` descriptor.

## [0.5.5] - 2026-08-17

**Pinout corrections — please re-check any ESP32 wiring made with an earlier build.** Three of the four board drawings were wrong; a knob you wired by following the Hardware view may be on the wrong pad.

### Fixed
- **ESP32-C3 SuperMini**: the two header columns were mirrored and GPIO0–4 ran in the wrong order. Correct, USB up: left `5 6 7 8 9 10 20 21`, right `5V GND 3V3 4 3 2 1 0`.
- **ESP32-S3 SuperMini**: replaced a guessed 11-per-side table with the actual board (the ESP32-S3-Zero layout): left `5V GND 3V3 1 2 3 4 5 6`, right `TX RX 13 12 11 10 9 8 7`, plus GPIO14/15/16 castellations and the back-side pads GPIO17/18/38–42/45, all bindable from the inspector. GPIO21 (the on-board WS2812) and GPIO48 (not present) are gone from the table.
- **ESP32-S3 DevKitC-1**: the left header was drawn upside-down (3V3 at the bottom, GND at the top) and both sides were squeezed to 20 rows. Now the official 22 + 22 from Espressif's figure, module at the top, USB at the bottom; GPIO19 (USB D-) and the extra grounds included; GPIO33/34 (not on the header) removed.
- **Daisy Seed OLED / sensor auto-wiring** paired an I2C3 SDA (D3) with an I2C1 SCL (D11). The Seed emitters init I2C1, so libDaisy refused the pins and the display stayed dark — every shipped Seed example was wired that way. I2C candidates are now the I2C1 pins only (D12/D11, D14/D13).
- Auto-assignment now reaches for the silkscreened bus pins first (SDA/SCL, UART RX, the I2S set), skips boot-strapping pins unless they *are* the dedicated pair (the C3's GPIO8/9), never offers the USB data lines, and never hands a button to the Seed's underside D0 test pad.
- File → New on an ESP32 target left the hardware view on the Daisy Seed while the target stayed ESP32.
- All seven example patches regenerated with the corrected assignments.

### Added
- `test:features` gains a `pinouts` group that pins the header order of all four boards exactly, and asserts the auto-assign preferences above.

## [0.5.4] - 2026-08-17

### Fixed
- The bundled example patches placed their pots, OLEDs and modules on top of the pin-label columns in the Hardware view. Parts now sit in a row under the board — ADC-side parts under the left column, displays and LEDs under the right — so wires drop straight to their pins. All seven examples, both board families.
- The updater logged the whole HTTP response (headers, cookies, stack) to stderr on a missing release; one line now.

### Added
- Screenshots of the three views in the README and on the website.
- The CI gate also runs on Windows; the release workflow can rebuild a single platform on demand.

## [0.5.3] - 2026-08-17

First public beta.

### Added
- **CI and releases.** GitHub Actions runs the full gate (typecheck, codegen snapshots, cross-target contract, feature tests, production build) on every push; a `v*` tag builds Linux AppImage (x64, arm64), Windows NSIS + portable, and an unsigned macOS dmg (Intel, Apple Silicon), and publishes them to a draft release with the updater manifests.
- **`.dpatch` round-trip test** in `test:features`: a state with a subpatch, poly, hardware + perform placement, presets, a collapsed node and non-default canvas prefs is serialised the way Save does, parsed and applied the way Open does, and deep-compared; save→load→save must be a fixed point.
- **Crash screen.** A render error anywhere in the window now lands on a screen whose first button is *Save patch as…* against the intact store, then *Reload* and *Report this* (pre-fills an issue with the error).
- **Window position and size persist** across launches, and are only restored if they still land on a connected display.
- **First-run guidance.** Every "not found on PATH" message now says how to install the tool on your OS (apt / brew / xcode-select / Daisy Toolchain + Zadig). The SDK installer checks for git, `arm-none-eabi-gcc` and `make` *before* cloning 50 MB.
- macOS/Linux GUI launches get the usual tool directories appended to PATH (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.platformio/penv/bin`), so an app opened from Finder or a launcher stops reporting every tool missing.
- A real app icon; `package.json` metadata (homepage, repository, bugs, keywords); `CONTRIBUTING.md`; a landing page for GitHub Pages.

### Fixed
- Canvas preferences (`gridShow`, `gridSnap`, `gridSize`, `marqueeSelect`) and the code panel height were written by every save and dropped by every load — snap-to-grid came back on each reopen.
- Presets captured inside a subpatch, or captured before nodes were grouped into one, were emptied on reopen: pruning compared against the root graph only. Presets now prune against every node id in the tree.
- `npm ci` failed on a clean checkout (electron-vite 2 declared a peer on vite ≤5 while the project is on vite 6). electron-vite bumped to 3.1.

### Changed
- `npm run test` now includes `test:features`.
- The auto-updater is disabled on macOS: builds are unsigned and Squirrel refuses to install an unsigned bundle, so rather than fail after downloading it does not offer.

## [0.5.2] - 2026-08-16

### Added
- **In-app user guide** under Help → Daisypatcher Guide (F1): getting started, the three views, build and flash, presets, samples, subpatches and poly, the logic layer, the Code node, the assistant, files, shortcuts, troubleshooting. Rendered by a small fixed-grammar Markdown renderer (no HTML pass-through — the CSP would not allow it and neither should a guide).
- Help menu links that go somewhere: libDaisy docs, DaisySP reference, the Daisy wiki, Report an Issue.

### Fixed
- Menu items could not be activated from the keyboard (Enter on a highlighted item was reported by GTK as an accelerator and refused).
- Opening an external link could take the whole app down when the desktop's `kde-open` crashed. Links now open through a detached process (`gio open` first on Linux) so a broken opener cannot reach Electron.

## [0.5.1] - 2026-08-16

### Fixed
- Opening a patch while another was open left the first patch's cables frozen on screen, pointing at nodes that no longer existed. The editor diffed connections by id alone, and every bundled example reused `c1…cN`; the diff now compares both endpoints too.

## [0.5.0] - 2026-08-16

The v0.5 milestone: **feels like an instrument, ships like a product.**

### Added
- **Subpatches**, flattened at the boundary — nothing downstream knows nesting exists. Collapse a selection (Ctrl+G), double-click to go inside, Esc to come out; the whole patch keeps playing while you are in.
- **Polyphony**: `poly` runs a body N times and sums the voices; `voice_id` gives each copy its number so voices can detune.
- **Presets**, capture / recall / morph, and on the device: they compile into the same mutable param globals the menu system uses, fired by a patchable `preset_recall`.
- **Samples** compiled into flash as `static const int16_t`; content-addressed library; decoded in the renderer so one codec set covers every container; 30 s cap enforced at import.
- **Logic layer** — `logic`, `toggle`, `counter`, `timer` (delay / pulse / gate-off = debounce), `state_machine`, `select`, `edge`. State is a signal.
- **Code node**: a small C-shaped language, parsed once, compiled to C++ for the device and to a closure tree for the emulator, so the two cannot drift.
- **Assistant** that edits the graph and never writes code — a closed set of operations validated against the node catalog before anything is applied, all-or-nothing, one undo entry. Ollama by default; Anthropic / OpenAI with a key kept in the main process.
- **Application menu** (File / Edit / View / Transport / Help), Open Recent, Open Example…, Preferences, Keyboard Shortcuts, About; the assistant and the generated-code view have top-bar buttons and menu entries.
- Open a `.dpatch` from the OS: double-click, command line, drag onto the window.
- Ask before closing with unsaved work: Save / Don't Save / Cancel. Live window title with a dirty marker.
- Generated-code view with per-node provenance highlighting; Perform surface arrangement separate from panel position; canvas marquee select, grid and snap.
- Bundled example patches (`File → Open Example…`).
- Test layers: `test:contract` (cross-target emitter contract, 90 kinds × 4 boards), `test:audio` (emulator vs host-compiled firmware, waveform compared, every gate input driven), `test:features` (behavioural).

### Fixed
- Sixteen emulator/firmware divergences, most from one cause: DaisySP setters rescale their arguments (`SetDecay` is `x*0.1-0.1`), so ports that stored what the caller passed modelled a different instrument. Real device defects this surfaced: phaser clipped at 1.59 on hardware; `overdrive.tone` was never emitted; `karplus` was excited by one sample instead of a noise burst; `dust` fired one sample; `stereo_widener` had no mid/side stage on Daisy; `formant` ran three different filters on three targets; `euclidean` / `step_seq` treated reset and clock as mutually exclusive in the app but not on the device; `arp` never restarted on a new gate.
- Ctrl+Shift+K (assistant) was unreachable — shadowed by the Ctrl+K palette.
- Ctrl+S opened the Save dialog every time even with a file open.
- Open… had no discard-unsaved-changes guard; opening a patch left the camera wherever it was.
- The top bar overlapped at the default window width; minimum width raised to what the layout can honour.
- A dead GPU process, a crashed renderer, or an unhandled main-process error each took the app and any unsaved patch with it.
- Hardware components loaded from older files with `config: {}` showed an OLED as 0×0; defaults are backfilled on load.
- Clocked preset recalls flooded the undo history; graph-driven recalls are silent.
- 32 phantom `/dev/ttyS*` ports in the serial-port list.
- Compiler warnings for unused output sockets on every build.

## [0.4.2] - 2026-07-14

### Added
- Daisy Seed OLED rendering: draw calls are now emitted as a real `DrawFrame()` (all element kinds — text, value, meters, scope, shapes) refreshed at ~30 fps from the main loop; previously the draw body was emitted as comments. Verified with an arm-none-eabi compile of the generated project.
- ESP32-S3 real I2S audio input: full-duplex on the existing I2S port, RX sharing BCLK/WS with TX; `audio_in` is no longer a stub on ESP32. Verified with a PlatformIO compile of a generated duplex project.
- Actionable permission errors when flashing on Linux: the flash log now prints the exact udev rule (Daisy DFU) or `dialout` group fix (ESP32 serial) when the failure is EACCES.
- Spacebar toggles the transport (play/stop).
- Theme picker is a custom popover with per-theme color swatches (replaces the native `<select>`).
- Palette: zero-result empty state with a clear-search action; cards carry their category's signal color and can be dropped onto the canvas with Enter/Space from the keyboard.
- Theme tokens `--dp-scrim` and `--dp-surface-terminal`, tuned per skin — the build log and all modal backdrops now re-skin with the theme.

### Changed
- All confirmation prompts use an in-app dialog (Esc/Enter, focus-trapped) instead of the OS `window.confirm`.
- The last text-glyph icons (play/stop, lock, popover close) are now inline SVGs matching the icon system.
- Keyboard focus uses one consistent accent treatment app-wide; `outline: none` no longer suppresses focus visibility anywhere.

- **Perform view**: a third view rendering the hardware layout as the physical pedal — powder-coat enclosure auto-sized to standard Hammond boxes, per-theme finishes, live LEDs/OLED, knobs swept with the mouse (Shift = fine, double-click = reset). ARRANGE mode for moving/rotating/nudging components on the face (0.5 mm snap, shared with the Hardware view, undoable), with the hardware inspector alongside.
- Per-theme cable personality: Studio Rack cables hang with real sag, CRT Patchbay traces run taut with phosphor bloom and beam jitter (free when stopped, reduced-motion safe).
- Compatible sockets stay lit while dragging a cable; incompatible ones dim. Refused drops flash the target socket.
- Inspector: click a value to type it exactly ("1.2k" works), double-click a slider to reset, Shift-drag for fine adjust, log tapers on frequency-style params, and CV-driven params show a "CV" tag with the live incoming value instead of a dead slider.
- First-run: empty canvas shows an invitation with a one-click starter patch; the hardware view got a matching empty state.
- Entrance motion for all modals and popovers; true animated folds for palette sections (all disabled under reduced-motion).

## [0.4.1] - 2026-07-13

### Added
- In-app Test Rig: generates a minimal test patch for any node kind (source → output, filter with noise + LFO sweep, envelope triggered by clock → VCA, …), builds it, flashes it, and opens the serial monitor for a pass/fail check.
- Verification Panel: filterable table of every node kind × target with per-`(kind, target)` pass/fail status, persisted to `localStorage` and mirrored to `~/.config/daisypatcher/verified.json`.
- ESP32-S3 DSP parity: real inline C++ emitters for all DaisySP-backed node kinds, plus USB-MIDI and SSD1306 OLED output.
- CV-modulation convention across worklets: modulatable params are exposed as `cv_<param>` input sockets — a connected CV replaces the slider value, clamped to the param's range; legacy `*_cv` offset sockets keep their additive semantics.
- `range` node.
- Studio Rack and CRT Patchbay themes — completes the three-theme set alongside Signal Lab.
- Armed flash: click Flash while the Seed is running, tap RESET, the flash fires itself (60 s timeout, click to cancel).
- Cable signal animation: audio cables bloom with amplitude, gate cables flash, clock cables tick; zero cost when playback is stopped, respects reduced-motion.
- Codegen snapshot tests (`npm run test:codegen`): 10 canonical patches × 2 targets, 60 snapshot files.
- Binding/pin editor in the Inspector; unbound hardware nodes now show "(unbound)" instead of a misleading pin control.
- Device-status system: running / DFU / not-detected pill in the status bar, guidance banner, and pre-flight flash tooltips.
- AGPL-3.0-or-later license (`LICENSE` file added).

### Changed
- Build, flash, and SDK operations are guarded against re-entrancy.
- SDK installer recovers from partial clones and preflights git availability.
- DFU device detection takes a Linux sysfs fast path, avoiding `dfu-util -l` polling when nothing is plugged in.
- README truth pass: udev rule for DFU permissions, DaisySP-LGPL disclosure, user-vs-developer prerequisites; the stale ESP32 support table corrected (23 false stubs → 4 real ones).

### Fixed
- Windows ESP32 builds: `.pio` path handling.

### Security
- Filesystem IPC scoped to dialog-granted paths.
- `shell.openExternal` restricted to an http(s) allowlist.
- Single-instance lock.

### Removed
- Flatpak distribution target — the sandbox cannot reach the host toolchains (`git`/`make`/`arm-none-eabi-gcc`/`dfu-util`/`pio`) the app drives.

## [0.4.0] - 2026-04-22

### Added
- 8 new hardware component kinds with realistic mm-scaled 2D shapes: slider, touch ribbon, LDR, gyroscope, magnetometer, time-of-flight sensor, electret mic, piezo. Pinout tables know which need ADC vs I²C; I²C sensors can share one bus.
- Hardware-view interactions: rotate (R), pan (space-drag / middle-click), wheel zoom centered on the cursor, arrow-key nudge, snap-to-grid and grid toggles.
- Hover/selection reveals component label, role badges, and pin-binding drag dots inside the SVG.

### Changed
- Hardware view rebuilt from scratch on a single-SVG coordinate system — board, pins, placed components, and wires all live in one `viewBox`, so wire anchors cannot drift from the visible shapes. Replaces the DOM-overlay approach that accumulated anchor-alignment bugs.
- Patch palette defaults to a compact grid layout — the 70+ node catalog fits at a glance; widening the palette adds columns.

## [0.3.2] - 2026-04-21

### Fixed
- Components rendered inside Rete's isolated React roots (cables, scope/VU nodes, OLED) could not reach the audio engine — React Context does not cross `createRoot` boundaries — so the 0.3.0 cable animation never ran and visual nodes silently showed baseline frames. The engine is now stashed in a module-level singleton that `useAudioEngine()` falls back to.

## [0.3.1] - 2026-04-21

### Fixed
- All cables disappearing: the 0.3.0 cable animation used a per-cable randomized SVG filter id whose URL resolution was inconsistent across contexts. Reverted to the shared `dp-cable-glow` id; per-cable blur modulation dropped, opacity-driven amplitude/gate/clock animation kept.

## [0.3.0] - 2026-04-21

### Added
- Cable signal animation on the patch canvas: audio cables bloom with RMS (fast attack, slow release), gate cables pulse on rising edges, clock cables render travelling dots synced to detected tempo; CV cables stay static.
- Signal-type color legend — collapsible bottom-right widget with the four signal swatches.
- Minimap — top-right graph overview with viewport indicator; click/drag to recenter the canvas.
- Hardware-view live activity: LEDs glow from their bound signal, buttons flash on rising edges, gate/CV/audio jacks show activity pulses.
- Binding labels — hardware-view overlay tagging each bound pin with a description derived from the linked graph node, toggled from a floating toolbar.

## [0.2.3] - 2026-04-21 and earlier

Collapsed pre-0.3 history.

- **0.2.3** (2026-04-21) — worklets always emitted as asset files, never inlined as `data:` URLs, which the production CSP (`script-src 'self'`) silently blocked.
- **0.2.2** (2026-04-21) — allowed `data:` URLs for worklets in the CSP (superseded by 0.2.3).
- **0.2.1** (2026-04-21) — fixed production AudioWorklet loading by pre-compiling `.worklet.ts` → `.js` (packaged builds served raw TypeScript and every `addModule()` rejected); one-click ESP32 toolchain install (pipx/pip + `pio platform install espressif32`).
- **0.2.0** (2026-04-21) — hardware view redesign: drag-to-pin wiring, pinout v3 matching the Electrosmith pinout poster, Daisy Seed pin map corrected against libDaisy source (DAC/SPI1/USART fixes, false ADC claims removed); per-node codegen + compile smoke harness (`scripts/codegen-compile-harness.mjs`).
- **Pre-0.2.0** (2026-04-20) — initial beta: Electron + React + TypeScript visual patcher with 84 DSP nodes emulated via WebAudio worklets, Rete.js graph editor, in-body OLED display designer, hardware pin-mapping view, codegen to libDaisy (make + dfu-util) and PlatformIO (pio upload), first-run SDK installer, serial monitor, save/load/undo/redo. Follow-ups the same day: Daisy flash-mode picker (internal / QSPI / SRAM), device info popover, DaisySP + DaisySP-LGPL built during SDK install, palette UX round (Cmd+B collapse, Cmd+K command palette, node icons), board autodetect by VID:PID, first ESP32 DSP parity pass (32 kinds to inline C++), electron-updater wired to GitHub Releases, Linux/Windows dist targets.
