# Daisypatcher

Visual node-based patcher for the Electro-Smith **Daisy Seed** and **ESP32-S3**. Build a DSP graph, hear it live in-app, wire up physical hardware on a breadboard view, compile to C++, flash the device.

> **Status:** public beta. 84 DSP nodes, real-time emulation, compile + flash working end-to-end on Linux. Mac/Windows toolchain paths handled but not heavily tested.

## What it does

- **Patch graph.** Drop and connect 84 nodes — oscillators, filters (SVF, Moog ladder), envelopes (ADSR, AR), effects (reverb, delay, chorus, phaser, flanger, ping-pong, granulator, pitch shifter), math and CV tools, sequencing (clock, step seq, euclidean), drums (kick/snare/hat), karplus, FM, wavetable, bitcrush, compressor/limiter/noise-gate, scope/VU/spectrum visualizers, MIDI, I2S, expression (math-scripting-lite), and more.
- **Live emulation.** Every DSP node has a WebAudio AudioWorklet twin — hit Play, turn a knob, hear it. Scope/VU/Spectrum nodes render live analyser data *inside* the node body.
- **OLED designer.** The OLED node carries a 128×64 pixel canvas in its body. Drop in text / meters / scopes / shapes, bind them to input sockets, see it animate in real time. Codegen emits the equivalent libDaisy SSD1306 draw calls.
- **Hardware view.** Second canvas: a render of your board with labeled pins. Drag knobs, buttons, switches, LEDs, MIDI/I2S jacks, OLEDs onto pins; codegen wires the right peripheral init.
- **Compile + flash.** First-run installer clones libDaisy + DaisySP with submodules and runs `make -C libDaisy`. Build button runs `make` (Seed) or `pio run` (ESP32); flash button runs `dfu-util` or `pio run -t upload`. Build log streams live.
- **Serial monitor.** Bottom-right panel talks to the Daisy over USB CDC. Send / receive / clear.
- **Everything else:** save/load `.dpatch`, undo/redo with drag coalescing, multi-select, copy/cut/paste, collapsible nodes (Cmd+.), resizable panels, collapsible palette (Cmd+B) with category folding + target-aware filter + icons-only mode, floating command palette (Cmd+K), recent-kinds strip, CPU-budget meter, auto-target detection from plugged-in hardware, electron-updater auto-update.

## Quickstart

**Toolchain prerequisites (everyone — the AppImage does NOT bundle these):**
- `git`, `make`, `arm-none-eabi-gcc` (for Daisy Seed builds) — on Debian/Ubuntu: `sudo apt install gcc-arm-none-eabi make git`
- `dfu-util` (for Seed flashing)
- `platformio` for ESP32: `pip install platformio`

**Flashing permissions (Linux):** the Seed's DFU bootloader (`0483:df11`) is root-only by default. One-time setup:

```bash
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"' | \
  sudo tee /etc/udev/rules.d/50-daisy-dfu.rules
sudo udevadm control --reload-rules
sudo usermod -aG dialout $USER   # serial monitor access; log out/in after
```

**Running from source additionally needs** Node 22+:

```bash
npm install
npm run dev         # launches the Electron app with HMR
```

On first launch the app will prompt to install libDaisy + DaisySP (one-time, ~50MB, a few minutes) into its config dir — `~/.config/Daisypatcher/sdk/` for the packaged app, `~/.config/daisypatcher/sdk/` when running from source. After that, Compile and Flash are live.

### Building a distributable

```bash
npm run dist         # build all configured targets for the current host
npm run dist:linux   # Linux only: AppImage (x64/arm64)
npm run dist:win     # Windows only: NSIS installer + portable .exe (x64)
npm run dist:all     # Linux + Windows in one pass
npm run publish      # build + upload artifacts to a GitHub Release
```

Linux ships as an AppImage in `dist/`. (Flatpak was dropped for the beta: the app drives host toolchains — `git`/`make`/`arm-none-eabi-gcc`/`dfu-util`/`pio` — which a flatpak sandbox can't reach without `flatpak-spawn --host` plumbing. Revisit post-beta if there's demand.)

Windows produces an NSIS installer (`.exe`, per-user install, user-selectable path) and a standalone portable `.exe`. Cross-building the Windows targets from a Linux host requires Wine (`sudo apt install wine`). Without code-signing certificates configured, SmartScreen will flag the installer on end-user machines — see the packaging notes before cutting a public Windows release.

Mac `.dmg` is not yet configured — PRs welcome.

## Architecture at a glance

Electron + Vite + React 19 + TypeScript. Three-process layout (main / sandboxed CJS preload / renderer). Graph state in Zustand with transaction-coalesced history. DSP emulation via AudioWorkletProcessors. Codegen has a pluggable `TargetBackend` so the same graph produces a libDaisy project for Seed or a PlatformIO Arduino project for ESP32.

Full internals and the checklist for adding a new node kind live in [`CLAUDE.md`](./CLAUDE.md).

## Status honesty

**Works:** real DSP for most of the 84 nodes, emulation, Daisy Seed compile + flash, hardware view round-trips, save/load, OLED emulator preview.

**Stubbed or partial:**
- ESP32 parity: real inline-C++ DSP now covers virtually all 84 kinds — reverb (FreeVerb), FM2, karplus, chorus, phaser, flanger, pitch shifter, granulator, drums, formant, wavetable, etc. Only `expression` (AST parser port pending) and `i2s_in` / `i2s_out` (not applicable — use `audio_in` / `audio_out`) remain passthrough. OLED drawing emits full Adafruit_SSD1306 code for ESP32. **Caveat:** ESP32 `audio_out` works; `audio_in` compiles but the I2S *input* path still delivers silence — real input capture is the next parity item.
- Studio Rack and CRT Patchbay themes reserved but not implemented — Signal Lab is the only live theme.
- No sketch → nodes reverse import (one-way codegen only; our own patches round-trip via `project.json`).
- No CLI, no MIDI learn, no polyphony, no subpatching — all on the roadmap.

## Roadmap (not a promise, a direction)

Patch bank / snapshots · MIDI learn · USB-host MIDI on Daisy · polyphony via voice-allocator · subpatches/macros · cable signal animation · minimap · recording · 3D/enclosure generation from hardware layout · CLI.

## Generated-firmware licensing note

Daisy Seed projects generated by this app link **libDaisy** and **DaisySP** (both MIT) *and* the **DaisySP-LGPL** subset (`USE_DAISYSP_LGPL = 1` in the emitted Makefile — it provides ReverbSc, Compressor and friends). If you **distribute compiled firmware binaries**, the LGPL part carries relink/source-availability obligations for that library. Firmware you flash to your own hardware is unaffected.

## Contributing

Beta. Issues welcome. PRs welcome if you know what you're doing with Electron + DSP — start with a small node kind addition, the 5-step checklist is in `CLAUDE.md`.

## License

**AGPL-3.0-or-later** — see [`LICENSE`](./LICENSE). Use it, fork it, ship it; if you distribute a modified version (including hosting it as a service), your changes must be open under the same terms.

Note: the license covers *this app*. Firmware **generated by** the app is your own work — it links libDaisy/DaisySP (MIT) and DaisySP-LGPL (see the note above), not Daisypatcher itself.
