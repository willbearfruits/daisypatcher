import type { Skin } from '../types'

/**
 * Studio Rack — vintage rack hardware, warm and analog.
 *
 * Dark warm charcoal like a powered-down studio at night, with analog-amber
 * LEDs and cream silkscreen text. Nodes read as rack units: brushed faceplate
 * headers, chunky physical cables with real sag, minimal glow — the warmth
 * comes from color temperature, not bloom. Still a dark theme; contrast stays
 * strong for long sessions.
 */

export const studioRack: Skin = {
  id: 'studio-rack',
  name: 'Studio Rack',
  description: 'Vintage rack hardware. Warm charcoal, brushed panels, amber LEDs.',

  bg: '#0f0d0b',
  bgGrid: 'rgba(255, 214, 170, 0.028)',
  surface: '#181410',
  surfaceElevated: '#221d17',
  surfaceSunken: '#0a0807',
  surfaceTerminal: '#0b0806',
  border: '#2e2720',
  borderStrong: '#4a3f30',

  scrim: 'rgba(10, 6, 2, 0.72)',

  textPrimary: '#f0e7d8',
  textMuted: '#a69881',
  textDim: '#6b5f4e',

  accent: '#f5a83b',
  accentMuted: 'rgba(245, 168, 59, 0.16)',
  success: '#9cbf4e',
  warning: '#e8762e',
  danger: '#e04b3a',

  // Colored patch cables on warm charcoal: hot amber-orange for audio,
  // teal for CV, brick red for gate, olive-lime for clock. Four hues spread
  // around the wheel so they stay tellable-apart at cable width.
  signal: {
    audio: '#ffab40',
    cv: '#56bfae',
    gate: '#e0564a',
    clock: '#a8c454'
  },

  // Real cables: thicker, heavier sag, almost no glow — analog gear doesn't bloom.
  cable: {
    width: 3,
    glow: 3,
    opacity: 0.95,
    sag: 0.22,
    rendering: 'physical'
  },

  // Perform finish: warm cream powder-coat, near-black silkscreen — the
  // classic boutique-pedal build.
  perform: {
    coat: '#e9dfc4',
    coatDeep: '#c7b896',
    ink: '#2a2117',
    hardware: '#1c150d'
  },

  shadowSm: '0 1px 2px rgba(8, 5, 2, 0.55)',
  shadowMd: '0 4px 14px rgba(8, 5, 2, 0.6), 0 1px 3px rgba(8, 5, 2, 0.65)',
  shadowGlow: '0 0 22px rgba(245, 168, 59, 0.18)',

  // Node = rack unit. Body stays a flat color (the Minimap paints it on
  // canvas); the header carries the brushed-aluminum sheen as a soft
  // top-lit vertical gradient.
  nodeBodyBg: 'rgba(30, 26, 21, 0.94)',
  nodeBodyBorder: '#4a3f30',
  nodeHeaderBg: 'linear-gradient(180deg, rgba(255, 226, 178, 0.10), rgba(255, 226, 178, 0.03))',
  nodeHeaderText: '#f0e7d8',
  nodeSelectedRing: '#f5a83b',

  canvasOverlay: 'radial-gradient(ellipse at center, transparent 42%, rgba(10, 6, 2, 0.42) 100%)'
}
