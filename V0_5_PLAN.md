# v0.5 milestone

Theme: **feels like an instrument, ships like a product.** Building on the
0.4.1 production pass (license, security, device-status system, binding fix).

## Landed 2026-07-13 (verified: typecheck 0 errors, snapshots green, build clean)
- [x] Studio Rack + CRT Patchbay themes — completes the 3-theme promise
- [x] Armed flash — click Flash while the Seed runs, tap RESET, it fires
      itself (no timing dance; 60 s timeout, click-to-cancel)
- [x] Cable signal animation — audio blooms, gates pulse, clocks tick
      (zero cost when stopped, reduced-motion respected)
- [x] Codegen snapshot tests (`npm run test:codegen`) — 10 canonical
      patches × 2 targets, 60 snapshot files

## Next in line for v0.5
- [x] Daisy OLED `DrawFrame()` main-loop wiring (ESP32 side already real) —
      real OneBitGraphicsDisplay emission for all element kinds, ~30 fps
      throttle in while(1), arm-none-eabi compile verified
- [x] ESP32 `audio_in` real I2S input (last parity gap) — full-duplex on
      I2S_NUM_0, pio-compile verified, zero snapshot drift
- [x] udev permission error surfaced specifically on dfu-util EACCES
      (+ dialout-group hint on the pio serial path)
- [ ] ESP32 I2S pin config bug (found during audio_in work): generated
      `i2s_pin_config_t` never sets `.mck_io_num`, so IDF 4.4
      zero-initializes it to GPIO0 (a strapping pin) instead of
      I2S_PIN_NO_CHANGE; the bound MCLK pin is also never actually
      configured. Pre-existing, drifts all esp32 snapshots — fix as a
      deliberate pass.
- [ ] Patch bank / snapshots (1–8 keys) — the "real instrument" upgrade;
      folds into the Perform view as its bank strip
- [ ] Recording emulator output to .wav

## Perform view (decided 2026-07-13)
User vision: physical emulation of the finished box — stompbox enclosure
rendered from the HardwareLayout, pots/buttons/OLED/LEDs live, controlled by
mouse and MIDI learn. Direction decided (user: "do your call powder coat -
silkscreen and 3d in the end"):
1. **Powder-coat** (2.5D skeuomorph SVG, no new deps) ships first — view
   name: **Perform**
2. **Silkscreen** mode toggle on the same enclosure model + 1:1 drill
   template export
3. **Orbit** (three.js 3D) last, as a third renderer over the same model,
   feeding the v2 STL/CAD path
MIDI learn: emulator-first ({cc,channel} → component binding stored in the
patch), firmware CC emission as fast-follow. Mockups:
https://claude.ai/code/artifact/7ee30110-13fd-4f49-b944-d2a0c26d55a9

## Release checklist (from the 0.4.1 audit)
- [ ] Commit + tag (user drives all commits)
- [ ] GitHub repo public + first release with latest.yml (updater is dead
      until then)
- [ ] CHANGELOG.md
- [ ] Multi-size Windows .ico
