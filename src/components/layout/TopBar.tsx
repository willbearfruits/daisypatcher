/**
 * TopBar — app chrome row.
 *
 * Layout: [dot + wordmark · new/open/save · undo/redo]  [file name + dirty dot]  [theme + play]
 *
 * Every icon is a subtle inline SVG sitting at --dp-text-muted, escalating
 * to --dp-text on hover and --dp-text-dim when disabled. No icon library;
 * the Signal Lab aesthetic rewards restraint.
 */

import { useEffect, useRef, useState } from 'react'
import { useTheme } from '@/theme'
import { THEMES } from '@/theme'
import { useEditorStore } from '@/state/store'
import { TARGETS, getTarget, isEsp32Target } from '@/codegen/targets'
import { useCompileStore } from '@/state/compileState'
import { newPatch, openPatch, savePatch } from '@/state/patchFile'
import type { DaisyFlashMode } from '@/types/store'
import type { NodeKind } from '@/types/graph'
import { UpdateBadge, UpdateMenu } from './UpdateBadge'
import { VerificationPanel } from './VerificationPanel'
import { TOGGLE_ASSISTANT_EVENT } from './AssistantPanel'
import { TOGGLE_CODE_PANEL_EVENT } from './CodePanel'
import { TestRigModal } from './TestRigModal'
import { requestConfirm } from './ConfirmDialog'
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

/* Checkmark in a circle — "node verified on hardware" / opens the
   global verification panel. */
function IconVerify() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 8.25l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* Sparkle-in-a-speech-bubble: ask the assistant. */
function IconAssistant() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 5.25v3.5M6.25 7h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/* Braces: the generated source. */
function IconCode() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M5.5 3.5c-1.5 0-2 .75-2 2v1.25c0 .75-.5 1.25-1.25 1.25.75 0 1.25.5 1.25 1.25V10.5c0 1.25.5 2 2 2M10.5 3.5c1.5 0 2 .75 2 2v1.25c0 .75.5 1.25 1.25 1.25-.75 0-1.25.5-1.25 1.25V10.5c0 1.25-.5 2-2 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

/* Transport: play triangle / stop square. */
function IconPlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M5.5 3.5v9L12.5 8L5.5 3.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconStop() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="4.25"
        y="4.25"
        width="7.5"
        height="7.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* Padlock — "target locked by user". Rendered small next to the switcher. */
function IconLock() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="3.5"
        y="7"
        width="9"
        height="6.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 7V5a2.5 2.5 0 015 0v2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
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

  /*
   * Verification panel + test-rig modal live here so the checklist can
   * launch the modal directly from a row's "Test" button without
   * plumbing a ref through the app. The modal is global — only one
   * at a time — so two siblings holding it would never collide.
   */
  const [verificationOpen, setVerificationOpen] = useState(false)
  const [testKind, setTestKind] = useState<NodeKind | null>(null)

  /*
   * The drag region (`-webkit-app-region: drag` in TopBar.module.css)
   * substitutes for the title bar `hiddenInset` removes, but it's just a
   * mouse listener to Chromium — macOS never learns to zoom the window on
   * a second click there the way it would for a real NSWindow title bar.
   * Skip it entirely over interactive descendants so double-clicking a
   * button/tab doesn't ALSO toggle the window size.
   */
  const onRootDoubleClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    if (target.closest('button, input, select, a, [role="tab"], [role="option"]')) return
    void window.daisy.window.titlebarDoubleClick()
  }

  return (
    <div className={styles.root} onDoubleClick={onRootDoubleClick}>
      <div className={styles.left}>
        <span className={styles.dot} aria-hidden />
        <span className={styles.wordmark}>DAISYPATCHER</span>
        <UpdateBadge />
        <span className={styles.divider} aria-hidden />
        <IconButton label="New" onClick={() => void newPatch()}>
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
        <IconButton
          label="Assistant (Ctrl+Shift+K)"
          onClick={() => window.dispatchEvent(new CustomEvent(TOGGLE_ASSISTANT_EVENT))}
        >
          <IconAssistant />
        </IconButton>
        <IconButton
          label="Generated code (Ctrl+Shift+C)"
          onClick={() => window.dispatchEvent(new CustomEvent(TOGGLE_CODE_PANEL_EVENT))}
        >
          <IconCode />
        </IconButton>
        <IconButton
          label="Verification checklist"
          onClick={() => setVerificationOpen(true)}
        >
          <IconVerify />
        </IconButton>
        <ThemePicker skinId={skinId} setSkinId={setSkinId} />
        <FlashModePicker />
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
          {isPlaying ? <IconStop /> : <IconPlay />}
        </button>
      </div>
      <VerificationPanel
        open={verificationOpen}
        onClose={() => setVerificationOpen(false)}
        onRetest={(kind) => {
          setVerificationOpen(false)
          setTestKind(kind)
        }}
      />
      <TestRigModal kind={testKind} onClose={() => setTestKind(null)} />
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
  const target = useEditorStore((s) => s.target)

  const glowing = useGlowPhase(glowUntil)
  const disabled = building || (sdkChecked && !sdkReady)
  // Named for the SELECTED board — this said "Daisy Seed" whatever the
  // top bar had lit, and the flash button next to it already got it right.
  const boardLabel = getTarget(target).label
  const title = !sdkReady && sdkChecked
    ? isEsp32Target(target)
      ? 'PlatformIO not installed \u2014 click the board status dot to install'
      : 'Daisy SDK not installed \u2014 click the board status dot to install'
    : building
      ? `Compiling for ${boardLabel}\u2026`
      : `Compile patch for ${boardLabel} (Ctrl+Enter)`

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
  const flashArmed = useCompileStore((s) => s.flashArmed)
  const deviceAvailable = useCompileStore((s) => s.deviceAvailable)
  const seedRunningPort = useCompileStore((s) => s.seedRunningPort)
  const lastBuildSuccess = useCompileStore((s) => s.lastBuildSuccess)
  const lastFlashSuccess = useCompileStore((s) => s.lastFlashSuccess)
  const glowUntil = useCompileStore((s) => s.lastFlashUntilMs)
  const flash = useCompileStore((s) => s.flash)
  const cancelArm = useCompileStore((s) => s.cancelArm)
  const target = useEditorStore((s) => s.target)

  const glowing = useGlowPhase(glowUntil)
  // Daisy is always clickable once a build exists: no DFU just means the
  // click ARMS (poll for the bootloader, auto-flash on sight). ESP32
  // still needs its serial port up front \u2014 esptool flashes immediately.
  const disabled =
    flashing ||
    lastBuildSuccess !== true ||
    (!deviceAvailable && target !== 'daisy_seed')

  // The tooltip is the pre-flight readout: say exactly WHY flashing is
  // blocked (or what a click will do), not just that it is.
  const title = flashing
    ? 'Flashing\u2026'
    : flashArmed
      ? 'Waiting for RESET tap\u2026 click to cancel'
      : lastBuildSuccess !== true
        ? 'Compile successfully before flashing'
        : !deviceAvailable
          ? target === 'daisy_seed'
            ? seedRunningPort
              ? 'Click to arm, then tap RESET \u2014 flashes the moment the bootloader appears'
              : 'Click to arm \u2014 connect the Seed and tap RESET; flashes when DFU appears'
            : 'No ESP32 serial port detected \u2014 check cable/driver'
          : `Flash binary to ${getTarget(target).label}`

  const glowClass =
    glowing && lastFlashSuccess === true
      ? styles.glowSuccess
      : glowing && lastFlashSuccess === false
        ? styles.glowDanger
        : ''

  return (
    <button
      type="button"
      className={`${styles.bigBtn} ${styles.flashBtn} ${flashing ? styles.busyFlash : ''} ${flashArmed ? styles.armedFlash : ''} ${glowClass}`}
      onClick={() => (flashArmed ? cancelArm() : void flash())}
      disabled={disabled}
      aria-label={flashArmed ? 'Cancel armed flash' : 'Flash'}
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
 * Segmented toggle between Patch, Hardware and Perform views. Sits in the
 * TopBar's center slot to the left of the file name. 2px accent underline
 * marks the active segment — deliberately spare so it reads as status, not
 * navigation.
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
      <button
        type="button"
        role="tab"
        aria-selected={view === 'perform'}
        className={`${styles.viewSeg} ${view === 'perform' ? styles.viewSegActive : ''}`}
        onClick={() => setView('perform')}
      >
        PERFORM
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
 * A second tiny padlock indicator appears directly next to whichever
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

  /*
   * Dot logic: null when no useful signal, 'match' (green) when detect
   * agrees, 'mismatch' (amber) when detect disagrees but the user has
   * locked the target (so we're nudging, not overriding).
   *
   * Compared by FAMILY, not by exact id. An S3 DevKitC, an S3 SuperMini
   * and a C3 SuperMini all enumerate as USB 303a:1001, so detection can
   * only ever tell us "an ESP32 is plugged in". Comparing exact ids would
   * light the amber mismatch dot permanently for two of the three boards
   * and offer to "switch" the user to a board we can't actually identify.
   */
  const dotState: 'match' | 'mismatch' | null =
    detectedBoard === null
      ? null
      : isEsp32Target(detectedBoard) === isEsp32Target(target)
        ? 'match'
        : targetLockedByUser
          ? 'mismatch'
          : null

  const onDotClick = async (): Promise<void> => {
    if (dotState !== 'mismatch' || detectedBoard === null) return
    const label = detectedBoard === 'daisy_seed' ? 'Seed' : 'ESP32'
    const ok = await requestConfirm({
      title: 'Switch target',
      message: `A ${label} is connected. Switch target?`,
      confirmLabel: 'Switch'
    })
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
      {/*
        Driven off the TARGETS registry rather than hand-written buttons —
        adding a board should not require touching the TopBar. Each backend
        already carries the label and description this needs.
      */}
      {Object.values(TARGETS).map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={target === t.id}
          className={`${styles.viewSeg} ${styles.targetSeg} ${target === t.id ? styles.viewSegActive : ''}`}
          onClick={() => choose(t.id)}
          title={t.description}
        >
          {t.shortLabel}
        </button>
      ))}
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
          <IconLock />
        </button>
      ) : null}
    </div>
  )
}

/* ---------- theme picker ----------
 *
 * Custom popover menu replacing the native <select> — the OS dropdown was
 * the one piece of chrome the theme system couldn't style. Interaction
 * model mirrors the StatusBar's DevicePopover: click-outside + Esc close.
 * Each row previews the skin with three swatches (bg / accent / audio
 * signal) pulled straight from the Skin object — data-driven, so this is
 * not a hardcoded-color violation.
 *
 * Keyboard: ArrowUp/ArrowDown move focus through the options (wrapping),
 * Enter/Space select, Esc closes and returns focus to the trigger.
 */
function ThemePicker({
  skinId,
  setSkinId
}: {
  skinId: string
  setSkinId: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const entries = Object.entries(THEMES)
  const current = THEMES[skinId] ?? entries[0]?.[1]

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  // Click-outside + Esc — same pattern as StatusBar's DevicePopover.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onDoc = (e: Event): void => {
      const node = wrapRef.current
      const t = e.target as Node | null
      if (node && t && !node.contains(t)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    // Defer attach so the click that opened the menu doesn't close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open])

  // Focus the active option when the menu opens.
  useEffect(() => {
    if (!open) return
    const idx = Math.max(0, Object.keys(THEMES).indexOf(skinId))
    itemRefs.current[idx]?.focus()
    // Only on open — arrow keys own focus afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const active = itemRefs.current.findIndex((el) => el === document.activeElement)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = (active + delta + entries.length) % entries.length
      itemRefs.current[next]?.focus()
      return
    }
    // Keep Enter/Space away from the global keybinding layer (space is
    // the transport toggle) — the focused option button handles them.
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
    }
  }

  return (
    <div className={styles.themeWrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.themeBtn}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Theme"
        title="Theme"
      >
        <span>{current?.name ?? 'Theme'}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div
          className={styles.themeMenu}
          role="listbox"
          aria-label="Theme"
          onKeyDown={onMenuKeyDown}
        >
          {entries.map(([id, skin], i) => (
            <button
              key={id}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              type="button"
              role="option"
              aria-selected={id === skinId}
              className={`${styles.themeItem} ${id === skinId ? styles.themeItemActive : ''}`}
              onClick={() => {
                setSkinId(id)
                close(true)
              }}
              title={skin.description}
            >
              <span className={styles.themeSwatches} aria-hidden>
                <span className={styles.themeSwatch} style={{ background: skin.bg }} />
                <span className={styles.themeSwatch} style={{ background: skin.accent }} />
                <span className={styles.themeSwatch} style={{ background: skin.signal.audio }} />
              </span>
              <span className={styles.themeName}>{skin.name}</span>
            </button>
          ))}
        </div>
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

/* ---------- flash-mode picker ----------
 *
 * Daisy-only segmented control. Sets `daisyFlashMode` in the editor
 * store which drives BOTH the generated Makefile's `APP_TYPE` AND the
 * DFU target address. Hidden when the target is ESP32. Shares the
 * `.viewSwitch` scaffolding so it reads as a sibling of the PATCH /
 * HARDWARE + SEED / ESP32 segmented controls.
 *
 * Bootloader warning: if the user picks 'internal' while the detected
 * DfuSe interface name looks like the Daisy Bootloader ("Flash "), a
 * one-shot toast fires through `setStatus`. Persistent warnings would
 * be nag-ware; a single advisory is enough.
 */
const FLASH_MODE_META: Record<DaisyFlashMode, { label: string; tip: string }> = {
  internal: {
    label: 'INT',
    tip:
      'Internal flash @ 0x08000000 (128 KB) \u2014 requires system DFU on a Seed without the Daisy Bootloader.'
  },
  qspi: {
    label: 'QSPI',
    tip:
      'QSPI flash @ 0x90040000 (8 MB) \u2014 default for factory Daisy Seeds with the Daisy Bootloader.'
  },
  sram: {
    label: 'SRAM',
    tip: 'SRAM @ 0x24000000 (512 KB) \u2014 fast iterate; app is volatile across reboots.'
  }
}

function FlashModePicker() {
  const target = useEditorStore((s) => s.target)
  const mode = useEditorStore((s) => s.daisyFlashMode)
  const setMode = useEditorStore((s) => s.setDaisyFlashMode)
  const setStatus = useEditorStore((s) => s.setStatus)
  const deviceDetails = useCompileStore((s) => s.deviceDetails)
  const warnedRef = useRef(false)

  if (target !== 'daisy_seed') return null

  const choose = (next: DaisyFlashMode): void => {
    if (next === mode) return
    setMode(next)
    // One-shot advisory: if user picks INT while the Daisy Bootloader
    // appears to be installed, surface a status-line warning so they
    // aren't surprised when the flash fails with "not writeable".
    if (next === 'internal' && !warnedRef.current) {
      const dfuse = (deviceDetails ?? [])
        .find((d) => d.kind === 'dfu' && d.dfuseInterfaceName)?.dfuseInterfaceName
      if (dfuse && /^flash\s*$/i.test(dfuse)) {
        warnedRef.current = true
        setStatus({
          kind: 'warn',
          message:
            'Daisy Bootloader detected \u2014 internal mode will fail unless the Seed is in system DFU.'
        })
      }
    }
  }

  const modes: DaisyFlashMode[] = ['internal', 'qspi', 'sram']

  return (
    <div className={styles.viewSwitch} role="tablist" aria-label="Flash mode">
      <span className={styles.flashModeTag}>FLASH</span>
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          className={`${styles.viewSeg} ${mode === m ? styles.viewSegActive : ''}`}
          onClick={() => choose(m)}
          title={FLASH_MODE_META[m].tip}
        >
          {FLASH_MODE_META[m].label}
        </button>
      ))}
    </div>
  )
}
