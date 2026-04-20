/**
 * StatusBar — bottom monospace strip. Three-column grid:
 * [device pill + engine state] · canvas meta · status message + CPU bar.
 *
 * The device pill has THREE states:
 *   - no device    — muted gray, no DFU and no open serial
 *   - DFU mode     — dfu-util sees 0483:df11; board is ready to flash
 *                    (and by definition NOT available as a serial port)
 *   - serial       — user has opened a serial connection from the monitor
 *
 * Priority: serial wins over DFU wins over nothing. In practice the board
 * can only be in one mode at a time (DFU or app), so the priorities only
 * matter during the brief transition after a flash.
 *
 * Click toggles the serial monitor (the more useful panel day-to-day).
 * Ctrl/Cmd+click still toggles the build log.
 *
 * The CPU bar at the far right shows an estimate of the Daisy Seed's
 * cost budget based on a static per-kind table (see src/state/cpuBudget.ts).
 */

import { useMemo, type MouseEvent } from 'react'
import { useEditorStore } from '@/state/store'
import { useCompileStore } from '@/state/compileState'
import { useSerialStore } from '@/state/serialState'
import { estimateCpu, topCostNodes, KIND_COST, FALLBACK_COST } from '@/state/cpuBudget'
import styles from './StatusBar.module.css'

type PillState = 'none' | 'dfu' | 'serial'

export function StatusBar() {
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const status = useEditorStore((s) => s.status)
  const meta = useEditorStore((s) => s.graph.meta)
  const nodes = useEditorStore((s) => s.graph.nodes)

  const deviceAvailable = useCompileStore((s) => s.deviceAvailable)
  const deviceLabel = useCompileStore((s) => s.deviceLabel)
  const seedAvailable = useCompileStore((s) => s.seedAvailable)
  const esp32Available = useCompileStore((s) => s.esp32Available)
  const toggleLogPanel = useCompileStore((s) => s.toggleLogPanel)
  const detectDevice = useCompileStore((s) => s.detectDevice)
  const target = useEditorStore((s) => s.target)

  const serialConnected = useSerialStore((s) => s.connected)
  const toggleMonitor = useSerialStore((s) => s.toggleMonitor)

  const engineDotClass = isPlaying ? styles.dotRunning : styles.dotIdle
  const engineText = isPlaying ? 'running' : 'idle'

  const messageClass =
    status.kind === 'info'
      ? styles.messageInfo
      : status.kind === 'warn'
        ? styles.messageWarn
        : status.kind === 'error'
          ? styles.messageError
          : styles.messageIdle

  const pillState: PillState = serialConnected
    ? 'serial'
    : deviceAvailable
      ? 'dfu'
      : 'none'

  const pillClass =
    pillState === 'serial'
      ? styles.pillSerial
      : pillState === 'dfu'
        ? styles.pillDfu
        : styles.pillNone

  const pillLabel =
    pillState === 'serial'
      ? 'Daisy Seed \u00B7 Serial'
      : pillState === 'dfu'
        ? (deviceLabel ?? (target === 'esp32_s3' ? 'ESP32 \u00B7 Port' : 'Daisy Seed \u00B7 DFU'))
        : 'no device'

  /*
   * "Other board also available" secondary indicator. When the user's
   * chosen target is selected for compile/flash but the OTHER target is
   * ALSO physically plugged in, surface a tiny neutral dot so the user
   * can see it's available without the pill overclaiming. Drives the
   * amber dot in the target dropdown too — here we just light up the
   * pill corner so the StatusBar stays informative.
   */
  const otherAvailable =
    target === 'daisy_seed' ? esp32Available : seedAvailable
  const otherLabel = target === 'daisy_seed' ? 'ESP32' : 'Seed'

  const onPillClick = (ev: MouseEvent<HTMLButtonElement>): void => {
    // Ctrl/Cmd+click re-routes to the build log so developers still have
    // one-click access to the build console without a second glyph.
    if (ev.ctrlKey || ev.metaKey) {
      toggleLogPanel()
      return
    }
    toggleMonitor()
    // Opportunistic refresh so the DFU side stays fresh if the 3s
    // poller hasn't ticked yet.
    void detectDevice()
  }

  // CPU estimate — recomputed whenever `nodes` changes (Zustand selector
  // already handles subscription).
  const cpu = useMemo(() => estimateCpu({ nodes, connections: [], meta }), [nodes, meta])
  const cpuPct = Math.round(cpu * 100)
  const top = useMemo(() => topCostNodes({ nodes, connections: [], meta }, 5), [nodes, meta])

  const cpuFillClass =
    cpu >= 0.85
      ? styles.cpuFillDanger
      : cpu >= 0.6
        ? styles.cpuFillWarn
        : styles.cpuFillOk

  const cpuTooltip = buildCpuTooltip(nodes.length, top)

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <button
          type="button"
          className={`${styles.pill} ${pillClass}`}
          onClick={onPillClick}
          aria-label={`Device: ${pillLabel}. Click toggles serial monitor, Ctrl+click toggles build log.`}
          title={`${pillLabel} \u2014 click: serial monitor, ctrl+click: build log`}
        >
          <svg
            className={styles.pillIcon}
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden
          >
            <rect x="2" y="2" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M0.5 3.5H2M0.5 6.5H2M8 3.5h1.5M8 6.5h1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span>{pillLabel}</span>
        </button>
        {otherAvailable ? (
          <span
            className={styles.alsoDot}
            title={`${otherLabel} also available`}
            aria-label={`${otherLabel} also available`}
          />
        ) : null}
        <span className={`${styles.dot} ${engineDotClass}`} aria-hidden />
        <span className={styles.engineText}>{engineText}</span>
      </div>
      <div className={styles.center}>
        <span>{formatSampleRate(meta.sampleRate)}</span>
        <span className={styles.sep}>{' \u00B7 '}</span>
        <span>{meta.blockSize}sp</span>
      </div>
      <div className={styles.right}>
        <span className={messageClass}>{status.message}</span>
        <div
          className={styles.cpu}
          title={cpuTooltip}
          aria-label={`CPU estimate ${cpuPct}%`}
        >
          <div className={styles.cpuTrack}>
            <div
              className={`${styles.cpuFill} ${cpuFillClass}`}
              style={{ width: `${cpuPct}%` }}
            />
          </div>
          <span className={styles.cpuLabel}>{cpuPct}%</span>
        </div>
      </div>
    </div>
  )
}

function formatSampleRate(sr: number): string {
  if (sr % 1000 === 0) return `${sr / 1000}kHz`
  return `${(sr / 1000).toFixed(1)}kHz`
}

function buildCpuTooltip(
  count: number,
  top: { kind: string; cost: number }[]
): string {
  const header = `CPU estimate \u00B7 ${count} node${count === 1 ? '' : 's'} \u00B7 see docs`
  if (top.length === 0) return header
  const lines = top
    .filter((n) => n.cost > 0)
    .map((n) => {
      const known = n.kind in KIND_COST
      const suffix = known ? '' : ` (fallback ${FALLBACK_COST})`
      return `  ${n.kind}: ${n.cost.toFixed(1)}${suffix}`
    })
  return `${header}\ntop costs:\n${lines.join('\n')}`
}
