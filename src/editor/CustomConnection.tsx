/**
 * Custom Rete connection renderer. Paints the cable with the source socket's
 * signal color and a soft Gaussian bloom for the Signal Lab "quiet bloom" look.
 *
 * The source signal is stashed on the connection instance as `signal` by the
 * sync layer — that avoids chasing the editor graph from inside React.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme } from 'rete-react-plugin'
import type { SignalKind } from '@/theme'
import { signalColorVar } from './sockets'
import styles from './CustomConnection.module.css'

const { useConnection } = Presets.classic

export interface SignalConnectionData {
  signal?: SignalKind
  isPseudo?: boolean
  isLoop?: boolean
}

type Props<S extends ClassicScheme> = {
  data: S['Connection'] & SignalConnectionData
}

/**
 * Build a smooth cubic bezier with a small downward sag. The sag factor is
 * intentionally modest (~0.12) — Phase 1 doesn't do physical cables.
 */
function buildPath(sx: number, sy: number, ex: number, ey: number): string {
  const dx = Math.abs(ex - sx)
  const handle = Math.max(60, dx * 0.5)
  const sag = Math.max(0, (ex - sx) * 0) + Math.abs(ex - sx) * 0.12
  const c1x = sx + handle
  const c1y = sy + sag
  const c2x = ex - handle
  const c2y = ey + sag
  return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`
}

export function CustomConnection<S extends ClassicScheme>(props: Props<S>): React.JSX.Element | null {
  const { start, end, path } = useConnection()
  if (!start || !end) return null

  // Fall back to rete's computed path; if unavailable synth one so the pseudo
  // connection (while dragging) still has a line to show.
  const d = path ?? buildPath(start.x, start.y, end.x, end.y)

  const signal = props.data.signal
  const isPseudo = !!props.data.isPseudo

  const strokeColor = signal ? signalColorVar(signal) : 'var(--dp-text-muted)'

  return (
    <svg className={styles.svg} data-testid="connection">
      <defs>
        <filter id="dp-cable-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        className={`${styles.path} ${isPseudo ? styles['path-pseudo'] : ''}`}
        d={d}
        style={{ color: strokeColor }}
      />
    </svg>
  )
}
