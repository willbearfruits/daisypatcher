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

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useEditorStore } from '@/state/store'
import { useCompileStore, type DeviceDetail } from '@/state/compileState'
import { useSerialStore, BAUD_RATES } from '@/state/serialState'
import { estimateCpu, topCostNodes, KIND_COST, FALLBACK_COST } from '@/state/cpuBudget'
import type { DaisyFlashMode } from '@/types/store'
import styles from './StatusBar.module.css'

/**
 * Daisy-only flash address map — kept local to the status bar so the
 * popover can display "Target addr: 0x..." in sync with the picker.
 */
const DAISY_FLASH_ADDRS: Record<DaisyFlashMode, string> = {
  internal: '0x08000000',
  qspi: '0x90040000',
  sram: '0x24000000'
}

const FLASH_MODE_LABEL: Record<DaisyFlashMode, string> = {
  internal: 'Internal',
  qspi: 'QSPI',
  sram: 'SRAM'
}

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

  /*
   * Click model:
   *   - single click        toggles the device-info popover
   *   - double-click        toggles the serial monitor (legacy muscle
   *                         memory for power users)
   *   - ctrl/cmd + click    toggles the build log (unchanged)
   *
   * The popover doubles as the full "device details" view AND the flash
   * mode picker, so one click gets a user everything they need about
   * the connected board.
   */
  const [popoverOpen, setPopoverOpen] = useState(false)
  const onPillClick = (ev: MouseEvent<HTMLButtonElement>): void => {
    if (ev.ctrlKey || ev.metaKey) {
      toggleLogPanel()
      return
    }
    if (ev.detail >= 2) {
      toggleMonitor()
      return
    }
    setPopoverOpen((v) => !v)
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
        <div className={styles.pillWrap}>
        <button
          type="button"
          className={`${styles.pill} ${pillClass}`}
          onClick={onPillClick}
          aria-label={`Device: ${pillLabel}. Click to open details, double-click toggles serial monitor, Ctrl+click toggles build log.`}
          title={`${pillLabel} \u2014 click: details, double-click: serial monitor, ctrl+click: build log`}
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
        {popoverOpen ? (
          <DevicePopover onClose={() => setPopoverOpen(false)} />
        ) : null}
        </div>
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

/* ---------- device popover ----------
 *
 * Anchored above the device pill (pill lives at the bottom of the window,
 * popover grows upward). Renders the full dfu-util / serialport detail
 * the user would otherwise have to hunt for in a terminal. Also doubles
 * as the canonical UI for the Daisy flash-mode picker — mirrors the
 * TopBar segmented control through the SAME store field so the two
 * surfaces never disagree.
 *
 * Interaction:
 *   - Esc / ✕ / click-outside all close it.
 *   - Buttons at the bottom re-open the serial monitor / build log for
 *     people who prefer clicking over keyboard shortcuts.
 */
function DevicePopover({ onClose }: { onClose: () => void }) {
  const target = useEditorStore((s) => s.target)
  const daisyFlashMode = useEditorStore((s) => s.daisyFlashMode)
  const setDaisyFlashMode = useEditorStore((s) => s.setDaisyFlashMode)
  const deviceDetails = useCompileStore((s) => s.deviceDetails)
  const toggleMonitor = useSerialStore((s) => s.toggleMonitor)
  const baud = useSerialStore((s) => s.baud)
  const setBaud = useSerialStore((s) => s.setBaud)
  const openLogPanel = useCompileStore((s) => s.openLogPanel)

  const ref = useRef<HTMLDivElement | null>(null)

  // Close-on-Esc and close-on-click-outside. We bind on mount and tear
  // down on unmount so only the currently-open popover reacts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDoc = (e: Event): void => {
      const node = ref.current
      if (!node) return
      const t = e.target as Node | null
      if (t && !node.contains(t)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // Defer attach so the click that opened the popover doesn't
    // immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [onClose])

  const dfuDevices = (deviceDetails ?? []).filter((d) => d.kind === 'dfu')
  const serialDevices = (deviceDetails ?? []).filter((d) => d.kind === 'serial')

  const firstDfu: DeviceDetail | undefined = dfuDevices[0]
  const bootloader = describeBootloader(firstDfu?.dfuseInterfaceName, firstDfu?.altName)
  const title = target === 'esp32_s3' ? 'ESP32-S3' : 'DAISY SEED'

  return (
    <div
      ref={ref}
      className={styles.popover}
      role="dialog"
      aria-label={`${title} device details`}
    >
      <div className={styles.popoverHeader}>
        <span>{title}</span>
        <button
          type="button"
          className={styles.popoverClose}
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          {'\u2715'}
        </button>
      </div>

      <div className={styles.popoverBody}>
        {target === 'daisy_seed' ? (
          <>
            <Row label="Bootloader" value={bootloader} />
            {firstDfu ? (
              <>
                <Row label="Device ID" value={firstDfu.busId ?? '\u2014'} />
                <Row label="Serial" value={firstDfu.serial ?? '\u2014'} />
                <Row label="USB path" value={firstDfu.path ?? '\u2014'} />
                {dfuDevices.map((d, idx) => (
                  <Row
                    key={`alt-${idx}`}
                    label={`Alt ${d.alt ?? idx}`}
                    value={d.altName ?? '\u2014'}
                    mono
                  />
                ))}
                <Row label="DFU ver" value={firstDfu.bcdDevice ?? '\u2014'} />
              </>
            ) : (
              <Row label="Status" value="no DFU device detected" dim />
            )}

            <div className={styles.popoverDivider} />

            <div className={styles.popoverModeRow}>
              <span className={styles.popoverLabel}>Flash mode</span>
              <select
                className={styles.popoverSelect}
                value={daisyFlashMode}
                onChange={(e) => setDaisyFlashMode(e.target.value as DaisyFlashMode)}
                aria-label="Flash mode"
              >
                <option value="internal">Internal (0x08000000)</option>
                <option value="qspi">QSPI (0x90040000)</option>
                <option value="sram">SRAM (0x24000000)</option>
              </select>
            </div>
            <Row label="Target addr" value={DAISY_FLASH_ADDRS[daisyFlashMode]} />
            <Row label="Mode" value={FLASH_MODE_LABEL[daisyFlashMode]} dim />
          </>
        ) : (
          <Esp32Popover
            serialDevices={serialDevices}
            baud={baud}
            setBaud={setBaud}
          />
        )}

        {serialDevices.length > 0 && target === 'daisy_seed' ? (
          <>
            <div className={styles.popoverDivider} />
            <div className={styles.popoverLabel}>Serial ports seen:</div>
            {serialDevices.map((d, idx) => (
              <div key={`s-${idx}`} className={styles.popoverSerialRow}>
                <span className={styles.popoverSerialPath}>{d.portPath ?? '\u2014'}</span>
                <span className={styles.popoverSerialMeta}>
                  {d.manufacturer ?? '\u2014'}
                  {d.vendorId && d.productId
                    ? ` ${d.vendorId.toLowerCase()}:${d.productId.toLowerCase()}`
                    : ''}
                </span>
              </div>
            ))}
          </>
        ) : null}
      </div>

      <div className={styles.popoverActions}>
        <button
          type="button"
          className={styles.popoverAction}
          onClick={() => {
            toggleMonitor()
            onClose()
          }}
        >
          Serial monitor
        </button>
        <button
          type="button"
          className={styles.popoverAction}
          onClick={() => {
            openLogPanel()
            onClose()
          }}
        >
          Build log
        </button>
      </div>
    </div>
  )
}

function Esp32Popover({
  serialDevices,
  baud,
  setBaud
}: {
  serialDevices: DeviceDetail[]
  baud: number
  setBaud: (b: number) => void
}) {
  const first = serialDevices[0]
  const vidPid =
    first?.vendorId && first.productId
      ? `${first.vendorId.toLowerCase()}:${first.productId.toLowerCase()}`
      : '\u2014'
  const kind = describeEsp32Kind(first?.vendorId, first?.productId)
  return (
    <>
      <Row label="Port" value={first?.portPath ?? 'no port detected'} />
      <Row label="VID:PID" value={vidPid} />
      <Row label="Adapter" value={kind} dim />
      <div className={styles.popoverDivider} />
      <div className={styles.popoverModeRow}>
        <span className={styles.popoverLabel}>Baud</span>
        <select
          className={styles.popoverSelect}
          value={baud}
          onChange={(e) => setBaud(parseInt(e.target.value, 10))}
          aria-label="Baud rate"
        >
          {BAUD_RATES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}

function Row({
  label,
  value,
  mono,
  dim
}: {
  label: string
  value: string
  mono?: boolean
  dim?: boolean
}) {
  const valueClass = [
    styles.popoverValue,
    mono ? styles.popoverValueMono : '',
    dim ? styles.popoverValueDim : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={styles.popoverRow}>
      <span className={styles.popoverLabel}>{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  )
}

/**
 * Map the DfuSe interface name (+ altName as a fallback) to a readable
 * bootloader identity. "Flash " is the Electro-Smith Daisy Bootloader's
 * signature; "Internal Flash" is STMicro's system bootloader. If the
 * string isn't recognised we surface it raw so the user isn't left
 * guessing.
 */
function describeBootloader(
  dfuse: string | undefined,
  altName: string | undefined
): string {
  if (!dfuse && !altName) return 'unknown'
  // "Flash " (trailing space on purpose) — libDaisy's bootloader.
  if (dfuse && /^flash\s*$/i.test(dfuse)) {
    // altName for the Daisy bootloader includes the QSPI region layout,
    // which we can surface as a version hint when present.
    if (altName && /\/0x90000000/.test(altName)) {
      return 'Daisy Bootloader (QSPI layout detected)'
    }
    return 'Daisy Bootloader'
  }
  if (dfuse && /internal flash/i.test(dfuse)) {
    return 'System (STMicro)'
  }
  return `unknown: "${dfuse ?? altName}"`
}

function describeEsp32Kind(vid: string | undefined, pid: string | undefined): string {
  const key = vid && pid ? `${vid.toLowerCase()}:${pid.toLowerCase()}` : ''
  if (key === '303a:1001') return 'Espressif native USB (S3)'
  if (key === '1a86:7523') return 'WCH CH340 UART bridge'
  if (key === '10c4:ea60') return 'Silicon Labs CP210x UART bridge'
  return '\u2014'
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
