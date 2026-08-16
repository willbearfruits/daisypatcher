/**
 * Preferences, Keyboard Shortcuts and About.
 *
 * Three small modals that the application menu needs a target for. They
 * share one component and one open-state so exactly one can be up at a
 * time — stacking a preferences sheet on an about box is a state nobody
 * wants and nobody should have to think about closing.
 *
 * Preferences is deliberately SHORT. Every setting here is one that lives
 * across patches (theme, canvas behaviour); anything patch-specific belongs
 * in the Inspector next to the thing it changes, not in a global sheet you
 * have to leave the canvas to reach. Provider/API-key settings for the
 * assistant live in its own panel for the same reason.
 *
 * Shortcuts is generated from a table rather than hand-written prose, and
 * that table is the same shape the menu accelerators use, so a binding
 * that changes in one place cannot silently stay stale in the other.
 */

import { useCallback, useEffect, useState } from 'react'
import { useEditorStore } from '@/state/store'
import { useTheme } from '@/theme/ThemeProvider'
import { THEMES } from '@/theme/themes'
import { openPatchFromPath } from '@/state/patchFile'
import { requestConfirm } from './ConfirmDialog'
import styles from './AppModals.module.css'

export type AppModalKind = 'preferences' | 'shortcuts' | 'about' | 'examples'
export const OPEN_APP_MODAL_EVENT = 'dp:open-app-modal'

export function openAppModal(kind: AppModalKind): void {
  window.dispatchEvent(new CustomEvent(OPEN_APP_MODAL_EVENT, { detail: kind }))
}

const MOD = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'

/** [chord, what it does]. Grouped the way the menu is. */
const SHORTCUTS: { group: string; rows: [string, string][] }[] = [
  {
    group: 'File',
    rows: [
      [`${MOD}+N`, 'New patch'],
      [`${MOD}+O`, 'Open…'],
      [`${MOD}+S`, 'Save'],
      [`${MOD}+Shift+S`, 'Save as…'],
      [`${MOD}+Enter`, 'Build'],
      [`${MOD}+Shift+Enter`, 'Build and flash']
    ]
  },
  {
    group: 'Edit',
    rows: [
      [`${MOD}+Z / ${MOD}+Shift+Z`, 'Undo / redo'],
      [`${MOD}+C / X / V`, 'Copy / cut / paste nodes'],
      [`${MOD}+D`, 'Duplicate selection'],
      [`${MOD}+A`, 'Select all'],
      ['Delete', 'Delete selection'],
      [`${MOD}+G`, 'Collapse selection into a subpatch'],
      ['Esc', 'Clear selection · leave subpatch']
    ]
  },
  {
    group: 'View',
    rows: [
      [`${MOD}+1 / 2 / 3`, 'Patch · Hardware · Perform'],
      [`${MOD}+K`, 'Command palette'],
      [`${MOD}+Shift+K`, 'Assistant'],
      [`${MOD}+Shift+C`, 'Generated code'],
      [`${MOD}+B`, 'Node palette'],
      ['`', 'Build log'],
      [`${MOD}+M`, 'Serial monitor'],
      [`${MOD}+/`, 'This list']
    ]
  },
  {
    group: 'Canvas',
    rows: [
      ['Drag', 'Marquee select'],
      ['Middle-drag · Space+drag', 'Pan'],
      ['Scroll', 'Zoom'],
      ['Double-click node', 'Collapse · enter subpatch'],
      ['Right-click', 'Context menu']
    ]
  },
  { group: 'Transport', rows: [['Space', 'Play / stop']] }
]

export function AppModals() {
  const [kind, setKind] = useState<AppModalKind | null>(null)

  useEffect(() => {
    const onOpen = (e: Event) => setKind((e as CustomEvent<AppModalKind>).detail)
    window.addEventListener(OPEN_APP_MODAL_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_APP_MODAL_EVENT, onOpen)
  }, [])

  const close = useCallback(() => setKind(null), [])

  useEffect(() => {
    if (!kind) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [kind, close])

  if (!kind) return null

  return (
    <div className={styles.scrim} onMouseDown={close} role="presentation">
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={kind}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <span className={styles.title}>
            {kind === 'preferences'
              ? 'PREFERENCES'
              : kind === 'shortcuts'
                ? 'KEYBOARD SHORTCUTS'
                : kind === 'examples'
                  ? 'EXAMPLE PATCHES'
                  : 'ABOUT'}
          </span>
          <span className={styles.spacer} />
          <button type="button" className={styles.close} onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        {kind === 'preferences' ? <Preferences /> : null}
        {kind === 'shortcuts' ? <Shortcuts /> : null}
        {kind === 'about' ? <About /> : null}
        {kind === 'examples' ? <Examples onDone={close} /> : null}
      </div>
    </div>
  )
}

function Preferences() {
  const { skinId, setSkinId } = useTheme()
  const layout = useEditorStore((s) => s.layout)
  const setLayout = useEditorStore((s) => s.setLayout)

  return (
    <div className={styles.body}>
      <section className={styles.section}>
        <h3 className={styles.h}>Appearance</h3>
        <label className={styles.row}>
          <span>Theme</span>
          <select className={styles.select} value={skinId} onChange={(e) => setSkinId(e.target.value)}>
            {Object.values(THEMES).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className={styles.section}>
        <h3 className={styles.h}>Canvas</h3>
        <label className={styles.row}>
          <span>Show grid</span>
          <input
            type="checkbox"
            checked={layout.gridShow}
            onChange={(e) => setLayout({ gridShow: e.target.checked })}
          />
        </label>
        <label className={styles.row}>
          <span>Snap to grid</span>
          <input
            type="checkbox"
            checked={layout.gridSnap}
            onChange={(e) => setLayout({ gridSnap: e.target.checked })}
          />
        </label>
        <label className={styles.row}>
          <span>Grid size</span>
          <select
            className={styles.select}
            value={layout.gridSize}
            onChange={(e) => setLayout({ gridSize: Number(e.target.value) })}
          >
            {[10, 16, 20, 24, 32].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.row}>
          <span>Left-drag on empty canvas</span>
          <select
            className={styles.select}
            value={layout.marqueeSelect ? 'marquee' : 'pan'}
            onChange={(e) => setLayout({ marqueeSelect: e.target.value === 'marquee' })}
          >
            <option value="marquee">Marquee select</option>
            <option value="pan">Pan</option>
          </select>
        </label>
        <label className={styles.row}>
          <span>Compact node palette</span>
          <input
            type="checkbox"
            checked={layout.paletteCompact}
            onChange={(e) => setLayout({ paletteCompact: e.target.checked })}
          />
        </label>
      </section>

      <p className={styles.note}>
        Assistant provider and API keys are in the Assistant panel ({MOD}+Shift+K → settings).
        Board, flash mode and SDK are in the top bar.
      </p>
    </div>
  )
}

function Shortcuts() {
  return (
    <div className={`${styles.body} ${styles.twoCol}`}>
      {SHORTCUTS.map((g) => (
        <section key={g.group} className={styles.section}>
          <h3 className={styles.h}>{g.group}</h3>
          <table className={styles.table}>
            <tbody>
              {g.rows.map(([k, v]) => (
                <tr key={k}>
                  <td className={styles.key}>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}

interface ExampleEntry {
  name: string
  path: string
  board?: string
  description?: string
}

/**
 * The bundled example patches.
 *
 * Seven patches were written for this app and, until now, the only way to
 * reach them was to know where the folder was. This lists them with the
 * one-line description each was built with and opens one in place — with
 * the same "discard unsaved changes?" guard the File menu uses, because an
 * example is exactly the thing you click on top of work you meant to keep.
 */
function Examples({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<ExampleEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const setStatus = useEditorStore((s) => s.setStatus)

  useEffect(() => {
    const w = window as unknown as { daisy?: { examples?: { list: () => Promise<ExampleEntry[]> } } }
    const api = w.daisy?.examples
    if (!api) {
      setList([])
      return
    }
    void api.list().then(setList)
  }, [])

  const open = useCallback(
    async (e: ExampleEntry) => {
      setBusy(e.path)
      const ok = await confirmDiscardForExample()
      if (!ok) {
        setBusy(null)
        return
      }
      const r = await openPatchFromPath(e.path)
      setBusy(null)
      if (r.loaded) onDone()
      else setStatus({ kind: 'error', message: `could not open ${e.name}` })
    },
    [onDone, setStatus]
  )

  if (list === null) return <p className={styles.note}>Loading…</p>
  if (list.length === 0) {
    return (
      <p className={styles.note}>
        No examples were found. In a development checkout run <code>npm run examples</code>.
      </p>
    )
  }

  return (
    <div className={styles.body}>
      <ul className={styles.exampleList}>
        {list.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              className={styles.exampleRow}
              disabled={busy !== null}
              onClick={() => void open(e)}
            >
              <span className={styles.exampleName}>
                {e.name.replace(/\.dpatch$/, '')}
                {e.board ? <span className={styles.exampleBoard}>{boardLabel(e.board)}</span> : null}
              </span>
              {e.description ? <span className={styles.exampleDesc}>{e.description}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        Opening an example replaces the current patch. Save first if you want to keep it.
      </p>
    </div>
  )
}

function boardLabel(id: string): string {
  switch (id) {
    case 'daisy_seed':
      return 'Daisy Seed'
    case 'esp32_s3_devkitc':
      return 'ESP32-S3'
    case 'esp32_s3_supermini':
      return 'S3 SuperMini'
    case 'esp32_c3_supermini':
      return 'C3 SuperMini'
    default:
      return id
  }
}

async function confirmDiscardForExample(): Promise<boolean> {
  const s = useEditorStore.getState()
  if (!s.isDirty && s.history.past.length === 0) return true
  return requestConfirm({
    title: 'Open example',
    message: 'Discard unsaved changes?',
    confirmLabel: 'Discard',
    danger: true
  })
}

function About() {
  const versions = (window as unknown as { daisy?: { versions?: Record<string, string> } }).daisy
    ?.versions
  return (
    <div className={styles.body}>
      <p className={styles.lede}>
        <strong>Daisypatcher</strong> — a visual patcher that compiles to firmware for the
        Electro-Smith Daisy Seed and ESP32-S3 / C3.
      </p>
      <p className={styles.note}>
        Version {__APP_VERSION__}
        {versions ? ` · Electron ${versions.electron} · Chromium ${versions.chrome}` : ''}
      </p>
      <p className={styles.note}>
        DSP by DaisySP (MIT, with LGPL modules), hardware by libDaisy (MIT). What you hear in the
        app is what the device plays — verified per node by <code>npm run test:audio</code>.
      </p>
    </div>
  )
}
