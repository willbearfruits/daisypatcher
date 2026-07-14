/**
 * Theme system: shared tokens stay constant across themes (structure, motion,
 * typography scale), skin tokens swap to change the mood.
 *
 * Components read only from CSS variables produced by ThemeProvider. No
 * component hardcodes a color or radius — that's the rule that makes multi-theme
 * work instead of drifting.
 */

export type SignalKind = 'audio' | 'cv' | 'gate' | 'clock'

export interface SignalPalette {
  audio: string
  cv: string
  gate: string
  clock: string
}

export interface CableStyle {
  width: number
  glow: number
  opacity: number
  sag: number
  rendering: 'smooth' | 'crackle' | 'physical'
}

/**
 * Perform-view physical finish — the "build" of the pedal each skin
 * produces. Consumed by `src/perform/` as `--dp-perform-*` vars; every
 * other color in that view comes from the regular skin tokens.
 */
export interface PerformFinish {
  /** Powder-coat face color (light end of the vertical coat gradient). */
  coat: string
  /** Powder-coat shadow color (dark end of the coat gradient). */
  coatDeep: string
  /** Silkscreen ink printed on the faceplate (name, control labels). */
  ink: string
  /** Dark machined-metal base tone for knobs / fader caps. */
  hardware: string
}

export interface Skin {
  id: string
  name: string
  description: string

  bg: string
  bgGrid: string
  surface: string
  surfaceElevated: string
  surfaceSunken: string
  /** Deep terminal/console surface — build log, monitor-style panels. */
  surfaceTerminal: string
  border: string
  borderStrong: string

  /** Modal/overlay backdrop wash — semi-transparent, tinted per skin. */
  scrim: string

  textPrimary: string
  textMuted: string
  textDim: string

  accent: string
  accentMuted: string
  success: string
  warning: string
  danger: string

  signal: SignalPalette

  cable: CableStyle

  perform: PerformFinish

  shadowSm: string
  shadowMd: string
  shadowGlow: string

  nodeBodyBg: string
  nodeBodyBorder: string
  nodeHeaderBg: string
  nodeHeaderText: string
  nodeSelectedRing: string

  canvasOverlay: string
}

export interface SharedTokens {
  fontSans: string
  fontMono: string
  fontDisplay: string

  fsXs: string
  fsSm: string
  fsMd: string
  fsLg: string
  fsXl: string

  lh: string
  lhTight: string

  space1: string
  space2: string
  space3: string
  space4: string
  space5: string
  space6: string
  space8: string
  space12: string

  radiusXs: string
  radiusSm: string
  radiusMd: string
  radiusLg: string

  motionFast: string
  motionNormal: string
  motionSlow: string
  ease: string
  easeOut: string

  panelW: string
  inspectorW: string
  topbarH: string
  statusbarH: string

  zCanvas: number
  zChrome: number
  zOverlay: number
  zModal: number
}

export interface Theme {
  shared: SharedTokens
  skin: Skin
}
