/**
 * HardwareView — full-canvas hardware layout editor. Replaces the patch-
 * graph Rete canvas when `store.view === 'hardware'`.
 *
 * Visual design (2026-04-21 rewrite):
 *   - Portrait canvas (SVG viewBox 1100 x 1500), modelled on the Electro-
 *     smith "DAISY PINOUT" poster but with USB at the TOP so the board
 *     reads the same way most users will install it in a case.
 *   - Two flanking pin rails. Each row has a pin-name pill nearest the
 *     board, then the poster's color-coded peripheral tokens cascading
 *     outward. Every row-rect is a single hit target that covers the pin
 *     pad + all of its pills — users can start a wire drop anywhere on
 *     the row, not just the tiny pin dot.
 *   - Board silhouette in the center column with a USB-C at the top,
 *     STM32H750IB QFP in the upper-middle, SDRAM below it, AK4556 codec
 *     near the bottom, status LED, pin-1 corner mark, and the silver
 *     solder-pad halo next to each header pin.
 *
 * Interaction (the part that was broken in the prior three passes):
 *   1. Each placed component gets one role badge per entry in
 *      KIND_ROLES[kind]. Badges are pointerdown + dragable.
 *   2. On pointerdown the badge captures the pointer AND we attach
 *      window-level pointermove/pointerup listeners. Earlier code relied
 *      only on React synthetic events which the SVG pin rows swallowed.
 *   3. During the drag a dashed preview line is drawn in SVG (world
 *      coords), compatible pins light up, incompatible pins dim to 0.35.
 *   4. Hit test is row-rect (big target) not pin-dot. Rects are indexed
 *      into a ref-map keyed by pin id and read via `document.elementFrom
 *      Point` + `data-pin-row` attributes, so the hit test works even
 *      when the drag started elsewhere on the DOM.
 *   5. Esc or release-in-empty-space cancels.
 *   6. Right-click clears a binding; single tap opens the same pin
 *      dropdown the Inspector uses.
 *
 * Constraints (from CLAUDE.md):
 *   - All colors via `--dp-*` tokens.
 *   - Inline SVG icons only, no emoji.
 *   - Keep `HardwarePalette` / `HardwareInspector` / codegen untouched.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useEditorStore } from '@/state/store'
import { KIND_ROLES } from '@/types/hardware'
import type { BoardPin, PinCapabilities, PlacedComponent } from '@/types/hardware'
import { getBoardPinout } from './boardPinout'
import type { BoardPhysicalPinPosition, BoardPinout } from './boardPinout'
import { HARDWARE_DRAG_MIME } from './HardwarePalette'
import { HARDWARE_ICON } from './hardwareIcons'
import styles from './HardwareView.module.css'

/* =====================================================================
 * Canvas geometry (SVG user units).
 * The canvas is intentionally portrait (tall) to match the poster feel.
 * ===================================================================== */

const CANVAS_W = 1400
const CANVAS_H = 1500

/** Board silhouette (centered horizontally; USB at the top). */
const BOARD_W = 260
const BOARD_H = 1000
const BOARD_X = (CANVAS_W - BOARD_W) / 2
const BOARD_Y = 240

/** Each side has 20 rows; pin spacing is derived. */
const ROWS_PER_SIDE = 20
const PIN_EDGE_INSET = 14 // from the board edge to the pin pad center
const PIN_ROW_TOP_MARGIN = 30
const PIN_ROW_BOTTOM_MARGIN = 30
const PIN_SPACING =
  (BOARD_H - PIN_ROW_TOP_MARGIN - PIN_ROW_BOTTOM_MARGIN) / (ROWS_PER_SIDE - 1)

/** Pin-name pill (closest to the board). */
const NAME_PILL_W = 62
const NAME_PILL_H = 22

/** Alt-function pills. */
const ALT_PILL_H = 18
const ALT_PILL_GAP = 4
const ALT_PILL_PAD_X = 7
const ALT_PILL_CHAR_W = 6.2 // empirical for the 11px monospace pill font

/** Horizontal gap between the board edge and the first pill. */
const ROW_GAP_FROM_BOARD = 12

/** Drag-snap threshold, canvas units. */
const SNAP_PX = 26

/* =====================================================================
 * Pill taxonomy: maps a poster alt-function token to a color category.
 * ===================================================================== */

type PillCategory =
  | 'pin'
  | 'gpio'
  | 'adc'
  | 'dac'
  | 'i2c'
  | 'spi'
  | 'uart'
  | 'i2s'
  | 'pwm'
  | 'power'
  | 'ground'
  | 'audio'
  | 'usb'
  | 'sd'
  | 'misc'

interface Pill {
  text: string
  category: PillCategory
}

function categorize(token: string): PillCategory {
  const t = token.toUpperCase()
  if (/^D\d+$/.test(t)) return 'pin'
  if (/^A\d+$/.test(t)) return 'adc'
  if (/^P[A-K]\d+$/.test(t)) return 'gpio'
  if (t.startsWith('ADC') || /^CH\d+$/.test(t)) return 'adc'
  if (t.startsWith('DAC')) return 'dac'
  if (t.startsWith('I2C')) return 'i2c'
  if (t.startsWith('SPI')) return 'spi'
  if (t.startsWith('USART') || t.startsWith('UART') || t.startsWith('LPUART')) return 'uart'
  if (t.startsWith('I2S') || t.startsWith('SAI') || t === 'SPDIF_RX') return 'i2s'
  if (t.startsWith('TIM')) return 'pwm'
  if (t === 'GPIO') return 'gpio'
  if (t.startsWith('USB')) return 'usb'
  if (t.startsWith('SD_')) return 'sd'
  if (t === 'VIN' || t === '3V3' || t === '3V3_A' || t === '3V3_D' || t === '3V3 A' || t === '3V3 D') return 'power'
  if (t === 'GND' || t === 'DGND' || t === 'AGND') return 'ground'
  if (t.startsWith('AUDIO') || t.startsWith('AUD')) return 'audio'
  return 'misc'
}

/** Pill fill — all colors resolved from `--dp-*` tokens via color-mix. */
function pillFill(category: PillCategory): string {
  switch (category) {
    case 'pin':    return 'color-mix(in srgb, var(--dp-accent) 40%, var(--dp-surface-elevated))'
    case 'gpio':   return 'color-mix(in srgb, var(--dp-text-muted) 55%, var(--dp-surface-sunken))'
    case 'adc':    return 'color-mix(in srgb, var(--dp-signal-cv) 80%, var(--dp-bg))'
    case 'dac':    return 'color-mix(in srgb, var(--dp-signal-audio) 85%, var(--dp-bg))'
    case 'i2c':    return 'color-mix(in srgb, var(--dp-signal-cv) 55%, var(--dp-signal-audio) 45%)'
    case 'spi':    return 'color-mix(in srgb, var(--dp-warning) 80%, var(--dp-bg))'
    case 'uart':   return 'color-mix(in srgb, var(--dp-signal-gate) 80%, var(--dp-warning) 20%)'
    case 'i2s':    return 'color-mix(in srgb, var(--dp-signal-audio) 60%, var(--dp-signal-clock) 40%)'
    case 'pwm':    return 'color-mix(in srgb, var(--dp-signal-gate) 85%, var(--dp-warning) 40%)'
    case 'power':  return 'color-mix(in srgb, var(--dp-danger) 85%, var(--dp-bg))'
    case 'ground': return 'color-mix(in srgb, var(--dp-text-dim) 55%, var(--dp-bg))'
    case 'audio':  return 'color-mix(in srgb, var(--dp-signal-audio) 85%, var(--dp-bg))'
    case 'usb':    return 'color-mix(in srgb, var(--dp-signal-clock) 70%, var(--dp-bg))'
    case 'sd':     return 'color-mix(in srgb, var(--dp-text-muted) 65%, var(--dp-bg))'
    case 'misc':   return 'color-mix(in srgb, var(--dp-text-dim) 45%, var(--dp-surface-sunken))'
  }
}

function pillTextColor(category: PillCategory): string {
  switch (category) {
    case 'pin':
    case 'gpio':
    case 'misc':
    case 'ground':
      return 'var(--dp-text)'
    default:
      return 'var(--dp-bg)'
  }
}

/**
 * Convert a PinCapabilities.label (slash-delimited tokens) into pills.
 * The name pill is always first (caller keeps `coord.pin` as the display
 * text so it stays short — e.g. "D15" even if the label says
 * "D15 / PC0 / A0 / ADC_0").
 */
function pillsFromLabel(label: string | undefined, pin: string): Pill[] {
  const pills: Pill[] = [{ text: pin, category: 'pin' }]
  if (!label) return pills
  const seen = new Set([pin.toUpperCase()])
  for (const rawTok of label.split('/').map((t) => t.trim()).filter(Boolean)) {
    const up = rawTok.toUpperCase()
    if (seen.has(up)) continue
    // Collapse `D15` / `PC0` duplicates: skip the pin name if repeated,
    // and keep the STM32 port + pin as a muted GPIO pill.
    if (/^D\d+$/.test(up)) continue
    seen.add(up)
    const cat = categorize(rawTok)
    pills.push({ text: rawTok, category: cat })
  }
  return pills
}

/** Decide the primary category for a pill stack so we can brighten the
 *  bound pill when the user has wired that role. */
function primaryCategoryOf(pills: Pill[]): PillCategory {
  // Prefer the most specific peripheral over generic GPIO / pin.
  const order: PillCategory[] = ['adc', 'dac', 'i2c', 'spi', 'uart', 'i2s', 'pwm', 'audio', 'usb', 'sd', 'gpio']
  for (const c of order) {
    if (pills.some((p) => p.category === c)) return c
  }
  return 'pin'
}

/* =====================================================================
 * Coordinate helpers.
 * ===================================================================== */

interface PinCoord {
  pin: string
  side: 'left' | 'right' | 'bottom'
  index: number
  label: string
  x: number
  y: number
  pillsX: number // x of the name-pill's near edge (outer edge of board)
}

function computePinCoords(layout: BoardPhysicalPinPosition[]): PinCoord[] {
  return layout.map((p) => {
    if (p.side === 'bottom') {
      // Off-board chips rendered beneath the silhouette.
      const x = BOARD_X + BOARD_W / 2 + (p.index - 0.5) * 110
      const y = BOARD_Y + BOARD_H + 48
      return { pin: p.pin, side: p.side, index: p.index, label: p.label, x, y, pillsX: x }
    }
    const x =
      p.side === 'left'
        ? BOARD_X + PIN_EDGE_INSET
        : BOARD_X + BOARD_W - PIN_EDGE_INSET
    // Left column rendered bottom-up so the silkscreen pin order matches
    // the poster when USB sits at the bottom of the silhouette.
    const rowIndex =
      p.side === 'left' ? ROWS_PER_SIDE - 1 - p.index : p.index
    const y = BOARD_Y + PIN_ROW_TOP_MARGIN + rowIndex * PIN_SPACING
    const pillsX = p.side === 'left' ? BOARD_X : BOARD_X + BOARD_W
    return { pin: p.pin, side: p.side, index: p.index, label: p.label, x, y, pillsX }
  })
}

/* =====================================================================
 * Wiring-drag state. A single active drag per view.
 * ===================================================================== */

interface WiringDrag {
  componentId: string
  role: string
  kind: string
  /** Drag source (badge center) in CANVAS coords. */
  sourceX: number
  sourceY: number
  /** Cursor in CANVAS coords. */
  x: number
  y: number
  /** If snapped to a compatible pin, its id. */
  snappedPin: string | null
}

/* =====================================================================
 * Top-level HardwareView component.
 * ===================================================================== */

export function HardwareView() {
  const components = useEditorStore((s) => s.hardware.components)
  const board = useEditorStore((s) => s.hardware.board)
  const selectedId = useEditorStore((s) => s.selectedHardwareId)
  const selectHardware = useEditorStore((s) => s.selectHardware)
  const addHardware = useEditorStore((s) => s.addHardware)
  const setHardwarePin = useEditorStore((s) => s.setHardwarePin)

  const rootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const pinout = useMemo(() => getBoardPinout(board), [board])
  const pinCoords = useMemo(() => computePinCoords(pinout.physicalLayout), [pinout])
  const pinCoordMap = useMemo(() => {
    const m = new Map<string, PinCoord>()
    for (const c of pinCoords) m.set(c.pin, c)
    return m
  }, [pinCoords])

  const [drag, setDrag] = useState<WiringDrag | null>(null)

  /** Convert a DOM client-space point into canvas-space coords.
   *  Uses the SVG's getScreenCTM().inverse() for an exact map (handles
   *  preserveAspectRatio='xMidYMid meet' correctly, unlike a simple
   *  bounding-rect scale). */
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const inv = ctm.inverse()
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const p = pt.matrixTransform(inv)
    return { x: p.x, y: p.y }
  }, [])

  /** Called by RoleBadge once the user crosses the drag threshold. */
  const beginWireDrag = useCallback(
    (componentId: string, role: string, kind: string, sx: number, sy: number) => {
      setDrag({
        componentId,
        role,
        kind,
        sourceX: sx,
        sourceY: sy,
        x: sx,
        y: sy,
        snappedPin: null
      })
    },
    []
  )

  /* ---- window-level drag tracking ---------------------------------
   * The RoleBadge fires pointerdown and calls beginWireDrag(); we
   * attach the pointermove/pointerup listeners here so SVG child
   * elements can't swallow them. Pointer capture on the badge isn't
   * enough because the pointer frequently leaves the badge in the
   * first 3-4px of the drag.
   * ----------------------------------------------------------------- */
  useEffect(() => {
    if (!drag) return
    const allowed = new Set(pinout.pinsForRole(drag.role, drag.kind))

    const onMove = (e: PointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY)
      // Snap to nearest compatible pin within SNAP_PX (canvas units).
      let best: { pin: string; d2: number } | null = null
      for (const [pin, coord] of pinCoordMap) {
        if (coord.side === 'bottom') continue
        if (!allowed.has(pin)) continue
        const dx = coord.x - p.x
        const dy = coord.y - p.y
        const d2 = dx * dx + dy * dy
        if (d2 > SNAP_PX * SNAP_PX) continue
        if (!best || d2 < best.d2) best = { pin, d2 }
      }
      setDrag((cur) =>
        cur ? { ...cur, x: p.x, y: p.y, snappedPin: best ? best.pin : null } : cur
      )
    }

    const onUp = (e: PointerEvent) => {
      // Primary hit-test: the pin-row DOM elements carry `data-pin-row`.
      // This is more forgiving than a pure distance check because the
      // user sees a big row they clicked on, not an invisible bounding
      // circle.
      const els = document.elementsFromPoint(e.clientX, e.clientY)
      let hitPin: string | null = null
      for (const el of els) {
        const attr = (el as Element).getAttribute?.('data-pin-row')
        if (attr && allowed.has(attr)) {
          hitPin = attr
          break
        }
      }
      // Fallback: distance check (for when the pointer ended just off-
      // row but inside the snap ring).
      if (!hitPin) {
        const p = toCanvas(e.clientX, e.clientY)
        let bestD2 = Infinity
        for (const [pin, coord] of pinCoordMap) {
          if (coord.side === 'bottom') continue
          if (!allowed.has(pin)) continue
          const dx = coord.x - p.x
          const dy = coord.y - p.y
          const d2 = dx * dx + dy * dy
          if (d2 <= SNAP_PX * SNAP_PX && d2 < bestD2) {
            hitPin = pin
            bestD2 = d2
          }
        }
      }
      if (hitPin) {
        useEditorStore.getState().beginTransaction()
        setHardwarePin(drag.componentId, drag.role, hitPin as BoardPin)
        useEditorStore.getState().endTransaction()
      }
      setDrag(null)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrag(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [drag, pinCoordMap, pinout, setHardwarePin, toCanvas])

  /* ---- palette drag / drop ---------------------------------------- */
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(HARDWARE_DRAG_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const kind = e.dataTransfer.getData(HARDWARE_DRAG_MIME)
      if (!kind) return
      e.preventDefault()
      const p = toCanvas(e.clientX, e.clientY)
      const id = addHardware(kind as PlacedComponent['kind'], { x: p.x, y: p.y })
      selectHardware(id)
    },
    [addHardware, selectHardware, toCanvas]
  )

  const onBgClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) selectHardware(null)
    },
    [selectHardware]
  )

  // Set of compatible pins while dragging — used to dim incompatible
  // rows and to short-circuit the hit-test.
  const allowedPins = useMemo(() => {
    if (!drag) return null
    return new Set(pinout.pinsForRole(drag.role, drag.kind))
  }, [drag, pinout])

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onBgClick}
    >
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <Caption boardLabel={pinout.label} />
        <Legend cx={CANVAS_W / 2} cy={168} />

        {board === 'daisy_seed' ? (
          <SeedSilhouette />
        ) : (
          <Esp32SilhouettePlaceholder />
        )}

        <PinRows
          pinCoords={pinCoords}
          pinout={pinout}
          allowedPins={allowedPins}
          draggingSnapPin={drag?.snappedPin ?? null}
          components={components}
        />

        <WireOverlay
          components={components}
          pinout={pinout}
          pinCoordMap={pinCoordMap}
        />

        {drag ? <WiringPreview drag={drag} pinCoordMap={pinCoordMap} /> : null}
      </svg>

      <div className={styles.overlay}>
        {components.map((c) => (
          <HardwareCard
            key={c.id}
            comp={c}
            selected={c.id === selectedId}
            onSelect={() => selectHardware(c.id)}
            allowedPinsForRole={(role) => new Set(pinout.pinsForRole(role, c.kind))}
            pinout={pinout}
            onBeginWireDrag={beginWireDrag}
            toCanvas={toCanvas}
            activeDragRole={drag && drag.componentId === c.id ? drag.role : null}
            svgRef={svgRef}
          />
        ))}
      </div>

      {components.length === 0 ? (
        <div className={styles.emptyHint}>
          <span>drag a component from the left onto the board</span>
        </div>
      ) : null}
    </div>
  )
}

/* =====================================================================
 * Caption and legend (atop the canvas).
 * ===================================================================== */

function Caption({ boardLabel }: { boardLabel: string }) {
  return (
    <g>
      <text
        x={CANVAS_W / 2}
        y={78}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="30"
        fill="var(--dp-text)"
        letterSpacing="0.32em"
      >
        DAISY PINOUT
      </text>
      <text
        x={CANVAS_W / 2}
        y={108}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="12"
        fill="var(--dp-text-dim)"
        letterSpacing="0.28em"
      >
        {boardLabel.toUpperCase()}
      </text>
    </g>
  )
}

function Legend({ cx, cy }: { cx: number; cy: number }) {
  const entries: { label: string; category: PillCategory }[] = [
    { label: 'GPIO',  category: 'gpio' },
    { label: 'ADC',   category: 'adc' },
    { label: 'DAC',   category: 'dac' },
    { label: 'I2C',   category: 'i2c' },
    { label: 'SPI',   category: 'spi' },
    { label: 'UART',  category: 'uart' },
    { label: 'I2S',   category: 'i2s' },
    { label: 'PWM',   category: 'pwm' },
    { label: 'POWER', category: 'power' },
    { label: 'USB',   category: 'usb' },
    { label: 'AUDIO', category: 'audio' }
  ]
  const pillW = 64
  const pillH = 18
  const gap = 6
  const totalW = entries.length * pillW + (entries.length - 1) * gap
  const startX = cx - totalW / 2
  return (
    <g>
      {entries.map((e, i) => {
        const x = startX + i * (pillW + gap)
        return (
          <g key={e.label}>
            <rect
              x={x}
              y={cy - pillH / 2}
              width={pillW}
              height={pillH}
              rx={pillH / 2}
              fill={pillFill(e.category)}
              stroke="var(--dp-border)"
              strokeWidth="0.75"
            />
            <text
              x={x + pillW / 2}
              y={cy + 4}
              textAnchor="middle"
              fontFamily="var(--dp-font-mono)"
              fontSize="10"
              letterSpacing="0.16em"
              fill={pillTextColor(e.category)}
            >
              {e.label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/* =====================================================================
 * Seed board silhouette.
 * ===================================================================== */

function SeedSilhouette() {
  // A slightly warmer PCB tone so it doesn't blend into the canvas.
  const pcbFill = 'color-mix(in srgb, var(--dp-surface-sunken) 70%, var(--dp-warning) 4%)'

  // STM32H750IB silhouette placement.
  const chipW = 140
  const chipH = 140
  const chipX = BOARD_X + (BOARD_W - chipW) / 2
  const chipY = BOARD_Y + 160

  // SDRAM silhouette.
  const sdramW = 120
  const sdramH = 36
  const sdramX = BOARD_X + (BOARD_W - sdramW) / 2
  const sdramY = chipY + chipH + 40

  // Codec silhouette.
  const codecW = 70
  const codecH = 40
  const codecX = BOARD_X + (BOARD_W - codecW) / 2
  const codecY = BOARD_Y + BOARD_H - 110

  return (
    <g>
      {/* PCB body */}
      <rect
        x={BOARD_X}
        y={BOARD_Y}
        width={BOARD_W}
        height={BOARD_H}
        rx="14"
        fill={pcbFill}
        stroke="var(--dp-border-strong)"
        strokeWidth="1.75"
      />
      <rect
        x={BOARD_X + 3}
        y={BOARD_Y + 3}
        width={BOARD_W - 6}
        height={BOARD_H - 6}
        rx="12"
        fill="none"
        stroke="var(--dp-border)"
        strokeWidth="1"
        opacity="0.6"
      />

      {/* Pin-1 corner mark (top-left inside the board) */}
      <circle cx={BOARD_X + 12} cy={BOARD_Y + 14} r="3" fill="var(--dp-text-dim)" />

      {/* USB-C connector sticking out the bottom (poster reference has USB
          at the opposite end from the audio jacks — user confirmed 2026-04-21). */}
      <rect
        x={BOARD_X + BOARD_W / 2 - 36}
        y={BOARD_Y + BOARD_H - 6}
        width="72"
        height="28"
        rx="4"
        fill="var(--dp-border-strong)"
        stroke="var(--dp-text-dim)"
        strokeWidth="1"
      />
      <rect
        x={BOARD_X + BOARD_W / 2 - 26}
        y={BOARD_Y + BOARD_H + 1}
        width="52"
        height="15"
        rx="3"
        fill="var(--dp-surface-sunken)"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H + 36}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="10"
        fill="var(--dp-text-dim)"
        letterSpacing="0.22em"
      >
        USB
      </text>

      {/* STM32H750IB — QFP silhouette with cardinal pin ticks */}
      <g transform={`translate(${chipX}, ${chipY})`}>
        <rect
          x={0}
          y={0}
          width={chipW}
          height={chipH}
          rx="4"
          fill="var(--dp-bg)"
          stroke="var(--dp-border-strong)"
          strokeWidth="1.4"
        />
        {Array.from({ length: 18 }).map((_, i) => {
          const o = 6 + i * ((chipW - 12) / 17)
          return (
            <g key={`qfp-${i}`} opacity="0.55">
              <line x1={-3} y1={o} x2={0} y2={o} stroke="var(--dp-text-dim)" strokeWidth="1" />
              <line x1={chipW} y1={o} x2={chipW + 3} y2={o} stroke="var(--dp-text-dim)" strokeWidth="1" />
              <line x1={o} y1={-3} x2={o} y2={0} stroke="var(--dp-text-dim)" strokeWidth="1" />
              <line x1={o} y1={chipH} x2={o} y2={chipH + 3} stroke="var(--dp-text-dim)" strokeWidth="1" />
            </g>
          )
        })}
        <circle cx={9} cy={9} r="2.4" fill="var(--dp-text-dim)" />
        <text
          x={chipW / 2}
          y={chipH / 2 - 4}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="14"
          fill="var(--dp-text)"
          letterSpacing="0.22em"
        >
          STM32
        </text>
        <text
          x={chipW / 2}
          y={chipH / 2 + 14}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="11"
          fill="var(--dp-text-muted)"
          letterSpacing="0.22em"
        >
          H750IB
        </text>
      </g>

      {/* SDRAM below the STM32 */}
      <rect
        x={sdramX}
        y={sdramY}
        width={sdramW}
        height={sdramH}
        rx="3"
        fill="var(--dp-bg)"
        stroke="var(--dp-border)"
        strokeWidth="1.1"
      />
      <text
        x={sdramX + sdramW / 2}
        y={sdramY + sdramH / 2 + 4}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="10"
        fill="var(--dp-text-dim)"
        letterSpacing="0.2em"
      >
        SDRAM
      </text>

      {/* Codec at the bottom */}
      <rect
        x={codecX}
        y={codecY}
        width={codecW}
        height={codecH}
        rx="3"
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />
      <text
        x={codecX + codecW / 2}
        y={codecY + codecH / 2 + 4}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="9"
        fill="var(--dp-text-muted)"
        letterSpacing="0.18em"
      >
        AK4556
      </text>

      {/* Status LED at the bottom-right */}
      <circle
        cx={BOARD_X + BOARD_W - 26}
        cy={BOARD_Y + BOARD_H - 26}
        r="5"
        fill="var(--dp-warning)"
        opacity="0.85"
      />
      <circle
        cx={BOARD_X + BOARD_W - 26}
        cy={BOARD_Y + BOARD_H - 26}
        r="8"
        fill="none"
        stroke="var(--dp-warning)"
        strokeWidth="1"
        opacity="0.3"
      />

      {/* Reset & boot buttons (decorative) */}
      <rect
        x={BOARD_X + 24}
        y={BOARD_Y + BOARD_H - 46}
        width="22"
        height="14"
        rx="2"
        fill="var(--dp-bg)"
        stroke="var(--dp-border)"
        strokeWidth="0.75"
      />
      <text
        x={BOARD_X + 35}
        y={BOARD_Y + BOARD_H - 35}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="6"
        fill="var(--dp-text-dim)"
        letterSpacing="0.12em"
      >
        RST
      </text>
      <rect
        x={BOARD_X + 52}
        y={BOARD_Y + BOARD_H - 46}
        width="22"
        height="14"
        rx="2"
        fill="var(--dp-bg)"
        stroke="var(--dp-border)"
        strokeWidth="0.75"
      />
      <text
        x={BOARD_X + 63}
        y={BOARD_Y + BOARD_H - 35}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="6"
        fill="var(--dp-text-dim)"
        letterSpacing="0.12em"
      >
        BOOT
      </text>

      {/* Wordmark */}
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H - 14}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="12"
        fill="var(--dp-text-muted)"
        letterSpacing="0.4em"
      >
        DAISY
      </text>
    </g>
  )
}

/* =====================================================================
 * ESP32-S3 placeholder silhouette.
 * TODO: proper ESP32-S3 DevKitC illustration (shield/antenna, USB-C,
 *       CP2102 chip, strapping-pin warnings). Deferred.
 * ===================================================================== */

function Esp32SilhouettePlaceholder() {
  return (
    <g>
      <rect
        x={BOARD_X}
        y={BOARD_Y}
        width={BOARD_W}
        height={BOARD_H}
        rx="10"
        fill="var(--dp-surface-sunken)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1.5"
      />
      {/* ESP32-S3 module block at the top third */}
      <rect
        x={BOARD_X + 24}
        y={BOARD_Y + 80}
        width={BOARD_W - 48}
        height="240"
        rx="4"
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1.2"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + 200}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="14"
        fill="var(--dp-text)"
        letterSpacing="0.22em"
      >
        ESP32-S3
      </text>
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + 222}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="10"
        fill="var(--dp-text-muted)"
        letterSpacing="0.2em"
      >
        MODULE
      </text>
      {/* USB-C at the bottom */}
      <rect
        x={BOARD_X + BOARD_W / 2 - 30}
        y={BOARD_Y + BOARD_H - 6}
        width="60"
        height="22"
        rx="3"
        fill="var(--dp-border-strong)"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H - 24}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="10"
        fill="var(--dp-text-dim)"
        letterSpacing="0.2em"
      >
        USB-C
      </text>
    </g>
  )
}

/* =====================================================================
 * Pin rows — name pill + alt-function pill stack per pin.
 * ===================================================================== */

function PinRows({
  pinCoords,
  pinout,
  allowedPins,
  draggingSnapPin,
  components
}: {
  pinCoords: PinCoord[]
  pinout: BoardPinout
  allowedPins: Set<string> | null
  draggingSnapPin: string | null
  components: PlacedComponent[]
}) {
  const boundPins = useMemo(() => {
    const set = new Set<string>()
    for (const c of components) for (const p of Object.values(c.pins)) if (p) set.add(p)
    return set
  }, [components])

  return (
    <g>
      {pinCoords.map((coord) => {
        if (coord.side === 'bottom') return null
        const cap = pinout.pinCaps[coord.pin] as PinCapabilities | undefined
        const bound = boundPins.has(coord.pin)
        const allowed = allowedPins ? allowedPins.has(coord.pin) : true
        const dimmed = allowedPins !== null && !allowed
        const snapping = draggingSnapPin === coord.pin
        return (
          <PinRow
            key={`${coord.side}-${coord.index}`}
            coord={coord}
            cap={cap}
            bound={bound}
            dimmed={dimmed}
            snapping={snapping}
          />
        )
      })}
    </g>
  )
}

function PinRow({
  coord,
  cap,
  bound,
  dimmed,
  snapping
}: {
  coord: PinCoord
  cap: PinCapabilities | undefined
  bound: boolean
  dimmed: boolean
  snapping: boolean
}) {
  const isLeft = coord.side === 'left'
  const [hovered, setHovered] = useState(false)

  const pills: Pill[] = useMemo(() => {
    if (cap?.label) return pillsFromLabel(cap.label, coord.pin)
    // Power / audio / USB rails: synthesize a single pill.
    const up = coord.pin.toUpperCase()
    const cat: PillCategory =
      up === 'VIN' || up === '3V3' || up === '3V3_A' || up === '3V3_D'
        ? 'power'
        : up === 'AGND' || up === 'DGND'
          ? 'ground'
          : up.startsWith('AUDIO')
            ? 'audio'
            : up.startsWith('USB')
              ? 'usb'
              : 'misc'
    return [{ text: coord.label, category: cat }]
  }, [cap?.label, coord.label, coord.pin])

  // Name pill lives immediately outside the board edge. Alt pills cascade
  // further outward (left grows left, right grows right).
  const nameX = isLeft
    ? BOARD_X - ROW_GAP_FROM_BOARD - NAME_PILL_W
    : BOARD_X + BOARD_W + ROW_GAP_FROM_BOARD
  const y = coord.y
  const nameTop = y - NAME_PILL_H / 2

  // Pre-compute widths so we can size the hit rect.
  const altPills = pills.slice(1)
  const altWidths = altPills.map((p) =>
    Math.max(32, ALT_PILL_PAD_X * 2 + p.text.length * ALT_PILL_CHAR_W)
  )
  let altCursor = ALT_PILL_GAP
  const altPositions = altPills.map((_, i) => {
    const off = altCursor
    altCursor += altWidths[i] + ALT_PILL_GAP
    return off
  })
  const totalAltW = altCursor
  const rowStart = isLeft
    ? nameX - totalAltW
    : nameX + NAME_PILL_W
  const rowEnd = isLeft
    ? nameX + NAME_PILL_W
    : nameX + NAME_PILL_W + totalAltW
  const rowX = Math.min(rowStart, rowEnd)
  const rowW = Math.abs(rowEnd - rowStart)
  // Hit rect extends slightly above/below for easier targeting.
  const HIT_PAD = 4

  const rowOpacity = dimmed ? 0.25 : 1
  const primaryCat = primaryCategoryOf(pills)

  return (
    <g
      opacity={rowOpacity}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{ transition: 'opacity 120ms var(--dp-ease)' }}
    >
      {/* Full-row hit rect — carries data-pin-row so the drop logic can
          identify which row the cursor is over. Kept mostly transparent
          so it doesn't visually clutter. */}
      <rect
        data-pin-row={coord.pin}
        x={rowX - HIT_PAD}
        y={y - (ALT_PILL_H + HIT_PAD) / 2 - HIT_PAD}
        width={rowW + HIT_PAD * 2}
        height={ALT_PILL_H + HIT_PAD * 2}
        fill={hovered || snapping ? 'color-mix(in srgb, var(--dp-accent) 6%, transparent)' : 'transparent'}
        rx="10"
        pointerEvents="all"
      />

      {/* Connector stub from the board edge out to the name pill */}
      <line
        x1={isLeft ? BOARD_X : BOARD_X + BOARD_W}
        y1={y}
        x2={isLeft ? nameX + NAME_PILL_W : nameX}
        y2={y}
        stroke="var(--dp-border)"
        strokeWidth="1"
      />

      {/* Solder-pad halo on the board edge */}
      <circle
        cx={coord.x}
        cy={y}
        r="6"
        fill="none"
        stroke="color-mix(in srgb, var(--dp-warning) 60%, var(--dp-border))"
        strokeWidth="1"
        opacity="0.45"
      />
      <circle
        cx={coord.x}
        cy={y}
        r="3.2"
        fill={bound ? 'var(--dp-accent)' : 'color-mix(in srgb, var(--dp-warning) 60%, var(--dp-text-muted))'}
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />

      {/* Pin-name pill */}
      <rect
        x={nameX}
        y={nameTop}
        width={NAME_PILL_W}
        height={NAME_PILL_H}
        rx={NAME_PILL_H / 2}
        fill={pillFill('pin')}
        stroke={
          snapping
            ? 'var(--dp-accent)'
            : bound
              ? 'var(--dp-accent)'
              : 'var(--dp-border-strong)'
        }
        strokeWidth={snapping ? 2 : bound ? 1.5 : 1}
        style={{
          filter: hovered ? 'brightness(1.12)' : undefined,
          transition: 'stroke 100ms var(--dp-ease), filter 100ms var(--dp-ease)'
        }}
      />
      <text
        x={nameX + NAME_PILL_W / 2}
        y={y + 1}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="12"
        fill="var(--dp-text)"
        letterSpacing="0.1em"
        dominantBaseline="middle"
      >
        {coord.pin.replace(/^USB_ID$/, 'USB ID')}
      </text>
      {cap?.stm32Pin ? (
        <text
          x={nameX + NAME_PILL_W / 2}
          y={y + NAME_PILL_H / 2 + 10}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="8"
          fill="var(--dp-text-dim)"
          letterSpacing="0.14em"
        >
          {cap.stm32Pin}
        </text>
      ) : null}

      {/* Alt-function pills */}
      {altPills.map((p, i) => {
        const pillW = altWidths[i]
        const off = altPositions[i]
        const px = isLeft ? nameX - off - pillW : nameX + NAME_PILL_W + off
        const py = y - ALT_PILL_H / 2
        const matched = bound && p.category === primaryCat
        return (
          <g key={`${coord.pin}-${i}`}>
            <rect
              x={px}
              y={py}
              width={pillW}
              height={ALT_PILL_H}
              rx={ALT_PILL_H / 2}
              fill={pillFill(p.category)}
              stroke={matched ? 'var(--dp-accent)' : 'transparent'}
              strokeWidth={matched ? 1.25 : 0}
              opacity={matched ? 1 : hovered || snapping ? 1 : 0.88}
              style={{ transition: 'opacity 100ms var(--dp-ease)' }}
            />
            <text
              x={px + pillW / 2}
              y={y + 1}
              textAnchor="middle"
              fontFamily="var(--dp-font-mono)"
              fontSize="10"
              fill={pillTextColor(p.category)}
              dominantBaseline="middle"
              letterSpacing="0.06em"
            >
              {p.text}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/* =====================================================================
 * Wire overlay (bound-role lines) & wiring preview.
 * ===================================================================== */

function WireOverlay({
  components,
  pinout,
  pinCoordMap
}: {
  components: PlacedComponent[]
  pinout: BoardPinout
  pinCoordMap: Map<string, PinCoord>
}) {
  // Ignore the unused pinout parameter intentionally: kept so the signature
  // parallels future overlays that may use target-specific routing rules.
  void pinout
  return (
    <g>
      {components.flatMap((c) => {
        const cardCx = c.position.x + 70 // CARD_W / 2
        const cardCy = c.position.y + 50
        return KIND_ROLES[c.kind]
          .map((role) => {
            const pin = c.pins[role]
            if (!pin) return null
            const coord = pinCoordMap.get(pin as string)
            if (!coord || coord.side === 'bottom') return null
            return (
              <line
                key={`${c.id}-${role}`}
                x1={cardCx}
                y1={cardCy}
                x2={coord.x}
                y2={coord.y}
                stroke="var(--dp-accent)"
                strokeWidth="1.5"
                strokeDasharray="3 5"
                strokeLinecap="round"
                opacity="0.85"
                className={styles.wireFadeIn}
              />
            )
          })
          .filter(Boolean) as React.ReactNode[]
      })}
    </g>
  )
}

function WiringPreview({
  drag,
  pinCoordMap
}: {
  drag: WiringDrag
  pinCoordMap: Map<string, PinCoord>
}) {
  const snapped = drag.snappedPin ? pinCoordMap.get(drag.snappedPin) : null
  const tx = snapped ? snapped.x : drag.x
  const ty = snapped ? snapped.y : drag.y
  return (
    <g pointerEvents="none">
      <line
        x1={drag.sourceX}
        y1={drag.sourceY}
        x2={tx}
        y2={ty}
        stroke="var(--dp-accent)"
        strokeWidth="2"
        strokeDasharray="5 5"
        strokeLinecap="round"
        opacity="0.95"
      />
      <circle
        cx={tx}
        cy={ty}
        r={snapped ? 10 : 5}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth="1.75"
        opacity={snapped ? 1 : 0.6}
      />
    </g>
  )
}

/* =====================================================================
 * Placed component card (HTML overlay).
 * ===================================================================== */

const CARD_W = 140
const CARD_H = 100

interface HardwareCardProps {
  comp: PlacedComponent
  selected: boolean
  onSelect: () => void
  allowedPinsForRole: (role: string) => Set<string>
  pinout: BoardPinout
  onBeginWireDrag: (componentId: string, role: string, kind: string, sx: number, sy: number) => void
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number }
  activeDragRole: string | null
  svgRef: React.RefObject<SVGSVGElement | null>
}

function HardwareCard({
  comp,
  selected,
  onSelect,
  allowedPinsForRole,
  pinout,
  onBeginWireDrag,
  toCanvas,
  activeDragRole,
  svgRef
}: HardwareCardProps) {
  const moveHardware = useEditorStore((s) => s.moveHardware)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{
    startClient: { x: number; y: number }
    startPos: { x: number; y: number }
  } | null>(null)
  const [popoverRole, setPopoverRole] = useState<string | null>(null)

  const Icon = HARDWARE_ICON[comp.kind]
  const requiredRoles = KIND_ROLES[comp.kind]
  const bound = requiredRoles.every((r) => {
    const pin = comp.pins[r]
    if (!pin) return false
    return allowedPinsForRole(r).has(pin)
  })

  // Card drag (position move). Uses window-level listeners so it keeps
  // moving when the cursor leaves the card or the canvas.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragStateRef.current
      if (!st) return
      // Canvas coords → delta in canvas space.
      const p0 = toCanvas(st.startClient.x, st.startClient.y)
      const p1 = toCanvas(e.clientX, e.clientY)
      moveHardware(comp.id, {
        x: st.startPos.x + (p1.x - p0.x),
        y: st.startPos.y + (p1.y - p0.y)
      })
    }
    const onUp = () => {
      if (dragStateRef.current) {
        useEditorStore.getState().endTransaction()
        dragStateRef.current = null
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [comp.id, moveHardware, toCanvas])

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest(`.${styles.roleBadge}`)) return
      if (target.tagName === 'BUTTON' || target.tagName === 'SELECT' || target.tagName === 'OPTION') return
      e.stopPropagation()
      onSelect()
      useEditorStore.getState().beginTransaction()
      dragStateRef.current = {
        startClient: { x: e.clientX, y: e.clientY },
        startPos: { ...comp.position }
      }
    },
    [comp.position, onSelect]
  )

  // Convert CANVAS-space position to client pixels via the SVG's CTM so
  // the card always lines up with the SVG's letterboxed viewport regardless
  // of container size. Recompute on mount / resize / position change.
  const [screen, setScreen] = useState<{ left: number; top: number; w: number; h: number }>({
    left: 0, top: 0, w: CARD_W, h: CARD_H
  })
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const compute = () => {
      const ctm = svg.getScreenCTM()
      const parent = svg.parentElement?.getBoundingClientRect()
      if (!ctm || !parent) return
      const pt = svg.createSVGPoint()
      pt.x = comp.position.x
      pt.y = comp.position.y
      const p1 = pt.matrixTransform(ctm)
      pt.x = comp.position.x + CARD_W
      pt.y = comp.position.y + CARD_H
      const p2 = pt.matrixTransform(ctm)
      setScreen({
        left: p1.x - parent.left,
        top: p1.y - parent.top,
        w: p2.x - p1.x,
        h: p2.y - p1.y
      })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(svg)
    window.addEventListener('resize', compute)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', compute)
    }
  }, [comp.position.x, comp.position.y, svgRef])

  return (
    <div
      ref={rootRef}
      className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
      style={{
        left: `${screen.left}px`,
        top: `${screen.top}px`,
        width: `${screen.w}px`,
        height: `${screen.h}px`
      }}
      onMouseDown={onMouseDown}
    >
      <span className={styles.cardIcon}>
        <Icon />
      </span>
      <span className={styles.cardLabel}>{comp.label}</span>
      <span
        className={styles.cardStatus}
        data-status={bound ? 'ok' : 'warn'}
        title={bound ? 'All roles wired' : 'Pins missing'}
      >
        {bound ? 'WIRED' : 'PINS?'}
      </span>
      <div className={styles.roleRow}>
        {requiredRoles.map((role) => {
          const pin = comp.pins[role]
          return (
            <RoleBadge
              key={role}
              role={role}
              componentId={comp.id}
              kind={comp.kind}
              currentPin={pin ?? null}
              allowed={allowedPinsForRole(role)}
              pinout={pinout}
              isBound={!!pin}
              isDragging={activeDragRole === role}
              onBeginWireDrag={onBeginWireDrag}
              toCanvas={toCanvas}
              onOpenPopover={() => setPopoverRole(role)}
              onClosePopover={() => setPopoverRole(null)}
              popoverOpen={popoverRole === role}
            />
          )
        })}
      </div>
    </div>
  )
}

/* =====================================================================
 * Role badge — the drag source.
 *
 * Earlier passes failed here for two reasons:
 *   1. Pointer events were handled via React synthetics only. SVG children
 *      above the badge would capture pointermove events once the cursor
 *      left the badge, and the drag would die silently.
 *   2. The hit test was a tiny 4px pin dot.
 *
 * Fix: pointerdown arms a press state. On the first pointermove that
 * crosses the drag threshold, we release the badge's pointer capture and
 * fire `onBeginWireDrag` — from there the top-level HardwareView tracks
 * pointermove/pointerup on `window`. That cleanly escapes the SVG's
 * hover/capture machinery. The hit test in the top-level drag handler
 * uses `document.elementsFromPoint` against `data-pin-row` attributes.
 * ===================================================================== */

interface RoleBadgeProps {
  role: string
  componentId: string
  kind: string
  currentPin: BoardPin | null
  allowed: Set<string>
  pinout: BoardPinout
  isBound: boolean
  isDragging: boolean
  onBeginWireDrag: (componentId: string, role: string, kind: string, sx: number, sy: number) => void
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number }
  onOpenPopover: () => void
  onClosePopover: () => void
  popoverOpen: boolean
}

function RoleBadge({
  role,
  componentId,
  kind,
  currentPin,
  allowed,
  pinout,
  isBound,
  isDragging,
  onBeginWireDrag,
  toCanvas,
  onOpenPopover,
  onClosePopover,
  popoverOpen
}: RoleBadgeProps) {
  const setHardwarePin = useEditorStore((s) => s.setHardwarePin)
  const rootRef = useRef<HTMLDivElement>(null)
  const pressRef = useRef<{
    startClient: { x: number; y: number }
    capturedPointerId: number | null
    startedDrag: boolean
  } | null>(null)

  const DRAG_THRESHOLD = 4

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      let captured: number | null = null
      try {
        ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
        captured = e.pointerId
      } catch {
        captured = null
      }
      pressRef.current = {
        startClient: { x: e.clientX, y: e.clientY },
        capturedPointerId: captured,
        startedDrag: false
      }
    },
    []
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const st = pressRef.current
      if (!st || st.startedDrag) return
      const dx = e.clientX - st.startClient.x
      const dy = e.clientY - st.startClient.y
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
      st.startedDrag = true
      // Release the pointer capture so window-level listeners on the
      // HardwareView can observe pointermove without fighting the badge.
      if (st.capturedPointerId !== null) {
        try {
          ;(e.currentTarget as Element).releasePointerCapture(st.capturedPointerId)
        } catch {
          /* noop */
        }
      }
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const p = toCanvas(cx, cy)
      onBeginWireDrag(componentId, role, kind, p.x, p.y)
    },
    [componentId, kind, onBeginWireDrag, role, toCanvas]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const st = pressRef.current
      if (!st) return
      // If pointer capture is still ours and no drag started, treat as tap.
      if (!st.startedDrag) {
        e.stopPropagation()
        onOpenPopover()
      }
      pressRef.current = null
    },
    [onOpenPopover]
  )

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isBound) return
      e.preventDefault()
      e.stopPropagation()
      useEditorStore.getState().beginTransaction()
      setHardwarePin(componentId, role, null)
      useEditorStore.getState().endTransaction()
    },
    [componentId, isBound, role, setHardwarePin]
  )

  return (
    <div
      ref={rootRef}
      className={`${styles.roleBadge} ${isBound ? styles.roleBound : styles.roleUnbound} ${
        isDragging ? styles.roleDragging : ''
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      title={
        isBound
          ? `${role} → ${currentPin}  (drag to rewire, right-click to clear)`
          : `${role} (drag to a pin, or tap to pick)`
      }
    >
      <span className={styles.roleName}>{role}</span>
      <span
        className={styles.roleDot}
        data-bound={isBound ? 'true' : 'false'}
        aria-hidden="true"
      >
        {isBound ? '' : '?'}
      </span>
      {isBound ? (
        <span className={styles.rolePinTag}>{currentPin}</span>
      ) : null}
      {popoverOpen ? (
        <RolePopover
          currentPin={currentPin}
          allowed={allowed}
          pinout={pinout}
          onSelect={(pin) => {
            useEditorStore.getState().beginTransaction()
            setHardwarePin(componentId, role, pin)
            useEditorStore.getState().endTransaction()
            onClosePopover()
          }}
          onClose={onClosePopover}
        />
      ) : null}
    </div>
  )
}

function RolePopover({
  currentPin,
  allowed,
  pinout,
  onSelect,
  onClose
}: {
  currentPin: BoardPin | null
  allowed: Set<string>
  pinout: BoardPinout
  onSelect: (pin: BoardPin | null) => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    // Delay hookup so the pointerup that OPENED the popover doesn't also
    // close it.
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])
  return (
    <div
      ref={rootRef}
      className={styles.rolePopover}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <select
        className={styles.rolePopoverSelect}
        value={(currentPin as string) ?? ''}
        onChange={(e) => {
          const v = e.target.value
          onSelect(v === '' ? null : (v as BoardPin))
        }}
      >
        <option value="">(none)</option>
        {pinout.pinsInOrder
          .filter((p) => allowed.has(p))
          .map((p) => (
            <option key={p} value={p}>
              {pinout.pinCaps[p]?.label ?? p}
            </option>
          ))}
      </select>
    </div>
  )
}
