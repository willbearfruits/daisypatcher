/**
 * HardwareView — the full-canvas hardware layout editor. Replaces the
 * patch-graph Rete canvas when `store.view === 'hardware'`.
 *
 * Layout
 * ------
 * Single full-bleed area. Inside:
 *   - A central SVG illustration of the Daisy Seed, with pin dots laid
 *     out along two headers per `PHYSICAL_PIN_LAYOUT`. Each pin dot is
 *     clickable; hovering shows a tooltip of its label and capabilities.
 *   - Placed components rendered as HTML cards positioned in absolute
 *     space around the Seed. A thin dotted SVG line is drawn from each
 *     bound role on a card to its assigned Seed pin. Wire color comes
 *     from the pin's primary capability (ADC -> CV, GPIO -> gate,
 *     I2C/I2S -> audio).
 *
 * Interaction
 * -----------
 *   - Drag a card in from the left palette: drop spawns a new placed
 *     component at cursor position, unbound.
 *   - Click a placed card to select it; inspector shows pin dropdowns.
 *   - Drag a placed card anywhere to reposition. The drag is coalesced
 *     into a single undo step via the store's transaction API.
 *   - Click on a pin-dot to cycle through unbound components' roles —
 *     this is a cheap fallback for now; the real "drag a role onto a
 *     pin" interaction can be layered on later without changing the
 *     data model.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '@/state/store'
import { KIND_ROLES } from '@/types/hardware'
import type { BoardPin, PlacedComponent } from '@/types/hardware'
import { getBoardPinout } from './boardPinout'
import type { BoardPhysicalPinPosition } from './boardPinout'
import { HARDWARE_DRAG_MIME } from './HardwarePalette'
import { HARDWARE_ICON } from './hardwareIcons'
import styles from './HardwareView.module.css'

/* --- PCB layout constants --- */

const CANVAS_W = 1200
const CANVAS_H = 900
const BOARD_W = 180
const BOARD_H = 520
const BOARD_X = (CANVAS_W - BOARD_W) / 2
const BOARD_Y = (CANVAS_H - BOARD_H) / 2
const PIN_ROW_COUNT = 20
const PIN_ROW_MARGIN = 20
const PIN_SPACING = (BOARD_H - 2 * PIN_ROW_MARGIN) / (PIN_ROW_COUNT - 1)
const PIN_RADIUS = 5
const PIN_LEFT_X = BOARD_X + 14
const PIN_RIGHT_X = BOARD_X + BOARD_W - 14

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

/** Map a board-pin identifier to its (x,y) on the canvas, or null. */
function pinPos(pin: BoardPin, layout: BoardPhysicalPinPosition[]): { x: number; y: number } | null {
  const found = layout.find((p) => p.pin === pin)
  if (!found) return null
  return {
    x: found.side === 'left' ? PIN_LEFT_X : PIN_RIGHT_X,
    y: BOARD_Y + PIN_ROW_MARGIN + found.index * PIN_SPACING
  }
}

/**
 * Pick the wire color for a bound pin. ADC -> CV magenta, I2C/I2S -> audio cyan,
 * GPIO default -> gate amber.
 */
function wireColorVar(pin: BoardPin, caps: Record<string, { adc?: boolean; i2c?: unknown; i2s?: unknown }>): string {
  const cap = caps[pin as string]
  if (cap?.adc) return 'var(--dp-signal-cv)'
  if (cap?.i2c || cap?.i2s) return 'var(--dp-signal-audio)'
  return 'var(--dp-signal-gate)'
}

export function HardwareView() {
  const components = useEditorStore((s) => s.hardware.components)
  const board = useEditorStore((s) => s.hardware.board)
  const selectedId = useEditorStore((s) => s.selectedHardwareId)
  const selectHardware = useEditorStore((s) => s.selectHardware)
  const addHardware = useEditorStore((s) => s.addHardware)
  const rootRef = useRef<HTMLDivElement>(null)
  const pinout = useMemo(() => getBoardPinout(board), [board])
  const pinCoords = useMemo(() => computePinCoords(pinout.physicalLayout), [pinout])

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
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      // Scale into canvas coords so placement persists regardless of screen size.
      const scaleX = CANVAS_W / rect.width
      const scaleY = CANVAS_H / rect.height
      const x = (e.clientX - rect.left) * scaleX
      const y = (e.clientY - rect.top) * scaleY
      const id = addHardware(kind as PlacedComponent['kind'], { x, y })
      selectHardware(id)
    },
    [addHardware, selectHardware]
  )

  // Clicking background deselects; clicking a card selects.
  const onBgClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) selectHardware(null)
    },
    [selectHardware]
  )

  return (
    <div
      ref={rootRef}
      className={styles.root}
      /* Inline fallback sizing so the view stays visible even if the CSS
         module fails to load (e.g. HMR hiccup) — tokens applied on top. */
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
        <PcbIllustration pinCoords={pinCoords} pinCaps={pinout.pinCaps} boardLabel={pinout.label} />
        <WireOverlay components={components} pinout={pinout} />
      </svg>
      <div className={styles.overlay}>
        {components.map((c) => (
          <HardwareCard
            key={c.id}
            comp={c}
            selected={c.id === selectedId}
            onSelect={() => selectHardware(c.id)}
            allowedPinsForRole={(role) => new Set(pinout.pinsForRole(role, c.kind))}
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

/* -------------------- PCB illustration -------------------- */

function PcbIllustration({
  pinCoords,
  pinCaps,
  boardLabel
}: {
  pinCoords: PinCoord[]
  pinCaps: Record<string, { adc?: boolean; gpio?: boolean; strapping?: boolean; usbReserved?: boolean }>
  boardLabel: string
}) {
  const [hoveredPin, setHoveredPin] = useState<string | null>(null)
  // Important: this selector must return a cached reference. Building a new
  // Set inside the selector makes useSyncExternalStore fire on every render
  // (fresh object identity every time), triggering an infinite loop. Select
  // the stable `components` array and derive the Set via useMemo instead.
  const components = useEditorStore((s) => s.hardware.components)
  const boundPins = useMemo(() => {
    const set = new Set<string>()
    for (const c of components) {
      for (const p of Object.values(c.pins)) {
        if (p) set.add(p)
      }
    }
    return set
  }, [components])

  return (
    <g>
      {/* Board body */}
      <rect
        x={BOARD_X}
        y={BOARD_Y}
        width={BOARD_W}
        height={BOARD_H}
        rx="6"
        fill="var(--dp-surface-elevated)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1.5"
      />
      {/* USB connector at the top */}
      <rect
        x={BOARD_X + BOARD_W / 2 - 22}
        y={BOARD_Y - 10}
        width="44"
        height="14"
        rx="2"
        fill="var(--dp-border-strong)"
        stroke="var(--dp-text-dim)"
        strokeWidth="1"
      />
      <rect
        x={BOARD_X + BOARD_W / 2 - 16}
        y={BOARD_Y - 7}
        width="32"
        height="8"
        fill="var(--dp-surface-sunken)"
      />
      {/* STM32 silhouette — small square in the middle */}
      <rect
        x={BOARD_X + BOARD_W / 2 - 28}
        y={BOARD_Y + BOARD_H / 2 - 28}
        width="56"
        height="56"
        rx="2"
        fill="var(--dp-surface-sunken)"
        stroke="var(--dp-border)"
        strokeWidth="1"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H / 2 + 4}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="9"
        fill="var(--dp-text-dim)"
        letterSpacing="0.12em"
      >
        STM32H7
      </text>
      {/* Wordmark */}
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H - 14}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="9"
        fill="var(--dp-text-dim)"
        letterSpacing="0.2em"
      >
        {boardLabel.toUpperCase()}
      </text>

      {/* Pin dots */}
      {pinCoords.map((p) => {
        const cap = pinCaps[p.pin]
        const isGpio = !!cap?.gpio
        const bound = boundPins.has(p.pin)
        const strap = !!cap?.strapping
        const hovered = hoveredPin === `${p.side}:${p.index}`
        const fill = !isGpio
          ? 'var(--dp-text-dim)'
          : bound
            ? 'var(--dp-signal-audio)'
            : strap
              ? 'var(--dp-signal-gate)'
              : 'var(--dp-text-muted)'
        return (
          <g
            key={`${p.side}-${p.index}`}
            onMouseEnter={() => setHoveredPin(`${p.side}:${p.index}`)}
            onMouseLeave={() => setHoveredPin(null)}
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={hovered ? PIN_RADIUS + 2 : PIN_RADIUS}
              fill={fill}
              stroke={strap ? 'var(--dp-signal-gate)' : 'var(--dp-border-strong)'}
              strokeWidth={strap ? 1.5 : 1}
              style={{ cursor: 'default' }}
            />
            {/* Silkscreen label — outside the board */}
            <text
              x={p.side === 'left' ? p.x - 10 : p.x + 10}
              y={p.y + 3}
              fontFamily="var(--dp-font-mono)"
              fontSize="8"
              textAnchor={p.side === 'left' ? 'end' : 'start'}
              fill={hovered ? 'var(--dp-text)' : 'var(--dp-text-dim)'}
            >
              {p.label}
            </text>
            {hovered ? <PinTooltip coord={p} pinCaps={pinCaps} /> : null}
          </g>
        )
      })}
    </g>
  )
}

function PinTooltip({
  coord,
  pinCaps
}: {
  coord: PinCoord
  pinCaps: Record<string, {
    gpio?: boolean; adc?: boolean; dac?: boolean; pwm?: boolean
    i2c?: string; spi?: string; uart?: string; i2s?: string
    strapping?: boolean; usbReserved?: boolean
  }>
}) {
  const cap = pinCaps[coord.pin] ?? null
  const caps: string[] = []
  if (cap?.gpio) caps.push('GPIO')
  if (cap?.adc) caps.push('ADC')
  if (cap?.dac) caps.push('DAC')
  if (cap?.pwm) caps.push('PWM')
  if (cap?.i2c) caps.push(`I2C(${cap.i2c})`)
  if (cap?.spi) caps.push(`SPI(${cap.spi})`)
  if (cap?.uart) caps.push(`UART(${cap.uart})`)
  if (cap?.i2s) caps.push(`I2S(${cap.i2s})`)
  if (cap?.strapping) caps.push('STRAP')
  if (cap?.usbReserved) caps.push('USB')
  const tooltipX = coord.side === 'left' ? coord.x - 100 : coord.x + 14
  const tooltipY = coord.y - 20
  const width = 96
  const height = caps.length ? 32 : 20
  const text = caps.join('  ')
  return (
    <g pointerEvents="none">
      <rect
        x={tooltipX}
        y={tooltipY}
        width={width}
        height={height}
        rx="3"
        fill="var(--dp-surface)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />
      <text
        x={tooltipX + 6}
        y={tooltipY + 12}
        fontFamily="var(--dp-font-mono)"
        fontSize="9"
        fill="var(--dp-text)"
      >
        {coord.label}
      </text>
      {caps.length ? (
        <text
          x={tooltipX + 6}
          y={tooltipY + 24}
          fontFamily="var(--dp-font-mono)"
          fontSize="8"
          fill="var(--dp-text-muted)"
        >
          {text}
        </text>
      ) : null}
    </g>
  )
}

/* -------------------- Wire overlay -------------------- */

function WireOverlay({
  components,
  pinout
}: {
  components: PlacedComponent[]
  pinout: import('./boardPinout').BoardPinout
}) {
  return (
    <g>
      {components.flatMap((c) => {
        const cardCx = c.position.x + 60  // CARD_W/2
        const cardCy = c.position.y + 40  // roughly card vcenter
        return KIND_ROLES[c.kind]
          .map((role) => {
            const pin = c.pins[role]
            if (!pin) return null
            const pos = pinPos(pin, pinout.physicalLayout)
            if (!pos) return null
            const color = wireColorVar(pin, pinout.pinCaps)
            return (
              <line
                key={`${c.id}-${role}`}
                x1={cardCx}
                y1={cardCy}
                x2={pos.x}
                y2={pos.y}
                stroke={color}
                strokeWidth="1.25"
                strokeDasharray="3 4"
                strokeLinecap="round"
                opacity="0.85"
              />
            )
          })
          .filter(Boolean) as React.ReactNode[]
      })}
    </g>
  )
}

/* -------------------- Placed component card -------------------- */

const CARD_W = 120
const CARD_H = 80

interface HardwareCardProps {
  comp: PlacedComponent
  selected: boolean
  onSelect: () => void
  /** Which pins are legal for this role on the active board. */
  allowedPinsForRole: (role: string) => Set<string>
}

function HardwareCard({ comp, selected, onSelect, allowedPinsForRole }: HardwareCardProps) {
  const moveHardware = useEditorStore((s) => s.moveHardware)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{
    startClient: { x: number; y: number }
    startPos: { x: number; y: number }
  } | null>(null)

  const Icon = HARDWARE_ICON[comp.kind]
  const requiredRoles = KIND_ROLES[comp.kind]
  const bound = requiredRoles.every((r) => {
    const pin = comp.pins[r]
    if (!pin) return false
    return allowedPinsForRole(r).has(pin)
  })

  useEffect(() => {
    // Mouse handlers live on the window so we keep tracking even when the
    // pointer leaves the card; unmount clears both.
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
      if ((e.target as HTMLElement).tagName === 'BUTTON') return
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
    </div>
  )
}

