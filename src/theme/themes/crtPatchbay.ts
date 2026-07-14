import type { Skin } from '../types'

/**
 * CRT Patchbay — green phosphor terminal.
 *
 * Near-black glass with P1 phosphor green as the primary voice and P3 amber
 * as the secondary. Signal colors are tuned to real CRT phosphor types
 * (P1 green / P11 blue / P3 amber / P7 yellow-green persistence) while
 * keeping four clearly separable hues. Cables glow like traces on a scope;
 * the canvas overlay adds faint scanlines plus a tube vignette.
 */

export const crtPatchbay: Skin = {
  id: 'crt-patchbay',
  name: 'CRT Patchbay',
  description: 'Green phosphor terminal. Amber secondary, glowing traces, scanline haze.',

  bg: '#020503',
  bgGrid: 'rgba(74, 246, 138, 0.045)',
  surface: '#06120a',
  surfaceElevated: '#0a1c10',
  surfaceSunken: '#010402',
  surfaceTerminal: '#020e07',
  border: '#133a21',
  borderStrong: '#1e5c33',

  scrim: 'rgba(0, 8, 3, 0.74)',

  textPrimary: '#cef5d3',
  textMuted: '#6fae7e',
  textDim: '#3f7050',

  accent: '#3dfa7e',
  accentMuted: 'rgba(61, 250, 126, 0.16)',
  success: '#6ef598',
  warning: '#ffb000',
  danger: '#ff5a3d',

  // Phosphor chart: audio = P1 green (the beam itself), cv = P11 blue,
  // gate = P3 amber (matches the cross-theme gate=amber convention),
  // clock = P7 yellow-green persistence trail.
  signal: {
    audio: '#3dfa7e',
    cv: '#57c4f5',
    gate: '#ffb000',
    clock: '#c9e64a'
  },

  // Traces, not wires: thin, taut (patchbays run tight), with a wide
  // phosphor bloom and a little beam jitter.
  cable: {
    width: 2,
    glow: 10,
    opacity: 0.9,
    sag: 0.08,
    rendering: 'crackle'
  },

  // Perform finish: dark green-black coat, phosphor-green silkscreen —
  // the pedal as a piece of terminal hardware.
  perform: {
    coat: '#0f2618',
    coatDeep: '#040c07',
    ink: '#3dfa7e',
    hardware: '#08110b'
  },

  shadowSm: '0 1px 2px rgba(0, 0, 0, 0.65)',
  shadowMd: '0 4px 18px rgba(0, 0, 0, 0.7), 0 1px 2px rgba(0, 0, 0, 0.75)',
  shadowGlow: '0 0 30px rgba(61, 250, 126, 0.22)',

  // Body stays a flat color (the Minimap paints it on canvas); the header
  // is a dim phosphor wash.
  nodeBodyBg: 'rgba(8, 20, 12, 0.94)',
  nodeBodyBorder: '#1e5c33',
  nodeHeaderBg: 'rgba(61, 250, 126, 0.09)',
  nodeHeaderText: '#cef5d3',
  nodeSelectedRing: '#3dfa7e',

  // Faint scanlines over a tube vignette. Kept subtle: 1px lines on a 3px
  // pitch at low alpha — texture you feel more than see.
  canvasOverlay:
    'repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.14) 0px, rgba(0, 0, 0, 0.14) 1px, transparent 1px, transparent 3px), radial-gradient(ellipse at center, transparent 38%, rgba(0, 6, 2, 0.5) 100%)'
}
