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
- **Everything else:** save/load `.dpatch`, undo/redo with drag coalescing, multi-select, copy/cut/paste, collapsible nodes (Cmd+.), resizable panels, palette fuzzy search, CPU-budget meter.

## Quickstart

**Prerequisites:**
- Node 22+
- `git`, `make`, `arm-none-eabi-gcc` (for Daisy Seed builds) — on Debian/Ubuntu: `sudo apt install gcc-arm-none-eabi make git`
- `dfu-util` (for Seed flashing)
- `platformio` for ESP32: `pip install platformio`

```bash
npm install
npm run dev         # launches the Electron app with HMR
```

On first launch the app will prompt to install libDaisy + DaisySP into `~/.config/daisypatcher/sdk/` (one-time, ~50MB, a few minutes). After that, Compile and Flash are live.

### Building a distributable

```bash
npm run dist       # produces an AppImage in dist/ (Linux)
```

Mac `.dmg` and Windows `.exe` targets are stubbed in the electron-builder config but not yet regularly tested — PRs welcome.

## Architecture at a glance

Electron + Vite + React 19 + TypeScript. Three-process layout (main / sandboxed CJS preload / renderer). Graph state in Zustand with transaction-coalesced history. DSP emulation via AudioWorkletProcessors. Codegen has a pluggable `TargetBackend` so the same graph produces a libDaisy project for Seed or a PlatformIO Arduino project for ESP32.

Full internals and the checklist for adding a new node kind live in [`CLAUDE.md`](./CLAUDE.md).

## Status honesty

**Works:** real DSP for most of the 84 nodes, emulation, Daisy Seed compile + flash, hardware view round-trips, save/load, OLED emulator preview.

**Stubbed or partial:**
- ESP32 codegen covers ~30 of 84 kinds natively; complex DaisySP-backed nodes (FM2, karplus, reverb, chorus, phaser, flanger, pitch_shifter, granulator, full OLED draw) emit a warning + passthrough on ESP32.
- OLED drawing on real hardware needs a small wiring step not yet finished (emitted as commented guidance). Emulator preview is full.
- Studio Rack and CRT Patchbay themes reserved but not implemented — Signal Lab is the only live theme.
- No sketch → nodes reverse import (one-way codegen only; our own patches round-trip via `project.json`).
- No CLI, no MIDI learn, no polyphony, no subpatching — all on the roadmap.

## Roadmap (not a promise, a direction)

Patch bank / snapshots · MIDI learn · USB-host MIDI on Daisy · polyphony via voice-allocator · subpatches/macros · cable signal animation · minimap · recording · 3D/enclosure generation from hardware layout · CLI.

## Contributing

Beta. Issues welcome. PRs welcome if you know what you're doing with Electron + DSP — start with a small node kind addition, the 5-step checklist is in `CLAUDE.md`.

## License

TBD.
