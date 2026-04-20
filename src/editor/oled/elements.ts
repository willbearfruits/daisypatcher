/**
 * Display-element schema for the OLED node. Elements describe what gets
 * drawn on the 128x64 SSD1306 screen. The node stores a JSON-serialised
 * array of these in its `elements` param.
 *
 * All positions are in pixel space: x in [0..127], y in [0..63]. Everything
 * is 1-bit (on/off); the preview renders pixels using the `--dp-signal-audio`
 * token to echo the physical blue/white OLED look.
 */

export type ElementKind =
  | 'text'
  | 'value'
  | 'meter'
  | 'scope'
  | 'rect'
  | 'circle'
  | 'line'
  | 'pattern'

export type BindingSource = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'none'

export interface BaseElement {
  id: string
  kind: ElementKind
  x: number
  y: number
}

export interface TextElement extends BaseElement {
  kind: 'text'
  text: string
  size: 1 | 2
}

export interface ValueElement extends BaseElement {
  kind: 'value'
  binding: BindingSource
  decimals: number
  unit?: string
  size: 1 | 2
}

export interface MeterElement extends BaseElement {
  kind: 'meter'
  binding: BindingSource
  width: number
  height: number
  orientation: 'h' | 'v'
}

export interface ScopeElement extends BaseElement {
  kind: 'scope'
  binding: BindingSource
  width: number
  height: number
}

export interface RectElement extends BaseElement {
  kind: 'rect'
  width: number
  height: number
  fill: boolean
  binding?: BindingSource
}

export interface CircleElement extends BaseElement {
  kind: 'circle'
  radius: number
  fill: boolean
}

export interface LineElement extends BaseElement {
  kind: 'line'
  x2: number
  y2: number
}

export interface PatternElement extends BaseElement {
  kind: 'pattern'
  cols: number
  rows: number
  cellSize: number
  binding: BindingSource
}

export type DisplayElement =
  | TextElement
  | ValueElement
  | MeterElement
  | ScopeElement
  | RectElement
  | CircleElement
  | LineElement
  | PatternElement

export const BINDING_VALUES: BindingSource[] = ['a', 'b', 'c', 'd', 'e', 'f', 'none']

function genId(): string {
  return 'el_' + Math.random().toString(36).slice(2, 10)
}

const VALID_KINDS = new Set<ElementKind>([
  'text',
  'value',
  'meter',
  'scope',
  'rect',
  'circle',
  'line',
  'pattern'
])

function isBinding(v: unknown): v is BindingSource {
  return typeof v === 'string' && (BINDING_VALUES as string[]).includes(v)
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  const n = Math.round(v)
  return n < min ? min : n > max ? max : n
}

function clampSize(v: unknown): 1 | 2 {
  return v === 2 ? 2 : 1
}

/**
 * Parse a JSON-serialised elements array defensively. Unknown kinds are
 * dropped; missing fields get sensible defaults. Never throws.
 */
export function parseElements(raw: string): DisplayElement[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: DisplayElement[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const kind = rec.kind
    if (typeof kind !== 'string' || !VALID_KINDS.has(kind as ElementKind)) continue
    const id = typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : genId()
    const x = clampInt(rec.x, 0, 127, 0)
    const y = clampInt(rec.y, 0, 63, 0)
    switch (kind as ElementKind) {
      case 'text':
        out.push({
          id,
          kind: 'text',
          x,
          y,
          text: typeof rec.text === 'string' ? rec.text : '',
          size: clampSize(rec.size)
        })
        break
      case 'value':
        out.push({
          id,
          kind: 'value',
          x,
          y,
          binding: isBinding(rec.binding) ? rec.binding : 'a',
          decimals: clampInt(rec.decimals, 0, 4, 2),
          unit: typeof rec.unit === 'string' ? rec.unit : '',
          size: clampSize(rec.size)
        })
        break
      case 'meter':
        out.push({
          id,
          kind: 'meter',
          x,
          y,
          binding: isBinding(rec.binding) ? rec.binding : 'a',
          width: clampInt(rec.width, 2, 128, 40),
          height: clampInt(rec.height, 2, 64, 8),
          orientation: rec.orientation === 'v' ? 'v' : 'h'
        })
        break
      case 'scope':
        out.push({
          id,
          kind: 'scope',
          x,
          y,
          binding: isBinding(rec.binding) ? rec.binding : 'a',
          width: clampInt(rec.width, 8, 128, 64),
          height: clampInt(rec.height, 4, 64, 24)
        })
        break
      case 'rect': {
        const el: RectElement = {
          id,
          kind: 'rect',
          x,
          y,
          width: clampInt(rec.width, 1, 128, 20),
          height: clampInt(rec.height, 1, 64, 12),
          fill: rec.fill === true
        }
        if (isBinding(rec.binding)) el.binding = rec.binding
        out.push(el)
        break
      }
      case 'circle':
        out.push({
          id,
          kind: 'circle',
          x,
          y,
          radius: clampInt(rec.radius, 1, 32, 6),
          fill: rec.fill === true
        })
        break
      case 'line':
        out.push({
          id,
          kind: 'line',
          x,
          y,
          x2: clampInt(rec.x2, 0, 127, Math.min(127, x + 16)),
          y2: clampInt(rec.y2, 0, 63, y)
        })
        break
      case 'pattern':
        out.push({
          id,
          kind: 'pattern',
          x,
          y,
          cols: clampInt(rec.cols, 1, 32, 8),
          rows: clampInt(rec.rows, 1, 8, 2),
          cellSize: clampInt(rec.cellSize, 1, 16, 4),
          binding: isBinding(rec.binding) ? rec.binding : 'a'
        })
        break
    }
  }
  return out
}

export function serializeElements(elements: DisplayElement[]): string {
  return JSON.stringify(elements)
}

/**
 * Default element created by the in-node toolbar when the user clicks "add".
 * Positions at the center of the 128x64 display.
 */
export function makeDefaultElement(kind: ElementKind): DisplayElement {
  const id = genId()
  switch (kind) {
    case 'text':
      return { id, kind: 'text', x: 4, y: 4, text: 'HELLO', size: 1 }
    case 'value':
      return {
        id,
        kind: 'value',
        x: 4,
        y: 20,
        binding: 'a',
        decimals: 2,
        unit: '',
        size: 1
      }
    case 'meter':
      return {
        id,
        kind: 'meter',
        x: 4,
        y: 40,
        binding: 'a',
        width: 60,
        height: 8,
        orientation: 'h'
      }
    case 'scope':
      return { id, kind: 'scope', x: 32, y: 20, binding: 'a', width: 64, height: 24 }
    case 'rect':
      return { id, kind: 'rect', x: 40, y: 20, width: 40, height: 20, fill: false }
    case 'circle':
      return { id, kind: 'circle', x: 64, y: 32, radius: 8, fill: false }
    case 'line':
      return { id, kind: 'line', x: 8, y: 32, x2: 120, y2: 32 }
    case 'pattern':
      return {
        id,
        kind: 'pattern',
        x: 8,
        y: 40,
        cols: 8,
        rows: 2,
        cellSize: 4,
        binding: 'a'
      }
  }
}

/** One-line description for the element list row. */
export function describeElement(el: DisplayElement): string {
  switch (el.kind) {
    case 'text':
      return `Text "${el.text}"`
    case 'value':
      return `Value ${el.binding.toUpperCase()}${el.unit ? ` ${el.unit}` : ''}`
    case 'meter':
      return `Meter ${el.binding.toUpperCase()} ${el.orientation}`
    case 'scope':
      return `Scope ${el.binding.toUpperCase()} ${el.width}x${el.height}`
    case 'rect':
      return `Rect ${el.width}x${el.height}${el.fill ? ' fill' : ''}`
    case 'circle':
      return `Circle r=${el.radius}${el.fill ? ' fill' : ''}`
    case 'line':
      return `Line ${el.x},${el.y}→${el.x2},${el.y2}`
    case 'pattern':
      return `Pattern ${el.cols}x${el.rows} ${el.binding.toUpperCase()}`
  }
}

/**
 * Axis-aligned bounding box of an element on the 128x64 canvas, used for
 * hit-testing clicks in the preview.
 */
export function elementBBox(el: DisplayElement): {
  x: number
  y: number
  w: number
  h: number
} {
  switch (el.kind) {
    case 'text': {
      const gw = 6 * el.size
      const gh = 8 * el.size
      return { x: el.x, y: el.y, w: Math.max(gw, gw * el.text.length), h: gh }
    }
    case 'value': {
      const gw = 6 * el.size
      const gh = 8 * el.size
      // Rough: decimals + sign + possibly "1.0" + unit. Give it room.
      const chars = 4 + el.decimals + (el.unit ? el.unit.length + 1 : 0)
      return { x: el.x, y: el.y, w: gw * chars, h: gh }
    }
    case 'meter':
      return { x: el.x, y: el.y, w: el.width, h: el.height }
    case 'scope':
      return { x: el.x, y: el.y, w: el.width, h: el.height }
    case 'rect':
      return { x: el.x, y: el.y, w: el.width, h: el.height }
    case 'circle':
      return {
        x: el.x - el.radius,
        y: el.y - el.radius,
        w: el.radius * 2 + 1,
        h: el.radius * 2 + 1
      }
    case 'line': {
      const x0 = Math.min(el.x, el.x2)
      const y0 = Math.min(el.y, el.y2)
      return {
        x: x0,
        y: y0,
        w: Math.abs(el.x2 - el.x) + 1,
        h: Math.abs(el.y2 - el.y) + 1
      }
    }
    case 'pattern':
      return {
        x: el.x,
        y: el.y,
        w: el.cols * el.cellSize,
        h: el.rows * el.cellSize
      }
  }
}
