/**
 * Pure 1-bit framebuffer renderer for the OLED node's in-body preview.
 *
 * `renderFrame()` walks the element list and writes into a 128x64 packed
 * 1-bit bitmap. Layout: `bitmap[y * 16 + (x >> 3)]`, bit `x & 7` (LSB = pixel
 * x=0). One pixel per bit; 1 = lit, 0 = off. Matches the SSD1306 linear-byte
 * layout with pages inverted — we only use it as a logical buffer here; the
 * component converts to canvas pixels.
 *
 * Input samples are either a single number (scalar CV value, -1..1) or a
 * `Float32Array` time-domain window. Scope elements prefer the waveform;
 * meter/value/pattern elements collapse to the scalar (mean of the window).
 */

import type {
  BindingSource,
  DisplayElement,
  CircleElement,
  LineElement,
  MeterElement,
  PatternElement,
  RectElement,
  ScopeElement,
  TextElement,
  ValueElement
} from './elements'
import { GLYPH_STRIDE_X, GLYPH_STRIDE_Y, glyphColumns } from './font5x7'

export const OLED_WIDTH = 128
export const OLED_HEIGHT = 64
/** Bytes per row (128 / 8). */
const ROW_STRIDE = 16
/** Total bitmap size in bytes. */
export const OLED_BITMAP_BYTES = ROW_STRIDE * OLED_HEIGHT

export type InputValue = number | Float32Array

export type InputMap = Partial<Record<BindingSource, InputValue>>

function clearBitmap(bitmap: Uint8Array): void {
  bitmap.fill(0)
}

function setPixel(bitmap: Uint8Array, x: number, y: number): void {
  if (x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) return
  bitmap[y * ROW_STRIDE + (x >> 3)] |= 1 << (x & 7)
}

function sampleBuffer(
  inputs: InputMap,
  binding: BindingSource,
  idx: number,
  len: number
): number {
  if (binding === 'none') return 0
  const v = inputs[binding]
  if (v === undefined) return 0
  if (typeof v === 'number') return v
  if (v.length === 0) return 0
  const scaled = Math.floor((idx / Math.max(1, len - 1)) * (v.length - 1))
  return v[Math.min(v.length - 1, Math.max(0, scaled))]
}

function sampleScalar(inputs: InputMap, binding: BindingSource): number {
  if (binding === 'none') return 0
  const v = inputs[binding]
  if (v === undefined) return 0
  if (typeof v === 'number') return v
  if (v.length === 0) return 0
  // RMS over the current window gives a stable meter/value reading.
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  return Math.sqrt(sum / v.length)
}

/** Clamp -1..1 to 0..1 and saturate. */
function unipolar(v: number): number {
  if (!Number.isFinite(v)) return 0
  const a = v < 0 ? -v : v
  return a > 1 ? 1 : a
}

function drawText(bitmap: Uint8Array, text: string, x: number, y: number, size: 1 | 2): void {
  let cx = x
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i)
    const cols = glyphColumns(cp)
    for (let col = 0; col < 5; col++) {
      const bits = cols[col]
      for (let row = 0; row < 7; row++) {
        if ((bits >> row) & 1) {
          if (size === 1) {
            setPixel(bitmap, cx + col, y + row)
          } else {
            // 2x scale: fill a 2x2 block per pixel.
            const px = cx + col * 2
            const py = y + row * 2
            setPixel(bitmap, px, py)
            setPixel(bitmap, px + 1, py)
            setPixel(bitmap, px, py + 1)
            setPixel(bitmap, px + 1, py + 1)
          }
        }
      }
    }
    cx += GLYPH_STRIDE_X * size
  }
  void GLYPH_STRIDE_Y
}

function drawRectOutline(
  bitmap: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  if (w <= 0 || h <= 0) return
  for (let i = 0; i < w; i++) {
    setPixel(bitmap, x + i, y)
    setPixel(bitmap, x + i, y + h - 1)
  }
  for (let j = 0; j < h; j++) {
    setPixel(bitmap, x, y + j)
    setPixel(bitmap, x + w - 1, y + j)
  }
}

function drawRectFilled(
  bitmap: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      setPixel(bitmap, x + i, y + j)
    }
  }
}

/** Midpoint circle algorithm. */
function drawCircle(
  bitmap: Uint8Array,
  cx: number,
  cy: number,
  r: number,
  fill: boolean
): void {
  if (r <= 0) return
  if (fill) {
    for (let dy = -r; dy <= r; dy++) {
      const lim = Math.floor(Math.sqrt(r * r - dy * dy))
      for (let dx = -lim; dx <= lim; dx++) {
        setPixel(bitmap, cx + dx, cy + dy)
      }
    }
    return
  }
  let x = r
  let y = 0
  let err = 1 - x
  while (x >= y) {
    setPixel(bitmap, cx + x, cy + y)
    setPixel(bitmap, cx - x, cy + y)
    setPixel(bitmap, cx + x, cy - y)
    setPixel(bitmap, cx - x, cy - y)
    setPixel(bitmap, cx + y, cy + x)
    setPixel(bitmap, cx - y, cy + x)
    setPixel(bitmap, cx + y, cy - x)
    setPixel(bitmap, cx - y, cy - x)
    y++
    if (err < 0) {
      err += 2 * y + 1
    } else {
      x--
      err += 2 * (y - x) + 1
    }
  }
}

/** Bresenham line. */
function drawLine(
  bitmap: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): void {
  let x = x0
  let y = y0
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  /* eslint-disable no-constant-condition */
  while (true) {
    setPixel(bitmap, x, y)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
}

function drawTextElement(bitmap: Uint8Array, el: TextElement): void {
  drawText(bitmap, el.text, el.x, el.y, el.size)
}

function formatValue(v: number, decimals: number, unit: string | undefined): string {
  const clamped = Number.isFinite(v) ? v : 0
  const s = clamped.toFixed(Math.max(0, Math.min(4, decimals)))
  return unit ? `${s}${unit}` : s
}

function drawValueElement(bitmap: Uint8Array, el: ValueElement, inputs: InputMap): void {
  const raw = sampleScalar(inputs, el.binding)
  const str = formatValue(raw, el.decimals, el.unit)
  drawText(bitmap, str, el.x, el.y, el.size)
}

function drawMeterElement(bitmap: Uint8Array, el: MeterElement, inputs: InputMap): void {
  const v = unipolar(sampleScalar(inputs, el.binding))
  // Frame
  drawRectOutline(bitmap, el.x, el.y, el.width, el.height)
  if (el.width <= 2 || el.height <= 2) return
  if (el.orientation === 'h') {
    const innerW = el.width - 2
    const fillW = Math.round(v * innerW)
    if (fillW > 0) drawRectFilled(bitmap, el.x + 1, el.y + 1, fillW, el.height - 2)
  } else {
    const innerH = el.height - 2
    const fillH = Math.round(v * innerH)
    if (fillH > 0) {
      drawRectFilled(bitmap, el.x + 1, el.y + 1 + (innerH - fillH), el.width - 2, fillH)
    }
  }
}

function drawScopeElement(bitmap: Uint8Array, el: ScopeElement, inputs: InputMap): void {
  drawRectOutline(bitmap, el.x, el.y, el.width, el.height)
  if (el.width <= 2 || el.height <= 2) return
  const innerW = el.width - 2
  const innerH = el.height - 2
  const midY = el.y + 1 + (innerH >> 1)
  let lastY = midY
  for (let i = 0; i < innerW; i++) {
    const s = sampleBuffer(inputs, el.binding, i, innerW)
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s
    const py = midY - Math.round(clamped * (innerH >> 1))
    const px = el.x + 1 + i
    if (i === 0) {
      setPixel(bitmap, px, py)
    } else {
      drawLine(bitmap, el.x + i, lastY, px, py)
    }
    lastY = py
  }
}

function drawRectElement(bitmap: Uint8Array, el: RectElement, inputs: InputMap): void {
  let w = el.width
  let h = el.height
  if (el.binding && el.binding !== 'none') {
    const v = unipolar(sampleScalar(inputs, el.binding))
    w = Math.max(1, Math.round(el.width * v))
    h = Math.max(1, Math.round(el.height * v))
  }
  if (el.fill) drawRectFilled(bitmap, el.x, el.y, w, h)
  else drawRectOutline(bitmap, el.x, el.y, w, h)
}

function drawCircleElement(bitmap: Uint8Array, el: CircleElement): void {
  drawCircle(bitmap, el.x, el.y, el.radius, el.fill)
}

function drawLineElement(bitmap: Uint8Array, el: LineElement): void {
  drawLine(bitmap, el.x, el.y, el.x2, el.y2)
}

function drawPatternElement(
  bitmap: Uint8Array,
  el: PatternElement,
  inputs: InputMap
): void {
  const v = unipolar(sampleScalar(inputs, el.binding))
  const total = el.cols * el.rows
  const lit = Math.round(v * total)
  let n = 0
  for (let r = 0; r < el.rows; r++) {
    for (let c = 0; c < el.cols; c++) {
      const gx = el.x + c * el.cellSize
      const gy = el.y + r * el.cellSize
      if (n < lit) {
        drawRectFilled(bitmap, gx + 1, gy + 1, Math.max(1, el.cellSize - 2), Math.max(1, el.cellSize - 2))
      } else {
        drawRectOutline(bitmap, gx, gy, el.cellSize, el.cellSize)
      }
      n++
    }
  }
}

/** Render the whole frame. Clears `bitmap` first. */
export function renderFrame(
  elements: DisplayElement[],
  inputs: InputMap,
  bitmap: Uint8Array
): void {
  clearBitmap(bitmap)
  for (const el of elements) {
    switch (el.kind) {
      case 'text':
        drawTextElement(bitmap, el)
        break
      case 'value':
        drawValueElement(bitmap, el, inputs)
        break
      case 'meter':
        drawMeterElement(bitmap, el, inputs)
        break
      case 'scope':
        drawScopeElement(bitmap, el, inputs)
        break
      case 'rect':
        drawRectElement(bitmap, el, inputs)
        break
      case 'circle':
        drawCircleElement(bitmap, el)
        break
      case 'line':
        drawLineElement(bitmap, el)
        break
      case 'pattern':
        drawPatternElement(bitmap, el, inputs)
        break
    }
  }
}

/** Whether the given pixel (x,y) is lit in `bitmap`. */
export function getPixel(bitmap: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) return false
  return (bitmap[y * ROW_STRIDE + (x >> 3)] & (1 << (x & 7))) !== 0
}
