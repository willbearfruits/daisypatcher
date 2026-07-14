# Changelog

All notable changes to Daisypatcher are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

Still planned for v0.5: MIDI learn, Silkscreen mode + drill-template export,
patch bank / snapshots, recording emulator output to .wav, ESP32 I2S MCLK
pin-config fix.

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
