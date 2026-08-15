/**
 * Target-support map — declares, per node kind, how well each compile
 * target supports it.
 *
 *   - 'native'      — full, tuned implementation for that target
 *   - 'stub'        — placeholder / pass-through / degraded-quality
 *                     implementation; the kind compiles and runs but the
 *                     DSP is not the canonical one
 *   - 'unsupported' — does not compile / does not run on that target
 *
 * This table drives the palette's target filter (All / Available / Native)
 * and the little coloured dots on palette cards (amber = stub, red = not
 * available).
 *
 * Source of truth today: everything is 'native' on daisy_seed. The big
 * ESP32 DSP parity port has LANDED (inline-C++ emitters for all DaisySP-
 * backed kinds, real USB-MIDI, real SSD1306 OLED draw) — the remaining
 * ESP32 stubs are enumerated below with their reasons.
 *
 * A missing entry is treated as 'native' (the default), which matches the
 * Daisy Seed reality without us having to enumerate 80+ kinds twice.
 */

import type { NodeKind } from '@/types/graph'
import type { BoardTarget } from '@/types/store'
import { BOARD_IDS } from '../../shared/boards'
import { ESP32_PROFILES } from '@/codegen/targets/esp32Profiles'

export type SupportLevel = 'native' | 'stub' | 'unsupported'

/**
 * Kinds that run as stubs on EVERY ESP32 target, regardless of chip.
 * Keep this in one place so flipping a kind to 'native' is a single-line
 * edit.
 */
const ESP32_STUBS: NodeKind[] = [
  // audio_in is native as of the full-duplex I2S RX path in
  // targets/esp32s3.ts: when the graph contains an audio_in node the
  // generated project runs the legacy I2S driver in master TX+RX mode on
  // one port (shared BCLK/WS, codec sd_in pin or GPIO39 default) and
  // in_l/in_r carry real line-in samples.
  //
  // explicit unsupported(): warn + passthrough by design
  'i2s_in',   // use audio_in / I2S codec binding instead
  'i2s_out',  // use audio_output — I2S is the default sink
  'expression' // no expression-to-C++ transpile on ESP32 yet
]

/**
 * Kinds that want external PSRAM but no longer require it.
 *
 * The granulator's four-second capture buffer is ~770 KB. It used to be a
 * static `EXT_RAM_ATTR` array, which meant it did not link at all without
 * PSRAM — and worse, "with PSRAM" turned out to be unknowable at build
 * time: PlatformIO's `esp32-s3-devkitc-1` is the N8 variant with none, and
 * the family also ships as N8R2 and N8R8.
 *
 * The buffer is now allocated at runtime with a heap fallback, so it links
 * everywhere and simply captures a shorter window on a board without PSRAM.
 * That makes it 'stub' rather than 'unsupported': it works, at reduced
 * length, and the palette should say so.
 */
const PSRAM_DEGRADED: NodeKind[] = ['granulator']

/**
 * Needs the TinyUSB device stack (`USBMIDI.h` from arduino-esp32), which
 * exists only on the S2/S3. The RISC-V C-series has USB Serial/JTAG, not
 * a device stack, so these cannot build there.
 */
const NEEDS_TINYUSB: NodeKind[] = ['midi_in_note', 'midi_in_cc', 'midi_out_note']

/**
 * Kinds that exist on the ESP32 only, with the reason.
 *
 * `distance_in` drives a VL53L0X, whose initialisation is a long vendor
 * tuning sequence rather than a few register writes. PlatformIO fetches the
 * Pololu library for it; libDaisy has no equivalent and no package manager
 * to fetch one, so on the Seed the node holds its sidebar value and says so.
 * Marking it unsupported is what makes the palette dim it instead of
 * implying a working ranger.
 */
const ESP32_ONLY: NodeKind[] = ['distance_in']

/**
 * Sparse map: only non-'native' entries are listed. `supportLevel()` is
 * the only consumer you should need.
 *
 * Built by iterating `BOARD_IDS` against each board's ESP32 profile, so a
 * newly added board picks up the right stubs automatically instead of
 * silently claiming full parity (`supportLevel` defaults to 'native').
 */
/**
 * Kinds with no emitter on ANY target yet — the node exists and works in
 * the emulator, but codegen would fall through to the generic passthrough
 * with only a warning. Listing them here makes the palette say so instead
 * of claiming native support by default.
 *
 * `menu` graduated off this list once `menuCodegen.ts` landed: the state
 * machine, the four CV outputs, live param targets and OLED drawing all
 * compile on every target now.
 */
const NO_CODEGEN_YET: NodeKind[] = []

export const TARGET_SUPPORT: Partial<Record<NodeKind, Partial<Record<BoardTarget, SupportLevel>>>> =
  (() => {
    const out: Partial<Record<NodeKind, Partial<Record<BoardTarget, SupportLevel>>>> = {}
    const put = (kind: NodeKind, board: BoardTarget, level: SupportLevel) => {
      out[kind] = { ...(out[kind] ?? {}), [board]: level }
    }
    for (const board of BOARD_IDS) {
      for (const kind of NO_CODEGEN_YET) put(kind, board, 'stub')
      const profile = ESP32_PROFILES[board]
      if (!profile) {
        // Daisy Seed — native except the parts that need an Arduino library.
        for (const kind of ESP32_ONLY) put(kind, board, 'unsupported')
        continue
      }
      for (const kind of ESP32_STUBS) put(kind, board, 'stub')
      if (!profile.hasPsram) for (const kind of PSRAM_DEGRADED) put(kind, board, 'stub')
      if (!profile.hasTinyUsbMidi) for (const kind of NEEDS_TINYUSB) put(kind, board, 'unsupported')
    }
    return out
  })()

/**
 * Resolved support level for a `(kind, target)` pair. Defaults to
 * 'native' when the kind isn't listed — that's the Daisy-Seed reality
 * today and avoids us having to enumerate every kind twice.
 */
export function supportLevel(kind: NodeKind, target: BoardTarget): SupportLevel {
  const entry = TARGET_SUPPORT[kind]
  if (!entry) return 'native'
  return entry[target] ?? 'native'
}
