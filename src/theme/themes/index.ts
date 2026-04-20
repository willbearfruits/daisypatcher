import type { Skin } from '../types'
import { signalLab } from './signalLab'

export const THEMES: Record<string, Skin> = {
  'signal-lab': signalLab
}

export const DEFAULT_THEME_ID = 'signal-lab'

export function getTheme(id: string): Skin {
  return THEMES[id] ?? signalLab
}

export { signalLab }
