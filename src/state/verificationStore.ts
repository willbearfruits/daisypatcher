/**
 * Verification store — persists the per-node "tested on hardware?" table.
 *
 * Lives in its own Zustand slice, separate from compile/editor stores so
 * the UI surfaces (TestRigModal + VerificationPanel) and the persistence
 * path don't entangle with graph/build concerns. Persisted through the
 * preload IPC bridge at `window.daisy.verification` to
 * `~/.config/daisypatcher/verified.json`. Loaded once on app boot via
 * `loadFromDisk()` from `App.tsx`.
 *
 * Schema: keyed by `${kind}:${target}` so the same node can track
 * independent results across Daisy Seed and ESP32-S3. Non-destructive:
 * when no entry exists for a key, callers treat status as `'unknown'`.
 *
 * Save strategy: every `setResult` writes immediately (fire-and-forget).
 * Table is tiny — a handful of KB at the limit — so we don't bother
 * debouncing. The preload bridge degrades gracefully if not present.
 */

import { create } from 'zustand'
import type { NodeKind } from '@/types/graph'
import type { BoardTarget } from '@/types/store'
import { LEGACY_BOARD_IDS } from '../../shared/boards'

export type VerificationResult = 'pass' | 'fail' | 'unknown'

export interface VerificationEntry {
  kind: NodeKind
  target: BoardTarget
  result: VerificationResult
  lastTestedMs: number | null
  notes: string
}

export type VerifiedTable = Record<string, VerificationEntry>

interface VerificationApi {
  load(): Promise<VerifiedTable>
  save(table: VerifiedTable): Promise<void>
}

interface MaybeDaisyApi {
  verification?: VerificationApi
}

function api(): MaybeDaisyApi {
  if (typeof window === 'undefined') return {}
  const w = window as unknown as { daisy?: MaybeDaisyApi }
  return w.daisy ?? {}
}

/**
 * Rewrite records saved under a legacy target id.
 *
 * Keys are `${nodeKind}:${target}`, and the compile target `'esp32_s3'`
 * became `'esp32_s3_devkitc'` when boards and targets merged into one
 * union. Without this pass every node the user verified on hardware
 * would silently show as untested — the records are still on disk, just
 * filed under a name nothing looks up any more.
 *
 * Only rewrites when the destination key is free, so a genuine result
 * recorded under the new id always wins.
 */
function migrateLegacyKeys(table: VerifiedTable): VerifiedTable {
  let changed = false
  const out: VerifiedTable = { ...table }
  for (const [key, entry] of Object.entries(table)) {
    const sep = key.lastIndexOf(':')
    if (sep < 0) continue
    const kind = key.slice(0, sep)
    const target = key.slice(sep + 1)
    const mapped = LEGACY_BOARD_IDS[target]
    if (!mapped) continue
    const nextKey = `${kind}:${mapped}`
    if (!(nextKey in out)) out[nextKey] = { ...entry, target: mapped }
    delete out[key]
    changed = true
  }
  return changed ? out : table
}

export function verificationKey(kind: NodeKind, target: BoardTarget): string {
  return `${kind}:${target}`
}

export interface VerificationState {
  table: VerifiedTable
  loaded: boolean
}

export interface VerificationActions {
  loadFromDisk(): Promise<void>
  saveToDisk(): Promise<void>
  setResult(
    kind: NodeKind,
    target: BoardTarget,
    result: VerificationResult,
    notes?: string
  ): void
  getEntry(kind: NodeKind, target: BoardTarget): VerificationEntry | null
}

/**
 * Two-tier persistence:
 *   1. `localStorage` — primary store. Synchronous, always available,
 *      survives dev-server restarts. This is what keeps results from
 *      disappearing between sessions even when IPC hasn't been
 *      re-registered (e.g. during main-process hot reload).
 *   2. IPC bridge to `verified.json` in userData — secondary mirror for
 *      portability (CLI, backup, sharing between installs).
 *
 * On load: prefer IPC (disk authority), fall back to localStorage, empty
 * otherwise. On save: write to both; IPC failures are logged but don't
 * affect the in-memory state.
 */
const LS_KEY = 'daisypatcher:verified'

function readLocalStorage(): VerifiedTable | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as VerifiedTable
  } catch {
    /* ignore — corrupt or missing */
  }
  return null
}

function writeLocalStorage(table: VerifiedTable): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(table))
  } catch {
    /* quota or disabled — non-fatal */
  }
}

export const useVerificationStore = create<VerificationState & VerificationActions>(
  (set, get) => ({
    table: {},
    loaded: false,

    async loadFromDisk() {
      const bridge = api().verification
      const ls = readLocalStorage()
      if (!bridge) {
        // No preload bridge — use localStorage as authority.
        set({ table: migrateLegacyKeys(ls ?? {}), loaded: true })
        return
      }
      try {
        const fromDisk = await bridge.load()
        // If the disk file is empty but localStorage has data (e.g. first
        // session after the IPC bridge wasn't wired, then it got fixed),
        // prefer localStorage to preserve the user's history.
        const diskEmpty = !fromDisk || Object.keys(fromDisk).length === 0
        const lsHasData = ls && Object.keys(ls).length > 0
        const chosen = diskEmpty && lsHasData ? ls : fromDisk ?? ls ?? {}
        set({ table: migrateLegacyKeys(chosen), loaded: true })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[verification] IPC load failed, falling back to localStorage', err)
        set({ table: migrateLegacyKeys(ls ?? {}), loaded: true })
      }
    },

    async saveToDisk() {
      const table = get().table
      // Synchronous mirror always runs first so data never gets lost to
      // an IPC error.
      writeLocalStorage(table)
      const bridge = api().verification
      if (!bridge) return
      try {
        await bridge.save(table)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[verification] IPC save failed, localStorage still has it', err)
      }
    },

    setResult(kind, target, result, notes) {
      const key = verificationKey(kind, target)
      const prev = get().table[key]
      const entry: VerificationEntry = {
        kind,
        target,
        result,
        lastTestedMs: Date.now(),
        notes: notes ?? prev?.notes ?? ''
      }
      const nextTable: VerifiedTable = { ...get().table, [key]: entry }
      set({ table: nextTable })
      // Best-effort write — ignore result, no UI for save failures.
      void get().saveToDisk()
    },

    getEntry(kind, target) {
      return get().table[verificationKey(kind, target)] ?? null
    }
  })
)
