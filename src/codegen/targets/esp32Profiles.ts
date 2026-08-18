/**
 * Per-board knobs for the ESP32 code generator.
 *
 * All Espressif targets share one emitter: `pio run` / `pio run --target
 * upload` / PlatformIO + Python are MCU-agnostic, and PlatformIO fetches
 * the right toolchain (Xtensa or RISC-V) from the `board =` value alone.
 * What actually differs between an S3 DevKitC, an S3 SuperMini and a C3
 * SuperMini is: which `board =` to write, which peripherals the silicon
 * has, and which GPIO numbers are safe to fall back to.
 *
 * Those differences live here, so `esp32s3.ts` stays one code path.
 */

import type { BoardId } from '../../../shared/boards'
import { PIO_ENV } from '../../../shared/boards'

export interface Esp32Defaults {
  /** GPIO used when an `led` component has no bound pin. */
  led: number
  /**
   * I2S bus fallbacks. `null` when the board has no set of pins that are
   * safe to guess at — the emitter then skips the peripheral and warns
   * rather than driving flash pins.
   */
  i2s: { sck: number; ws: number; sdOut: number; sdIn: number; mclk: number } | null
  oled: { sda: number; scl: number }
}

/**
 * What a board's external RAM looks like — or `null` for none.
 *
 * This is the thing the `platformio.ini` block has to get RIGHT per board:
 * the S3 family ships the same chip with no PSRAM (N8), 2 MB quad-SPI
 * PSRAM (R2, the ESP32-S3-Zero / most SuperMinis) or 8 MB octal (R8, the
 * DevKitC-1 N8R8), and the Arduino core has to be told which at build
 * time via `board_build.arduino.memory_type`. Emitting the octal settings
 * for a quad board does not degrade gracefully — the firmware boots into
 * a PSRAM-init panic loop. So a wrong `hasPsram: true` used to be worse
 * than `false`, which is why the SuperMini shipped without PSRAM even
 * though it has 2 MB.
 */
export interface Esp32Psram {
  /** `qspi` (R2, R8 quad) or `opi` (octal, DevKitC-1 N8R8). */
  bus: 'qspi' | 'opi'
  /** Flash size string for `board_upload.flash_size` / partition choice. */
  flash: '4MB' | '8MB' | '16MB'
}

export interface Esp32Profile {
  boardId: BoardId
  label: string
  /** Compact TopBar label. */
  shortLabel: string
  description: string
  /** platformio.ini `board =` / build-env name. */
  pioBoard: string
  /**
   * External PSRAM, or `null`. Drives the platformio.ini memory block and
   * the palette's PSRAM_DEGRADED note; the granulator asks for PSRAM at
   * runtime and falls back to a shorter heap buffer either way, so a
   * wrong `null` costs capture length, not a build.
   */
  psram: Esp32Psram | null
  /** TinyUSB device stack (`USBMIDI.h`) — S2/S3 only, never RISC-V C-series. */
  hasTinyUsbMidi: boolean
  /** Native-USB CDC-on-boot build flags. */
  usbCdcOnBoot: boolean
  defaults: Esp32Defaults
}

/**
 * ESP32-S3 DevKitC-1 — the original target.
 *
 * These GPIO defaults are the pre-existing hardcoded literals, preserved
 * exactly so codegen snapshots do not drift.
 */
const S3_DEVKITC: Esp32Profile = {
  boardId: 'esp32_s3_devkitc',
  label: 'ESP32-S3',
  shortLabel: 'S3',
  description: 'Espressif ESP32-S3 DevKitC-1 (Arduino / PlatformIO)',
  pioBoard: PIO_ENV.esp32_s3_devkitc,
  /*
   * `null` on purpose, and not a mistake about the hardware.
   *
   * PlatformIO's `esp32-s3-devkitc-1` definition is the N8 variant, which
   * has no PSRAM; the family also ships as N8R2 (quad) and N8R8 (octal)
   * and nothing at build time distinguishes them. Claiming octal here
   * emitted `memory_type = qio_opi` for a chip that may not have it, and
   * the wrong bus type is a boot loop, not a warning. Buffers that want
   * PSRAM ask for it at runtime and fall back, so this only controls the
   * platformio.ini block — and the safe answer for a board we cannot
   * identify is "assume none". A user with an N8R8 can add the block by
   * hand after Eject.
   */
  psram: null,
  hasTinyUsbMidi: true,
  usbCdcOnBoot: true,
  defaults: {
    led: 21,
    // sd_in falls back to 39 (not 35): 35 is the sd_out default and a
    // single GPIO can't be both TX and RX data in full-duplex.
    i2s: { sck: 36, ws: 37, sdOut: 35, sdIn: 39, mclk: 38 },
    oled: { sda: 8, scl: 9 }
  }
}

/**
 * ESP32-C3 SuperMini — 22.5 x 18 mm, 16 pins, RISC-V.
 *
 * Only GPIO0-10 plus 20/21 are exposed, so every S3 default above is
 * either a flash pin or simply absent here. ADC is GPIO0-5 only. The chip
 * has no PSRAM and no TinyUSB device stack, so `granulator` and the USB
 * MIDI kinds are marked unsupported (see targetSupport.ts).
 *
 * Fallbacks avoid the strapping pins (2, 8, 9) except for I2C, where 8/9
 * are the board's documented SDA/SCL and are held high by their pullups.
 */
const C3_SUPERMINI: Esp32Profile = {
  boardId: 'esp32_c3_supermini',
  label: 'C3 SuperMini',
  shortLabel: 'C3 SM',
  description: 'ESP32-C3 SuperMini (RISC-V, 16 pins, no PSRAM)',
  pioBoard: PIO_ENV.esp32_c3_supermini,
  psram: null,
  hasTinyUsbMidi: false,
  usbCdcOnBoot: true,
  defaults: {
    led: 10,
    // The C3 routes I2S through the GPIO matrix, so any free pin works.
    // sd_in shares the ADC-capable low block; sdOut/sck/ws avoid straps.
    i2s: { sck: 4, ws: 5, sdOut: 6, sdIn: 7, mclk: 3 },
    oled: { sda: 8, scl: 9 }
  }
}

/**
 * ESP32-S3 SuperMini — the ESP32-S3-Zero form factor (18 x 23.5 mm,
 * ESP32-S3FH4R2: 4 MB flash, 2 MB quad-SPI PSRAM in the package). See
 * `hardware/esp32S3SuperMiniPinout.ts` for the pin table, checked against
 * a board in hand.
 *
 * Unlike the DevKitC, this board IS identifiable — the S3-Zero pinout only
 * exists on the FH4R2 — so the PSRAM block can be emitted with confidence:
 * quad bus, 4 MB flash. That gives the granulator its full four-second
 * buffer here.
 */
const S3_SUPERMINI: Esp32Profile = {
  boardId: 'esp32_s3_supermini',
  label: 'S3 SuperMini',
  shortLabel: 'S3 SM',
  description: 'ESP32-S3 SuperMini / S3-Zero (18 header pins + pads, WS2812 on GPIO21)',
  pioBoard: PIO_ENV.esp32_s3_supermini,
  psram: { bus: 'qspi', flash: '4MB' },
  hasTinyUsbMidi: true,
  usbCdcOnBoot: true,
  defaults: {
    // GPIO21 is the on-board WS2812 — a plain digitalWrite there lights
    // nothing, but it is the only "LED pin" the board has.
    led: 21,
    // All on the header; 15 was a pad.
    i2s: { sck: 4, ws: 5, sdOut: 6, sdIn: 7, mclk: 13 },
    oled: { sda: 8, scl: 9 }
  }
}

/**
 * Profile per board — `null` for anything that isn't an Espressif part.
 *
 * `satisfies Record<BoardId, …>` is load-bearing: adding a board to
 * `BOARD_IDS` without deciding its profile is a compile error here rather
 * than a silent fall-through to the Daisy branch at runtime.
 */
export const ESP32_PROFILES = {
  daisy_seed: null,
  esp32_s3_devkitc: S3_DEVKITC,
  esp32_c3_supermini: C3_SUPERMINI,
  esp32_s3_supermini: S3_SUPERMINI
} satisfies Record<BoardId, Esp32Profile | null>

export function esp32ProfileFor(board: BoardId): Esp32Profile | null {
  return ESP32_PROFILES[board]
}
