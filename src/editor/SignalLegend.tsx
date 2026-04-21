/**
 * SignalLegend — small always-visible swatch strip explaining the four
 * signal kinds. Sits in the bottom-left corner of the patch canvas. The
 * colors come from `--dp-signal-*` tokens so every theme can re-skin them.
 *
 * Collapsible: click the chevron to shrink to just the four color dots.
 * Collapsed state persists within the component — this is a view nicety,
 * not a patch property, so there's no reason to push it through the store.
 */

import * as React from 'react'
import type { SignalKind } from '@/theme'
import styles from './SignalLegend.module.css'

interface LegendEntry {
  kind: SignalKind
  label: string
  description: string
}

const ENTRIES: LegendEntry[] = [
  { kind: 'audio', label: 'audio', description: 'audio: PCM samples (-1..1)' },
  { kind: 'cv', label: 'cv', description: 'cv: control voltage, slow-moving' },
  { kind: 'gate', label: 'gate', description: 'gate: on/off trigger (0 or 1)' },
  { kind: 'clock', label: 'clock', description: 'clock: tempo pulses' }
]

export function SignalLegend(): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState(false)

  return (
    <div
      className={`${styles.root} ${collapsed ? styles.collapsed : ''}`}
      role="group"
      aria-label="Signal type legend"
    >
      {ENTRIES.map((e) => (
        <span
          key={e.kind}
          className={`${styles.item} ${styles[e.kind]}`}
          title={e.description}
        >
          <span className={styles.swatch} aria-hidden />
          {collapsed ? null : <span className={styles.label}>{e.label}</span>}
        </span>
      ))}
      <button
        type="button"
        className={styles.toggle}
        aria-label={collapsed ? 'Expand signal legend' : 'Collapse signal legend'}
        onClick={() => setCollapsed((c) => !c)}
      >
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M2 4 L5 7 L8 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}
