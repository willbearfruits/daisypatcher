/**
 * The last line between a render bug and a blank window.
 *
 * Without this, one thrown render anywhere in the tree — a hand-edited
 * patch with an `elements` blob the OLED designer does not expect, a
 * param that came off disk as a string where a number was assumed —
 * unmounts EVERYTHING and the user is looking at a black rectangle with an
 * hour of unsaved work in it. The only exit is to kill the app.
 *
 * So the boundary's first job is not to explain the crash; it is to get
 * the patch out. `Save patch as…` runs the ordinary save path against the
 * store — the store is intact, it is only the view that fell over — and
 * only then offers to reload the window. The error text is there for the
 * issue report, not for the user to fix.
 *
 * Deliberately a class: React has no hook equivalent for
 * `getDerivedStateFromError`, and this is the one place a class earns it.
 */

import * as React from 'react'
import { savePatchAs } from '@/state/patchFile'
import { useEditorStore } from '@/state/store'
import styles from './ErrorBoundary.module.css'

interface State {
  error: Error | null
  info: string | null
  saved: string | null
  saving: boolean
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null, info: null, saved: null, saving: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The stack goes to the console (DevTools in dev; the log the user can
    // attach to a report in prod). The store's status line may itself be
    // part of what fell over, so we do not route through it.
    console.error('[daisypatcher] render error', error, info.componentStack)
    this.setState({ info: info.componentStack ?? null })
  }

  private save = async (): Promise<void> => {
    this.setState({ saving: true })
    try {
      const res = await savePatchAs(useEditorStore)
      this.setState({ saved: res.saved ? (res.path ?? 'saved') : null, saving: false })
    } catch (err) {
      this.setState({ saved: `save failed: ${(err as Error).message}`, saving: false })
    }
  }

  private reload = (): void => {
    window.location.reload()
  }

  private report = (): void => {
    const { error, info } = this.state
    const body = [
      '**What happened**',
      '',
      '(what were you doing when the window went red?)',
      '',
      '**Error**',
      '```',
      `${error?.name ?? 'Error'}: ${error?.message ?? ''}`,
      (error?.stack ?? '').split('\n').slice(0, 12).join('\n'),
      '```',
      '',
      '**Component stack**',
      '```',
      (info ?? '').split('\n').slice(0, 20).join('\n'),
      '```'
    ].join('\n')
    const url =
      'https://github.com/willbearfruits/daisypatcher/issues/new?title=' +
      encodeURIComponent(`Render error: ${error?.message?.slice(0, 80) ?? 'unknown'}`) +
      '&body=' +
      encodeURIComponent(body)
    const w = window as unknown as { daisy?: { openExternal?: (u: string) => void } }
    w.daisy?.openExternal?.(url)
  }

  render(): React.ReactNode {
    const { error, saved, saving } = this.state
    if (!error) return this.props.children

    const dirty = useEditorStore.getState().isDirty
    const name = useEditorStore.getState().graph.meta.name || 'untitled'

    return (
      <div className={styles.screen} role="alertdialog" aria-labelledby="dp-crash-title">
        <div className={styles.card}>
          <h1 id="dp-crash-title" className={styles.title}>
            Something in the window broke
          </h1>
          <p className={styles.lead}>
            The patch itself is fine — only the display failed. Save your work first, then reload.
          </p>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void this.save()}
              disabled={saving}
            >
              {saving ? 'Saving…' : `Save “${name}” as…`}
            </button>
            <button type="button" className={styles.secondary} onClick={this.reload}>
              Reload window
            </button>
            <button type="button" className={styles.secondary} onClick={this.report}>
              Report this
            </button>
          </div>

          {saved ? (
            <p className={styles.saved}>{saved.startsWith('save failed') ? saved : `Saved to ${saved}`}</p>
          ) : dirty ? (
            <p className={styles.warn}>You have unsaved changes.</p>
          ) : null}

          <details className={styles.details}>
            <summary>Error details</summary>
            <pre className={styles.pre}>
              {`${error.name}: ${error.message}\n\n${error.stack ?? ''}`}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
