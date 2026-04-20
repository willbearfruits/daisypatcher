/**
 * Palette icon glyphs — compact 20x20 stroke SVGs, one per `NodeKind`.
 *
 * We don't ship 80 unique icons — that's visual noise and maintenance
 * burden. Most kinds fall back to a small set of canonical glyphs keyed
 * off category (source / process / io) plus a few special shapes for
 * things that are visually self-evident (sine wave, filter bell, ADSR
 * ramp, drum, scope, knob…). When a kind has a stronger identity than
 * its category fallback, it gets its own glyph; everything else shares.
 *
 * All icons render in `currentColor` so the card can tint them via CSS.
 */

import type { JSX } from 'react'
import type { NodeKind } from '@/types/graph'
import { NODE_DEFINITIONS } from './definitions'

/** Shared wrapper: 20x20 viewBox, 1.5px stroke, round caps. */
function Ico({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

/* ---------- canonical glyphs ---------- */

const SineIcon = () => (
  <Ico>
    <path d="M2 10 C 5 3, 7 17, 10 10 S 15 3, 18 10" />
  </Ico>
)

const NoiseIcon = () => (
  <Ico>
    <path d="M2 10 L4 6 L5 13 L7 5 L8 14 L10 7 L12 13 L14 5 L15 14 L17 8 L18 11" />
  </Ico>
)

const LfoIcon = () => (
  <Ico>
    <path d="M2 10 C 5 4, 7 16, 10 10 S 15 4, 18 10" />
    <circle cx="10" cy="10" r="0.6" fill="currentColor" stroke="none" />
  </Ico>
)

const ConstantIcon = () => (
  <Ico>
    <path d="M2 10 L18 10" />
    <path d="M10 5 L10 15" strokeDasharray="2 2" />
  </Ico>
)

const GearIcon = () => (
  <Ico>
    <circle cx="10" cy="10" r="3" />
    <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10 M4.5 4.5 L5.7 5.7 M14.3 14.3 L15.5 15.5 M4.5 15.5 L5.7 14.3 M14.3 5.7 L15.5 4.5" />
  </Ico>
)

const PlugIcon = () => (
  <Ico>
    <path d="M4 8 L4 4 M8 8 L8 4" />
    <path d="M2 8 L10 8 L10 12 C 10 14, 8 15, 6 15 C 4 15, 2 14, 2 12 Z" />
    <path d="M6 15 L6 18" />
  </Ico>
)

const FilterIcon = () => (
  <Ico>
    <path d="M2 14 L7 14 C 9 14, 9 6, 11 6 C 13 6, 13 14, 18 14" />
  </Ico>
)

const AdsrIcon = () => (
  <Ico>
    <path d="M2 16 L5 4 L8 9 L13 9 L16 16" />
  </Ico>
)

const DrumIcon = () => (
  <Ico>
    <ellipse cx="10" cy="6" rx="7" ry="2" />
    <path d="M3 6 L3 13 C 3 14, 6 15, 10 15 S 17 14, 17 13 L 17 6" />
  </Ico>
)

const ScopeIcon = () => (
  <Ico>
    <rect x="2" y="4" width="16" height="12" rx="1.5" />
    <path d="M4 12 C 6 8, 8 14, 10 10 S 14 6, 16 12" />
  </Ico>
)

const KnobIcon = () => (
  <Ico>
    <circle cx="10" cy="10" r="6" />
    <path d="M10 4 L10 7" />
  </Ico>
)

const GateIcon = () => (
  <Ico>
    <path d="M2 14 L7 14 L7 6 L12 6 L12 14 L18 14" />
  </Ico>
)

const ClockIcon = () => (
  <Ico>
    <circle cx="10" cy="10" r="6.5" />
    <path d="M10 6 L10 10 L13 12" />
  </Ico>
)

const DelayIcon = () => (
  <Ico>
    <path d="M2 10 L5 10" />
    <path d="M7 10 L10 10" />
    <path d="M12 10 L15 10" />
    <path d="M17 10 L18 10" />
  </Ico>
)

const MixIcon = () => (
  <Ico>
    <path d="M3 4 L3 16 M8 4 L8 16 M13 4 L13 16 M17 4 L17 16" />
    <circle cx="3" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="13" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="17" cy="10" r="1.2" fill="currentColor" stroke="none" />
  </Ico>
)

const LedIcon = () => (
  <Ico>
    <circle cx="10" cy="10" r="3.5" />
    <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10 M4.5 4.5 L5.7 5.7 M14.3 14.3 L15.5 15.5 M4.5 15.5 L5.7 14.3 M14.3 5.7 L15.5 4.5" />
  </Ico>
)

const MidiIcon = () => (
  <Ico>
    <circle cx="10" cy="10" r="7" />
    <circle cx="10" cy="15" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="6" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
  </Ico>
)

/* ---------- per-kind map ---------- */

/**
 * Kind-specific overrides. Anything not listed here uses the category
 * fallback below — that keeps this table short and the visual language
 * consistent (sources share a waveform, process shares a gear, etc.).
 */
const KIND_ICON_OVERRIDES: Partial<Record<NodeKind, () => JSX.Element>> = {
  // sources
  oscillator: SineIcon,
  noise: NoiseIcon,
  lfo: LfoIcon,
  constant: ConstantIcon,
  karplus: SineIcon,
  fm_op: SineIcon,
  fm2: SineIcon,
  wavetable: SineIcon,
  drum_kick: DrumIcon,
  drum_snare: DrumIcon,
  drum_hat: DrumIcon,
  // filters
  filter_svf: FilterIcon,
  filter_moog: FilterIcon,
  formant: FilterIcon,
  // envelopes & CV
  adsr: AdsrIcon,
  ar: AdsrIcon,
  envelope_follower: AdsrIcon,
  // clocks / sequencing
  clock: ClockIcon,
  clock_divider: ClockIcon,
  step_seq: ClockIcon,
  euclidean: ClockIcon,
  arp: ClockIcon,
  // effects with a clear identity
  delay: DelayIcon,
  ping_pong: DelayIcon,
  // mix-like
  mixer4: MixIcon,
  sum: MixIcon,
  crossfade: MixIcon,
  // visual
  scope: ScopeIcon,
  vu: ScopeIcon,
  spectrum_scope: ScopeIcon,
  // hardware IO
  knob_in: KnobIcon,
  gate_in: GateIcon,
  button: GateIcon,
  led: LedIcon,
  switch_3way: GateIcon,
  audio_in: PlugIcon,
  audio_output: PlugIcon,
  i2s_in: PlugIcon,
  i2s_out: PlugIcon,
  midi_in_note: MidiIcon,
  midi_in_cc: MidiIcon,
  midi_out_note: MidiIcon,
  oled: ScopeIcon
}

function categoryFallback(kind: NodeKind): () => JSX.Element {
  const def = NODE_DEFINITIONS[kind]
  if (!def) return GearIcon
  if (def.category === 'source') return SineIcon
  if (def.category === 'io') return PlugIcon
  return GearIcon
}

/**
 * Resolve the icon component for a kind. Always returns something —
 * falls back to the category glyph and then to a plain gear.
 */
export function iconForKind(kind: NodeKind): () => JSX.Element {
  return KIND_ICON_OVERRIDES[kind] ?? categoryFallback(kind)
}
