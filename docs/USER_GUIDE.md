# Daisypatcher Guide

Daisypatcher is a visual patcher for the Electro-Smith **Daisy Seed** and the **ESP32-S3 / C3**. You drop DSP nodes on a canvas, wire them up, hear the result in the app, lay out the physical controls, and flash the whole thing to a board as firmware. What you hear in the app is what the device plays — every node is checked for that.

This guide is also in the app: **Help → Daisypatcher Guide** (or press **F1**).

## Getting started

1. **Install the SDK** when asked on first launch. This clones libDaisy and DaisySP (~50 MB) and builds them once. You can Skip and still patch and listen; you need the SDK to Build or Flash for the Daisy. ESP32 boards use PlatformIO, installed the same way from the top bar.
2. **Open an example** — the empty canvas offers one, or use **File → Open Example…**. Seven patches ship with the app, from a bare drone to a four-track tracker.
3. **Press Space** to hear it. The transport button is at the far right of the top bar.
4. **Pick a board** in the top bar: `SEED`, `S3`, `C3 SM`, `S3 SM`. The palette greys out nodes the chosen board cannot run.
5. **Build**, then **Flash** — the two buttons left of Play. Build compiles firmware; Flash puts it on a connected board.

## The three views

The tabs at the top of the window switch between them. **Ctrl+1 / 2 / 3** does the same.

### Patch

The node canvas. Everything about the *sound* lives here.

- **Add a node**: drag it from the palette on the left, or press **Ctrl+K** and type its name.
- **Wire**: drag from an output socket (right side of a node) to an input socket (left side). Cables are colour-coded by what they carry — audio, CV, gate, clock — and only like-to-like connects.
- **Select**: click a node. Drag on empty canvas to marquee-select several. **Ctrl+A** selects all.
- **Move**: drag a node. Selected nodes move together.
- **Pan**: middle-drag, or hold **Space** and drag. **Scroll** to zoom. **Ctrl+0** fits the whole patch in view.
- **Delete**: select and press **Delete**.
- **Collapse a node** to just its header: double-click it. Cables stay attached.
- **Right-click** a node or the canvas for a context menu.

The **Inspector** on the right shows the selected node's parameters. Numeric parameters are sliders; most also have a matching CV input socket on the node — when a cable is connected there, the cable value replaces the slider.

### Hardware

The physical side: knobs, buttons, LEDs, an OLED, jacks, sensors, all placed on a picture of your board and bound to real pins.

- **Place a component**: drag it from the palette onto the board. It picks the first free suitable pins automatically; a matching node (a `Knob`, a `Button`, an `LED`…) appears in the Patch view, already bound.
- **Rebind pins**: select the component; the Inspector lists its pins with alternatives.
- **Delete a component**: its paired node in the patch is removed too. Deleting a node in the patch removes its component. Undo restores both together.
- Switching board with components placed keeps them; any pin that does not exist on the new board is flagged in the status bar so you can repin.

Sensors (IMU, compass, distance) are read from the main loop, not the audio callback — their outputs are smoothed so an audio-rate reading is a ramp, not a staircase.

### Perform

The instrument you would hold. Every hardware control is drawn as itself — a fader is a fader, an OLED shows what the OLED shows — and works with the mouse. Presets are recallable from here.

**Arrange** lets you lay the controls out for playing rather than for drilling: move, resize (`[` `]`), rotate (`R`), hide (`H`). This layout is separate from the panel layout in the Hardware view, so arranging for the hand never moves the holes.

## Building and flashing

**Build** (**Ctrl+Enter**) generates C++ from the patch and compiles it with the real toolchain. The **Build Log** at the bottom shows every command; open it with the backtick key. A build that succeeds ends with the binary size.

**Flash** (**Ctrl+Shift+Enter**) sends the last build to a connected board.

- **Daisy Seed**: hold BOOT, tap RESET, release BOOT to enter DFU mode. The status dot in the top bar goes green when a Seed is seen. Flash mode is chosen in the top bar: `INT` (internal flash — plain Seeds), `QSPI` (needs the Daisy bootloader; larger patches, samples), `SRAM` (volatile — testing).
- **ESP32**: plug in over USB; the port is detected. Some boards need BOOT held while plugging in.

**Generated code** (**Ctrl+Shift+C**) shows the C++ the build will use, live, with each node's lines highlighted when you select it. **Eject** writes the whole project to a folder you can open in any editor — one-way; edits out there do not come back into the patch.

## Presets

A preset is every knob and switch in the patch — not the wiring. **+ Capture** in the Presets rail saves the current state; click a slot to recall it; double-click to rename.

**Morph** drags every numeric parameter between two presets at once. Choices (waveform, mode) snap at the halfway point.

Presets compile into the firmware. To recall them *on the device*, add a **Preset** node and patch a trigger into it — a button, a clock division, anything. In Morph mode its CV input walks between two slots. Only numeric parameters travel to the device; the app warns about the rest.

A preset captures the **whole patch**, boxes included: nodes inside a subpatch, and the voice inside a poly, are part of it wherever you happen to be when you press Capture. A poly voice is one entry that applies to every voice — voices are copies and cannot be tuned apart. On the device the same holds: a preset that moves a voice's oscillator moves it in all N voices.

## Samples

The **Sample** node plays audio from your library. Select it, click **Import…** in the Inspector, and pick any audio file up to 30 seconds. It is decoded, resampled to the patch's rate, and stored once — importing the same file twice costs nothing.

Samples are **compiled into the firmware** as a constant array, which is why length is capped: this is for drum hits, one-shots and short loops. The build log reports how much flash they use. Samples are not stored inside `.dpatch` files; a patch opened on another machine without the sample warns and plays silence for that node.

Modes: **One-shot** plays to the end on each trigger, **Loop** repeats, **Gate** plays while the trigger is held. `eoc` fires at the end of each pass — useful as a clock.

## Subpatches and polyphony

**Subpatch**: select some nodes and press **Ctrl+G** to collapse them into one box with inlets `a–d` and outlets `out`, `out2`. Double-click the box to go inside; the bar at the top shows where you are and **Esc** comes back out. The whole patch keeps playing while you are inside. Right-click → *Expand* puts the nodes back.

**Poly**: the same idea, N times. Double-click a Poly node to edit *one voice*; the app runs that voice `Voices` times and sums them. Inside, the **Voice** node gives each copy its own number (`norm` 0…1, `index` 0…N-1) — patch it into a pitch offset for a detuned stack. Every voice hears the same inputs; this is stacking, not note allocation.

## Logic

Nodes that give a patch memory. Their outputs are ordinary signals, so anything can read them.

- **Logic** — AND / OR / XOR / NAND / NOR / NOT on two gates.
- **Toggle** — flips on each rising edge. Turns a momentary button into a switch.
- **Counter** — counts edges; `cv` is 0…1 across the range, `n` is the raw number, `carry` fires on wrap.
- **Timer** — *Delay* fires once after the time; *Pulse* holds high for the time; *Gate-off* holds high until the input has been low for the time — that is a debounce, and every patch that counts button presses needs one.
- **State** — holds one of N states; `next` / `prev` / `rst` move it; `state` is 0…1, so it drops straight into a **Select**.
- **Select** — passes one of four inputs, chosen by CV. *Crossfade* mode blends instead of switching.
- **Edge** — turns any gate into a one-sample trigger on the rising edge, falling edge, or both.

## The Code node

For the thing the catalog does not have. It runs a small C-shaped language — the same source becomes C++ on the device and runs live in the app. It has four inputs (`a b c d`), four parameters (`p1`…`p4`), two outputs (`out`, `out2`), and `sr` for the sample rate.

    state float phase = 0;      // persists between samples
    float inc = p1 / sr;        // local, per sample
    phase = phase + inc;
    if (phase > 1) { phase = phase - 1; }
    out = sin(phase * 2 * PI) * a;

Available: `+ - * /`, comparisons, `? :`, `if / else`, and `sin cos tan tanh abs sqrt exp log floor ceil round sign min max pow fmod clamp`. Deliberately absent: loops, arrays, pointers, functions — each is either unbounded inside an audio callback or needs memory the node has no business managing. Division, `log` and `sqrt` are guarded identically on both sides so one bad sample cannot poison the patch.

## The Assistant

**Ctrl+Shift+K**, or the speech-bubble button in the top bar. Describe what you want — "add a low-pass after the oscillator and sweep it with an LFO" — and it proposes edits to your patch: nodes to add, cables to wire, parameters to set. **Nothing is applied until you click Apply**, the whole suggestion is **one undo step**, and every proposed edit is checked against the node catalog before it can touch the canvas — an invented node kind or a cable between incompatible sockets is refused with the reason.

It never writes code. It edits the graph, so everything it makes can be heard in the app and checked against the device like anything else.

Provider and model are under **settings** in the panel. **Ollama** (local, no key) is the default; it needs a model pulled first — the panel tells you which. Anthropic and OpenAI keys are stored in your config folder, readable only by you, and never enter the app window.

**What is sent.** When you send a request, the current patch — node kinds, parameters and connections; not your samples, not your files — and your message go to the provider you chose. With Ollama that stays on your machine. With a cloud provider it goes to their API over HTTPS. Nothing is sent until you press Send, and nothing else in the app talks to the network except the update check and the one-time SDK download.

## Files

- **`.dpatch`** is the patch: nodes, cables, hardware layout, presets, and window layout. It is JSON; you can read it.
- **Save** (**Ctrl+S**) writes back to the file you opened. **Save As** (**Ctrl+Shift+S**) picks a new name.
- **Open Recent** is under File. Double-clicking a `.dpatch` in your file manager opens it, and so does dropping one onto the canvas.
- Closing with unsaved work asks: Save, Don't Save, or Cancel.
- Where things live: your SDK and build workspace are in `~/.config/daisypatcher/` (Linux), your sample library and assistant settings alongside.

## Keyboard shortcuts

**Help → Keyboard Shortcuts** (**Ctrl+/**) lists them all. The ones worth knowing on day one:

| | |
|---|---|
| Space | Play / stop |
| Ctrl+K | Command palette — every action, and every node, by name |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S | Save |
| Ctrl+Enter | Build |
| Ctrl+1 / 2 / 3 | Patch / Hardware / Perform |
| Ctrl+Shift+C | Generated code |
| Ctrl+Shift+K | Assistant |
| Ctrl+G | Collapse selection into a subpatch |
| Ctrl+0 | Zoom to fit |
| ` | Build log |
| F1 | This guide |

## When something is wrong

- **No sound in the app** — press Space; check the Output node is connected; the browser audio engine starts on the first Play.
- **Build button disabled** — the SDK is not installed yet (Daisy) or PlatformIO is missing (ESP32). The top bar's status dot opens the installer.
- **Flash finds no device** — Daisy: BOOT + RESET for DFU; check the cable carries data. ESP32: some boards need BOOT held while plugging in; the port list only shows real USB devices.
- **A knob does nothing on the device** — a few parameters are baked into the firmware at build time (buffer sizes, some table lengths). The build log says which, per node.
- **The assistant does nothing** — no model is available. For Ollama, pull the one the panel names; or set a cloud key under settings.
- **A patch opens looking empty** — the camera fits the patch on load; press **Ctrl+0** if you have panned away.
- **The device sounds different from the app** — it should not. Every node kind is compared, level and waveform, emulator against firmware, before release. If one differs, that is a bug: **Help → Report an Issue** and attach the `.dpatch`.

## Reference

- **libDaisy** — the Daisy Seed hardware library: <https://electro-smith.github.io/libDaisy/>
- **DaisySP** — the DSP library the Daisy target uses; most nodes are one of its modules: <https://electro-smith.github.io/DaisySP/>
- **Daisy Wiki** — pinouts, bootloader, getting started with the Seed itself: <https://github.com/electro-smith/DaisyWiki/wiki>
