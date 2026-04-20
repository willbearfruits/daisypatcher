/**
 * BuildLogPanel — bottom-docked developer console.
 *
 * Docking strategy: rendered outside the `.dp-app` grid, fixed to the
 * bottom of the viewport so it overlays the canvas and inspector without
 * re-triggering any grid reflow. Slide transition is a 180ms transform —
 * when closed it translates off-screen and pointer-events become none.
 *
 * Log rendering: trimmed to the last 500 lines by default with a "show
 * all" affordance that expands to the full 2000-line cap. That keeps the
 * panel jank-free even during a chatty libDaisy build.
 *
 * Auto-scroll: we remember whether the user scrolled off the bottom. As
 * long as they're pinned to the bottom, new lines keep us pinned. If
 * they scroll up, we respect that until they scroll back down.
 *
 * Focus discipline: none of the controls call .focus(), and the body is
 * a static list so opening the panel never steals focus from the Rete
 * editor. It's a read-mostly surface.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useCompileStore, type LogLine } from '@/state/compileState'
import { useEditorStore } from '@/state/store'
import { ResizeHandle } from './ResizeHandle'
import styles from './BuildLogPanel.module.css'

const DEFAULT_BUILD_LOG_H = 220

const DEFAULT_TAIL = 500

export function BuildLogPanel() {
  const open = useCompileStore((s) => s.logPanelOpen)
  const close = useCompileStore((s) => s.closeLogPanel)
  const clear = useCompileStore((s) => s.clearLog)
  const log = useCompileStore((s) => s.log)
  const building = useCompileStore((s) => s.building)
  const flashing = useCompileStore((s) => s.flashing)
  const sdkInstalling = useCompileStore((s) => s.sdkInstalling)

  const [showAll, setShowAll] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  // Store-driven panel height. Drag above the header shrinks/grows.
  const height = useEditorStore((s) => s.layout.buildLogH)
  const setHeight = useEditorStore((s) => s.setBuildLogH)

  const visible = useMemo(() => {
    if (showAll || log.length <= DEFAULT_TAIL) return log
    return log.slice(log.length - DEFAULT_TAIL)
  }, [log, showAll])

  /* Auto-scroll — only when the user hasn't intentionally scrolled up. */
  useEffect(() => {
    if (!open) return
    if (!stickToBottom.current) return
    const el = bodyRef.current
    if (!el) return
    // `scrollTop` + `scrollIntoView` both move focus on some browsers; this
    // direct assignment doesn't, which matches the no-focus-steal guarantee.
    el.scrollTop = el.scrollHeight
  }, [visible, open])

  const onScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    stickToBottom.current = atBottom
  }

  const action = sdkInstalling
    ? 'installing sdk\u2026'
    : building
      ? 'building\u2026'
      : flashing
        ? 'flashing\u2026'
        : 'idle'

  const stateDotClass = sdkInstalling
    ? styles.dotSdk
    : building
      ? styles.dotBuild
      : flashing
        ? styles.dotFlash
        : styles.dotIdle

  const truncatedCount = !showAll && log.length > DEFAULT_TAIL ? log.length - DEFAULT_TAIL : 0

  return (
    <div
      className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
      aria-hidden={!open}
      style={{ height: `${height}px` }}
    >
      {/* Top-edge resize handle — drag up grows, drag down shrinks. */}
      <ResizeHandle
        orientation="horizontal"
        ariaLabel="Resize build log"
        onResize={(dy) => setHeight(height - dy)}
        onReset={() => setHeight(DEFAULT_BUILD_LOG_H)}
      />
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={`${styles.stateDot} ${stateDotClass}`} aria-hidden />
          <span className={styles.title}>BUILD LOG</span>
        </div>
        <div className={styles.headerCenter}>
          <span>{action}</span>
        </div>
        <div className={styles.headerRight}>
          {truncatedCount > 0 ? (
            <button
              type="button"
              className={styles.headerBtn}
              onClick={() => setShowAll(true)}
              title={`Show all ${log.length} lines`}
            >
              show all ({truncatedCount} hidden)
            </button>
          ) : null}
          <button
            type="button"
            className={styles.headerBtn}
            onClick={() => {
              clear()
              setShowAll(false)
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className={styles.headerBtn}
            onClick={() => close()}
            aria-label="Close build log"
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
        {visible.length === 0 ? (
          <div className={styles.empty}>no output yet</div>
        ) : (
          visible.map((line, i) => <LogRow key={i} line={line} />)
        )}
      </div>
    </div>
  )
}

function LogRow({ line }: { line: LogLine }) {
  const cls =
    line.stream === 'error'
      ? styles.rowError
      : line.stream === 'flash'
        ? styles.rowFlash
        : line.stream === 'sdk'
          ? styles.rowSdk
          : line.stream === 'info'
            ? styles.rowInfo
            : styles.rowBuild
  return (
    <div className={`${styles.row} ${cls}`}>
      <span className={styles.channel}>{line.stream}</span>
      <span className={styles.text}>{line.text}</span>
    </div>
  )
}
