import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { EmitContext, NodeEmitter } from '../nodeEmitters'
import { MENU_DRAW_ESP32_CPP, MENU_RUNTIME_CPP } from '../menuCodegen'


/* --------------------------- OLED --------------------------- */
//
// Uses Adafruit_SSD1306 over I2C (Wire.h). The target emits `Wire.begin(sda, scl)`
// in its hardware init block when an OLED component is placed. This emitter
// instantiates the device and renders the configured element list in the
// audio callback's per-sample loop — once per block is enough in practice;
// rendering on every sample is wasteful but keeps the emitter local and
// deterministic. We throttle with a counter so display.display() fires at
// ~30 Hz rather than every sample.

const OLED_INPUT_SOCKETS: ReadonlyArray<'a' | 'b' | 'c' | 'd' | 'e' | 'f'> = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f'
]

interface OledElement {
  kind: string
  x?: number
  y?: number
  text?: string
  size?: number
  binding?: string
  decimals?: number
  unit?: string
  width?: number
  height?: number
  orientation?: string
  radius?: number
  fill?: boolean
  x2?: number
  y2?: number
  cols?: number
  rows?: number
  cellSize?: number
  /** `menu` elements only — graph id of the menu node to draw. */
  menuNodeId?: string
}

function parseOledElements(raw: unknown): OledElement[] {
  if (typeof raw !== 'string') return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data as OledElement[]
  } catch {
    return []
  }
}

export function sanitizeCString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function bindingCacheName(b: unknown, v: string): string {
  if (typeof b !== 'string') return '0.f'
  const idx = OLED_INPUT_SOCKETS.indexOf(b as 'a')
  if (idx < 0) return '0.f'
  return `${v}_in_${b}`
}

/** Menu nodes referenced by an element list, as `elementId -> C++ var`. */
function menuVarsForElements(
  ctx: EmitContext,
  elements: OledElement[]
): Map<string, string> {
  const out = new Map<string, string>()
  for (const el of elements) {
    if (el.kind !== 'menu' || typeof el.menuNodeId !== 'string') continue
    const node = ctx.graph.nodes.find((n) => n.id === el.menuNodeId && n.kind === 'menu')
    if (node) out.set(el.menuNodeId, ctx.varName(node.id))
  }
  return out
}

export const oled: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines: string[] = []
    lines.push(`#ifndef DP_OLED_INCLUDED`)
    lines.push(`#define DP_OLED_INCLUDED 1`)
    lines.push(`#include <Adafruit_SSD1306.h>`)
    lines.push(`#endif`)
    // Menu drawing needs Adafruit_SSD1306 to already be visible, and the
    // runtime it builds on. Both are include-guarded, so emitting them from
    // here as well as from the menu node is idempotent regardless of which
    // node topo-sorts first.
    const elements = parseOledElements(ctx.node.params.elements)
    const menuVars = menuVarsForElements(ctx, elements)
    if (menuVars.size > 0) {
      lines.push(MENU_RUNTIME_CPP)
      lines.push(MENU_DRAW_ESP32_CPP)
      for (const mv of menuVars.values()) lines.push(`extern DpMenu ${mv}_m;`)
    }
    lines.push(`Adafruit_SSD1306 ${v}(128, 64, &Wire);`)
    for (const sock of OLED_INPUT_SOCKETS) lines.push(`float ${v}_in_${sock} = 0.f;`)
    lines.push(`int ${v}_draw_ctr = 0;`)
    return lines.join('\n')
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `    ${v}.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n    ${v}.clearDisplay();\n    ${v}.display();`
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const elements = parseOledElements(ctx.node.params.elements)
    if (elements.length > 12) ctx.warn('oled draw is approximate at high element counts')
    const menuVars = menuVarsForElements(ctx, elements)

    const lines: string[] = []
    lines.push(`    // --- OLED ${v}: latch inputs, render at ~30 Hz ---`)
    for (const sock of OLED_INPUT_SOCKETS) {
      const expr = ctx.inputExpr(ctx.node.id, sock, '0.f')
      lines.push(`    ${v}_in_${sock} = ${expr};`)
    }
    // Throttle: SAMPLE_RATE / 30 ≈ 1600 samples at 48 kHz.
    lines.push(`    ${v}_draw_ctr++;`)
    lines.push(`    if (${v}_draw_ctr >= (SAMPLE_RATE / 30)) {`)
    lines.push(`        ${v}_draw_ctr = 0;`)
    lines.push(`        ${v}.clearDisplay();`)
    for (const el of elements) {
      const x = typeof el.x === 'number' ? el.x | 0 : 0
      const y = typeof el.y === 'number' ? el.y | 0 : 0
      if (el.kind === 'text') {
        const t = sanitizeCString(typeof el.text === 'string' ? el.text : '')
        const sz = el.size === 2 ? 2 : 1
        lines.push(`        ${v}.setTextSize(${sz});`)
        lines.push(`        ${v}.setTextColor(SSD1306_WHITE);`)
        lines.push(`        ${v}.setCursor(${x}, ${y});`)
        lines.push(`        ${v}.print("${t}");`)
      } else if (el.kind === 'value') {
        const cache = bindingCacheName(el.binding, v)
        const decimals = typeof el.decimals === 'number' ? el.decimals | 0 : 2
        const unit = sanitizeCString(typeof el.unit === 'string' ? el.unit : '')
        const sz = el.size === 2 ? 2 : 1
        lines.push(`        { char _buf[24]; snprintf(_buf, sizeof _buf, "%.${decimals}f${unit}", ${cache});`)
        lines.push(`          ${v}.setTextSize(${sz}); ${v}.setTextColor(SSD1306_WHITE);`)
        lines.push(`          ${v}.setCursor(${x}, ${y}); ${v}.print(_buf); }`)
      } else if (el.kind === 'meter') {
        const cache = bindingCacheName(el.binding, v)
        const w = typeof el.width === 'number' ? el.width | 0 : 40
        const h = typeof el.height === 'number' ? el.height | 0 : 8
        lines.push(`        { float _mv = fabsf(${cache}); if (_mv > 1.f) _mv = 1.f;`)
        lines.push(`          ${v}.drawRect(${x}, ${y}, ${w}, ${h}, SSD1306_WHITE);`)
        if (el.orientation === 'v') {
          lines.push(`          int _fh = (int)(_mv * (float)(${h - 2}));`)
          lines.push(`          ${v}.fillRect(${x + 1}, ${y + h - 1} - _fh, ${w - 2}, _fh, SSD1306_WHITE); }`)
        } else {
          lines.push(`          int _fw = (int)(_mv * (float)(${w - 2}));`)
          lines.push(`          ${v}.fillRect(${x + 1}, ${y + 1}, _fw, ${h - 2}, SSD1306_WHITE); }`)
        }
      } else if (el.kind === 'scope') {
        const cache = bindingCacheName(el.binding, v)
        const w = typeof el.width === 'number' ? el.width | 0 : 64
        const h = typeof el.height === 'number' ? el.height | 0 : 24
        lines.push(`        { int _midY = ${y + (h >> 1)};`)
        lines.push(`          int _pxY = _midY - (int)((${cache}) * (float)(${h >> 1}));`)
        lines.push(`          for (int _xx = 0; _xx < ${w}; _xx++) ${v}.drawPixel(${x} + _xx, _pxY, SSD1306_WHITE); }`)
      } else if (el.kind === 'rect') {
        const w = typeof el.width === 'number' ? el.width | 0 : 20
        const h = typeof el.height === 'number' ? el.height | 0 : 12
        if (el.fill === true) {
          lines.push(`        ${v}.fillRect(${x}, ${y}, ${w}, ${h}, SSD1306_WHITE);`)
        } else {
          lines.push(`        ${v}.drawRect(${x}, ${y}, ${w}, ${h}, SSD1306_WHITE);`)
        }
      } else if (el.kind === 'circle') {
        const r = typeof el.radius === 'number' ? el.radius | 0 : 6
        lines.push(`        ${v}.drawCircle(${x}, ${y}, ${r}, SSD1306_WHITE);`)
      } else if (el.kind === 'line') {
        const x2 = typeof el.x2 === 'number' ? el.x2 | 0 : x + 8
        const y2 = typeof el.y2 === 'number' ? el.y2 | 0 : y
        lines.push(`        ${v}.drawLine(${x}, ${y}, ${x2}, ${y2}, SSD1306_WHITE);`)
      } else if (el.kind === 'menu') {
        const w = typeof el.width === 'number' ? el.width | 0 : 128
        const h = typeof el.height === 'number' ? el.height | 0 : 64
        const rows = typeof el.rows === 'number' ? el.rows | 0 : 6
        const mv = typeof el.menuNodeId === 'string' ? menuVars.get(el.menuNodeId) : undefined
        if (!mv) {
          // Same fallback the emulator's renderer draws.
          lines.push(`        ${v}.setTextSize(1); ${v}.setTextColor(SSD1306_WHITE);`)
          lines.push(`        ${v}.setCursor(${x + 2}, ${y + 2}); ${v}.print("NO MENU BOUND");`)
        } else {
          lines.push(`        dp_menu_draw(${v}, &${mv}_m, ${x}, ${y}, ${w}, ${h}, ${rows});`)
        }
      } else if (el.kind === 'pattern') {
        const cache = bindingCacheName(el.binding, v)
        const cols = typeof el.cols === 'number' ? el.cols | 0 : 8
        const rows = typeof el.rows === 'number' ? el.rows | 0 : 2
        const cell = typeof el.cellSize === 'number' ? el.cellSize | 0 : 4
        lines.push(`        { float _pv = fabsf(${cache}); if (_pv > 1.f) _pv = 1.f;`)
        lines.push(`          int _lit = (int)(_pv * (float)(${cols * rows}));`)
        lines.push(`          for (int _rr = 0; _rr < ${rows}; _rr++) for (int _cc = 0; _cc < ${cols}; _cc++) {`)
        lines.push(`            int _idx = _rr * ${cols} + _cc;`)
        lines.push(`            if (_idx < _lit) ${v}.fillRect(${x} + _cc * ${cell}, ${y} + _rr * ${cell}, ${cell - 1}, ${cell - 1}, SSD1306_WHITE);`)
        lines.push(`            else ${v}.drawRect(${x} + _cc * ${cell}, ${y} + _rr * ${cell}, ${cell - 1}, ${cell - 1}, SSD1306_WHITE);`)
        lines.push(`          } }`)
      }
    }
    lines.push(`        ${v}.display();`)
    lines.push(`    }`)
    return lines.join('\n') + '\n'
  }
}

/* --------------------------- visual stubs --------------------------- */

export const visualPassthrough: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const def = NODE_DEFINITIONS[ctx.node.kind]
    if (!def) return ''
    const input = ctx.inputExpr(ctx.node.id, def.inputs[0]?.id ?? '', '0.f')
    const lines: string[] = [`    // ${ctx.node.kind}: no-op on ESP32 (visual-only)`]
    for (const out of def.outputs) {
      lines.push(`    float ${ctx.outputVar(ctx.node.id, out.id)} = ${input};`)
    }
    return lines.join('\n') + '\n'
  }
}
