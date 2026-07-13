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
- [ ] Daisy OLED `DrawFrame()` main-loop wiring (ESP32 side already real)
- [ ] ESP32 `audio_in` real I2S input (last parity gap)
- [ ] udev permission error surfaced specifically on dfu-util EACCES
- [ ] Patch bank / snapshots (1–8 keys) — the "real instrument" upgrade
- [ ] Recording emulator output to .wav

## Release checklist (from the 0.4.1 audit)
- [ ] Commit + tag (user drives all commits)
- [ ] GitHub repo public + first release with latest.yml (updater is dead
      until then)
- [ ] CHANGELOG.md
- [ ] Multi-size Windows .ico
