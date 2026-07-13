import type { Skin } from '../types'
import { signalLab } from './signalLab'
import { studioRack } from './studioRack'
import { crtPatchbay } from './crtPatchbay'

export const THEMES: Record<string, Skin> = {
  'signal-lab': signalLab,
  'studio-rack': studioRack,
  'crt-patchbay': crtPatchbay
}

export const DEFAULT_THEME_ID = 'signal-lab'

export function getTheme(id: string): Skin {
  return THEMES[id] ?? signalLab
}

export { signalLab, studioRack, crtPatchbay }
