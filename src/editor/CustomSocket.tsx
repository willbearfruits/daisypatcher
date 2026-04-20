/**
 * Custom socket renderer used by rete-react-plugin's `customize.socket` hook.
 *
 * Replaces the plugin's default pastel socket with a precise, instrument-style
 * signal pill. This component is the click/drag target for
 * `rete-connection-plugin` — it must not have `pointer-events: none` and must
 * not be wrapped by an absolutely positioned overlay that steals events.
 */

import * as React from 'react'
import type { ClassicPreset } from 'rete'
import { SignalSocket } from './sockets'
import type { SignalKind } from '@/theme'
import styles from './CustomSocket.module.css'

type Props = {
  data: ClassicPreset.Socket
}

function kindClass(kind: SignalKind | undefined): string {
  switch (kind) {
    case 'audio':
      return styles['signal-audio']
    case 'cv':
      return styles['signal-cv']
    case 'gate':
      return styles['signal-gate']
    case 'clock':
      return styles['signal-clock']
    default:
      return styles['signal-audio']
  }
}

export function CustomSocket(props: Props): React.JSX.Element {
  const socket = props.data
  const kind: SignalKind | undefined = socket instanceof SignalSocket ? socket.signal : undefined
  const title = kind ? `${kind} signal` : socket.name
  return (
    <div className={`${styles.socket} ${kindClass(kind)}`} title={title} data-signal={kind}>
      <span className={styles.disc} aria-hidden />
    </div>
  )
}

export default CustomSocket
