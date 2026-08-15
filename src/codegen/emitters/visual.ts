import { MENU_DRAW_DAISY_CPP, MENU_RUNTIME_CPP } from '../menuCodegen'
import type { EmitContext, NodeEmitter } from './shared'


// ---------------------------------------------------------------------------
// Visual / passthrough nodes
// ---------------------------------------------------------------------------

export const visualPassthrough: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = ${i}; // ${ctx.node.kind}: emulator-only, passthrough on hardware\n`
  }
}

// ---------------------------------------------------------------------------
// OLED (SSD1306 over I2C)
// ---------------------------------------------------------------------------
//
// Produces libDaisy `OledDisplay<SSD130xI2c128x64Driver>` init and a real
// `<var>_DrawFrame()` function (file scope, emitted from `declare`) that
// renders the user-designed element list. Input sampling goes through
// `volatile float` caches latched each AudioCallback sample and read by
// the draw function — not sample-accurate, but fine for a 30 Hz display.
//
// The `loop` hook calls `<var>_DrawFrame()` from main()'s `while(1)`,
// throttled to ~30 fps via `System::GetNow()`. Drawing NEVER runs in
// AudioCallback: a full 128x64 frame over I2C@400kHz is >20 ms of
// blocking transfer.
//
// Transport: the `oled_ssd1306` placed component only exposes `sda`/`scl`
// roles (see KIND_ROLES in src/types/hardware.ts), so I2C is the one
// transport the hardware model can express; the SPI driver variants are
// intentionally not emitted.
//
// The emitter is defensive: if there is no hardware layout yet (parallel
// agent in flight) OR the node's `bindingId` doesn't resolve to a placed
// OLED with `sda`+`scl` pins, we emit default I2C1 pins (D11/D12 on the
// Daisy Seed) and attach a `warn(...)` so the user sees it.

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

function sanitizeCString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
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

function bindingToCache(b: unknown, v: string): string {
  if (typeof b !== 'string') return '0.f'
  const idx = OLED_INPUT_SOCKETS.indexOf(b as 'a')
  if (idx < 0) return '0.f'
  return `${v}_in_${b}`
}

/**
 * C++ for one OLED element, using the libDaisy `OneBitGraphicsDisplay`
 * API (SetCursor/WriteString/DrawRect/DrawCircle/DrawLine/DrawPixel).
 * Rendering semantics mirror the ESP32 Adafruit_SSD1306 emitter 1:1 —
 * note the coordinate-convention translation: Adafruit rects take
 * (x, y, w, h) covering pixels x..x+w-1, libDaisy's DrawRect takes
 * inclusive corners (x1, y1, x2, y2), hence the `- 1` on extents.
 * Lines are indented for a function body; unknown kinds emit nothing.
 */
function emitOledElement(el: OledElement, v: string, menuVars: Map<string, string>): string {
  const x = typeof el.x === 'number' ? el.x | 0 : 0
  const y = typeof el.y === 'number' ? el.y | 0 : 0
  const k = el.kind
  if (k === 'menu') {
    const w = typeof el.width === 'number' ? el.width | 0 : 128
    const h = typeof el.height === 'number' ? el.height | 0 : 64
    const rows = typeof el.rows === 'number' ? el.rows | 0 : 6
    const mv = typeof el.menuNodeId === 'string' ? menuVars.get(el.menuNodeId) : undefined
    if (!mv) {
      // Same fallback the emulator's renderer draws, so an unbound element
      // looks identical in the app and on the panel.
      return [
        `    ${v}.SetCursor(${x + 2}, ${y + 2});`,
        `    ${v}.WriteString("NO MENU BOUND", Font_6x8, true);`
      ].join('\n')
    }
    return `    dp_menu_draw(${v}, &${mv}_m, ${x}, ${y}, ${w}, ${h}, ${rows});`
  }
  if (k === 'text') {
    const t = sanitizeCString(typeof el.text === 'string' ? el.text : '')
    const fontExpr = el.size === 2 ? 'Font_11x18' : 'Font_6x8'
    return [
      `    ${v}.SetCursor(${x}, ${y});`,
      `    ${v}.WriteString("${t}", ${fontExpr}, true);`
    ].join('\n')
  }
  if (k === 'value') {
    const cache = bindingToCache(el.binding, v)
    const decimals = typeof el.decimals === 'number' ? el.decimals | 0 : 2
    const unit = sanitizeCString(typeof el.unit === 'string' ? el.unit : '')
    const fontExpr = el.size === 2 ? 'Font_11x18' : 'Font_6x8'
    return [
      `    {`,
      `        char _buf[24];`,
      `        snprintf(_buf, sizeof _buf, "%.${decimals}f${unit}", (double)(${cache}));`,
      `        ${v}.SetCursor(${x}, ${y});`,
      `        ${v}.WriteString(_buf, ${fontExpr}, true);`,
      `    }`
    ].join('\n')
  }
  if (k === 'meter') {
    const cache = bindingToCache(el.binding, v)
    const w = typeof el.width === 'number' ? el.width | 0 : 40
    const h = typeof el.height === 'number' ? el.height | 0 : 8
    const lines: string[] = [
      `    {`,
      `        float _mv = fabsf(${cache});`,
      `        if (_mv > 1.f) _mv = 1.f;`,
      `        ${v}.DrawRect(${x}, ${y}, ${x + w - 1}, ${y + h - 1}, true, false);`
    ]
    if (el.orientation === 'v') {
      lines.push(`        int _fh = (int)(_mv * (float)(${h - 2}));`)
      lines.push(
        `        if (_fh > 0) ${v}.DrawRect(${x + 1}, ${y + h - 1} - _fh, ${x + w - 2}, ${y + h - 2}, true, true);`
      )
    } else {
      lines.push(`        int _fw = (int)(_mv * (float)(${w - 2}));`)
      lines.push(
        `        if (_fw > 0) ${v}.DrawRect(${x + 1}, ${y + 1}, ${x} + _fw, ${y + h - 2}, true, true);`
      )
    }
    lines.push(`    }`)
    return lines.join('\n')
  }
  if (k === 'scope') {
    const cache = bindingToCache(el.binding, v)
    const w = typeof el.width === 'number' ? el.width | 0 : 64
    const h = typeof el.height === 'number' ? el.height | 0 : 24
    return [
      `    { // scope — single-sample sparkline`,
      `        int _pxY = ${y + (h >> 1)} - (int)((${cache}) * (float)(${h >> 1}));`,
      `        if (_pxY >= 0 && _pxY < 64) {`,
      `            for (int _xx = 0; _xx < ${w}; _xx++) ${v}.DrawPixel(${x} + _xx, _pxY, true);`,
      `        }`,
      `    }`
    ].join('\n')
  }
  if (k === 'rect') {
    const w = typeof el.width === 'number' ? el.width | 0 : 20
    const h = typeof el.height === 'number' ? el.height | 0 : 12
    const fillArg = el.fill === true ? 'true' : 'false'
    return `    ${v}.DrawRect(${x}, ${y}, ${x + w - 1}, ${y + h - 1}, true, ${fillArg});`
  }
  if (k === 'circle') {
    const r = typeof el.radius === 'number' ? el.radius | 0 : 6
    return `    ${v}.DrawCircle(${x}, ${y}, ${r}, true);`
  }
  if (k === 'line') {
    const x2 = typeof el.x2 === 'number' ? el.x2 | 0 : x + 8
    const y2 = typeof el.y2 === 'number' ? el.y2 | 0 : y
    return `    ${v}.DrawLine(${x}, ${y}, ${x2}, ${y2}, true);`
  }
  if (k === 'pattern') {
    const cache = bindingToCache(el.binding, v)
    const cols = typeof el.cols === 'number' ? el.cols | 0 : 8
    const rows = typeof el.rows === 'number' ? el.rows | 0 : 2
    const cell = typeof el.cellSize === 'number' ? el.cellSize | 0 : 4
    return [
      `    {`,
      `        float _pv = fabsf(${cache});`,
      `        if (_pv > 1.f) _pv = 1.f;`,
      `        int _lit = (int)(_pv * (float)(${cols * rows}));`,
      `        for (int _rr = 0; _rr < ${rows}; _rr++) for (int _cc = 0; _cc < ${cols}; _cc++) {`,
      `            int _idx = _rr * ${cols} + _cc;`,
      `            ${v}.DrawRect(${x} + _cc * ${cell}, ${y} + _rr * ${cell}, ${x} + _cc * ${cell} + ${cell - 2}, ${y} + _rr * ${cell} + ${cell - 2}, true, _idx < _lit);`,
      `        }`,
      `    }`
    ].join('\n')
  }
  return ''
}

export const oled: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const elements = parseOledElements(ctx.node.params.elements)
    if (elements.length > 12) {
      ctx.warn('oled draw is approximate at high element counts')
    }
    const lines: string[] = []
    // daisy_seed.h pulls in OledDisplay<> but not the SSD130x driver
    // header — bring it in at file scope so the template arg resolves.
    lines.push(`#include "dev/oled_ssd130x.h"`)
    lines.push(`#include <cstdio>`)
    /*
     * Menu elements need the runtime + draw helpers defined ABOVE
     * `<v>_DrawFrame()`, which is emitted a few lines down in this same
     * declare block. The menu node emits the runtime too (both are guarded
     * by `#ifndef DP_MENU_RUNTIME`, so whichever lands first wins), but its
     * `DpMenu` instance may be declared after this block — hence the
     * `extern`. Which of the two nodes topo-sorts first is not something
     * this emitter should have to care about.
     */
    const menuVars = menuVarsForElements(ctx, elements)
    if (menuVars.size > 0) {
      lines.push(MENU_RUNTIME_CPP)
      lines.push(MENU_DRAW_DAISY_CPP)
      for (const mv of menuVars.values()) lines.push(`extern DpMenu ${mv}_m;`)
    }
    lines.push(`using ${v}_Type = OledDisplay<SSD130xI2c128x64Driver>;`)
    lines.push(`${v}_Type ${v};`)
    // Written per-sample in AudioCallback (interrupt context), read by
    // ${v}_DrawFrame() from main()'s while(1) — volatile keeps the
    // cross-context reads honest.
    for (const sock of OLED_INPUT_SOCKETS) {
      lines.push(`volatile float ${v}_in_${sock} = 0.f;`)
    }
    lines.push(`uint32_t ${v}_last_frame_ms = 0;`)
    lines.push(``)
    lines.push(`// Full display refresh for ${v}. Called from main()'s while(1) at`)
    lines.push(`// ~30 fps — NEVER from AudioCallback (blocking I2C transfer).`)
    lines.push(`void ${v}_DrawFrame() {`)
    lines.push(`    ${v}.Fill(false);`)
    for (const el of elements) {
      const code = emitOledElement(el, v, menuVars)
      if (code) lines.push(code)
    }
    lines.push(`    ${v}.Update();`)
    lines.push(`}`)
    return lines.join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const bindingId =
      typeof ctx.node.params.bindingId === 'string'
        ? ctx.node.params.bindingId
        : ''
    const hw = ctx.hardware

    let sdaPin: string | null = null
    let sclPin: string | null = null
    let bindingLabel: string | null = null
    if (bindingId && hw) {
      const comp = hw.components.find((c) => c.id === bindingId)
      if (comp) {
        const sda = comp.pins['sda']
        const scl = comp.pins['scl']
        if (sda) sdaPin = sda
        if (scl) sclPin = scl
        bindingLabel = comp.label
      }
    }

    if (!sdaPin || !sclPin) {
      ctx.warn('oled not bound to hardware; using default I2C1 pins (D11/D12)')
      sdaPin = sdaPin ?? 'D12'
      sclPin = sclPin ?? 'D11'
    }

    const sdaD = parseInt(sdaPin.slice(1), 10)
    const sclD = parseInt(sclPin.slice(1), 10)

    return [
      `    // --- OLED: ${bindingLabel ?? 'unbound — default I2C1 pins'} ---`,
      `    {`,
      `        ${v}_Type::Config oled_cfg;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.mode   = I2CHandle::Config::Mode::I2C_MASTER;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.periph = I2CHandle::Config::Peripheral::I2C_1;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.speed  = I2CHandle::Config::Speed::I2C_400KHZ;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.pin_config.scl = hw.GetPin(${sclD});`,
      `        oled_cfg.driver_config.transport_config.i2c_config.pin_config.sda = hw.GetPin(${sdaD});`,
      `        oled_cfg.driver_config.transport_config.i2c_address = 0x3C;`,
      `        ${v}.Init(oled_cfg);`,
      `    }`
    ].join('\n')
  },

  /**
   * Per-AudioCallback sample: latch the current input values into the
   * per-node caches so `<var>_DrawFrame()` (invoked from main()'s while(1)
   * via the `loop` hook) sees stable values. No audio outputs — the node
   * is a sink.
   */
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines: string[] = []
    lines.push(`    // --- OLED ${v}: latch input samples for ${v}_DrawFrame() ---`)
    for (const sock of OLED_INPUT_SOCKETS) {
      const expr = ctx.inputExpr(ctx.node.id, sock, '0.f')
      lines.push(`    ${v}_in_${sock} = ${expr};`)
    }
    return lines.join('\n') + '\n'
  },

  /**
   * Main-loop hook: refresh the display at ~30 fps. `System::GetNow()`
   * is libDaisy's ms tick; unsigned subtraction survives wraparound.
   * The blocking I2C traffic (~1 KB framebuffer) lives here, never in
   * AudioCallback.
   */
  loop: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `        { // OLED ${v}: throttled refresh (~30 fps)`,
      `            uint32_t _now = System::GetNow();`,
      `            if (_now - ${v}_last_frame_ms >= 33) {`,
      `                ${v}_last_frame_ms = _now;`,
      `                ${v}_DrawFrame();`,
      `            }`,
      `        }`
    ].join('\n')
  }
}
