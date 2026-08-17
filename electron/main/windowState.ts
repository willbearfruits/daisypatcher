/**
 * Remember where the window was.
 *
 * Small on purpose: one JSON file in userData, read synchronously at
 * startup (it is a hundred bytes and the window cannot be created without
 * it), written debounced on move/resize and once more on close.
 *
 * The one thing this must get right is a monitor that is no longer there.
 * A laptop that was docked yesterday saves bounds on a display that does
 * not exist today, and restoring them puts the window somewhere the user
 * cannot reach — the classic "the app launches but I can't see it" report.
 * So saved bounds are only honoured if they intersect a current display;
 * otherwise Electron's default placement is used and only the SIZE is kept.
 */

import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface SavedState {
  bounds?: Rectangle
  maximized?: boolean
}

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function isRect(v: unknown): v is Rectangle {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (k) => typeof r[k] === 'number' && Number.isFinite(r[k] as number)
  )
}

function load(): SavedState {
  try {
    const p = statePath()
    if (!existsSync(p)) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const o = parsed as Record<string, unknown>
    return {
      bounds: isRect(o.bounds) ? o.bounds : undefined,
      maximized: typeof o.maximized === 'boolean' ? o.maximized : undefined
    }
  } catch {
    return {}
  }
}

function save(state: SavedState): void {
  try {
    const p = statePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(state), 'utf8')
  } catch {
    // Not worth surfacing — the next launch just uses defaults.
  }
}

/** Does at least a usable corner of `r` land on some current display? */
function onSomeDisplay(r: Rectangle): boolean {
  const MIN_VISIBLE = 100
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea
    const overlapX = Math.min(r.x + r.width, w.x + w.width) - Math.max(r.x, w.x)
    const overlapY = Math.min(r.y + r.height, w.y + w.height) - Math.max(r.y, w.y)
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE
  })
}

export interface WindowStateOptions {
  defaultWidth: number
  defaultHeight: number
  minWidth: number
  minHeight: number
}

/**
 * Bounds to pass to `new BrowserWindow`, and whether to maximize once shown.
 * Only x/y are included when the saved position is still on a display.
 */
export function restoreWindowState(opts: WindowStateOptions): {
  bounds: Partial<Rectangle>
  maximized: boolean
} {
  const saved = load()
  const b = saved.bounds
  if (!b) {
    return { bounds: { width: opts.defaultWidth, height: opts.defaultHeight }, maximized: false }
  }
  const width = Math.max(opts.minWidth, Math.round(b.width))
  const height = Math.max(opts.minHeight, Math.round(b.height))
  const candidate = { x: Math.round(b.x), y: Math.round(b.y), width, height }
  if (onSomeDisplay(candidate)) {
    return { bounds: candidate, maximized: saved.maximized === true }
  }
  return { bounds: { width, height }, maximized: saved.maximized === true }
}

/** Start tracking a window; writes on move/resize (debounced) and on close. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  let last: SavedState = {}

  const snapshot = (): SavedState => {
    // While maximized (or fullscreen) the "normal" bounds are what we want
    // back when the user un-maximizes next launch — not the screen size.
    const maximized = win.isMaximized()
    const bounds = maximized || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
    return { bounds, maximized }
  }

  const schedule = () => {
    if (win.isDestroyed()) return
    last = snapshot()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      save(last)
    }, 400)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    if (!win.isDestroyed()) last = snapshot()
    save(last)
  })
}
