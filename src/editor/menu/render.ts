/**
 * Menu → screen rows.
 *
 * The layout is expressed as data rather than drawing commands so the
 * in-node preview, the OLED bitmap renderer and the C++ emitters all agree
 * on what a menu looks like without three separate implementations. The
 * firmware side walks the same row list and calls its own text routine.
 *
 * Layout on a 128x64 SSD1306 with the 5x7 font:
 *   row 0        title (current submenu, or the menu name at the root)
 *   rows 1..N    entries, one per line, with a cursor marker
 *   right column value, for value leaves
 */

import { entriesAt, formatValue, type MenuNode, type MenuTree } from './tree'
import type { MenuState } from './machine'

export interface MenuRow {
  /** Entry label, already trimmed to the visible width. */
  label: string
  /** Formatted value for value leaves; empty for submenus. */
  value: string
  /** True for the row under the cursor. */
  selected: boolean
  /** True while this row's value is being edited. */
  editing: boolean
  /** Submenus get a trailing marker to show they descend. */
  submenu: boolean
}

export interface MenuScreen {
  title: string
  rows: MenuRow[]
  /** True when there are entries above the visible window. */
  moreAbove: boolean
  /** True when there are entries below it. */
  moreBelow: boolean
}

/** Visible entry rows on a 64px-high screen with a title line. */
export const MENU_VISIBLE_ROWS = 6

/** Characters that fit across 128px in the 5x7 font (5px + 1px gap). */
export const MENU_COLS = 21

function trim(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…'
}

/** The title for the level currently open. */
function titleFor(tree: MenuTree, state: MenuState): string {
  if (state.path.length === 0) return 'MENU'
  let list: MenuNode[] = tree.root
  let label = 'MENU'
  for (const idx of state.path) {
    const n = list[idx]
    if (!n || n.kind !== 'submenu') break
    label = n.label
    list = n.children
  }
  return label.toUpperCase()
}

/**
 * Build the visible screen for the current state.
 *
 * The window scrolls to keep the cursor in view rather than paging, which
 * is what makes a long list (six oscillators) usable on six rows.
 */
export function buildMenuScreen(
  tree: MenuTree,
  state: MenuState,
  visibleRows: number = MENU_VISIBLE_ROWS
): MenuScreen {
  const list = entriesAt(tree, state.path)
  const title = titleFor(tree, state)
  if (list.length === 0) {
    return { title, rows: [], moreAbove: false, moreBelow: false }
  }

  const cursor = Math.max(0, Math.min(list.length - 1, Math.round(state.cursor)))
  // Keep the cursor inside the window, scrolling by the minimum needed.
  let start = 0
  if (list.length > visibleRows) {
    start = Math.min(
      Math.max(0, cursor - Math.floor(visibleRows / 2)),
      list.length - visibleRows
    )
  }
  const end = Math.min(list.length, start + visibleRows)

  const rows: MenuRow[] = []
  for (let i = start; i < end; i++) {
    const n = list[i]
    const isSel = i === cursor
    const value = n.kind === 'value' ? formatValue(n) : ''
    // Reserve the right-hand columns for the value so a long label can't
    // push it off the screen.
    const labelCols = MENU_COLS - (value ? value.length + 1 : 1)
    rows.push({
      label: trim(n.label, labelCols),
      value,
      selected: isSel,
      editing: isSel && state.editing && n.kind === 'value',
      submenu: n.kind === 'submenu'
    })
  }

  return {
    title,
    rows,
    moreAbove: start > 0,
    moreBelow: end < list.length
  }
}

/**
 * One row as a single line of text, the form the firmware draws.
 *
 * `>` marks the cursor, `[ ]` brackets a value being edited (so a physical
 * screen shows edit mode without needing inverse video), and a trailing
 * `>` marks a submenu.
 */
export function menuRowText(row: MenuRow): string {
  const cursor = row.selected ? '>' : ' '
  const body = row.submenu ? `${row.label}` : row.label
  const tail = row.submenu ? '>' : row.editing ? `[${row.value}]` : row.value
  const pad = Math.max(1, MENU_COLS - cursor.length - body.length - tail.length)
  return `${cursor}${body}${' '.repeat(pad)}${tail}`
}
