# Board reference cards

The pictures the pin tables in `src/hardware/*Pinout.ts` were checked against.
When a board drawing looks wrong, this is what to compare it with — and if
you have a board whose silkscreen disagrees, a photo of it is the most useful
thing you can attach to an issue.

| File | Board | Source |
|---|---|---|
| `esp32-c3-supermini-pincard.jpeg` | ESP32-C3 SuperMini | vendor pin card, top view, USB up |
| `esp32-s3-supermini-s3-zero-pincard.jpg` | ESP32-S3 SuperMini (Waveshare ESP32-S3-Zero layout) | vendor pin card + outline, top view, USB up |
| (not redistributed) | ESP32-S3-DevKitC-1 v1.1 | Espressif's own figure and J1/J3 tables: <https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html> — module at top, USB at bottom |

The Daisy Seed table is checked against libDaisy's own `daisy_seed.cpp` pin
map rather than a picture.
