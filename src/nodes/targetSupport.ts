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

export type SupportLevel = 'native' | 'stub' | 'unsupported'

/**
 * Kinds that still run as stubs on the ESP32-S3 target. Keep this in one
 * place so flipping a kind to 'native' is a single-line edit.
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
 * Sparse map: only non-'native' entries are listed. `supportLevel()` is
 * the only consumer you should need.
 */
export const TARGET_SUPPORT: Partial<Record<NodeKind, Partial<Record<BoardTarget, SupportLevel>>>> =
  (() => {
    const out: Partial<Record<NodeKind, Partial<Record<BoardTarget, SupportLevel>>>> = {}
    for (const kind of ESP32_STUBS) {
      out[kind] = { ...(out[kind] ?? {}), esp32_s3: 'stub' }
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
