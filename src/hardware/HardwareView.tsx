/**
 * HardwareView — the full-canvas hardware layout editor. Replaces the
 * patch-graph Rete canvas when `store.view === 'hardware'`.
 *
 * Visual goals
 * ------------
 * Tries to match the Electrosmith "DAISY PINOUT" poster:
 *   - Centered board illustration with a large STM32 chip silhouette, a
 *     USB-C connector at the top, and small codec rectangle near the
 *     audio-out pins. A pin-1 corner mark for orientation.
 *   - Each breakout pin is rendered as a pin-name pill at the edge of the
 *     board, with a horizontal stack of color-coded peripheral pills
 *     extending outward. One pill per labelled alt-function (GPIO, ADC_N,
 *     DAC_N, I2Cx_SDA, SPIx_MOSI, USARTx_TX, SAIx_FS_B, TIMx_CHn, USB,
 *     POWER, ...).
 *   - Pills are color-coded by peripheral category using --dp-signal-*
 *     tokens mixed with the background so they read well at small sizes.
 *
 * Interaction
 * -----------
 *   - Drop a new component from the left palette onto the canvas → spawn
 *     an unbound placed component at cursor.
 *   - Click a placed card to select; drag to reposition (coalesced undo).
 *   - Each placed card has one role badge per entry in KIND_ROLES[kind].
 *     Drag from a role badge: enter "wiring mode". A dashed preview line
 *     follows the cursor; compatible pins (pinsForRole) glow, others dim.
 *     Release over a compatible pin binds. Release elsewhere, or press
 *     Esc, cancels.
 *   - Right-click a bound role badge clears the binding.
 *   - Click (no drag) on a role badge opens an inline popover with a pin
 *     dropdown — same as the Inspector's, just local.
 *   - The Inspector's dropdowns continue to work (both UIs write to the
 *     same `setHardwarePin` action).
 *
 * Implementation notes
 * --------------------
 *   - Wiring drags use pointer events with setPointerCapture so the drag
 *     continues when the cursor leaves the canvas.
 *   - Snap-to-pin: when the cursor is within SNAP_PX of a compatible
 *     pin's center, the preview line rubber-bands to that pin.
 *   - Colors are resolved via CSS variable tokens only; the pill color
 *     helpers use color-mix() via inline `fill` attributes to soften
 *     the signal colors without re-declaring them in CSS.
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

/* --- PCB layout constants (SVG user units) --- */

const CANVAS_W = 1600
const CANVAS_H = 1000
const BOARD_W = 210
const BOARD_H = 640
const BOARD_X = (CANVAS_W - BOARD_W) / 2
const BOARD_Y = 140
const PIN_ROW_COUNT = 20
const PIN_ROW_MARGIN = 22
const PIN_SPACING = (BOARD_H - 2 * PIN_ROW_MARGIN) / (PIN_ROW_COUNT - 1)
const PIN_RADIUS = 4
const PIN_LEFT_X = BOARD_X + 10
const PIN_RIGHT_X = BOARD_X + BOARD_W - 10

/** Width/height of the pin-name pill at the inner edge of each row. */
const NAME_PILL_W = 60
const NAME_PILL_H = 22
/** Each peripheral pill. */
const ALT_PILL_H = 16
const ALT_PILL_GAP = 3
const ALT_PILL_PAD_X = 6
const ALT_PILL_CHAR_W = 5.6  // approximation for 10px mono; good enough for layout
const ROW_GAP_FROM_BOARD = 10

/** Drag-snap threshold, in canvas units. */
const SNAP_PX = 18

interface PinCoord {
  pin: string
  x: number
  y: number
  side: 'left' | 'right'
  index: number
  label: string
}

function computePinCoords(layout: BoardPhysicalPinPosition[]): PinCoord[] {
  return layout.map((p) => ({
    pin: p.pin,
    side: p.side,
    index: p.index,
    label: p.label,
    x: p.side === 'left' ? PIN_LEFT_X : PIN_RIGHT_X,
    y: BOARD_Y + PIN_ROW_MARGIN + p.index * PIN_SPACING
  }))
}

/** Resolve the centre point of a bound pin on the canvas. */
function pinPos(pin: BoardPin, layout: BoardPhysicalPinPosition[]): { x: number; y: number } | null {
  const found = layout.find((p) => p.pin === pin)
  if (!found) return null
  return {
    x: found.side === 'left' ? PIN_LEFT_X : PIN_RIGHT_X,
    y: BOARD_Y + PIN_ROW_MARGIN + found.index * PIN_SPACING
  }
}

/* -------------------- Peripheral pill taxonomy --------------------- */

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
  | 'misc'

interface Pill {
  text: string
  category: PillCategory
}

/**
 * Classify a single alt-function token into a pill category so it can
 * pick a color. Token examples: `D15`, `PC0`, `ADC_0`, `CH10`,
 * `USART2_TX`, `I2C1_SDA`, `SPI1_MOSI`, `I2S1_CK`, `SAI2_FS_B`,
 * `TIM2_CH4`, `DAC_OUT_1`, `USB`.
 */
function categorize(token: string): PillCategory {
  const t = token.toUpperCase()
  if (/^D\d+$/.test(t)) return 'pin'
  if (/^P[A-K]\d+$/.test(t)) return 'pin'
  if (/^ADC(_|$)|^CH\d+$/.test(t)) return 'adc'
  if (t.startsWith('DAC')) return 'dac'
  if (t.startsWith('I2C')) return 'i2c'
  if (t.startsWith('SPI')) return 'spi'
  if (t.startsWith('USART') || t.startsWith('UART') || t.startsWith('LPUART')) return 'uart'
  if (t.startsWith('I2S') || t.startsWith('SAI')) return 'i2s'
  if (t.startsWith('TIM')) return 'pwm'
  if (t === 'GPIO') return 'gpio'
  if (t === 'USB' || t === 'USB_DP' || t === 'USB_DM') return 'usb'
  if (t === 'VIN' || t === '3V3' || t === '3V3_A' || t === '3V3_D') return 'power'
  if (t === 'GND' || t === 'DGND' || t === 'AGND') return 'ground'
  if (t.startsWith('AUDIO') || t.startsWith('AUD_')) return 'audio'
  return 'misc'
}

/**
 * Token-color mapping, resolved through CSS tokens. We mix each signal
 * token with the background so it sits comfortably inside the dark PCB
 * surface without washing out the text.
 *
 * These produce the `fill` / `stroke` for the pill rect + label.
 */
function pillFill(category: PillCategory): string {
  switch (category) {
    case 'pin':   return 'color-mix(in srgb, var(--dp-accent) 22%, var(--dp-surface-elevated))'
    case 'gpio':  return 'color-mix(in srgb, var(--dp-text-muted) 22%, var(--dp-surface-sunken))'
    case 'adc':   return 'color-mix(in srgb, var(--dp-signal-cv) 80%, var(--dp-bg))'
    case 'dac':   return 'color-mix(in srgb, var(--dp-signal-audio) 85%, var(--dp-bg))'
    case 'i2c':   return 'color-mix(in srgb, var(--dp-signal-audio) 50%, var(--dp-signal-clock) 50%)'
    case 'spi':   return 'color-mix(in srgb, var(--dp-signal-gate) 80%, var(--dp-bg))'
    case 'uart':  return 'color-mix(in srgb, var(--dp-signal-clock) 75%, var(--dp-bg))'
    case 'i2s':   return 'color-mix(in srgb, var(--dp-signal-cv) 50%, var(--dp-signal-audio) 50%)'
    case 'pwm':   return 'color-mix(in srgb, var(--dp-warning) 80%, var(--dp-bg))'
    case 'power': return 'color-mix(in srgb, var(--dp-danger) 80%, var(--dp-bg))'
    case 'ground':return 'color-mix(in srgb, var(--dp-text-dim) 40%, var(--dp-bg))'
    case 'audio': return 'color-mix(in srgb, var(--dp-signal-audio) 80%, var(--dp-bg))'
    case 'usb':   return 'color-mix(in srgb, var(--dp-text-muted) 30%, var(--dp-surface-sunken))'
    case 'misc':  return 'color-mix(in srgb, var(--dp-text-dim) 35%, var(--dp-surface-sunken))'
  }
}

/**
 * Pill text color — dark on the light/colored pills, light on the dim
 * pills. Keeps contrast readable without per-theme overrides.
 */
function pillTextColor(category: PillCategory): string {
  switch (category) {
    case 'pin':
    case 'gpio':
    case 'usb':
    case 'misc':
    case 'ground':
      return 'var(--dp-text)'
    default:
      return 'var(--dp-bg)'
  }
}

/**
 * Convert a PinCapabilities entry into an ordered list of pills. The
 * pin-name pill is emitted first, then GPIO/ADC/DAC/I2C/SPI/UART/I2S/PWM
 * pills based on the flags, then extra tokens parsed from the `label`
 * (so poster-style tokens like `TIM2_CH4` also get their own pill).
 */
function pillsForPin(cap: PinCapabilities): Pill[] {
  const seen = new Set<string>()
  const pills: Pill[] = []
  const push = (text: string, category: PillCategory) => {
    const key = text.toUpperCase()
    if (seen.has(key)) return
    seen.add(key)
    pills.push({ text, category })
  }

  // Name pill: short, closest to the board.
  push(cap.pin, 'pin')

  // Flag-based pills first so they appear in a consistent order even if
  // the label text shifts around.
  if (cap.gpio && !cap.adc && !cap.dac) push('GPIO', 'gpio')
  if (cap.adc) push('ADC', 'adc')
  if (cap.dac) push('DAC', 'dac')
  if (cap.i2c) push(`I2C_${cap.i2c.toUpperCase()}`, 'i2c')
  if (cap.spi) push(`SPI_${cap.spi.toUpperCase()}`, 'spi')
  if (cap.uart) push(`UART_${cap.uart.toUpperCase()}`, 'uart')
  if (cap.i2s) push(`I2S_${cap.i2s.toUpperCase()}`, 'i2s')
  if (cap.pwm) push('PWM', 'pwm')

  // Parse label tokens for richer peripheral-specific pills. Tokens are
  // the `/ SEGMENTS /` between slashes in the label.
  if (cap.label) {
    const tokens = cap.label.split('/').map((t) => t.trim()).filter(Boolean)
    for (const tok of tokens) {
      const cat = categorize(tok)
      // Skip redundant pin-name / port-name pills.
      if (cat === 'pin') continue
      // Skip bare `ADC`/`DAC` tokens (already covered) but keep numbered
      // variants like `ADC_0` or `CH10`.
      const upper = tok.toUpperCase()
      if (upper === 'GPIO' || upper === 'ADC' || upper === 'DAC' || upper === 'PWM') continue
      push(tok, cat)
    }
  }

  return pills
}

/** Wire color for a bound role — matches the pin's primary category. */
function wireColorForPin(pin: BoardPin, caps: Record<string, PinCapabilities>): string {
  const cap = caps[pin as string]
  if (!cap) return 'var(--dp-text-dim)'
  if (cap.adc) return 'var(--dp-signal-cv)'
  if (cap.dac) return 'var(--dp-signal-audio)'
  if (cap.i2c) return 'color-mix(in srgb, var(--dp-signal-audio) 50%, var(--dp-signal-clock) 50%)'
  if (cap.spi) return 'var(--dp-signal-gate)'
  if (cap.uart) return 'var(--dp-signal-clock)'
  if (cap.i2s) return 'color-mix(in srgb, var(--dp-signal-cv) 60%, var(--dp-signal-audio) 40%)'
  return 'var(--dp-signal-gate)'
}

/* -------------------- Wiring-drag state -------------------- */

interface WiringDrag {
  componentId: string
  role: string
  kind: string
  /** Current cursor position in CANVAS coords. */
  x: number
  y: number
  /** Source point in CANVAS coords (role badge center). */
  sourceX: number
  sourceY: number
  /** If cursor snapped to a pin, that pin id. */
  snappedPin: string | null
}

/* =========================================================
 * Main view
 * ========================================================= */

export function HardwareView() {
  const components = useEditorStore((s) => s.hardware.components)
  const board = useEditorStore((s) => s.hardware.board)
  const selectedId = useEditorStore((s) => s.selectedHardwareId)
  const selectHardware = useEditorStore((s) => s.selectHardware)
  const addHardware = useEditorStore((s) => s.addHardware)
  const setHardwarePin = useEditorStore((s) => s.setHardwarePin)
  const rootRef = useRef<HTMLDivElement>(null)
  const pinout = useMemo(() => getBoardPinout(board), [board])
  const pinCoords = useMemo(() => computePinCoords(pinout.physicalLayout), [pinout])

  // Fast pin-id → coord lookup for snap testing.
  const pinCoordMap = useMemo(() => {
    const m = new Map<string, PinCoord>()
    for (const c of pinCoords) m.set(c.pin, c)
    return m
  }, [pinCoords])

  // Wiring drag state; one drag at a time.
  const [drag, setDrag] = useState<WiringDrag | null>(null)

  /** Convert a DOM client-space point into canvas-space coords. */
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const scaleX = CANVAS_W / rect.width
    const scaleY = CANVAS_H / rect.height
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    }
  }, [])

  /** Start a wire drag from a role badge on a placed component. */
  const beginWireDrag = useCallback(
    (componentId: string, role: string, kind: string, sourceX: number, sourceY: number) => {
      setDrag({
        componentId,
        role,
        kind,
        sourceX,
        sourceY,
        x: sourceX,
        y: sourceY,
        snappedPin: null
      })
    },
    []
  )

  // During a wire drag, track mousemove/up at the window level so we get
  // the full drag even when the cursor leaves the SVG.
  useEffect(() => {
    if (!drag) return
    const allowed = new Set(pinout.pinsForRole(drag.role, drag.kind))

    const onMove = (e: PointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY)
      // Snap to nearest compatible pin within SNAP_PX.
      let best: { pin: string; d2: number } | null = null
      for (const [pin, coord] of pinCoordMap) {
        if (!allowed.has(pin)) continue
        const dx = coord.x - p.x
        const dy = coord.y - p.y
        const d2 = dx * dx + dy * dy
        if (d2 > SNAP_PX * SNAP_PX) continue
        if (!best || d2 < best.d2) best = { pin, d2 }
      }
      setDrag((cur) =>
        cur
          ? {
              ...cur,
              x: p.x,
              y: p.y,
              snappedPin: best ? best.pin : null
            }
          : cur
      )
    }

    const onUp = (e: PointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY)
      let hitPin: string | null = null
      for (const [pin, coord] of pinCoordMap) {
        if (!allowed.has(pin)) continue
        const dx = coord.x - p.x
        const dy = coord.y - p.y
        if (dx * dx + dy * dy <= SNAP_PX * SNAP_PX) {
          hitPin = pin
          break
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

  // Set of compatible pins for the currently-dragging role (used to
  // highlight targets; undefined when not dragging).
  const allowedPins = useMemo(() => {
    if (!drag) return null
    return new Set(pinout.pinsForRole(drag.role, drag.kind))
  }, [drag, pinout])

  return (
    <div
      ref={rootRef}
      className={styles.root}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onBgClick}
    >
      <svg
        className={styles.svg}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <PcbIllustration
          pinCoords={pinCoords}
          pinout={pinout}
          allowedPins={allowedPins}
          draggingSnapPin={drag?.snappedPin ?? null}
          components={components}
          boardLabel={pinout.label}
        />
        <WireOverlay components={components} pinout={pinout} />
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

/* ====================================================================
 * PCB illustration — board body + pin rails with pill stacks
 * ==================================================================== */

function PcbIllustration({
  pinCoords,
  pinout,
  allowedPins,
  draggingSnapPin,
  components,
  boardLabel
}: {
  pinCoords: PinCoord[]
  pinout: BoardPinout
  allowedPins: Set<string> | null
  draggingSnapPin: string | null
  components: PlacedComponent[]
  boardLabel: string
}) {
  const [hoveredPin, setHoveredPin] = useState<string | null>(null)
  const boundPins = useMemo(() => {
    const set = new Set<string>()
    for (const c of components) {
      for (const p of Object.values(c.pins)) if (p) set.add(p)
    }
    return set
  }, [components])

  // Pin-to-matched-peripheral for the pin: when a pin is bound, we brighten
  // the pill that matches the bound role's peripheral so it pops out.
  const pinMatchedCategory = useMemo(() => {
    const m = new Map<string, PillCategory>()
    for (const c of components) {
      for (const [role, pin] of Object.entries(c.pins)) {
        if (!pin) continue
        const cap = pinout.pinCaps[pin]
        if (!cap) continue
        const r = role.toLowerCase()
        // Prefer the category that actually corresponds to the role.
        if (c.kind === 'pot' || c.kind === 'cv_jack') m.set(pin, 'adc')
        else if (c.kind === 'oled_ssd1306') m.set(pin, 'i2c')
        else if (c.kind === 'i2s_codec') m.set(pin, 'i2s')
        else if (c.kind === 'midi_jack') m.set(pin, 'uart')
        else if (r === 'signal' && cap.dac) m.set(pin, 'dac')
        else m.set(pin, 'gpio')
      }
    }
    return m
  }, [components, pinout])

  return (
    <g>
      {/* Caption above board */}
      <text
        x={CANVAS_W / 2}
        y={BOARD_Y - 92}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="22"
        fill="var(--dp-text)"
        letterSpacing="0.28em"
      >
        DAISY PINOUT
      </text>
      <text
        x={CANVAS_W / 2}
        y={BOARD_Y - 68}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="11"
        fill="var(--dp-text-dim)"
        letterSpacing="0.24em"
      >
        BOARD: {boardLabel.toUpperCase()}
      </text>

      {/* Legend — compact color-coded chips above the board */}
      <Legend cx={CANVAS_W / 2} cy={BOARD_Y - 40} />

      {/* Board body */}
      <rect
        x={BOARD_X}
        y={BOARD_Y}
        width={BOARD_W}
        height={BOARD_H}
        rx="10"
        fill="var(--dp-surface-sunken)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1.75"
      />
      {/* Soft inner highlight to suggest PCB mask depth */}
      <rect
        x={BOARD_X + 3}
        y={BOARD_Y + 3}
        width={BOARD_W - 6}
        height={BOARD_H - 6}
        rx="8"
        fill="none"
        stroke="var(--dp-border)"
        strokeWidth="1"
        opacity="0.6"
      />

      {/* Pin-1 corner mark (top-left, inside the board) */}
      <circle
        cx={BOARD_X + 8}
        cy={BOARD_Y + 10}
        r="2.4"
        fill="var(--dp-text-dim)"
      />

      {/* USB-C connector at the top */}
      <rect
        x={BOARD_X + BOARD_W / 2 - 28}
        y={BOARD_Y - 16}
        width="56"
        height="20"
        rx="3"
        fill="var(--dp-border-strong)"
        stroke="var(--dp-text-dim)"
        strokeWidth="1"
      />
      <rect
        x={BOARD_X + BOARD_W / 2 - 20}
        y={BOARD_Y - 12}
        width="40"
        height="11"
        rx="2"
        fill="var(--dp-surface-sunken)"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y - 22}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="8"
        fill="var(--dp-text-dim)"
        letterSpacing="0.14em"
      >
        USB
      </text>

      {/* STM32 chip silhouette — QFP pattern with center text */}
      <g transform={`translate(${BOARD_X + BOARD_W / 2 - 54}, ${BOARD_Y + BOARD_H / 2 - 64})`}>
        <rect
          x={0}
          y={0}
          width={108}
          height={108}
          rx="3"
          fill="var(--dp-bg)"
          stroke="var(--dp-border-strong)"
          strokeWidth="1.25"
        />
        {/* Faux QFP pins along each side (decorative) */}
        {Array.from({ length: 14 }).map((_, i) => {
          const o = 8 + i * 7
          return (
            <g key={`qfp-${i}`} opacity="0.55">
              <line x1={-3} y1={o} x2={0} y2={o} stroke="var(--dp-text-dim)" strokeWidth="1" />
              <line x1={108} y1={o} x2={111} y2={o} stroke="var(--dp-text-dim)" strokeWidth="1" />
              <line x1={o} y1={-3} x2={o} y2={0} stroke="var(--dp-text-dim)" strokeWidth="1" />
              <line x1={o} y1={108} x2={o} y2={111} stroke="var(--dp-text-dim)" strokeWidth="1" />
            </g>
          )
        })}
        {/* Chip pin-1 mark */}
        <circle cx={8} cy={8} r="2" fill="var(--dp-text-dim)" />
        <text
          x={54}
          y={52}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="11"
          fill="var(--dp-text)"
          letterSpacing="0.18em"
        >
          STM32
        </text>
        <text
          x={54}
          y={68}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="10"
          fill="var(--dp-text-muted)"
          letterSpacing="0.18em"
        >
          H750IB
        </text>
      </g>

      {/* Codec silhouette (AK4556 / WM8731) near the bottom */}
      <rect
        x={BOARD_X + BOARD_W / 2 - 26}
        y={BOARD_Y + BOARD_H - 80}
        width="52"
        height="22"
        rx="2"
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H - 66}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="8"
        fill="var(--dp-text-muted)"
        letterSpacing="0.16em"
      >
        AK4556
      </text>

      {/* SDRAM silhouette on the opposite side */}
      <rect
        x={BOARD_X + 18}
        y={BOARD_Y + BOARD_H / 2 + 70}
        width={BOARD_W - 36}
        height="22"
        rx="2"
        fill="var(--dp-bg)"
        stroke="var(--dp-border)"
        strokeWidth="1"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H / 2 + 85}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="7"
        fill="var(--dp-text-dim)"
        letterSpacing="0.14em"
      >
        SDRAM
      </text>

      {/* Status LED dot near the bottom */}
      <circle
        cx={BOARD_X + BOARD_W - 18}
        cy={BOARD_Y + BOARD_H - 18}
        r="3"
        fill="var(--dp-warning)"
        opacity="0.8"
      />

      {/* Wordmark */}
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H - 18}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="9"
        fill="var(--dp-text-dim)"
        letterSpacing="0.24em"
      >
        {boardLabel.toUpperCase()}
      </text>

      {/* Pin rows — name pill + alt-function pills outward */}
      {pinCoords.map((coord) => {
        const cap = pinout.pinCaps[coord.pin] as PinCapabilities | undefined
        const hovered = hoveredPin === coord.pin
        const bound = boundPins.has(coord.pin)
        const allowed = allowedPins ? allowedPins.has(coord.pin) : true
        const dimmed = allowedPins !== null && !allowed
        const snapping = draggingSnapPin === coord.pin
        const matchedCategory = pinMatchedCategory.get(coord.pin) ?? null
        return (
          <PinRow
            key={`${coord.side}-${coord.index}`}
            coord={coord}
            cap={cap}
            bound={bound}
            hovered={hovered}
            dimmed={dimmed}
            snapping={snapping}
            matchedCategory={matchedCategory}
            onHover={(h) => setHoveredPin(h ? coord.pin : null)}
          />
        )
      })}
    </g>
  )
}

/* -------------------- Small legend chips above the board -------------------- */

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
    { label: 'POWER', category: 'power' }
  ]
  const pillW = 54
  const pillH = 16
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
              y={cy + 3.5}
              textAnchor="middle"
              fontFamily="var(--dp-font-mono)"
              fontSize="9"
              letterSpacing="0.12em"
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

/* -------------------- Per-pin row: name pill + pills outward -------------------- */

function PinRow({
  coord,
  cap,
  bound,
  hovered,
  dimmed,
  snapping,
  matchedCategory,
  onHover
}: {
  coord: PinCoord
  cap: PinCapabilities | undefined
  bound: boolean
  hovered: boolean
  dimmed: boolean
  snapping: boolean
  matchedCategory: PillCategory | null
  onHover: (h: boolean) => void
}) {
  const isLeft = coord.side === 'left'
  const isPower = !cap  // power/audio rails have no capability entry
  // The pin-name pill sits just outside the board edge.
  // Alt pills stack further outward. Left side grows to the left; right
  // side grows to the right.
  const nameX = isLeft ? BOARD_X - ROW_GAP_FROM_BOARD - NAME_PILL_W : BOARD_X + BOARD_W + ROW_GAP_FROM_BOARD
  const y = coord.y
  const nameTopY = y - NAME_PILL_H / 2

  // Build the list of pills to show outward. For power/audio rails we
  // synthesize a single descriptive pill so the layout stays consistent.
  const pills: Pill[] = useMemo(() => {
    if (cap) return pillsForPin(cap)
    // Power/audio/USB fallback: one pill describing the rail.
    const name = coord.pin
    const cat: PillCategory =
      name === 'VIN' || name === '3V3' || name === '3V3_A'
        ? 'power'
        : name === 'AGND' || name === 'DGND'
          ? 'ground'
          : name.startsWith('AUDIO')
            ? 'audio'
            : name.startsWith('USB')
              ? 'usb'
              : 'misc'
    return [{ text: coord.label, category: cat }]
  }, [cap, coord.label, coord.pin])

  // Layout the alt pills. First pill is the pin-name pill (consumes the
  // NAME_PILL_W slot). Subsequent pills are alt pills.
  const altPills = pills.slice(1)

  // Baseline opacity depending on filter state.
  const rowOpacity = dimmed ? 0.25 : 1

  return (
    <g
      opacity={rowOpacity}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      style={{ transition: 'opacity 120ms ease' }}
    >
      {/* Thin connector stub from the board edge to the pin-name pill */}
      <line
        x1={isLeft ? BOARD_X : BOARD_X + BOARD_W}
        y1={y}
        x2={isLeft ? nameX + NAME_PILL_W : nameX}
        y2={y}
        stroke="var(--dp-border)"
        strokeWidth="1"
      />
      {/* Header pin dot (simulated solder pad) */}
      <circle
        cx={coord.x}
        cy={y}
        r={PIN_RADIUS}
        fill={bound ? 'var(--dp-accent)' : 'var(--dp-text-dim)'}
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />

      {/* Pin-name pill */}
      <g>
        <rect
          x={nameX}
          y={nameTopY}
          width={NAME_PILL_W}
          height={NAME_PILL_H}
          rx={NAME_PILL_H / 2}
          fill={pillFill(pills[0]?.category ?? 'pin')}
          stroke={
            snapping
              ? 'var(--dp-accent)'
              : bound
                ? 'var(--dp-accent)'
                : 'var(--dp-border-strong)'
          }
          strokeWidth={snapping || bound ? 1.5 : 1}
          style={{
            filter: hovered ? 'brightness(1.15)' : undefined,
            transition: 'stroke 100ms ease, filter 100ms ease'
          }}
        />
        <text
          x={nameX + NAME_PILL_W / 2}
          y={y + 1}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="11"
          fill={pillTextColor(pills[0]?.category ?? 'pin')}
          letterSpacing="0.06em"
          dominantBaseline="middle"
        >
          {coord.pin}
        </text>
        {/* STM32 pin name (micro-text underneath the name pill) */}
        {cap?.stm32Pin ? (
          <text
            x={nameX + NAME_PILL_W / 2}
            y={y + NAME_PILL_H / 2 + 8}
            textAnchor="middle"
            fontFamily="var(--dp-font-mono)"
            fontSize="7"
            fill="var(--dp-text-dim)"
            letterSpacing="0.12em"
          >
            {cap.stm32Pin}
          </text>
        ) : null}
      </g>

      {/* Alt-function pills */}
      {altPills.map((p, i) => {
        const pillW = Math.max(
          30,
          ALT_PILL_PAD_X * 2 + p.text.length * ALT_PILL_CHAR_W
        )
        // Position each pill further from the board.
        // Compute cumulative offset by summing previous pill widths.
        let offset = ALT_PILL_GAP
        for (let j = 0; j < i; j++) {
          const prev = altPills[j]
          const w = Math.max(
            30,
            ALT_PILL_PAD_X * 2 + prev.text.length * ALT_PILL_CHAR_W
          )
          offset += w + ALT_PILL_GAP
        }
        const px = isLeft
          ? nameX - offset - pillW
          : nameX + NAME_PILL_W + offset
        const py = y - ALT_PILL_H / 2
        const highlighted = matchedCategory === p.category && bound
        return (
          <g key={`${coord.pin}-alt-${i}`}>
            <rect
              x={px}
              y={py}
              width={pillW}
              height={ALT_PILL_H}
              rx={ALT_PILL_H / 2}
              fill={pillFill(p.category)}
              stroke={highlighted ? 'var(--dp-accent)' : 'transparent'}
              strokeWidth={highlighted ? 1.25 : 0}
              opacity={highlighted ? 1 : hovered ? 1 : 0.88}
              style={{ transition: 'opacity 100ms ease' }}
            />
            <text
              x={px + pillW / 2}
              y={y + 1}
              textAnchor="middle"
              fontFamily="var(--dp-font-mono)"
              fontSize="9"
              fill={pillTextColor(p.category)}
              dominantBaseline="middle"
              letterSpacing="0.06em"
            >
              {p.text}
            </text>
          </g>
        )
      })}

      {/* Hover tooltip (power users — replicates old behaviour for non-
          power rails) */}
      {hovered && cap && !isPower ? (
        <PinTooltip coord={coord} cap={cap} />
      ) : null}
    </g>
  )
}

function PinTooltip({
  coord,
  cap
}: {
  coord: PinCoord
  cap: PinCapabilities
}) {
  const items: string[] = []
  if (cap.gpio) items.push('GPIO')
  if (cap.adc) items.push('ADC')
  if (cap.dac) items.push('DAC')
  if (cap.pwm) items.push('PWM')
  if (cap.i2c) items.push(`I2C.${cap.i2c}`)
  if (cap.spi) items.push(`SPI.${cap.spi}`)
  if (cap.uart) items.push(`UART.${cap.uart}`)
  if (cap.i2s) items.push(`I2S.${cap.i2s}`)
  const isLeft = coord.side === 'left'
  const tipX = isLeft ? BOARD_X + BOARD_W + 14 : BOARD_X - 14 - 180
  const tipY = coord.y - 30
  return (
    <g pointerEvents="none">
      <rect
        x={tipX}
        y={tipY}
        width={180}
        height={48}
        rx="4"
        fill="var(--dp-surface)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
        opacity="0.98"
      />
      <text
        x={tipX + 8}
        y={tipY + 16}
        fontFamily="var(--dp-font-mono)"
        fontSize="10"
        fill="var(--dp-text)"
      >
        {cap.label ?? coord.pin}
      </text>
      <text
        x={tipX + 8}
        y={tipY + 32}
        fontFamily="var(--dp-font-mono)"
        fontSize="8"
        fill="var(--dp-text-muted)"
        letterSpacing="0.06em"
      >
        {items.join('  ')}
      </text>
    </g>
  )
}

/* -------------------- Wire overlay (bound-role lines) -------------------- */

function WireOverlay({
  components,
  pinout
}: {
  components: PlacedComponent[]
  pinout: BoardPinout
}) {
  return (
    <g>
      {components.flatMap((c) => {
        const cardCx = c.position.x + 60  // CARD_W/2
        const cardCy = c.position.y + 40
        return KIND_ROLES[c.kind]
          .map((role) => {
            const pin = c.pins[role]
            if (!pin) return null
            const pos = pinPos(pin, pinout.physicalLayout)
            if (!pos) return null
            const color = wireColorForPin(pin, pinout.pinCaps)
            return (
              <line
                key={`${c.id}-${role}`}
                x1={cardCx}
                y1={cardCy}
                x2={pos.x}
                y2={pos.y}
                stroke={color}
                strokeWidth="1.4"
                strokeDasharray="3 4"
                strokeLinecap="round"
                opacity="0.9"
                className={styles.wireFadeIn}
              />
            )
          })
          .filter(Boolean) as React.ReactNode[]
      })}
    </g>
  )
}

/* -------------------- Wiring preview line (while dragging) ----------- */

function WiringPreview({
  drag,
  pinCoordMap
}: {
  drag: WiringDrag
  pinCoordMap: Map<string, PinCoord>
}) {
  // Rubber-band to the snapped pin when present.
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
        strokeWidth="1.5"
        strokeDasharray="4 4"
        strokeLinecap="round"
        opacity="0.95"
      />
      {/* Arrowhead dot at the far end */}
      <circle
        cx={tx}
        cy={ty}
        r={snapped ? 7 : 4}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth="1.5"
        opacity={snapped ? 1 : 0.6}
      />
    </g>
  )
}

/* ====================================================================
 * Placed component card (HTML overlay, not SVG)
 * ==================================================================== */

const CARD_W = 140
const CARD_H = 100

interface HardwareCardProps {
  comp: PlacedComponent
  selected: boolean
  onSelect: () => void
  /** Which pins are legal for this role on the active board. */
  allowedPinsForRole: (role: string) => Set<string>
  pinout: BoardPinout
  /** Start a wire drag from a role badge; positions are in CANVAS coords. */
  onBeginWireDrag: (componentId: string, role: string, kind: string, sx: number, sy: number) => void
  /** Convert client coords to canvas coords. */
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number }
  /** Which of this card's role badges is currently being dragged (if any). */
  activeDragRole: string | null
}

function HardwareCard({
  comp,
  selected,
  onSelect,
  allowedPinsForRole,
  pinout,
  onBeginWireDrag,
  toCanvas,
  activeDragRole
}: HardwareCardProps) {
  const moveHardware = useEditorStore((s) => s.moveHardware)
  const rootRef = useRef<HTMLDivElement>(null)
  const badgeRefs = useRef<Record<string, HTMLDivElement | null>>({})
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

  // Card-drag (position) handlers. Role badges stop propagation so they
  // don't trigger card drag.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragStateRef.current
      if (!st || !rootRef.current) return
      const parentRect = rootRef.current.parentElement?.getBoundingClientRect()
      if (!parentRect) return
      const scaleX = CANVAS_W / parentRect.width
      const scaleY = CANVAS_H / parentRect.height
      const dx = (e.clientX - st.startClient.x) * scaleX
      const dy = (e.clientY - st.startClient.y) * scaleY
      moveHardware(comp.id, {
        x: st.startPos.x + dx,
        y: st.startPos.y + dy
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
  }, [comp.id, moveHardware])

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      // Ignore clicks on interactive child widgets (buttons, selects, badges).
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

  // Clamp the card inside the canvas in CSS% so it scales with parent.
  const leftPct = (comp.position.x / CANVAS_W) * 100
  const topPct = (comp.position.y / CANVAS_H) * 100
  const widthPct = (CARD_W / CANVAS_W) * 100
  const heightPct = (CARD_H / CANVAS_H) * 100

  return (
    <div
      ref={rootRef}
      className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
      style={{
        left: `${leftPct}%`,
        top: `${topPct}%`,
        width: `${widthPct}%`,
        height: `${heightPct}%`
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
      {/* Role badges — one per required role, arranged along the bottom */}
      <div className={styles.roleRow}>
        {requiredRoles.map((role) => {
          const pin = comp.pins[role]
          const isBound = !!pin
          const dragging = activeDragRole === role
          return (
            <RoleBadge
              key={role}
              role={role}
              componentId={comp.id}
              kind={comp.kind}
              currentPin={pin ?? null}
              allowed={allowedPinsForRole(role)}
              pinout={pinout}
              isBound={isBound}
              isDragging={dragging}
              onBeginWireDrag={onBeginWireDrag}
              toCanvas={toCanvas}
              registerRef={(el) => (badgeRefs.current[role] = el)}
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

/* -------------------- Role badge + popover -------------------- */

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
  registerRef: (el: HTMLDivElement | null) => void
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
  registerRef,
  onOpenPopover,
  onClosePopover,
  popoverOpen
}: RoleBadgeProps) {
  const setHardwarePin = useEditorStore((s) => s.setHardwarePin)
  const rootRef = useRef<HTMLDivElement>(null)
  const pressStateRef = useRef<{
    startClient: { x: number; y: number }
    startedDrag: boolean
  } | null>(null)

  useLayoutEffect(() => {
    registerRef(rootRef.current)
    return () => registerRef(null)
  }, [registerRef])

  // Drag threshold in CSS px before we flip from click→drag.
  const DRAG_THRESHOLD = 4

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      pressStateRef.current = {
        startClient: { x: e.clientX, y: e.clientY },
        startedDrag: false
      }
    },
    []
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const st = pressStateRef.current
      if (!st || st.startedDrag) return
      const dx = e.clientX - st.startClient.x
      const dy = e.clientY - st.startClient.y
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
      // Crossed threshold → begin wire drag.
      st.startedDrag = true
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
      const st = pressStateRef.current
      if (st && !st.startedDrag) {
        // Tap without drag → open popover.
        e.stopPropagation()
        onOpenPopover()
      }
      pressStateRef.current = null
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
          : `${role} (drag to a pin, or click to pick)`
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
  // Close on outside click.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
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
