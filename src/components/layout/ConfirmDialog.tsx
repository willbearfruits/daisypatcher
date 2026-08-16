/**
 * ConfirmDialog — in-app replacement for `window.confirm`.
 *
 * Two ways in:
 *   1. React code renders `<ConfirmDialog …/>` directly (rarely needed).
 *   2. Non-React code (store actions, patchFile.ts) calls the promise
 *      bridge `requestConfirm(opts)`. A single `<ConfirmHost />` mounted in
 *      App.tsx listens for those requests and renders the dialog.
 *
 * Interaction contract:
 *   - Esc     = cancel
 *   - Enter   = confirm (regardless of which button holds focus)
 *   - Tab     = focus trapped, toggling between the two buttons
 *   - backdrop click = cancel
 *   - `danger` styles the confirm button in --dp-danger and starts focus
 *     on Cancel so a reflexive keypress can't destroy work by accident;
 *     non-destructive confirms start on Confirm.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './ConfirmDialog.module.css'

export interface ConfirmOptions {
  /** Short uppercase kicker above the message, e.g. "new patch". */
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive action — confirm button renders in danger tones. */
  danger?: boolean
  /**
   * An optional third button between Cancel and Confirm. Used for the
   * quit dialog's "Don't Save": two choices are not enough when one of them
   * is "lose your work" — the person needs a way to save AND leave.
   */
  altLabel?: string
}

interface ConfirmDialogProps extends ConfirmOptions {
  onConfirm: () => void
  onCancel: () => void
  onAlt?: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  altLabel,
  onConfirm,
  onCancel,
  onAlt
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  // Initial focus: Cancel for destructive confirms, Confirm otherwise.
  useEffect(() => {
    const target = danger ? cancelRef.current : confirmRef.current
    target?.focus()
  }, [danger])

  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent) => {
      // Everything is handled here — stopPropagation keeps the global
      // keybinding layer (space transport, delete-selection…) quiet while
      // the dialog is up.
      ev.stopPropagation()
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onCancel()
        return
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        onConfirm()
        return
      }
      if (ev.key === 'Tab') {
        // Two-stop focus trap.
        ev.preventDefault()
        const next =
          document.activeElement === confirmRef.current
            ? cancelRef.current
            : confirmRef.current
        next?.focus()
      }
    },
    [onCancel, onConfirm]
  )

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onCancel()
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-label={title ?? message}
      >
        {title ? <div className={styles.title}>{title}</div> : null}
        <div className={styles.message}>{message}</div>
        <div className={styles.footer}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.btn}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          {altLabel && onAlt ? (
            <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={onAlt}>
              {altLabel}
            </button>
          ) : null}
          <button
            ref={confirmRef}
            type="button"
            className={`${styles.btn} ${danger ? styles.btnDanger : styles.btnConfirm}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- imperative bridge ----------
 *
 * `requestConfirm` is callable from anywhere (including non-React modules
 * like patchFile.ts). It resolves `true` on confirm, `false` on cancel.
 * The host component below must be mounted for dialogs to appear; if it
 * isn't (shouldn't happen — App.tsx renders it unconditionally), requests
 * resolve `false` so callers fail safe.
 */

export type ConfirmChoice = 'confirm' | 'alt' | 'cancel'

interface ActiveRequest {
  opts: ConfirmOptions
  resolve: (choice: ConfirmChoice) => void
}

let hostListener: ((req: ActiveRequest | null) => void) | null = null
let activeRequest: ActiveRequest | null = null

/** Which button was pressed. `requestConfirm` collapses this to a boolean. */
export function requestChoice(opts: ConfirmOptions): Promise<ConfirmChoice> {
  return new Promise<ConfirmChoice>((resolve) => {
    // A second request while one is up cancels the first — overlapping
    // confirms have no sane stacking order in this app.
    if (activeRequest) activeRequest.resolve('cancel')
    activeRequest = { opts, resolve }
    if (hostListener) {
      hostListener(activeRequest)
    } else {
      activeRequest.resolve('cancel')
      activeRequest = null
    }
  })
}

export function requestConfirm(opts: ConfirmOptions): Promise<boolean> {
  return requestChoice(opts).then((c) => c === 'confirm')
}

/** Mounted once in App.tsx; renders whatever `requestConfirm` queued. */
export function ConfirmHost() {
  const [request, setRequest] = useState<ActiveRequest | null>(null)

  useEffect(() => {
    hostListener = setRequest
    // Pick up a request that raced in before mount.
    if (activeRequest) setRequest(activeRequest)
    return () => {
      hostListener = null
    }
  }, [])

  if (!request) return null

  const settle = (choice: ConfirmChoice): void => {
    request.resolve(choice)
    if (activeRequest === request) activeRequest = null
    setRequest(null)
  }

  return (
    <ConfirmDialog
      {...request.opts}
      onConfirm={() => settle('confirm')}
      onCancel={() => settle('cancel')}
      onAlt={request.opts.altLabel ? () => settle('alt') : undefined}
    />
  )
}
