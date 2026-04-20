/**
 * UpdateBadge — subtle "update available" indicator for the TopBar.
 *
 * Three visible states drive the coloured dot:
 *   - available:   green  → click opens popover with release notes + Download
 *   - downloading: cyan   → click opens popover with progress bar
 *   - downloaded:  amber  → click opens popover with "Restart now" CTA
 *
 * In any other state (idle / checking / none / error) the badge itself is
 * NOT rendered — we don't want to clutter the TopBar chrome when there's
 * nothing to say. The sibling `UpdateMenu` (rendered by the same module
 * below) gives the user a way to trigger a manual check at any time.
 *
 * Dismissal: when the user clicks "Dismiss" on the available-popover we
 * hide the badge for the rest of the session. A genuine new release
 * (status=available with a new version) will re-show it because the
 * store resets `dismissed` on each status event.
 */

import { useEffect, useRef, useState } from 'react'
import { useUpdateStore } from '@/state/updateState'
import styles from './UpdateBadge.module.css'

/* ---------- icons ---------- */

/** Down-arrow-into-tray icon — the universal "incoming download" glyph. */
function IconUpdate() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2v7M5 6.5L8 9.5l3-3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2.5 11v2a0.5 0.5 0 00.5.5h10a0.5 0.5 0 00.5-.5v-2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

/** Gear icon for the manual check affordance. */
function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1"/>
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4"
            stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  )
}

/* ---------- click-outside hook ---------- */

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    // Use `mousedown` so the popover closes before the click lands on
    // whatever is underneath — prevents double-interactions.
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [ref, onOutside, active])
}

/* ---------- badge + popover ---------- */

export function UpdateBadge() {
  const state = useUpdateStore((s) => s.state)
  const dismissed = useUpdateStore((s) => s.dismissed)
  const percent = useUpdateStore((s) => s.percent)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useClickOutside(rootRef, () => setOpen(false), open)

  // Don't render anything when there's no update-relevant state. The manual
  // check button (UpdateMenu) lives as a sibling so it's always available.
  const visible =
    (state === 'available' || state === 'downloading' || state === 'downloaded') && !dismissed

  if (!visible) return null

  const dotClass =
    state === 'available'
      ? styles.dotAvailable
      : state === 'downloading'
        ? styles.dotDownloading
        : styles.dotDownloaded

  const tooltip =
    state === 'available'
      ? 'Update available'
      : state === 'downloading'
        ? `Downloading update (${Math.round(percent)}%)`
        : 'Update ready — restart to install'

  return (
    <div className={styles.wrap} ref={rootRef}>
      <button
        type="button"
        className={styles.badge}
        onClick={() => setOpen((v) => !v)}
        aria-label={tooltip}
        title={tooltip}
      >
        <IconUpdate />
        <span className={`${styles.dot} ${dotClass}`} aria-hidden />
      </button>
      {open ? <UpdatePopover onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

/* ---------- popover body ---------- */

function UpdatePopover({ onClose }: { onClose: () => void }) {
  const state = useUpdateStore((s) => s.state)
  const version = useUpdateStore((s) => s.version)
  const currentVersion = useUpdateStore((s) => s.currentVersion)
  const releaseNotes = useUpdateStore((s) => s.releaseNotes)
  const percent = useUpdateStore((s) => s.percent)
  const error = useUpdateStore((s) => s.error)

  const download = useUpdateStore((s) => s.download)
  const install = useUpdateStore((s) => s.installAndRestart)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const check = useUpdateStore((s) => s.check)

  const [notesExpanded, setNotesExpanded] = useState(false)

  const title =
    state === 'error'
      ? 'Update check failed'
      : version
        ? `Version ${version} available`
        : 'Update'

  return (
    <div className={styles.popover} role="dialog" aria-label="Update" onClick={(e) => e.stopPropagation()}>
      <div className={styles.popTitle}>{title}</div>
      <div className={styles.popSub}>current {currentVersion}</div>

      {state === 'error' && error ? <div className={styles.error}>{error}</div> : null}

      {releaseNotes ? (
        <>
          <div className={`${styles.notes} ${notesExpanded ? styles.notesExpanded : ''}`}>
            {releaseNotes}
          </div>
          <button
            type="button"
            className={styles.notesToggle}
            onClick={() => setNotesExpanded((v) => !v)}
          >
            {notesExpanded ? 'show less' : 'show more'}
          </button>
        </>
      ) : null}

      {state === 'downloading' ? (
        <>
          <div className={styles.progress}>
            <div className={styles.progressFill} style={{ width: `${Math.round(percent)}%` }} />
          </div>
          <div className={styles.progressLabel}>{Math.round(percent)}% downloaded</div>
        </>
      ) : null}

      <div className={styles.row}>
        {state === 'available' ? (
          <>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={() => {
                dismiss()
                onClose()
              }}
            >
              Dismiss
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => void download()}
            >
              Download
            </button>
          </>
        ) : null}

        {state === 'downloading' ? (
          // electron-updater has no stable "cancel" surface — the download
          // promise can't be aborted once it's in flight without tripping
          // the updater's internal state machine. Keep the popover open and
          // just offer Dismiss (it hides the badge but the download still
          // completes in the background — which is what users want).
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => {
              dismiss()
              onClose()
            }}
          >
            Hide
          </button>
        ) : null}

        {state === 'downloaded' ? (
          <>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={() => {
                dismiss()
                onClose()
              }}
            >
              Next launch
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => void install()}
            >
              Restart now
            </button>
          </>
        ) : null}

        {state === 'error' ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => void check()}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  )
}

/* ---------- manual check menu ---------- */

/**
 * Gear-menu trigger — always available in the TopBar so the user can ask
 * for a manual check regardless of update state. On "no updates" we show
 * a transient toast because surfacing the `none` state through the badge
 * itself (rendering a grey dot that says "you're up to date") would be
 * needlessly chatty.
 */
export function UpdateMenu() {
  const state = useUpdateStore((s) => s.state)
  const check = useUpdateStore((s) => s.check)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toastKey, setToastKey] = useState(0)
  const [showToast, setShowToast] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Track the last state we observed so we only fire a toast when `none`
  // arrives in response to our own click (not, say, a background re-check).
  const awaitingResultRef = useRef(false)

  useClickOutside(wrapRef, () => setMenuOpen(false), menuOpen)

  // When the store transitions to `none` after a manual check, pop the toast.
  useEffect(() => {
    if (!awaitingResultRef.current) return
    if (state === 'none') {
      awaitingResultRef.current = false
      setToastKey((k) => k + 1)
      setShowToast(true)
    } else if (state === 'available' || state === 'downloaded') {
      // Badge will render itself — no toast needed.
      awaitingResultRef.current = false
    } else if (state === 'error') {
      awaitingResultRef.current = false
    }
  }, [state])

  // Auto-hide the toast after 2.5s.
  useEffect(() => {
    if (!showToast) return
    const id = window.setTimeout(() => setShowToast(false), 2500)
    return () => window.clearTimeout(id)
  }, [showToast, toastKey])

  const handleCheck = async (): Promise<void> => {
    setMenuOpen(false)
    awaitingResultRef.current = true
    await check()
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.menuBtn}
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="App menu"
        title="App menu"
      >
        <IconGear />
      </button>
      {menuOpen ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => void handleCheck()}
          >
            Check for updates
          </button>
        </div>
      ) : null}
      {showToast ? (
        <div className={styles.toast} role="status">
          No updates available
        </div>
      ) : null}
    </div>
  )
}
