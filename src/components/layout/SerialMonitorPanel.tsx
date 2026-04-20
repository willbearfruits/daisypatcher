/**
 * SerialMonitorPanel — bottom-right-docked runtime console.
 *
 * Sibling of BuildLogPanel but docked to the bottom-right corner rather
 * than spanning full width. Same slide-in transform pattern, same
 * stick-to-bottom auto-scroll convention, same token-only styling.
 *
 * Header carries the live controls: port dropdown, baud dropdown,
 * Connect / Disconnect toggle, Close. The footer is a send field
 * (Enter dispatches). Disabled-while-disconnected is enforced at the
 * DOM level so the button visibly dims.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent
} from 'react'
import {
  useSerialStore,
  BAUD_RATES,
  type SerialLine
} from '@/state/serialState'
import { useEditorStore } from '@/state/store'
import { ResizeHandle } from './ResizeHandle'
import styles from './SerialMonitorPanel.module.css'

const DEFAULT_SERIAL_H = 260

const DEFAULT_TAIL = 500

function fmtTime(t: number): string {
  const d = new Date(t)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function SerialMonitorPanel() {
  const open = useSerialStore((s) => s.monitorOpen)
  const close = useSerialStore((s) => s.closeMonitor)
  const ports = useSerialStore((s) => s.ports)
  const connected = useSerialStore((s) => s.connected)
  const connecting = useSerialStore((s) => s.connecting)
  const currentPath = useSerialStore((s) => s.currentPath)
  const baud = useSerialStore((s) => s.baud)
  const lines = useSerialStore((s) => s.lines)
  const connect = useSerialStore((s) => s.connect)
  const disconnect = useSerialStore((s) => s.disconnect)
  const send = useSerialStore((s) => s.send)
  const setBaud = useSerialStore((s) => s.setBaud)
  const setPath = useSerialStore((s) => s.setPath)
  const clearLines = useSerialStore((s) => s.clearLines)

  const [draft, setDraft] = useState('')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  const height = useEditorStore((s) => s.layout.serialMonitorH)
  const setHeight = useEditorStore((s) => s.setSerialMonitorH)

  const visible = useMemo(() => {
    if (lines.length <= DEFAULT_TAIL) return lines
    return lines.slice(lines.length - DEFAULT_TAIL)
  }, [lines])

  useEffect(() => {
    if (!open) return
    if (!stickToBottom.current) return
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [visible, open])

  const onScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    stickToBottom.current = atBottom
  }

  // Auto-select the first port once the list is populated so the
  // Connect button is immediately useful without a dropdown nudge.
  const selectedPath =
    currentPath && ports.some((p) => p.path === currentPath)
      ? currentPath
      : ports[0]?.path ?? ''

  const onPortChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setPath(e.target.value)
  }
  const onBaudChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setBaud(parseInt(e.target.value, 10))
  }

  const onToggleConnect = async (): Promise<void> => {
    if (connected) {
      await disconnect()
      return
    }
    if (!selectedPath) return
    await connect(selectedPath, baud)
  }

  const onSend = async (): Promise<void> => {
    if (!connected) return
    const text = draft
    if (text.length === 0) return
    setDraft('')
    await send(text)
  }

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void onSend()
    }
  }

  const stateDotClass = connected
    ? styles.dotConnected
    : connecting
      ? styles.dotConnecting
      : styles.dotIdle

  return (
    <div
      className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
      aria-hidden={!open}
      style={{ height: `${height}px` }}
    >
      <ResizeHandle
        orientation="horizontal"
        ariaLabel="Resize serial monitor"
        onResize={(dy) => setHeight(height - dy)}
        onReset={() => setHeight(DEFAULT_SERIAL_H)}
      />
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={`${styles.stateDot} ${stateDotClass}`} aria-hidden />
          <span className={styles.title}>SERIAL</span>
        </div>
        <div className={styles.headerCenter}>
          <select
            className={styles.select}
            value={selectedPath}
            onChange={onPortChange}
            disabled={connected || connecting}
            aria-label="Serial port"
          >
            {ports.length === 0 ? (
              <option value="">no ports</option>
            ) : (
              ports.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.path}
                </option>
              ))
            )}
          </select>
          <select
            className={styles.select}
            value={baud}
            onChange={onBaudChange}
            disabled={connected || connecting}
            aria-label="Baud rate"
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.headerRight}>
          <button
            type="button"
            className={styles.headerBtn}
            onClick={() => clearLines()}
            title="Clear monitor"
          >
            Clear
          </button>
          <button
            type="button"
            className={`${styles.headerBtn} ${connected ? styles.btnDanger : styles.btnPrimary}`}
            onClick={() => void onToggleConnect()}
            disabled={connecting || (!connected && !selectedPath)}
          >
            {connecting ? 'connecting\u2026' : connected ? 'Disconnect' : 'Connect'}
          </button>
          <button
            type="button"
            className={styles.headerBtn}
            onClick={() => close()}
            aria-label="Close serial monitor"
            title="Close"
          >
            Close
          </button>
        </div>
      </div>

      <div
        className={styles.body}
        ref={bodyRef}
        onScroll={onScroll}
        tabIndex={-1}
      >
        {!connected && lines.length === 0 ? (
          <div className={styles.empty}>Connect to a port to see output.</div>
        ) : (
          visible.map((line, i) => <LineRow key={i} line={line} />)
        )}
      </div>

      <div className={styles.footer}>
        <input
          className={styles.input}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="send a line\u2026"
          disabled={!connected}
          aria-label="Send line"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className={`${styles.headerBtn} ${styles.btnPrimary}`}
          onClick={() => void onSend()}
          disabled={!connected || draft.length === 0}
        >
          Send
        </button>
      </div>
    </div>
  )
}

function LineRow({ line }: { line: SerialLine }) {
  const outgoing = line.text.startsWith('> ')
  const sysline = line.text.startsWith('[serial]')
  const cls = outgoing
    ? styles.rowOut
    : sysline
      ? styles.rowSys
      : styles.rowIn
  return (
    <div className={`${styles.row} ${cls}`}>
      <span className={styles.time}>{fmtTime(line.t)}</span>
      <span className={styles.text}>{line.text}</span>
    </div>
  )
}
