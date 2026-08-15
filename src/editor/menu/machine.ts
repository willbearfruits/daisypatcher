/**
 * Encoder-driven menu state machine.
 *
 * Pure functions over an explicit state object, deliberately free of any
 * DOM, worklet or store dependency, because the SAME behaviour has to run
 * in four places: the in-node preview, the emulator worklet, the Daisy
 * firmware and the ESP32 firmware. Anything stateful or environment-bound
 * here would have to be reimplemented three times and would drift.
 *
 * The interaction, as specified:
 *   - clockwise      -> next entry (or increase, while editing)
 *   - anticlockwise  -> previous entry (or decrease, while editing)
 *   - click          -> enter a submenu, or start editing a value;
 *                       clicking again while editing confirms and steps back
 *   - long press     -> assignable (default: up one level)
 *   - double click   -> assignable (default: jump to root)
 */

import {
  clampTo,
  entriesAt,
  type MenuAction,
  type MenuNode,
  type MenuTree
} from './tree'

export interface MenuState {
  /** Indices from the root down to the currently open submenu. */
  path: number[]
  /** Cursor position within the entries at `path`. */
  cursor: number
  /** True while the encoder edits the focused value rather than navigating. */
  editing: boolean
}

export function initialMenuState(): MenuState {
  return { path: [], cursor: 0, editing: false }
}

/** A value the machine wrote, for the caller to push at a param / CV out. */
export interface MenuValueChange {
  leafId: string
  value: number
}

export interface MenuStepResult {
  state: MenuState
  /** Values changed by this step. Empty for pure navigation. */
  changed: MenuValueChange[]
  /** Tree with any edited leaf updated — same object when nothing changed. */
  tree: MenuTree
}

function noChange(state: MenuState, tree: MenuTree): MenuStepResult {
  return { state, changed: [], tree }
}

/** The entry the cursor is on, or null when the level is empty. */
export function focusedEntry(tree: MenuTree, state: MenuState): MenuNode | null {
  const list = entriesAt(tree, state.path)
  if (list.length === 0) return null
  const i = clampTo(state.cursor, 0, list.length - 1)
  return list[Math.round(i)] ?? null
}

/**
 * Replace one leaf in the tree, returning a new tree. Structural sharing is
 * not attempted — trees are small (tens of nodes) and this runs on user
 * input, not per audio sample.
 */
function withLeafValue(tree: MenuTree, leafId: string, value: number): MenuTree {
  const mapNode = (n: MenuNode): MenuNode => {
    if (n.kind === 'value') {
      return n.id === leafId ? { ...n, value } : n
    }
    return { ...n, children: n.children.map(mapNode) }
  }
  return { ...tree, root: tree.root.map(mapNode) }
}

/**
 * Encoder rotation. `detents` is signed: +1 per clockwise click.
 *
 * Navigation clamps at the ends rather than wrapping. Wrapping a menu is a
 * coin-flip preference, and clamping means a fast spin lands predictably on
 * the first or last entry instead of somewhere in the middle.
 */
export function menuTurn(tree: MenuTree, state: MenuState, detents: number): MenuStepResult {
  if (detents === 0) return noChange(state, tree)
  const list = entriesAt(tree, state.path)
  if (list.length === 0) return noChange(state, tree)

  if (!state.editing) {
    const cursor = Math.round(clampTo(state.cursor + detents, 0, list.length - 1))
    return noChange({ ...state, cursor }, tree)
  }

  const entry = focusedEntry(tree, state)
  if (!entry || entry.kind !== 'value') return noChange(state, tree)
  const next = clampTo(entry.value + detents * entry.step, entry.min, entry.max)
  if (next === entry.value) return noChange(state, tree)
  return {
    state,
    changed: [{ leafId: entry.id, value: next }],
    tree: withLeafValue(tree, entry.id, next)
  }
}

/**
 * Short click. Enters a submenu, starts editing a value, or confirms an
 * edit in progress (which also steps focus back to navigation).
 */
export function menuClick(tree: MenuTree, state: MenuState): MenuStepResult {
  const entry = focusedEntry(tree, state)
  if (!entry) return noChange(state, tree)

  if (state.editing) {
    // Confirm — the value is already live; leaving edit mode is the "back".
    return noChange({ ...state, editing: false }, tree)
  }
  if (entry.kind === 'submenu') {
    const list = entriesAt(tree, state.path)
    const idx = list.indexOf(entry)
    return noChange({ path: [...state.path, idx], cursor: 0, editing: false }, tree)
  }
  return noChange({ ...state, editing: true }, tree)
}

/** Up one level. No-op at the root, so a stray long press can't escape. */
export function menuBack(tree: MenuTree, state: MenuState): MenuStepResult {
  if (state.editing) return noChange({ ...state, editing: false }, tree)
  if (state.path.length === 0) return noChange(state, tree)
  const path = state.path.slice(0, -1)
  // Restore the cursor onto the submenu we just came out of, rather than
  // dumping the user at the top of the parent list.
  const cursor = state.path[state.path.length - 1] ?? 0
  return noChange({ path, cursor, editing: false }, tree)
}

export function menuHome(tree: MenuTree, _state: MenuState): MenuStepResult {
  return noChange(initialMenuState(), tree)
}

/** Reset the focused value to its default. */
export function menuReset(tree: MenuTree, state: MenuState): MenuStepResult {
  const entry = focusedEntry(tree, state)
  if (!entry || entry.kind !== 'value') return noChange(state, tree)
  if (entry.value === entry.defaultValue) return noChange(state, tree)
  return {
    state,
    changed: [{ leafId: entry.id, value: entry.defaultValue }],
    tree: withLeafValue(tree, entry.id, entry.defaultValue)
  }
}

/** Flip a value between its two extremes — handy for on/off leaves. */
export function menuToggle(tree: MenuTree, state: MenuState): MenuStepResult {
  const entry = focusedEntry(tree, state)
  if (!entry || entry.kind !== 'value') return noChange(state, tree)
  const next = entry.value > (entry.min + entry.max) / 2 ? entry.min : entry.max
  return {
    state,
    changed: [{ leafId: entry.id, value: next }],
    tree: withLeafValue(tree, entry.id, next)
  }
}

/** Dispatch an assignable action. */
export function menuAction(
  tree: MenuTree,
  state: MenuState,
  action: MenuAction
): MenuStepResult {
  switch (action) {
    case 'back':   return menuBack(tree, state)
    case 'home':   return menuHome(tree, state)
    case 'reset':  return menuReset(tree, state)
    case 'toggle': return menuToggle(tree, state)
    case 'none':   return noChange(state, tree)
  }
}

/* =====================================================================
 * Click classifier.
 *
 * Turns a raw switch level into short / long / double, and is shared with
 * the firmware emitters so the timing rules are identical on hardware.
 *
 * A short click is deliberately reported on RELEASE, not press: until the
 * button comes back up we cannot know whether it is a long press, and
 * firing both would make every long press also perform the short action.
 * The double-click window then delays a lone short click by `doubleMs` —
 * unavoidable, and the reason `doubleMs` is user-tunable.
 * ===================================================================== */

export interface ClickDetectorState {
  pressed: boolean
  /** ms timestamp of the current press, -1 when not pressed. */
  pressedAtMs: number
  /** ms timestamp of the last completed short click, -1 when none pending. */
  lastClickMs: number
  /** True once the current press has already fired its long action. */
  longFired: boolean
}

export function initialClickState(): ClickDetectorState {
  return { pressed: false, pressedAtMs: -1, lastClickMs: -1, longFired: false }
}

export type ClickEvent = 'click' | 'long' | 'double' | null

/**
 * Feed the switch level and the current time; returns the gesture, if any.
 * Call every block — `nowMs` is what makes the timing testable and lets the
 * firmware pass its own millis().
 */
export function clickStep(
  st: ClickDetectorState,
  level: boolean,
  nowMs: number,
  longMs: number,
  doubleMs: number
): { state: ClickDetectorState; event: ClickEvent } {
  let s = st
  let event: ClickEvent = null

  if (level && !s.pressed) {
    // Press edge.
    if (s.lastClickMs >= 0 && nowMs - s.lastClickMs <= doubleMs) {
      event = 'double'
      s = { pressed: true, pressedAtMs: nowMs, lastClickMs: -1, longFired: true }
      return { state: s, event }
    }
    s = { ...s, pressed: true, pressedAtMs: nowMs, longFired: false }
    return { state: s, event }
  }

  if (level && s.pressed && !s.longFired && nowMs - s.pressedAtMs >= longMs) {
    // Held past the threshold — fire long now, and suppress the click that
    // would otherwise arrive on release.
    return { state: { ...s, longFired: true }, event: 'long' }
  }

  if (!level && s.pressed) {
    // Release edge.
    const wasLong = s.longFired
    s = { ...s, pressed: false, pressedAtMs: -1 }
    if (wasLong) return { state: { ...s, lastClickMs: -1, longFired: false }, event: null }
    // Arm the double-click window instead of firing immediately.
    return { state: { ...s, lastClickMs: nowMs, longFired: false }, event: null }
  }

  if (!level && s.lastClickMs >= 0 && nowMs - s.lastClickMs > doubleMs) {
    // Window expired with no second press — it was a plain click.
    return { state: { ...s, lastClickMs: -1 }, event: 'click' }
  }

  return { state: s, event }
}
