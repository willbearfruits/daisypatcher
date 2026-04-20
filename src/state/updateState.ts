/**
 * Auto-update state — listens to the main-process updater bridge and exposes
 * a small reactive store for the TopBar badge + update popover.
 *
 * Design choices:
 *   - Separate store (not piggybacking on compileState) because update events
 *     are lifecycle-independent from build/flash. Keeps subscriptions cheap
 *     and prevents accidental re-renders across unrelated UI surfaces.
 *   - The preload bridge exposes two channels: `onStatus` for the lifecycle
 *     union and `onProgress` for per-chunk download progress. We subscribe
 *     to both at store construction so even before any UI renders, the
 *     store is ready to record the first `checking-for-update` event.
 *   - Dev-mode short-circuit: when `window.daisy.updates` isn't available
 *     (web-only dev, or main-process guarded out), every action still
 *     resolves but logs a note into the compile log so it's visible.
 *   - `dismissed` is a per-session flag. We never persist it — users should
 *     be re-prompted on next launch if they haven't taken action yet.
 */

import { create } from 'zustand'
import { useCompileStore } from '@/state/compileState'

type UpdateLifecycle =
  | 'idle'
  | 'checking'
  | 'none'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  state: UpdateLifecycle
  /** Version string for the available/downloaded update. */
  version: string | null
  /** Currently-running app version. Injected at build time. */
  currentVersion: string
  releaseNotes: string | null
  /** Download progress 0..100. Zero outside the `downloading` state. */
  percent: number
  error: string | null
  /** User dismissed the available-update UI for this session. */
  dismissed: boolean
}

export interface UpdateActions {
  check(): Promise<void>
  download(): Promise<void>
  installAndRestart(): Promise<void>
  dismiss(): void
}

/* ---------- IPC shape (same as preload bridge) ---------- */

type Unsub = () => void

interface UpdatesApi {
  check(): Promise<void>
  download(): Promise<void>
  install(): Promise<void>
  onStatus(cb: (p: DaisyUpdateStatus) => void): Unsub
  onProgress(cb: (p: DaisyUpdateProgress) => void): Unsub
}

function bridge(): UpdatesApi | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { daisy?: { updates?: UpdatesApi } }
  return w.daisy?.updates
}

/** Read the build-time version constant, with a safe fallback. */
function readAppVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const useUpdateStore = create<UpdateState & UpdateActions>((set, get) => {
  const updates = bridge()

  // Register listeners once, at store construction, so late-constructed UI
  // still sees status events that fired during first-paint work.
  try {
    updates?.onStatus((p) => {
      switch (p.state) {
        case 'checking':
          set({ state: 'checking', error: null })
          break
        case 'available':
          set({
            state: 'available',
            version: p.version,
            releaseNotes: p.releaseNotes,
            error: null,
            // A new version arriving resets any prior dismissal — user
            // should see the badge again for a genuinely new release.
            dismissed: false
          })
          break
        case 'none':
          set({ state: 'none', version: p.version, error: null })
          break
        case 'downloaded':
          set({
            state: 'downloaded',
            version: p.version,
            percent: 100,
            error: null,
            dismissed: false
          })
          break
        case 'error':
          set({ state: 'error', error: p.message })
          break
      }
    })
    updates?.onProgress((p) => {
      // Only transition to 'downloading' from the UI thread if we haven't
      // already reached 'downloaded' — the main-process emits a final
      // 100% progress and then a separate downloaded event.
      const cur = get().state
      if (cur === 'downloaded') return
      set({
        state: 'downloading',
        percent: Math.max(0, Math.min(100, p.percent))
      })
    })
  } catch {
    // Preload not ready — degrade silently; actions below re-check.
  }

  return {
    state: 'idle',
    version: null,
    currentVersion: readAppVersion(),
    releaseNotes: null,
    percent: 0,
    error: null,
    dismissed: false,

    async check() {
      const api = bridge()
      if (!api) {
        // Dev-mode path (or pre-bridge). Mirror the guidance from the main
        // process by recording a note in the compile log — there is no
        // separate log store, compileState.log is the unified sink.
        useCompileStore.getState().appendLog({
          stream: 'info',
          text: '[update] disabled in dev',
          t: Date.now()
        })
        set({ state: 'none', error: null })
        return
      }
      try {
        await api.check()
      } catch (err) {
        set({ state: 'error', error: (err as Error).message })
      }
    },

    async download() {
      const api = bridge()
      if (!api) return
      try {
        // Flip into a provisional downloading state — real progress events
        // will overwrite `percent` immediately.
        set({ state: 'downloading', percent: 0, error: null })
        await api.download()
      } catch (err) {
        set({ state: 'error', error: (err as Error).message })
      }
    },

    async installAndRestart() {
      const api = bridge()
      if (!api) return
      try {
        await api.install()
      } catch (err) {
        set({ state: 'error', error: (err as Error).message })
      }
    },

    dismiss() {
      set({ dismissed: true })
    }
  }
})
