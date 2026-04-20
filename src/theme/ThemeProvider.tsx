import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Skin, Theme } from './types'
import { shared } from './tokens.shared'
import { DEFAULT_THEME_ID, getTheme } from './themes'

interface ThemeContextValue {
  theme: Theme
  skinId: string
  setSkinId: (id: string) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * Flatten a skin into CSS custom properties. Colors and shape tokens become
 * --dp-* vars so every component can read them without importing JS.
 *
 * Signal colors get both namespaced (--dp-signal-audio) and aliased
 * (--dp-signal-for-audio) so Rete.js sockets can look up by signal kind.
 */
function skinToCssVars(skin: Skin): Record<string, string> {
  return {
    '--dp-bg': skin.bg,
    '--dp-bg-grid': skin.bgGrid,
    '--dp-surface': skin.surface,
    '--dp-surface-elevated': skin.surfaceElevated,
    '--dp-surface-sunken': skin.surfaceSunken,
    '--dp-border': skin.border,
    '--dp-border-strong': skin.borderStrong,

    '--dp-text': skin.textPrimary,
    '--dp-text-muted': skin.textMuted,
    '--dp-text-dim': skin.textDim,

    '--dp-accent': skin.accent,
    '--dp-accent-muted': skin.accentMuted,
    '--dp-success': skin.success,
    '--dp-warning': skin.warning,
    '--dp-danger': skin.danger,

    '--dp-signal-audio': skin.signal.audio,
    '--dp-signal-cv': skin.signal.cv,
    '--dp-signal-gate': skin.signal.gate,
    '--dp-signal-clock': skin.signal.clock,

    '--dp-cable-width': `${skin.cable.width}px`,
    '--dp-cable-glow': `${skin.cable.glow}px`,
    '--dp-cable-opacity': `${skin.cable.opacity}`,

    '--dp-shadow-sm': skin.shadowSm,
    '--dp-shadow-md': skin.shadowMd,
    '--dp-shadow-glow': skin.shadowGlow,

    '--dp-node-bg': skin.nodeBodyBg,
    '--dp-node-border': skin.nodeBodyBorder,
    '--dp-node-header-bg': skin.nodeHeaderBg,
    '--dp-node-header-text': skin.nodeHeaderText,
    '--dp-node-selected-ring': skin.nodeSelectedRing,

    '--dp-canvas-overlay': skin.canvasOverlay
  }
}

function sharedToCssVars() {
  return {
    '--dp-font-sans': shared.fontSans,
    '--dp-font-mono': shared.fontMono,
    '--dp-font-display': shared.fontDisplay,

    '--dp-fs-xs': shared.fsXs,
    '--dp-fs-sm': shared.fsSm,
    '--dp-fs-md': shared.fsMd,
    '--dp-fs-lg': shared.fsLg,
    '--dp-fs-xl': shared.fsXl,

    '--dp-lh': shared.lh,
    '--dp-lh-tight': shared.lhTight,

    '--dp-space-1': shared.space1,
    '--dp-space-2': shared.space2,
    '--dp-space-3': shared.space3,
    '--dp-space-4': shared.space4,
    '--dp-space-5': shared.space5,
    '--dp-space-6': shared.space6,
    '--dp-space-8': shared.space8,
    '--dp-space-12': shared.space12,

    '--dp-radius-xs': shared.radiusXs,
    '--dp-radius-sm': shared.radiusSm,
    '--dp-radius-md': shared.radiusMd,
    '--dp-radius-lg': shared.radiusLg,

    '--dp-motion-fast': shared.motionFast,
    '--dp-motion-normal': shared.motionNormal,
    '--dp-motion-slow': shared.motionSlow,
    '--dp-ease': shared.ease,
    '--dp-ease-out': shared.easeOut,

    '--dp-panel-w': shared.panelW,
    '--dp-inspector-w': shared.inspectorW,
    '--dp-topbar-h': shared.topbarH,
    '--dp-statusbar-h': shared.statusbarH,

    // Stacking order. Chrome (TopBar / StatusBar) sits above the canvas so
    // dropdowns and popovers anchored to those bars don't get painted over
    // by adjacent grid tracks. Overlay + modal track the classic pattern.
    '--dp-z-canvas': String(shared.zCanvas),
    '--dp-z-chrome': String(shared.zChrome),
    '--dp-z-overlay': String(shared.zOverlay),
    '--dp-z-modal': String(shared.zModal)
  }
}

interface ThemeProviderProps {
  children: ReactNode
  initialSkin?: string
}

export function ThemeProvider({ children, initialSkin = DEFAULT_THEME_ID }: ThemeProviderProps) {
  const [skinId, setSkinId] = useState(initialSkin)

  const theme = useMemo<Theme>(
    () => ({ shared, skin: getTheme(skinId) }),
    [skinId]
  )

  useEffect(() => {
    const root = document.documentElement
    const vars = { ...sharedToCssVars(), ...skinToCssVars(theme.skin) }
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    root.setAttribute('data-theme', theme.skin.id)
  }, [theme])

  return (
    <ThemeContext.Provider value={{ theme, skinId, setSkinId }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}
