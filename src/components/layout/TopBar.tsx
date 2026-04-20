/**
 * TopBar — app chrome row.
 *
 * Layout: [dot + wordmark · new/open/save · undo/redo]  [file name + dirty dot]  [theme + play]
 *
 * Every icon is a subtle inline SVG sitting at --dp-text-muted, escalating
 * to --dp-text on hover and --dp-text-dim when disabled. No icon library;
 * the Signal Lab aesthetic rewards restraint.
 */

import { useEffect, useState } from 'react'
import { useTheme } from '@/theme'
import { THEMES } from '@/theme'
import { useEditorStore } from '@/state/store'
import { useCompileStore } from '@/state/compileState'
import { newPatch, openPatch, savePatch } from '@/state/patchFile'
import { UpdateBadge, UpdateMenu } from './UpdateBadge'
import styles from './TopBar.module.css'

/* ---------- inline 16x16 icons ---------- */

function IconNew() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 1.5h6l3 3V14a0.5 0.5 0 01-.5.5h-8.5A0.5 0.5 0 012.5 14V2A0.5 0.5 0 013 1.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M9 1.5v3h3" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M7.5 7v4M5.5 9h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  )
}

function IconOpen() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M1.5 4.5A1 1 0 012.5 3.5h3l1.5 1.5h5.5a1 1 0 011 1V12a1 1 0 01-1 1h-10a1 1 0 01-1-1V4.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
    </svg>
  )
}

function IconSave() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 2.5h9L13.5 4.5v9a0.5 0.5 0 01-.5.5H3a0.5 0.5 0 01-.5-.5v-11z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M4.5 2.5V6h7V2.5" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
      <rect x="5" y="9" width="6" height="4" stroke="currentColor" strokeWidth="1"/>
    </svg>
  )
}

function IconUndo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M6 5L2.5 8L6 11" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round"/>
      <path d="M2.5 8h7a4 4 0 014 4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none"/>
    </svg>
  )
}

function IconRedo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M10 5L13.5 8L10 11" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round"/>
      <path d="M13.5 8h-7a4 4 0 00-4 4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none"/>
    </svg>
  )
}

/* Chip-with-down-arrow: "compile & stage for chip". */
function IconCompile() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="4" y="7" width="8" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M2.5 9.5H4M2.5 11.5H4M12 9.5h1.5M12 11.5h1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M8 1.5v4.5M6 4l2 2 2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

/* Lightning: "send over the wire". */
function IconFlash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M9 1.5L3 9h4l-1 5.5L13 7H9l1-5.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  )
}

/* Tiny rotating ring used as the "busy" indicator overlaid on the button. */
function BusyRing() {
  return (
    <svg
      className={styles.busyRing}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
    >
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M17 10a7 7 0 00-7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/* ---------- component ---------- */

export function TopBar() {
  const { skinId, setSkinId } = useTheme()
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const setPlaying = useEditorStore((s) => s.setPlaying)
  const pastLen = useEditorStore((s) => s.history.past.length)
  const futureLen = useEditorStore((s) => s.history.future.length)
  const graphName = useEditorStore((s) => s.graph.meta.name)
  const isDirty = useEditorStore((s) => s.isDirty)

  const canUndo = pastLen > 0
  const canRedo = futureLen > 0

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <span className={styles.dot} aria-hidden />
        <span className={styles.wordmark}>DAISYPATCHER</span>
        <UpdateBadge />
        <span className={styles.divider} aria-hidden />
        <IconButton label="New" onClick={() => newPatch()}>
          <IconNew />
        </IconButton>
        <IconButton label="Open" onClick={() => void openPatch()}>
          <IconOpen />
        </IconButton>
        <IconButton label="Save" onClick={() => void savePatch()}>
          <IconSave />
        </IconButton>
        <span className={styles.divider} aria-hidden />
        <IconButton
          label="Undo"
          disabled={!canUndo}
          onClick={() => useEditorStore.getState().undo()}
        >
          <IconUndo />
        </IconButton>
        <IconButton
          label="Redo"
          disabled={!canRedo}
          onClick={() => useEditorStore.getState().redo()}
        >
          <IconRedo />
        </IconButton>
      </div>

      <div className={styles.center}>
        <ViewSwitcher />
        <TargetSwitcher />
        <span className={styles.filename}>
          {graphName || 'untitled'}
          {isDirty ? <span className={styles.dirty} aria-label="unsaved changes" /> : null}
        </span>
      </div>

      <div className={styles.right}>
        <UpdateMenu />
        <select
          className={styles.select}
          value={skinId}
          onChange={(e) => setSkinId(e.target.value)}
          aria-label="Theme"
        >
          {Object.entries(THEMES).map(([id, skin]) => (
            <option key={id} value={id}>
              {skin.name}
            </option>
          ))}
        </select>
        <span className={styles.divider} aria-hidden />
        <CompileButton />
        <FlashButton />
        <span className={styles.divider} aria-hidden />
        <button
          type="button"
          className={`${styles.play} ${isPlaying ? styles.playActive : ''}`}
          onClick={() => setPlaying(!isPlaying)}
          aria-label={isPlaying ? 'Stop' : 'Play'}
          title={isPlaying ? 'Stop' : 'Play'}
        >
          {isPlaying ? '\u25A0' : '\u25B6'}
        </button>
      </div>
    </div>
  )
}

/* ---------- compile / flash buttons ----------
 *
 * Big-mood buttons — these are the payoff of the whole app so they're
 * deliberately chunky (32x32) and sit inside their own visual frame.
 * State visualisation:
 *   - idle:     muted border
 *   - busy:     pulsing --dp-signal-cv (compile) / --dp-signal-gate (flash)
 *               plus the rotating BusyRing overlay
 *   - success:  --dp-success glow for 1500ms
 *   - failure:  --dp-danger glow for 1500ms
 */

function useGlowPhase(untilMs: number | null): boolean {
  const [active, setActive] = useState(() => untilMs !== null && untilMs > Date.now())
  useEffect(() => {
    if (untilMs === null) {
      setActive(false)
      return
    }
    const remain = untilMs - Date.now()
    if (remain <= 0) {
      setActive(false)
      return
    }
    setActive(true)
    const t = setTimeout(() => setActive(false), remain)
    return () => clearTimeout(t)
  }, [untilMs])
  return active
}

function CompileButton() {
  const building = useCompileStore((s) => s.building)
  const lastSuccess = useCompileStore((s) => s.lastBuildSuccess)
  const glowUntil = useCompileStore((s) => s.lastBuildFlashUntilMs)
  const sdkReady = useCompileStore((s) => s.sdkReady)
  const sdkChecked = useCompileStore((s) => s.sdkChecked)
  const build = useCompileStore((s) => s.build)

  const glowing = useGlowPhase(glowUntil)
  const disabled = building || (sdkChecked && !sdkReady)
  const title = !sdkReady && sdkChecked
    ? 'SDK not installed \u2014 install via settings menu'
    : building
      ? 'Compiling\u2026'
      : 'Compile patch for Daisy Seed'

  const glowClass =
    glowing && lastSuccess === true
      ? styles.glowSuccess
      : glowing && lastSuccess === false
        ? styles.glowDanger
        : ''

  return (
    <button
      type="button"
      className={`${styles.bigBtn} ${styles.compileBtn} ${building ? styles.busyCompile : ''} ${glowClass}`}
      onClick={() => void build()}
      disabled={disabled}
      aria-label="Compile"
      aria-busy={building || undefined}
      title={title}
    >
      <span className={styles.bigBtnIcon}>
        <IconCompile />
      </span>
      {building ? <BusyRing /> : null}
    </button>
  )
}

function FlashButton() {
  const flashing = useCompileStore((s) => s.flashing)
  const deviceAvailable = useCompileStore((s) => s.deviceAvailable)
  const lastBuildSuccess = useCompileStore((s) => s.lastBuildSuccess)
  const lastFlashSuccess = useCompileStore((s) => s.lastFlashSuccess)
  const glowUntil = useCompileStore((s) => s.lastFlashUntilMs)
  const flash = useCompileStore((s) => s.flash)

  const glowing = useGlowPhase(glowUntil)
  const disabled = flashing || !deviceAvailable || lastBuildSuccess !== true

  const title = flashing
    ? 'Flashing\u2026'
    : !deviceAvailable
      ? 'No Daisy Seed in DFU mode detected'
      : lastBuildSuccess !== true
        ? 'Compile successfully before flashing'
        : 'Flash binary to Daisy Seed'

  const glowClass =
    glowing && lastFlashSuccess === true
      ? styles.glowSuccess
      : glowing && lastFlashSuccess === false
        ? styles.glowDanger
        : ''

  return (
    <button
      type="button"
      className={`${styles.bigBtn} ${styles.flashBtn} ${flashing ? styles.busyFlash : ''} ${glowClass}`}
      onClick={() => void flash()}
      disabled={disabled}
      aria-label="Flash"
      aria-busy={flashing || undefined}
      title={title}
    >
      <span className={styles.bigBtnIcon}>
        <IconFlash />
      </span>
      {flashing ? <BusyRing /> : null}
    </button>
  )
}

interface IconButtonProps {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}

/* ---------- view switcher ---------- */

/**
 * Segmented toggle between Patch and Hardware views. Sits in the TopBar's
 * center slot to the left of the file name. 2px accent underline marks the
 * active segment — deliberately spare so it reads as status, not navigation.
 */
function ViewSwitcher() {
  const view = useEditorStore((s) => s.view)
  const setView = useEditorStore((s) => s.setView)
  return (
    <div className={styles.viewSwitch} role="tablist" aria-label="View">
      <button
        type="button"
        role="tab"
        aria-selected={view === 'patch'}
        className={`${styles.viewSeg} ${view === 'patch' ? styles.viewSegActive : ''}`}
        onClick={() => setView('patch')}
      >
        PATCH
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'hardware'}
        className={`${styles.viewSeg} ${view === 'hardware' ? styles.viewSegActive : ''}`}
        onClick={() => setView('hardware')}
      >
        HARDWARE
      </button>
    </div>
  )
}

/**
 * TargetSwitcher — compact segmented control for the compile target.
 * Sits to the right of the PATCH/HARDWARE view toggle. Re-uses the
 * same `.viewSwitch` styling so it feels like a sibling, differentiated
 * only by being in mono + uppercase.
 *
 * Autodetect affordance (one adjacent dot):
 *   - green dot: detected board matches the current target.
 *   - amber dot: detected board differs AND the user has locked the
 *                target. Clicking asks whether to switch; accepting
 *                releases the lock and applies autodetect.
 *   - no dot:    nothing detected, or detection is ambiguous.
 *
 * A second tiny "●" lock indicator appears directly next to whichever
 * segment is active when `targetLockedByUser` is true. Clicking it
 * releases the lock so the next autodetect tick can apply.
 */
function TargetSwitcher() {
  const target = useEditorStore((s) => s.target)
  const setTarget = useEditorStore((s) => s.setTarget)
  const autoSetTarget = useEditorStore((s) => s.autoSetTarget)
  const releaseTargetLock = useEditorStore((s) => s.releaseTargetLock)
  const targetLockedByUser = useEditorStore((s) => s.targetLockedByUser)
  const detectedBoard = useEditorStore((s) => s.detectedBoard)
  const refreshSdkStatus = useCompileStore((s) => s.refreshSdkStatus)
  const detectDevice = useCompileStore((s) => s.detectDevice)

  const choose = (t: typeof target): void => {
    if (t === target) return
    setTarget(t)
    void refreshSdkStatus()
    void detectDevice()
  }

  // Dot logic: null when no useful signal, 'match' (green) when detect
  // agrees, 'mismatch' (amber) when detect disagrees but the user has
  // locked the target (so we're nudging, not overriding).
  const dotState: 'match' | 'mismatch' | null =
    detectedBoard === null
      ? null
      : detectedBoard === target
        ? 'match'
        : targetLockedByUser
          ? 'mismatch'
          : null

  const onDotClick = (): void => {
    if (dotState !== 'mismatch' || detectedBoard === null) return
    const label = detectedBoard === 'daisy_seed' ? 'Seed' : 'ESP32'
    const ok = window.confirm(`A ${label} is connected. Switch target?`)
    if (!ok) return
    releaseTargetLock()
    autoSetTarget(detectedBoard)
    void refreshSdkStatus()
    void detectDevice()
  }

  const onLockClick = (): void => {
    releaseTargetLock()
  }

  const dotTitle =
    dotState === 'match'
      ? 'Autodetect: this target is plugged in'
      : dotState === 'mismatch'
        ? `Autodetect: a ${detectedBoard === 'daisy_seed' ? 'Seed' : 'ESP32'} is plugged in — click to switch`
        : ''

  return (
    <div className={styles.viewSwitch} role="tablist" aria-label="Target">
      <button
        type="button"
        role="tab"
        aria-selected={target === 'daisy_seed'}
        className={`${styles.viewSeg} ${target === 'daisy_seed' ? styles.viewSegActive : ''}`}
        onClick={() => choose('daisy_seed')}
        title="Daisy Seed (STM32H7)"
      >
        SEED
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={target === 'esp32_s3'}
        className={`${styles.viewSeg} ${target === 'esp32_s3' ? styles.viewSegActive : ''}`}
        onClick={() => choose('esp32_s3')}
        title="ESP32-S3 DevKitC-1 (Arduino / PlatformIO)"
      >
        ESP32
      </button>
      {dotState !== null ? (
        <button
          type="button"
          className={`${styles.targetDot} ${dotState === 'match' ? styles.targetDotMatch : styles.targetDotMismatch}`}
          onClick={onDotClick}
          aria-label={dotTitle}
          title={dotTitle}
        />
      ) : null}
      {targetLockedByUser ? (
        <button
          type="button"
          className={styles.targetLockDot}
          onClick={onLockClick}
          aria-label="Target locked by user \u2014 click to release and re-apply autodetect"
          title="Target locked \u2014 click to release"
        >
          {'\u25CF'}
        </button>
      ) : null}
    </div>
  )
}

function IconButton({ label, onClick, disabled, children }: IconButtonProps) {
  return (
    <button
      type="button"
      className={styles.iconBtn}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}
