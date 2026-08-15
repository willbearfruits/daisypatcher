/**
 * Menu tree schema for the `menu` node.
 *
 * The node stores a JSON-serialised `MenuTree` in its `tree` param, the way
 * the OLED node stores its display elements — same reasoning: the shape is
 * richer than a param slider can express, so an in-node editor owns it and
 * the inspector treats the param as opaque.
 *
 * A tree is a list of nodes. Two kinds:
 *   - `submenu` — has children; entering it descends a level.
 *   - `value`   — a leaf the encoder edits in place.
 *
 * A value leaf can deliver its value two ways, and both may be used at once:
 *   - `target`  — writes a named node's param directly (no cable). This is
 *                 what makes "6 oscillators x 3 params" practical; 18 cables
 *                 across the canvas would not be.
 *   - `out`     — mirrors onto one of the node's four CV outputs, for
 *                 leaves you want to patch somewhere that isn't a param.
 */

/** Which of the menu node's four CV outputs a leaf mirrors to. */
export type MenuOutSlot = 'a' | 'b' | 'c' | 'd' | 'none'

/** What a long-press or double-click does. Assignable per menu node. */
export type MenuAction = 'back' | 'home' | 'reset' | 'toggle' | 'none'

export interface MenuTargetRef {
  /** Graph node id whose param this leaf drives. */
  nodeId: string
  paramId: string
}

export interface MenuSubmenu {
  id: string
  kind: 'submenu'
  label: string
  children: MenuNode[]
}

export interface MenuValue {
  id: string
  kind: 'value'
  label: string
  /** Continuous number, or a pick-list the encoder steps through. */
  type: 'number' | 'enum'
  min: number
  max: number
  step: number
  /** Present when `type === 'enum'`; the encoder indexes this list. */
  options?: string[]
  /** Current value. For enums this is the index into `options`. */
  value: number
  /** Reset target for the `reset` action. */
  defaultValue: number
  unit?: string
  target?: MenuTargetRef
  out: MenuOutSlot
}

export type MenuNode = MenuSubmenu | MenuValue

export interface MenuTree {
  /** Top-level entries. */
  root: MenuNode[]
  longPress: MenuAction
  doubleClick: MenuAction
  /** Hold time (ms) that counts as a long press. */
  longMs: number
  /** Window (ms) within which a second click counts as a double. */
  doubleMs: number
}

export function emptyMenuTree(): MenuTree {
  return {
    root: [],
    longPress: 'back',
    doubleClick: 'home',
    longMs: 500,
    doubleMs: 300
  }
}

/* =====================================================================
 * Parsing. Same contract as the OLED's `parseElements`: never throw on a
 * malformed or hand-edited param — fall back to an empty tree so the node
 * still renders and the user can rebuild it.
 * ===================================================================== */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function parseAction(v: unknown, fallback: MenuAction): MenuAction {
  return v === 'back' || v === 'home' || v === 'reset' || v === 'toggle' || v === 'none'
    ? v
    : fallback
}

function parseOutSlot(v: unknown): MenuOutSlot {
  return v === 'a' || v === 'b' || v === 'c' || v === 'd' ? v : 'none'
}

function parseNode(raw: unknown, depth: number): MenuNode | null {
  if (!isObj(raw) || depth > MAX_DEPTH) return null
  const id = str(raw.id, '')
  const label = str(raw.label, '')
  if (!id) return null

  if (raw.kind === 'submenu') {
    const kids = Array.isArray(raw.children) ? raw.children : []
    return {
      id,
      kind: 'submenu',
      label,
      children: kids
        .map((k) => parseNode(k, depth + 1))
        .filter((k): k is MenuNode => k !== null)
    }
  }

  if (raw.kind === 'value') {
    const type = raw.type === 'enum' ? 'enum' : 'number'
    const options =
      type === 'enum' && Array.isArray(raw.options)
        ? raw.options.map((o) => String(o))
        : undefined
    // Enum bounds are derived from the option list, never trusted from the
    // file — a stale min/max would let the cursor index off the end.
    const min = type === 'enum' ? 0 : num(raw.min, 0)
    const max = type === 'enum' ? Math.max(0, (options?.length ?? 1) - 1) : num(raw.max, 1)
    const step = type === 'enum' ? 1 : num(raw.step, 0.01)
    const target = isObj(raw.target)
      ? { nodeId: str(raw.target.nodeId, ''), paramId: str(raw.target.paramId, '') }
      : undefined
    return {
      id,
      kind: 'value',
      label,
      type,
      min,
      max,
      step,
      options,
      value: clampTo(num(raw.value, min), min, max),
      defaultValue: clampTo(num(raw.defaultValue, num(raw.value, min)), min, max),
      unit: typeof raw.unit === 'string' ? raw.unit : undefined,
      target: target && target.nodeId && target.paramId ? target : undefined,
      out: parseOutSlot(raw.out)
    }
  }

  return null
}

/** Guard against a cyclic or absurdly deep hand-edited tree. */
const MAX_DEPTH = 8

export function clampTo(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

export function parseMenuTree(raw: unknown): MenuTree {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return emptyMenuTree()
    }
  }
  if (!isObj(data)) return emptyMenuTree()
  const rootRaw = Array.isArray(data.root) ? data.root : []
  const base = emptyMenuTree()
  return {
    root: rootRaw.map((n) => parseNode(n, 0)).filter((n): n is MenuNode => n !== null),
    longPress: parseAction(data.longPress, base.longPress),
    doubleClick: parseAction(data.doubleClick, base.doubleClick),
    longMs: num(data.longMs, base.longMs),
    doubleMs: num(data.doubleMs, base.doubleMs)
  }
}

export function serializeMenuTree(tree: MenuTree): string {
  return JSON.stringify(tree)
}

/* =====================================================================
 * Traversal helpers.
 * ===================================================================== */

/** The list of entries shown at `path` (empty path = root). */
export function entriesAt(tree: MenuTree, path: number[]): MenuNode[] {
  let list = tree.root
  for (const idx of path) {
    const n = list[idx]
    if (!n || n.kind !== 'submenu') return list
    list = n.children
  }
  return list
}

/** Every value leaf, depth-first — used for CV outs and codegen. */
export function collectValues(tree: MenuTree): MenuValue[] {
  const out: MenuValue[] = []
  const walk = (list: MenuNode[]): void => {
    for (const n of list) {
      if (n.kind === 'value') out.push(n)
      else walk(n.children)
    }
  }
  walk(tree.root)
  return out
}

/** Human-readable value for display: enum label, or number + unit. */
export function formatValue(v: MenuValue): string {
  if (v.type === 'enum') {
    const i = Math.round(clampTo(v.value, v.min, v.max))
    return v.options?.[i] ?? String(i)
  }
  const decimals = v.step >= 1 ? 0 : v.step >= 0.1 ? 1 : 2
  return `${v.value.toFixed(decimals)}${v.unit ?? ''}`
}
