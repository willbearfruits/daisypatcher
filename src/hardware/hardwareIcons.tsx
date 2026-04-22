/**
 * Inline SVG icons for hardware-component palette / placed cards. Hand-drawn
 * at 24x24, using currentColor so token-driven coloring works everywhere.
 * No emoji, no external assets.
 */

import type { ReactElement } from 'react'
import type { HardwareKind } from '@/types/hardware'

export function IconPot() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.25" />
      <line x1="12" y1="12" x2="16" y2="7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" />
      <circle cx="12" cy="20" r="0.9" fill="currentColor" />
      <circle cx="5" cy="15.5" r="0.9" fill="currentColor" />
      <circle cx="19" cy="15.5" r="0.9" fill="currentColor" />
    </svg>
  )
}

export function IconButton() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="7" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </svg>
  )
}

export function IconSwitch() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="8" y="4" width="8" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <rect x="10" y="9" width="4" height="4" fill="currentColor" opacity="0.7" />
      <line x1="12" y1="6" x2="12" y2="8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="12" y1="16" x2="12" y2="18" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

export function IconLED() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="10" r="5" stroke="currentColor" strokeWidth="1.25" />
      <line x1="9.5" y1="15" x2="9.5" y2="20" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="14.5" y1="15" x2="14.5" y2="20" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M10 4.5L12 2l2 2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
      <path d="M7 5L4.5 3.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
      <path d="M17 5l2.5-1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
    </svg>
  )
}

export function IconGateJack() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M3 7v10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
    </svg>
  )
}

export function IconCVJack() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M8 12h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
    </svg>
  )
}

export function IconAudioJack() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="10" width="14" height="4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M17 10l4 2-4 2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <line x1="6" y1="10" x2="6" y2="14" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="10" y1="10" x2="10" y2="14" stroke="currentColor" strokeWidth="1" opacity="0.6" />
    </svg>
  )
}

export function IconMidiJack() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="9" cy="15" r="1" fill="currentColor" />
      <circle cx="15" cy="15" r="1" fill="currentColor" />
      <circle cx="12" cy="9" r="1" fill="currentColor" />
      <circle cx="7" cy="10.5" r="1" fill="currentColor" />
      <circle cx="17" cy="10.5" r="1" fill="currentColor" />
    </svg>
  )
}

export function IconOLED() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="6" width="18" height="12" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="5.5" y="8.5" width="13" height="7" fill="currentColor" opacity="0.12" />
      <path d="M7 11h4M7 13h6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
    </svg>
  )
}

export function IconI2S() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="14" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="7" y="8" width="10" height="8" stroke="currentColor" strokeWidth="1" opacity="0.8" />
      <line x1="4" y1="9" x2="2.5" y2="9" stroke="currentColor" strokeWidth="1" />
      <line x1="4" y1="12" x2="2.5" y2="12" stroke="currentColor" strokeWidth="1" />
      <line x1="4" y1="15" x2="2.5" y2="15" stroke="currentColor" strokeWidth="1" />
      <line x1="20" y1="9" x2="21.5" y2="9" stroke="currentColor" strokeWidth="1" />
      <line x1="20" y1="12" x2="21.5" y2="12" stroke="currentColor" strokeWidth="1" />
      <line x1="20" y1="15" x2="21.5" y2="15" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function IconEncoder() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1" />
      <line x1="12" y1="3" x2="12" y2="5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
      <line x1="12" y1="19" x2="12" y2="21" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
      <line x1="3" y1="12" x2="5" y2="12" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
      <line x1="19" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.6" />
    </svg>
  )
}

export function IconSlider() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="10" y="3" width="4" height="18" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="6" y="7" width="12" height="4" rx="1" fill="currentColor" opacity="0.85" />
      <line x1="12" y1="13" x2="12" y2="21" stroke="currentColor" strokeWidth="1" opacity="0.6" />
    </svg>
  )
}

export function IconTouchRibbon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="10" y="3" width="4" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="0.75" opacity="0.5" />
    </svg>
  )
}

export function IconLDR() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M6.5 9 l2.5 0 l1 3 l1 -3 l1 3 l1 -3 l1 3 l1 -3 l2 0"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconGyroscope() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 12a4 4 0 1 1 4 4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M14 16l2 0 0 -2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M12 6v3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
      <path d="M15 8l2 1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
      <circle cx="6.5" cy="6.5" r="0.8" fill="currentColor" />
    </svg>
  )
}

export function IconMagnetometer() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1" />
      <path d="M12 7l1.2 4 L12 12 l-1.2 -1 Z" fill="currentColor" opacity="0.85" />
      <path d="M12 17l-1.2 -4 L12 12 l1.2 1 Z" fill="currentColor" opacity="0.35" />
    </svg>
  )
}

export function IconTof() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="6" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="10" cy="12" r="2.25" fill="currentColor" opacity="0.9" />
      <path d="M16 9l5 3 -5 3 Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" opacity="0.85" />
    </svg>
  )
}

export function IconElectret() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="0.75" opacity="0.5" />
      <circle cx="9" cy="10" r="0.7" fill="currentColor" opacity="0.7" />
      <circle cx="12" cy="9" r="0.7" fill="currentColor" opacity="0.7" />
      <circle cx="15" cy="10" r="0.7" fill="currentColor" opacity="0.7" />
      <circle cx="9" cy="13" r="0.7" fill="currentColor" opacity="0.7" />
      <circle cx="12" cy="14" r="0.7" fill="currentColor" opacity="0.7" />
      <circle cx="15" cy="13" r="0.7" fill="currentColor" opacity="0.7" />
    </svg>
  )
}

export function IconPiezo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1" opacity="0.75" />
      <line x1="4" y1="12" x2="2.5" y2="11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <line x1="20" y1="12" x2="21.5" y2="13" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

/** Pick the right icon for a HardwareKind. Used by placed cards + inspector. */
export const HARDWARE_ICON: Record<HardwareKind, () => ReactElement> = {
  pot: IconPot,
  button: IconButton,
  switch_3way: IconSwitch,
  led: IconLED,
  gate_jack: IconGateJack,
  cv_jack: IconCVJack,
  audio_jack: IconAudioJack,
  midi_jack: IconMidiJack,
  oled_ssd1306: IconOLED,
  i2s_codec: IconI2S,
  encoder: IconEncoder,
  slider: IconSlider,
  touch_ribbon: IconTouchRibbon,
  ldr: IconLDR,
  gyroscope: IconGyroscope,
  magnetometer: IconMagnetometer,
  tof: IconTof,
  electret: IconElectret,
  piezo: IconPiezo
}
