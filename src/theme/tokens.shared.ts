import type { SharedTokens } from './types'

export const shared: SharedTokens = {
  fontSans: `'Inter', 'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
  fontMono: `'JetBrains Mono', 'Berkeley Mono', 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace`,
  fontDisplay: `'Inter', 'SF Pro Display', system-ui, sans-serif`,

  fsXs: '11px',
  fsSm: '12px',
  fsMd: '13px',
  fsLg: '15px',
  fsXl: '18px',

  lh: '1.5',
  lhTight: '1.2',

  space1: '4px',
  space2: '8px',
  space3: '12px',
  space4: '16px',
  space5: '20px',
  space6: '24px',
  space8: '32px',
  space12: '48px',

  radiusXs: '2px',
  radiusSm: '4px',
  radiusMd: '6px',
  radiusLg: '10px',

  motionFast: '120ms',
  motionNormal: '200ms',
  motionSlow: '320ms',
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
  easeOut: 'cubic-bezier(0.2, 0.8, 0.2, 1)',

  panelW: '240px',
  inspectorW: '280px',
  topbarH: '44px',
  statusbarH: '26px',

  zCanvas: 1,
  // Chrome bars (TopBar / StatusBar) sit above the canvas so their
  // dropdowns / popovers don't get painted over by the canvas grid track.
  zChrome: 20,
  zOverlay: 100,
  zModal: 1000
}
