import type { Skin } from '../types'

/**
 * Signal Lab — modern, scientific, lab-instrument.
 *
 * Near-black canvas with a faint grid. Signals are color-coded by type so
 * you can read a patch at a glance: cyan for audio, magenta for CV, amber
 * for gate, lime for clock. Warm-tuned so it doesn't feel clinical.
 */

export const signalLab: Skin = {
  id: 'signal-lab',
  name: 'Signal Lab',
  description: 'Modern scientific. Color-coded signals, sharp lines, quiet bloom.',

  bg: '#07090c',
  bgGrid: 'rgba(255, 255, 255, 0.025)',
  surface: '#0d1117',
  surfaceElevated: '#141b24',
  surfaceSunken: '#05070a',
  border: '#1a2230',
  borderStrong: '#2a3545',

  textPrimary: '#e6edf3',
  textMuted: '#8b95a4',
  textDim: '#5a6472',

  accent: '#22d3ee',
  accentMuted: 'rgba(34, 211, 238, 0.15)',
  success: '#34d399',
  warning: '#fbbf24',
  danger: '#f87171',

  signal: {
    audio: '#22d3ee',
    cv: '#f472b6',
    gate: '#fbbf24',
    clock: '#a3e635'
  },

  cable: {
    width: 2,
    glow: 6,
    opacity: 0.92,
    sag: 0.12,
    rendering: 'smooth'
  },

  shadowSm: '0 1px 2px rgba(0, 0, 0, 0.4)',
  shadowMd: '0 4px 16px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.6)',
  shadowGlow: '0 0 24px rgba(34, 211, 238, 0.15)',

  nodeBodyBg: 'rgba(20, 27, 36, 0.92)',
  nodeBodyBorder: '#2a3545',
  nodeHeaderBg: 'rgba(34, 211, 238, 0.08)',
  nodeHeaderText: '#e6edf3',
  nodeSelectedRing: '#22d3ee',

  canvasOverlay: 'radial-gradient(ellipse at center, transparent 40%, rgba(0, 0, 0, 0.35) 100%)'
}
