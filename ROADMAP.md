# Roadmap

Written 2026-08-19, after the v0.5.6 release and a review of where this
actually stands. Supersedes the "next in line" section of `V0_5_PLAN.md`
(that file stays as the record of what the v0.5 milestone contained).
`V2_PLAN.md` remains the long-horizon vision.

The one-line version: **the hard half is built twice over — patch→firmware,
and (in LAMINA) design→fab. What is unproven is whether either survives
contact with real hardware in someone else's hands. The next month is
proving that, not adding.**

---

## Where this actually stands

**Built:** ~77k hand-written lines. 95 node kinds (94 native on Seed, 92 on
S3 SuperMini, 91 DevKitC, 88 C3). Four boards with pin tables checked
against real cards. Five test layers — snapshots, cross-target contract,
behavioural features (154 checks), real per-node compiles, and emulator↔
firmware audio parity. Public since 2026-08-17, CI on every push, releases
built by GitHub Actions for Linux/Windows/macOS.

**Not proven:** `~/.config/daisypatcher/verified.json` records **19 of 95
kinds verified on real hardware, all Daisy Seed, zero ESP32**, with two
recorded failures — `freeze` ("just white noise", 2026-04-22) and
`filter_moog` ("no output", 2026-07-13). MoogLadder was re-ported faithfully
in the v0.5.0 divergence pass, so the second may already be fixed and nobody
re-checked. The Windows and macOS builds have never been run by anyone. No
user outside this machine has installed the app.

That gap — not features — is what decides whether any of this matters.

## Competitive position (researched 2026-08-19)

| | |
|---|---|
| **plugdata** | The real rival. Free (GPL/AGPL), actively developed (v0.9.3-2, Mar 2026), GUI, Compiled Mode → Daisy via hvcc. Electro-Smith archived their own `pd2dsy` in Mar 2025 pointing users here. **No ESP32. No pin GUI** (board dropdown + hand-written JSON). |
| **hvcc / heavy** | Pd subset → C, GPL-3.0, maintained by Wasted Audio. Healthiest thing in the space (v0.17.0, Aug 2026). Daisy via `c2daisy` + `json2daisy`. No ESP32 generator. |
| **RNBO** | $299 perpetual / $100 yr **and requires Max 8+**. Daisy only via generic Minimal Export; `rnbo.example.daisy` self-labels "use at own risk", no functional commits since Jul 2024, unanswered "builds but no output" thread on their own forum. No ESP32. |
| **oopsy** | Dead. Last release Dec 2021, 34 open issues. |
| **Faust** | Not visual (the IDE's diagram tab is read-only SVG). `faust2daisy` tracks libDaisy 8.1.0; `faust2esp32` is WM8978/AC101 only, no S3. |
| **Electro-Smith** | Alive — **Seed3 shipping ($29.99, TAC5242, USB-C)**, Seed2 DFM, libDaisy v8.1.0 active. **DaisySP is frozen** (v1.0.0 Jan 2024, last commit May 2025). `flash.daisy.audio` is WebUSB DFU flashing only; no web IDE, no visual tool. |

**Two claims survive scrutiny and are worth saying out loud:**

1. **Nobody generates pin-binding code from a drawn board.** `json2daisy`
   emits libDaisy BSP C++ from pin descriptions, but it is a Python CLI over
   hand-written JSON with no GUI, official or community. Every competitor
   makes you describe the hardware separately, in text.
2. **ESP32 visual audio DSP does not exist.** No hvcc target, no Faust S3
   support, no RNBO. The only prior art is two abandoned ~2020 hacks.
   XOD/Visuino/Node-RED are GPIO/IoT with no audio-rate concept.

**Where we lose:** catalogue and community. plugdata brings Pd's object
library and decades of patches; we have 95 nodes and no users. That is the
gap Phase 3 (custom nodes) exists to close.

**Strategic note:** DaisySP being frozen is good for us — the parity target
has stopped moving, so the 89 faithful ports will not rot. It also means the
catalogue only grows if we grow it.

---

## Phase 0 — Hardware truth · **blocks everything**

Nothing below this line is worth doing until the pin tables are proven on
metal. Three of four board pinouts were confidently wrong until v0.5.5; the
Seed's OLED auto-wiring paired an I²C3 SDA with an I²C1 SCL, which libDaisy
refuses — every shipped Seed example was wired that way. Clean, tested,
well-commented code that was wrong about the physical world. No unit test
can find that class of bug.

- [ ] Re-test the two recorded failures: `freeze`, `filter_moog`.
- [ ] Work the remaining unverified kinds on the Seed with the in-app Test
      Rig (Inspector → TEST). The verification matrix **is** the document —
      do not write a separate one.
- [ ] All four boards for everything *bound*: pot on the pin the app drew,
      button, LED, encoder, OLED over I²C, MIDI, I²S DAC.
- [ ] Compile-verified but never heard: preset recall on device (the
      tree-preset table is compile-proven only), samples in flash,
      `audio_in` with a real signal into the interface.
- [ ] ESP32: currently **zero** kinds verified on hardware.

## Phase 1 — Trust off this machine

- [ ] Cold install on Windows and on macOS. Expect the toolchain not to be
      found and SmartScreen/Gatekeeper to scare people off; the interesting
      output is where it breaks, not whether it runs.
- [ ] Three strangers, one hour each, **watched in silence**, each given a
      task ("make a synth where a knob changes pitch, flash it to this
      board") rather than asked for an opinion. Note every hesitation.

## Phase 2 — Seed3

New board, $29.99, TAC5242 codec, USB-C. Unsupported today. Cheap and
visible positioning, and the pinout test group (`test:features --only
pinouts`) now exists to pin its header order the day it is added. Do it
while the pinout code is still fresh.

## Phase 3 — Custom nodes · **the answer to plugdata's catalogue**

The decided design (see "Node authoring" below): a `.dpnode` file is a Code
node's source plus metadata, loadable at runtime, no rebuild, no TypeScript,
no three-way duplication. This is the community story and it is mostly
packaging of mechanisms that already exist.

- [ ] `.dpnode` format + loader: name, category, description, declared
      sockets, declared params (kind/range/default), Code-node source.
- [ ] "Publish as node" panel in the Code node's editor.
- [ ] Bounded `buffer` primitive in the language (below) — without it a
      custom node cannot be a delay, and a delay is the first thing anyone
      will try to write.
- [ ] `npm run new:node <kind>` scaffold for in-repo contributors (separate,
      cheap, an afternoon).

## Phase 4 — ESP32 as the wedge

The empty market. Needs Phase 0's ESP32 verification first, then say it
plainly in the README and on the site: *the only visual patcher that emits
ESP32 audio firmware.* Nobody can contest it today.

## Phase 5 — Presence

Daisy forum and Discord. A free tool in a small niche gets 200 stars and
five users unless the author is visibly present. Worth more than any feature
in Phases 2–4.

## Phase 6 — The LAMINA bridge

`~/Projects/lamina` is a design-first PCB studio by the same author: board
shape/holes/silkscreen/copper art, a two-board sandwich (panel + main with
connector gap and standoff length), 3D preview, and export to JLCPCB
Gerber/Excellon, KiCad, DipTrace, FlatCAM, G-code, STL/OBJ/GLB.

**The join is real, not a vibe.** Daisypatcher's `perform/enclosureModel.ts`
already holds per-kind hole diameters in millimetres with the parts named in
the comments (`pot: 7 // 16mm Alpha bushing`, `button: 12 // 3PDT
footswitch`, `midi_jack: 14.5 // DIN5 panel hole`). LAMINA's library has
`pot_alpha_16mm`, `sw_footswitch_3pdt`, `jack_35_pj398sm`, `oled_096_i2c`,
`enc_ec11` — and `mod_daisy_seed`, `mod_esp32_c3_supermini`,
`mod_esp32_s3_zero`: the exact three boards this app targets. LAMINA's
panel+main sandwich *is* the Perform face plus the Hardware pin map.

**Build a bridge, not a brand.** One export, one direction:

- [ ] `PlacedComponent.config.part` — a LAMINA footprint id chosen in the
      Inspector, defaulting per kind. **Worth doing even if the bridge never
      ships**, because it is what makes this app's own drill-template output
      honest instead of assuming every pot is a 16 mm Alpha.
- [ ] `daisypatcher → .lamina.json` export: Perform placement becomes panel
      items, hardware bindings become the main board, the target module
      drops in as `mod_*`, computed hole diameters become drills.
- [ ] Success criterion: **patch → firmware → Gerber zip → JLCPCB in one
      afternoon.** Prove it by ordering one board.

**Do not couple them yet.** LAMINA is days old, not in git, with 16 of 97
footprints carrying `verify:true`. A wrong dimension in either tool produces
a board that does not fit — the most expensive bug there is, because a fab
tells you about it. Gate this on LAMINA having its own hardware-truth pass.

**Mapping gaps today** (≈9 of 21 hardware kinds covered): LAMINA has no
DIN-5 MIDI jack, no PCM5102A/MAX98357A module footprints, and none of
slider, touch ribbon, LDR, electret, piezo, IMU, compass or ToF.
`switch_3way` wants an MTS-**103** (on-off-on); LAMINA has 102 and 202.

---

## Node authoring — the decided design

**The problem.** Adding a node today touches seven files across three
languages: the `NodeKind` union, a `NodeDefinition`, a TS worklet, a
registry line, a Daisy emitter, an ESP32 emitter, two dispatch tables, and
sometimes `targetSupport.ts` and `store.ts`. Worse than the file count: the
DSP is written **three times** (TS + two C++), kept in sync only by
`test:contract` and `test:audio` — that duplication is exactly where the 16
emulator/firmware divergences came from. And it needs a rebuild, so nobody
can hand another user a node.

**The insight.** The Code node already solves this.
`src/codegen/codeNode/lang.ts` parses a small C-shaped language once;
`toCpp.ts` emits firmware and `code.worklet.ts` compiles the same AST to a
tree of closures for the emulator. One parse, two backends, so the two
**cannot** drift. It is already CSP-safe by construction (parse on the main
thread, post the AST to the worklet — no `eval`, no compiler in a worklet).

So: **a custom node is a Code node plus metadata.** Name, category, icon,
declared sockets, declared params with ranges and defaults, and the source.
Ship it as a `.dpnode` file. That yields, for free:

- no rebuild, no TypeScript, no PR required to share a node;
- no three-way duplication and therefore no possible drift;
- it works in the emulator and on the device from the same source;
- the assistant can use it immediately (its catalogue is generated from
  `NODE_DEFINITIONS`, so a registered custom kind appears automatically);
- **a real sandbox**: the language has no I/O, no `eval`, no loops (so no
  infinite loop in an audio callback), and guarded division/`log`/`sqrt`.
  Loading a stranger's `.dpnode` is safe in a way that loading a stranger's
  JS worklet never could be. This is the reason the design is right.

**Two things must change to make it work.**

1. **A bounded buffer primitive.** The language deliberately has no arrays —
   correct for unbounded structures, wrong for the one bounded case that
   matters. Without `state buffer[N]` (compile-time N, clamped index) a
   custom node cannot be a delay, a chorus, a reverb or a wavetable, which
   is most of what anyone wants to write. Keep it bounded and clamped and it
   stays as safe as the rest of the language.
2. **Per-kind sockets.** The Code node's fixed 4-in/2-out/4-param shape is
   right for an *instance* — CLAUDE.md rejects per-instance sockets for good
   reasons (threading an instance-specific definition through the editor,
   engine, connection index and both emitters). A loaded custom **kind** is
   different: its definition is fixed at load time, which is exactly how the
   built-in catalogue already works. Declared sockets per custom kind are
   therefore cheap and do not reopen that decision.

**Built-in nodes stay hand-written.** They need DaisySP, tight per-sample
code and platform APIs a sandboxed language should not reach. Two tiers with
different contracts is honest; trying to unify them would make the built-ins
worse to serve a use case they do not have.

**Helper GUI: yes — but it is a form, not a new tool.** The Code node
already has an in-node editor. "Publish as node" is a panel on it: name,
category, sockets, params. Do not build a separate node-builder application.

---

## Deliberately not doing yet

MIDI learn · recording the emulator to `.wav` · Silkscreen mode + drill
template (superseded by the LAMINA bridge) · code signing (until users ask)
· more built-in nodes (Phase 3 makes that the community's job) · polyphonic
note allocation — `poly` is voice *stacking*, not allocation; a MIDI
polysynth needs a real allocator and that is a design job, not an increment.
