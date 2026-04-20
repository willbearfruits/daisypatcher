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
 * Source of truth today: everything is 'native' on daisy_seed. On esp32_s3
 * a handful of kinds are implemented as stubs while a parallel agent ports
 * the real DSP; the list is enumerated below. When the port lands, flip
 * each entry to 'native' and the palette adjusts automatically — no other
 * wiring needed.
 *
 * A missing entry is treated as 'native' (the default), which matches the
 * Daisy Seed reality without us having to enumerate 80+ kinds twice.
 */

import type { NodeKind } from '@/types/graph'
import type { BoardTarget } from '@/types/store'

export type SupportLevel = 'native' | 'stub' | 'unsupported'

/**
 * Kinds that run as stubs on the ESP32-S3 target today. Keep this in one
 * place so flipping a kind to 'native' is a single-line edit.
 */
const ESP32_STUBS: NodeKind[] = [
  // synthesis
  'karplus',
  'fm_op',
  'fm2',
  'wavetable',
  'drum_kick',
  'drum_snare',
  'drum_hat',
  // filters
  'formant',
  // effects
  'reverb',
  'chorus',
  'phaser',
  'flanger',
  'pitch_shifter',
  'vibrato',
  'freeze',
  'stereo_widener',
  'ping_pong',
  'granulator',
  // dynamics
  'noise_gate',
  // IO — MIDI and OLED aren't hooked up on ESP32 yet
  'midi_in_note',
  'midi_in_cc',
  'midi_out_note',
  'oled'
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
