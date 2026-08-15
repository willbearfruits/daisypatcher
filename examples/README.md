# Example patches

Five complete patches, one per idea, each targeting a specific board. Open
one with **Open** in the toolbar (or `Ctrl+O`) — the patch, the hardware
layout and the compile target all come from the file, so it arrives ready to
build.

| Patch | Board | What it is |
|---|---|---|
| `daisy-sampler.dpatch` | Daisy Seed | Live-input sampler: hold a slice, granulate it, filter and reverb |
| `daisy-tracker.dpatch` | Daisy Seed | Four-track pattern sequencer with per-track faders |
| `esp32-sequencer.dpatch` | ESP32-S3 DevKitC | Eight-step melody + Euclidean drums, encoder menu |
| `esp32-drone-box.dpatch` | ESP32-C3 SuperMini | Four detuned voices drifting against each other |
| `esp32-gesture-box.dpatch` | ESP32-S3 DevKitC | A resonator played by tilting the box and waving at it |

All five compile to real firmware — that is checked, not assumed. See
"Verified" below.

## Wiring

Each patch already has its hardware laid out and pinned. Switch to the
**Hardware** tab to see which pin each control landed on; the assignments
come from the board's own pinout table using the same first-free rule the
app applies when you drop a component, so nothing here is special-cased.

**Daisy Seed** patches use the onboard audio codec — no external DAC needed.
**ESP32** patches include a PCM5102A line-out module, because the ESP32 has
no audio hardware of its own.

## The patches

### `daisy-sampler` — Daisy Seed

Audio in → `freeze` → `granulator` → filter → reverb.

`freeze` holds whatever is at its input while its gate is high, and the
granulator reads that held buffer. Together they behave like a sampler with
scrub and stretch rather than a plain looper: capture a moment, then move
through it at any speed and pitch.

Four knobs, each scaled to the range its destination actually wants — grain
size in milliseconds, density in grains per second, pitch in semitones,
cutoff in Hz. A raw 0–1 knob into `cv_grain_size` would clamp to the 10 ms
floor across its whole travel and feel broken.

Patch a gate into the Capture jack to record. The LED is a level meter fed
by an envelope follower rather than the capture gate — it shows signal
present, which is more useful than showing a button you are already holding.

### `daisy-tracker` — Daisy Seed

Four tracks, one clock, laid out the way a tracker's columns are: a pattern
plus a voice per track.

- **1 Lead** — 8-step pattern → square oscillator + envelope
- **2 Bass** — 8-step pattern → Karplus-Strong pluck
- **3 Kick** — clock ÷4
- **4 Hats** — clock ÷2

Four faders are the channel volumes, into a 4-channel mixer, then a tone
filter and reverb. Faders rather than mute buttons because the mixer's level
inputs are CV and the editor refuses a gate-to-CV cable — correctly, and
per-track level is the better control anyway.

Everything else lives under the encoder: tempo, per-track voice parameters,
master tone and reverb. That is how a tracker on a box with no keyboard has
to work, and it is what the menu node exists for.

### `esp32-sequencer` — ESP32-S3 DevKitC

An 8-step melodic line over a Euclidean drum part, both locked to one clock.
The melody's pitch CV is remapped to a two-octave span before it reaches the
oscillator, because `pitch_cv` is octave-scaled and additive — feeding it a
raw 0–1 would give you a semitone of range.

Drums come off clock divisions rather than the melody's step count, so the
rhythm can be a different length from the tune.

Eleven parameters over one encoder and no cables: the menu's leaves target
node params directly. Turn to move, click to enter or edit, click again to
confirm, long-press to go back, double-click for the root.

### `esp32-drone-box` — ESP32-C3 SuperMini

Four detuned voices, three slow LFOs at deliberately non-integer rates
(0.037, 0.053, 0.017 Hz). A drone that repeats is a loop; the point is that
these never line up, so the beating between the voices keeps evolving.

Note how the two knobs are wired. An LFO emits `wave * depth + offset`, so
the root-pitch knob goes to `cv_offset` and the spread knob to `cv_depth` —
one cable each, and the LFO's output is already "root pitch, drifting by
this much". Building the same thing from a multiply and an adder is not
possible, and should not be: `sum` and `multiply` are audio-rate nodes.

Chosen for the C3 SuperMini deliberately. That board exposes thirteen usable
pins, so the budget *is* the design: four pots and a three-wire line-out and
the board is full. Everything else is generated on-chip.

### `esp32-gesture-box` — ESP32-S3 DevKitC

A Karplus-Strong resonator you play with your hands and no controls at all.

- **Tilt front/back** (IMU X) → pitch
- **Tilt left/right** (IMU Y) → damping
- **Hand distance** (time-of-flight) → delay mix

Tilt is a genuinely good controller for this: it is absolute, so the sound
has a resting position you can return to, which an encoder cannot give you.
A clock keeps the string struck so the box is playable the moment it powers
up, and a second quiet voice wanders in pitch so a still box does not sound
static.

The IMU, the ranger and the display share one I²C bus — three devices, two
wires, which is what the hardware view's shared-bus roles are for.

## These files are generated

`scripts/build-examples.mjs` builds them; do not hand-edit the `.dpatch`
JSON.

```bash
npm run examples          # rebuild
npm run examples:check    # verify they match the builder, write nothing
```

A patch is a graph of socket ids and param names, and hand-editing JSON
against an 80-kind catalog produces files that load with half their cables
missing and nothing to tell you. The builder checks every node kind, socket
id and param name against `NODE_DEFINITIONS` as it writes; checks every
cable for signal-kind compatibility, since the editor would refuse a
mismatched one and a file containing one describes a patch that cannot be
drawn; and takes every pin from the real board pinout with the app's own
collision rules.

It also means the examples cannot rot. Rename a socket and the build fails
loudly instead of shipping five broken demos.

## Verified

Every patch here has been compiled for its own board — `make` for the Daisy
Seed, `pio run` for the ESP32s — not merely generated:

```
daisy-sampler        daisy_seed            96,872 B
daisy-tracker        daisy_seed           122,236 B
esp32-drone-box      esp32_c3_supermini   382,352 B
esp32-gesture-box    esp32_s3_devkitc     391,472 B
esp32-sequencer      esp32_s3_devkitc     395,200 B
```
