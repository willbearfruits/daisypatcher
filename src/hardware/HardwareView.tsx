/**
 * HardwareView — full-canvas hardware layout editor. Replaces the patch-
 * graph Rete canvas when `store.view === 'hardware'`.
 *
 * Rewrite (2026-04-21, SVG-only):
 *   Every visible element — board silhouette, pin rows, placed components,
 *   role badges, wires, binding labels — renders INSIDE the same <svg>
 *   element in the same coordinate system. There is no HTML DOM overlay
 *   for placed components. Because components and wires share the SVG's
 *   viewBox, wires cannot visually drift from the shapes they terminate
 *   at; pan and zoom are pure viewBox updates that move everything
 *   together.
 *
 *   Only input-space math crosses coordinate systems — the `toCanvas`
 *   helper uses `svg.getScreenCTM().inverse()` to map client events onto
 *   the canvas, never for rendering.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ReactElement } from 'react'
import { useEditorStore } from '@/state/store'
import { KIND_ROLES, roleLabel } from '@/types/hardware'
import type {
  BoardPin,
  HardwareKind,
  PinCapabilities,
  PlacedComponent
} from '@/types/hardware'
import { getBoardPinout } from './boardPinout'
import type { BoardPhysicalPinPosition, BoardPinout, ResolvedGeometry } from './boardPinout'
import { resolveGeometry } from './boardPinout'
import { HARDWARE_DRAG_MIME } from './HardwarePalette'
import {
  MM_PER_UNIT,
  nextRotation,
  renderComponentShape,
  rotationOf,
  shapeSizeCanvas
} from './componentShapes'
import styles from './HardwareView.module.css'
import activityStyles from './HardwareActivity.module.css'
import {
  HardwareActivityProvider,
  useHardwareActivity,
  type ActivityFrame
} from './HardwareActivity'
import { BindingLabels } from './BindingLabels'

/* =====================================================================
 * Constants.
 * ===================================================================== */

const CANVAS_W = 1400
const CANVAS_H = 1500

/*
 * Board box + pin pitch used to live here as module constants, with a
 * hardcoded ROWS_PER_SIDE = 20. That worked only because both original
 * boards happen to have exactly 20 pins per side; a SuperMini has 8.
 * They now come from `getBoardPinout(board).geometry`, resolved once per
 * render by `resolveGeometry` — see boardPinout.ts. The Seed and S3
 * DevKitC values are unchanged, so their rendering is pixel-identical.
 */

const NAME_PILL_W = 62
const NAME_PILL_H = 22

const ALT_PILL_H = 18
const ALT_PILL_GAP = 4
const ALT_PILL_PAD_X = 7
const ALT_PILL_CHAR_W = 6.2

const ROW_GAP_FROM_BOARD = 12

/** Distance (canvas units) within which wire-drag snaps to a pin. */
const SNAP_PX = 26

/** Grid: 2 mm minor, 10 mm major (canvas units via MM_PER_UNIT=3). */
const GRID_MINOR_MM = 2
const GRID_MAJOR_MM = 10
const GRID_MINOR = GRID_MINOR_MM * MM_PER_UNIT
const GRID_MAJOR = GRID_MAJOR_MM * MM_PER_UNIT

function snapToGrid(v: number): number {
  return Math.round(v / GRID_MINOR) * GRID_MINOR
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (t as HTMLElement).isContentEditable === true
  )
}

/* =====================================================================
 * Pill taxonomy — maps poster alt-function tokens to a color category.
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

function pillsFromLabel(label: string | undefined, pin: string): Pill[] {
  const pills: Pill[] = [{ text: pin, category: 'pin' }]
  if (!label) return pills
  const seen = new Set([pin.toUpperCase()])
  for (const rawTok of label.split('/').map((t) => t.trim()).filter(Boolean)) {
    const up = rawTok.toUpperCase()
    if (seen.has(up)) continue
    if (/^D\d+$/.test(up)) continue
    seen.add(up)
    pills.push({ text: rawTok, category: categorize(rawTok) })
  }
  return pills
}

function primaryCategoryOf(pills: Pill[]): PillCategory {
  const order: PillCategory[] = ['adc', 'dac', 'i2c', 'spi', 'uart', 'i2s', 'pwm', 'audio', 'usb', 'sd', 'gpio']
  for (const c of order) {
    if (pills.some((p) => p.category === c)) return c
  }
  return 'pin'
}

/* =====================================================================
 * Pin coord helpers.
 * ===================================================================== */

interface PinCoord {
  pin: string
  side: 'left' | 'right' | 'bottom'
  index: number
  label: string
  x: number
  y: number
  pillsX: number
}

function computePinCoords(
  layout: BoardPhysicalPinPosition[],
  g: ResolvedGeometry
): PinCoord[] {
  return layout.map((p) => {
    if (p.side === 'bottom') {
      const x = g.boardX + g.boardW / 2 + (p.index - 0.5) * 110
      const y = g.boardY + g.boardH + 48
      return { pin: p.pin, side: p.side, index: p.index, label: p.label, x, y, pillsX: x }
    }
    const x =
      p.side === 'left'
        ? g.boardX + g.pinEdgeInset
        : g.boardX + g.boardW - g.pinEdgeInset
    /*
     * Reverse within the LEFT column's OWN length, not the global row
     * count. For the symmetric legacy boards these are the same number,
     * so nothing moves; on an asymmetric board reversing against the
     * global max would push the shorter column off the silhouette.
     */
    const rowIndex =
      p.side === 'left' && g.leftColumnBottomUp ? g.leftCount - 1 - p.index : p.index
    const y = g.boardY + g.rowTopMargin + rowIndex * g.pitch
    const pillsX = p.side === 'left' ? g.boardX : g.boardX + g.boardW
    return { pin: p.pin, side: p.side, index: p.index, label: p.label, x, y, pillsX }
  })
}

/* =====================================================================
 * Wiring-drag state.
 * ===================================================================== */

interface WiringDrag {
  componentId: string
  role: string
  kind: HardwareKind
  sourceX: number
  sourceY: number
  x: number
  y: number
  snappedPin: string | null
}

/* =====================================================================
 * Top-level HardwareView.
 * ===================================================================== */

export function HardwareView() {
  return (
    <HardwareActivityProvider>
      <HardwareViewInner />
    </HardwareActivityProvider>
  )
}

function HardwareViewInner() {
  const components = useEditorStore((s) => s.hardware.components)
  const board = useEditorStore((s) => s.hardware.board)
  const selectedId = useEditorStore((s) => s.selectedHardwareId)
  const selectHardware = useEditorStore((s) => s.selectHardware)
  const addHardware = useEditorStore((s) => s.addHardware)
  const setHardwarePin = useEditorStore((s) => s.setHardwarePin)
  const moveHardware = useEditorStore((s) => s.moveHardware)
  const setHardwareConfig = useEditorStore((s) => s.setHardwareConfig)
  const removeHardware = useEditorStore((s) => s.removeHardware)

  const [showLabels, setShowLabels] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [snap, setSnap] = useState(true)

  const [zoom, setZoom] = useState(1)
  const [vbOrigin, setVbOrigin] = useState({ x: 0, y: 0 })
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const vbOriginRef = useRef(vbOrigin)
  vbOriginRef.current = vbOrigin

  const rootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const pinout = useMemo(() => getBoardPinout(board), [board])
  const geom = useMemo(() => resolveGeometry(pinout, CANVAS_W), [pinout])

  /*
   * How many bindings point at pins this board doesn't have. Switching
   * boards deliberately leaves them dangling rather than clearing them,
   * so the user needs to see that there's something to fix — and a way to
   * fix it that isn't repinning every role by hand.
   */
  const invalidPins = useEditorStore((s) => {
    const caps = getBoardPinout(s.hardware.board).pinCaps
    let n = 0
    for (const c of s.hardware.components)
      for (const p of Object.values(c.pins))
        if (typeof p === 'string' && !(p in caps)) n++
    return n
  })
  const repinForBoard = useEditorStore((s) => s.repinForBoard)
  const pinCoords = useMemo(
    () => computePinCoords(pinout.physicalLayout, geom),
    [pinout]
  )
  const pinCoordMap = useMemo(() => {
    const m = new Map<string, PinCoord>()
    for (const c of pinCoords) m.set(c.pin, c)
    return m
  }, [pinCoords])

  const [drag, setDrag] = useState<WiringDrag | null>(null)

  /** Convert client-space point to SVG canvas coords. Only used for input
   *  events — rendering stays in canvas coords throughout. */
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const p = pt.matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  const beginWireDrag = useCallback(
    (
      componentId: string,
      role: string,
      kind: HardwareKind,
      sx: number,
      sy: number
    ) => {
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

  /* Window-level listener pair for role-badge wire drags. */
  useEffect(() => {
    if (!drag) return
    const allowed = new Set(pinout.pinsForRole(drag.role, drag.kind))

    const onMove = (e: PointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY)
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
      const els = document.elementsFromPoint(e.clientX, e.clientY)
      let hitPin: string | null = null
      for (const el of els) {
        const attr = (el as Element).getAttribute?.('data-pin-row')
        if (attr && allowed.has(attr)) {
          hitPin = attr
          break
        }
      }
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

  /* Palette drag/drop onto the canvas. */
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(HARDWARE_DRAG_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const kind = e.dataTransfer.getData(HARDWARE_DRAG_MIME) as HardwareKind
      if (!kind) return
      e.preventDefault()
      const p = toCanvas(e.clientX, e.clientY)
      const nat = shapeSizeCanvas(kind)
      let x = p.x - nat.w / 2
      let y = p.y - nat.h / 2
      if (snap) {
        x = snapToGrid(x)
        y = snapToGrid(y)
      }
      const id = addHardware(kind, { x, y })
      selectHardware(id)
    },
    [addHardware, selectHardware, toCanvas, snap]
  )

  /* Pan / zoom. */
  const fitToBoard = useCallback(() => {
    setZoom(1)
    setVbOrigin({ x: 0, y: 0 })
  }, [])

  const zoomActualSize = useCallback(() => {
    setZoom(1)
    setVbOrigin({ x: 0, y: 0 })
  }, [])

  const toggleGrid = useCallback(() => setShowGrid((v) => !v), [])
  const toggleSnap = useCallback(() => setSnap((v) => !v), [])

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const delta = -e.deltaY
      const factor = Math.exp(delta * 0.0015)
      const p = toCanvas(e.clientX, e.clientY)
      const z0 = zoomRef.current
      const z1 = Math.max(0.3, Math.min(4, z0 * factor))
      const vb0 = vbOriginRef.current
      const nx = p.x - (p.x - vb0.x) * (z0 / z1)
      const ny = p.y - (p.y - vb0.y) * (z0 / z1)
      setZoom(z1)
      setVbOrigin({ x: nx, y: ny })
    },
    [toCanvas]
  )

  /* Space-drag / middle-click pan. */
  const spaceHeldRef = useRef(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const panDragRef = useRef<{
    startClient: { x: number; y: number }
    startOrigin: { x: number; y: number }
  } | null>(null)
  const [isPanning, setIsPanning] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTextTarget(e.target)) {
        if (!spaceHeldRef.current) {
          spaceHeldRef.current = true
          setSpaceHeld(true)
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false
        setSpaceHeld(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const onPanStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const isMiddle = e.button === 1
    const isSpaceLeft = e.button === 0 && spaceHeldRef.current
    if (!isMiddle && !isSpaceLeft) return
    e.preventDefault()
    e.stopPropagation()
    panDragRef.current = {
      startClient: { x: e.clientX, y: e.clientY },
      startOrigin: { ...vbOriginRef.current }
    }
    setIsPanning(true)
  }, [])

  useEffect(() => {
    if (!isPanning) return
    const onMove = (e: MouseEvent) => {
      const st = panDragRef.current
      if (!st) return
      const svg = svgRef.current
      if (!svg) return
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const scale = 1 / (ctm.a || 1)
      const dx = (e.clientX - st.startClient.x) * scale
      const dy = (e.clientY - st.startClient.y) * scale
      setVbOrigin({ x: st.startOrigin.x - dx, y: st.startOrigin.y - dy })
    }
    const onUp = () => {
      panDragRef.current = null
      setIsPanning(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isPanning])

  /* Keyboard shortcuts for the selected component. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return
      if (!selectedId) return
      const step = e.shiftKey ? 10 * MM_PER_UNIT : 1 * MM_PER_UNIT
      const comp = useEditorStore
        .getState()
        .hardware.components.find((c) => c.id === selectedId)
      if (!comp) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        moveHardware(comp.id, { x: comp.position.x - step, y: comp.position.y })
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        moveHardware(comp.id, { x: comp.position.x + step, y: comp.position.y })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveHardware(comp.id, { x: comp.position.x, y: comp.position.y - step })
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveHardware(comp.id, { x: comp.position.x, y: comp.position.y + step })
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        setHardwareConfig(comp.id, 'rotation', nextRotation(rotationOf(comp)))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeHardware(comp.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, moveHardware, setHardwareConfig, removeHardware])

  /* Deselect on SVG empty-area click. */
  const onBackgroundClick = useCallback(() => {
    selectHardware(null)
  }, [selectHardware])

  /* While dragging a wire, compute allowed pins for highlighting. */
  const allowedPins = useMemo(() => {
    if (!drag) return null
    return new Set(pinout.pinsForRole(drag.role, drag.kind))
  }, [drag, pinout])

  /* viewBox derived from pan + zoom. */
  const vbW = CANVAS_W / zoom
  const vbH = CANVAS_H / zoom
  const vbX = vbOrigin.x
  const vbY = vbOrigin.y

  const cursorClass = isPanning
    ? styles.panning
    : spaceHeld
      ? styles.panReady
      : ''

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${cursorClass}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onWheel={onWheel}
      onMouseDown={onPanStart}
    >
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={(e) => {
          // Only deselect when the click lands on the SVG background itself,
          // not on any child. Pan is already handled earlier via the parent
          // div's onMouseDown with modifier checks.
          if (e.button !== 0) return
          if (e.target === e.currentTarget) {
            onBackgroundClick()
          }
        }}
      >
        {showGrid ? <GridLayer /> : null}

        <Caption boardLabel={pinout.label} provisional={pinout.provisional} />
        <Legend cx={CANVAS_W / 2} cy={168} />

        {/* Data-driven: adding a board never touches this file. */}
        {(() => {
          const Silhouette = SILHOUETTES[geom.silhouette]
          return <Silhouette geom={geom} />
        })()}

        <PinRows
          pinCoords={pinCoords}
          pinout={pinout}
          geom={geom}
          allowedPins={allowedPins}
          draggingSnapPin={drag?.snappedPin ?? null}
          components={components}
        />

        <WireOverlay
          components={components}
          pinCoordMap={pinCoordMap}
          zoom={zoom}
        />

        {showLabels ? (
          <BindingLabels
            components={components}
            pinCoordMap={pinCoordMap}
            boardX={geom.boardX}
            boardW={geom.boardW}
          />
        ) : null}

        {/* Placed components — render AFTER wires so component chrome is
            on top. Wires still anchor cleanly to component centers because
            both live in the same SVG coordinate space. */}
        <g>
          {components.map((c) => (
            <PlacedComponentView
              key={c.id}
              comp={c}
              selected={c.id === selectedId}
              pinout={pinout}
              onSelect={() => selectHardware(c.id)}
              onBeginWireDrag={beginWireDrag}
              toCanvas={toCanvas}
              zoom={zoom}
              snap={snap}
              activeDragRole={
                drag && drag.componentId === c.id ? drag.role : null
              }
            />
          ))}
        </g>

        {drag ? (
          <WiringPreview drag={drag} pinCoordMap={pinCoordMap} zoom={zoom} />
        ) : null}
      </svg>

      <HardwareToolbar
        invalidPins={invalidPins}
        onRepin={repinForBoard}
        showLabels={showLabels}
        onToggleLabels={() => setShowLabels((v) => !v)}
        showGrid={showGrid}
        onToggleGrid={toggleGrid}
        snap={snap}
        onToggleSnap={toggleSnap}
        zoom={zoom}
        onFitToBoard={fitToBoard}
        onZoomActual={zoomActualSize}
        onZoomIn={() => setZoom((z) => Math.min(4, z * 1.2))}
        onZoomOut={() => setZoom((z) => Math.max(0.3, z / 1.2))}
      />

      {components.length === 0 ? (
        <div className={styles.emptyHint}>
          <div className={styles.emptyMark} aria-hidden>
            {/* Board-with-pin-headers mark — same treatment as the patch
              * canvas crosshair (accent stroke + glow). */}
            <svg
              width="30"
              height="30"
              viewBox="0 0 30 30"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <rect x="9" y="4" width="12" height="22" rx="2" />
              <line x1="6" y1="8" x2="9" y2="8" />
              <line x1="6" y1="13" x2="9" y2="13" />
              <line x1="6" y1="18" x2="9" y2="18" />
              <line x1="6" y1="23" x2="9" y2="23" />
              <line x1="21" y1="8" x2="24" y2="8" />
              <line x1="21" y1="13" x2="24" y2="13" />
              <line x1="21" y1="18" x2="24" y2="18" />
              <line x1="21" y1="23" x2="24" y2="23" />
            </svg>
          </div>
          <span className={styles.emptyTitle}>
            drag a component from the palette onto the board
          </span>
          <span className={styles.emptySub}>
            hardware nodes dropped in the patch — knobs, buttons, leds — place
            their component here automatically
          </span>
        </div>
      ) : null}
    </div>
  )
}

/* =====================================================================
 * Toolbar (top-right floating).
 * ===================================================================== */

function HardwareToolbar({
  invalidPins,
  onRepin,
  showLabels,
  onToggleLabels,
  showGrid,
  onToggleGrid,
  snap,
  onToggleSnap,
  zoom,
  onFitToBoard,
  onZoomActual,
  onZoomIn,
  onZoomOut
}: {
  invalidPins: number
  onRepin: () => void
  showLabels: boolean
  onToggleLabels: () => void
  showGrid: boolean
  onToggleGrid: () => void
  snap: boolean
  onToggleSnap: () => void
  zoom: number
  onFitToBoard: () => void
  onZoomActual: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}) {
  return (
    <div className={activityStyles.toolbar}>
      {invalidPins > 0 ? (
        <button
          type="button"
          className={`${activityStyles.toolbarButton} ${activityStyles.toolbarWarn}`}
          onClick={onRepin}
          title={`${invalidPins} pin binding${invalidPins === 1 ? '' : 's'} don't exist on this board — click to reassign them`}
        >
          repin {invalidPins}
        </button>
      ) : null}
      <button
        type="button"
        className={activityStyles.toolbarButton}
        onClick={onZoomOut}
        title="Zoom out"
      >
        <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
          <line x1="3" y1="8" x2="13" y2="8" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className={activityStyles.toolbarButton}
        onClick={onZoomActual}
        title="Zoom 100%"
      >
        <span style={{ minWidth: 38, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
      </button>
      <button
        type="button"
        className={activityStyles.toolbarButton}
        onClick={onZoomIn}
        title="Zoom in"
      >
        <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
          <line x1="3" y1="8" x2="13" y2="8" strokeLinecap="round" />
          <line x1="8" y1="3" x2="8" y2="13" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className={activityStyles.toolbarButton}
        onClick={onFitToBoard}
        title="Fit to board"
      >
        <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
          <path d="M3 3h3M3 3v3M13 3h-3M13 3v3M3 13h3M3 13v-3M13 13h-3M13 13v-3" strokeLinecap="round" />
        </svg>
        <span>fit</span>
      </button>
      <button
        type="button"
        className={activityStyles.toolbarButton}
        data-active={showGrid ? 'true' : 'false'}
        onClick={onToggleGrid}
        title={showGrid ? 'Hide grid' : 'Show grid'}
      >
        <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
          <path d="M3 3h10v10H3z" />
          <path d="M3 8h10M8 3v10" strokeLinecap="round" opacity="0.5" />
        </svg>
        <span>grid</span>
      </button>
      <button
        type="button"
        className={activityStyles.toolbarButton}
        data-active={snap ? 'true' : 'false'}
        onClick={onToggleSnap}
        title={snap ? 'Snap OFF' : 'Snap ON'}
      >
        <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 2v2M8 12v2M2 8h2M12 8h2" strokeLinecap="round" />
        </svg>
        <span>snap</span>
      </button>
      <button
        type="button"
        className={activityStyles.toolbarButton}
        data-active={showLabels ? 'true' : 'false'}
        onClick={onToggleLabels}
        title={showLabels ? 'Hide binding labels' : 'Show binding labels'}
      >
        <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
          <path d="M2 4h5l2 2h5v6H2z" strokeLinejoin="round" strokeLinecap="round" />
          <line x1="5" y1="9" x2="11" y2="9" strokeLinecap="round" />
        </svg>
        <span>labels</span>
      </button>
    </div>
  )
}

/* =====================================================================
 * Grid layer.
 * ===================================================================== */

function GridLayer() {
  const minorLines: React.ReactNode[] = []
  const majorLines: React.ReactNode[] = []
  for (let x = 0; x <= CANVAS_W; x += GRID_MINOR) {
    const isMajor = x % GRID_MAJOR === 0
    const line = (
      <line
        key={`gx${x}`}
        x1={x}
        y1={0}
        x2={x}
        y2={CANVAS_H}
        stroke={isMajor ? 'var(--dp-border)' : 'var(--dp-border-strong)'}
        strokeWidth={isMajor ? 0.5 : 0.25}
        opacity={isMajor ? 0.35 : 0.12}
      />
    )
    if (isMajor) majorLines.push(line)
    else minorLines.push(line)
  }
  for (let y = 0; y <= CANVAS_H; y += GRID_MINOR) {
    const isMajor = y % GRID_MAJOR === 0
    const line = (
      <line
        key={`gy${y}`}
        x1={0}
        y1={y}
        x2={CANVAS_W}
        y2={y}
        stroke={isMajor ? 'var(--dp-border)' : 'var(--dp-border-strong)'}
        strokeWidth={isMajor ? 0.5 : 0.25}
        opacity={isMajor ? 0.35 : 0.12}
      />
    )
    if (isMajor) majorLines.push(line)
    else minorLines.push(line)
  }
  return (
    <g pointerEvents="none">
      {minorLines}
      {majorLines}
    </g>
  )
}

/* =====================================================================
 * Caption + legend.
 * ===================================================================== */

function Caption({ boardLabel, provisional }: { boardLabel: string; provisional?: string }) {
  return (
    <g pointerEvents="none">
      <text
        x={CANVAS_W / 2}
        y={78}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="30"
        fill="var(--dp-text)"
        letterSpacing="0.32em"
      >
        {/*
          Was the literal "DAISY PINOUT", which captioned an ESP32-C3
          board as a Daisy. The board name is the headline; "PINOUT" drops
          to the sub-line, so the two-line rhythm is unchanged and every
          board reads correctly.
        */}
        {boardLabel.toUpperCase()}
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
        PINOUT
      </text>
      {/*
        A board whose pin order we could not confirm is still usable, but the
        caveat has to be visible to someone holding the board — one that lives
        only in a source comment reaches nobody.
      */}
      {provisional ? (
        <text
          x={CANVAS_W / 2}
          y={130}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="11"
          fill="var(--dp-warning)"
          letterSpacing="0.12em"
        >
          {provisional.toUpperCase()}
        </text>
      ) : null}
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
    <g pointerEvents="none">
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
 * Seed / ESP32 silhouettes — retained from the prior iteration.
 * ===================================================================== */

function SeedSilhouette({ geom }: { geom: ResolvedGeometry }) {
  /*
   * Destructured under the old module-constant names on purpose: every
   * expression below (`BOARD_X + (BOARD_W - chipW) / 2` and ~30 more) is
   * left exactly as it was when these were module constants. Rewriting
   * them all would be a large diff with a big typo surface and no
   * behavioural gain.
   */
  const { boardX: BOARD_X, boardY: BOARD_Y, boardW: BOARD_W, boardH: BOARD_H } = geom
  const pcbFill = 'color-mix(in srgb, var(--dp-surface-sunken) 70%, var(--dp-warning) 4%)'

  const chipW = 140
  const chipH = 140
  const chipX = BOARD_X + (BOARD_W - chipW) / 2
  const chipY = BOARD_Y + 160

  const sdramW = 120
  const sdramH = 36
  const sdramX = BOARD_X + (BOARD_W - sdramW) / 2
  const sdramY = chipY + chipH + 40

  const codecW = 70
  const codecH = 40
  const codecX = BOARD_X + (BOARD_W - codecW) / 2
  const codecY = BOARD_Y + BOARD_H - 110

  return (
    <g pointerEvents="none">
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
      <circle cx={BOARD_X + 12} cy={BOARD_Y + 14} r="3" fill="var(--dp-text-dim)" />
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

function Esp32DevkitSilhouette({ geom }: { geom: ResolvedGeometry }) {
  const { boardX: BOARD_X, boardY: BOARD_Y, boardW: BOARD_W, boardH: BOARD_H } = geom
  return (
    <g pointerEvents="none">
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

/**
 * SuperMini-class boards: a small PCB that is almost entirely module,
 * with a USB-C shell overhanging one end and an RF antenna keep-out at
 * the same end. Drawn in proportion to the board box so both the C3 and
 * the (taller) S3 variants use it without adjustment.
 */
function Esp32SuperminiSilhouette({ geom }: { geom: ResolvedGeometry }) {
  const { boardX: BOARD_X, boardY: BOARD_Y, boardW: BOARD_W, boardH: BOARD_H } = geom
  const usbW = BOARD_W * 0.42
  const antH = BOARD_H * 0.11
  return (
    <g>
      <rect
        x={BOARD_X}
        y={BOARD_Y}
        width={BOARD_W}
        height={BOARD_H}
        rx={10}
        fill="var(--dp-surface-sunken)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1.5"
      />
      {/* USB-C shell, overhanging the top edge */}
      <rect
        x={BOARD_X + (BOARD_W - usbW) / 2}
        y={BOARD_Y - 14}
        width={usbW}
        height={26}
        rx={5}
        fill="var(--dp-surface-elevated)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1.5"
      />
      {/* antenna keep-out */}
      <rect
        x={BOARD_X + 10}
        y={BOARD_Y + 20}
        width={BOARD_W - 20}
        height={antH}
        rx={4}
        fill="none"
        stroke="var(--dp-border)"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      {/* shielded module can */}
      <rect
        x={BOARD_X + 14}
        y={BOARD_Y + 20 + antH + 10}
        width={BOARD_W - 28}
        height={BOARD_H * 0.44}
        rx={4}
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y + BOARD_H * 0.52}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="11"
        fill="var(--dp-text-dim)"
        letterSpacing="0.16em"
      >
        SUPERMINI
      </text>
    </g>
  )
}

/**
 * Silhouette artwork per board style. A new board that reuses an existing
 * style costs zero view code — it just names the style in its geometry.
 */
const SILHOUETTES = {
  seed: SeedSilhouette,
  esp32_devkit: Esp32DevkitSilhouette,
  esp32_supermini: Esp32SuperminiSilhouette
} satisfies Record<
  ResolvedGeometry['silhouette'],
  (props: { geom: ResolvedGeometry }) => ReactElement
>

/* =====================================================================
 * Pin rows.
 * ===================================================================== */

function PinRows({
  pinCoords,
  pinout,
  geom,
  allowedPins,
  draggingSnapPin,
  components
}: {
  pinCoords: PinCoord[]
  pinout: BoardPinout
  geom: ResolvedGeometry
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
            geom={geom}
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
  geom,
  cap,
  bound,
  dimmed,
  snapping
}: {
  coord: PinCoord
  geom: ResolvedGeometry
  cap: PinCapabilities | undefined
  bound: boolean
  dimmed: boolean
  snapping: boolean
}) {
  const isLeft = coord.side === 'left'
  const [hovered, setHovered] = useState(false)

  const pills: Pill[] = useMemo(() => {
    if (cap?.label) return pillsFromLabel(cap.label, coord.pin)
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

  const nameX = isLeft
    ? geom.boardX - ROW_GAP_FROM_BOARD - NAME_PILL_W
    : geom.boardX + geom.boardW + ROW_GAP_FROM_BOARD
  const y = coord.y
  const nameTop = y - NAME_PILL_H / 2

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
  const rowStart = isLeft ? nameX - totalAltW : nameX + NAME_PILL_W
  const rowEnd = isLeft
    ? nameX + NAME_PILL_W
    : nameX + NAME_PILL_W + totalAltW
  const rowX = Math.min(rowStart, rowEnd)
  const rowW = Math.abs(rowEnd - rowStart)
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
      <line
        x1={isLeft ? geom.boardX : geom.boardX + geom.boardW}
        y1={y}
        x2={isLeft ? nameX + NAME_PILL_W : nameX}
        y2={y}
        stroke="var(--dp-border)"
        strokeWidth="1"
      />
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
 * Wire overlay — component center → bound pin.
 * Because both endpoints are in the same SVG coord system, anchors align
 * trivially. Stroke-width scales with 1/zoom so the wire keeps a constant
 * perceived weight at any zoom level.
 * ===================================================================== */

function WireOverlay({
  components,
  pinCoordMap,
  zoom
}: {
  components: PlacedComponent[]
  pinCoordMap: Map<string, PinCoord>
  zoom: number
}) {
  const sw = Math.max(0.5, 1.5 / zoom)
  return (
    <g pointerEvents="none">
      {components.flatMap((c) => {
        const nat = shapeSizeCanvas(c.kind)
        // Rotation is about the natural center, so the shape center in
        // canvas coords is always position + natural/2 (rotation leaves it
        // invariant).
        const cx = c.position.x + nat.w / 2
        const cy = c.position.y + nat.h / 2
        const nodes: React.ReactNode[] = []
        for (const role of KIND_ROLES[c.kind]) {
          const pin = c.pins[role]
          if (!pin) continue
          const coord = pinCoordMap.get(pin as string)
          if (!coord || coord.side === 'bottom') continue
          nodes.push(
            <line
              key={`${c.id}-${role}`}
              x1={cx}
              y1={cy}
              x2={coord.x}
              y2={coord.y}
              stroke="var(--dp-accent)"
              strokeWidth={sw}
              strokeLinecap="round"
              opacity="0.85"
              className={styles.wireFadeIn}
            />
          )
        }
        return nodes
      })}
    </g>
  )
}

function WiringPreview({
  drag,
  pinCoordMap,
  zoom
}: {
  drag: WiringDrag
  pinCoordMap: Map<string, PinCoord>
  zoom: number
}) {
  const snapped = drag.snappedPin ? pinCoordMap.get(drag.snappedPin) : null
  const tx = snapped ? snapped.x : drag.x
  const ty = snapped ? snapped.y : drag.y
  const sw = Math.max(0.75, 2 / zoom)
  return (
    <g pointerEvents="none">
      <line
        x1={drag.sourceX}
        y1={drag.sourceY}
        x2={tx}
        y2={ty}
        stroke="var(--dp-accent)"
        strokeWidth={sw}
        strokeDasharray={`${5 / zoom} ${5 / zoom}`}
        strokeLinecap="round"
        opacity="0.95"
      />
      <circle
        cx={tx}
        cy={ty}
        r={snapped ? 10 / zoom : 5 / zoom}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth={Math.max(1, 1.75 / zoom)}
        opacity={snapped ? 1 : 0.6}
      />
    </g>
  )
}

/* =====================================================================
 * Placed component view — fully SVG.
 * Structure, from outer to inner:
 *   <g transform="translate(x, y)">                       (position)
 *     <g transform="rotate(rot, naturalW/2, naturalH/2)"> (rotation)
 *       <foreignObject or inner SVG> shape artwork         (natural coords)
 *       <rect> transparent click-catcher                  (drag + select)
 *       <rect> selection outline                          (when selected)
 *       <g>    activity overlay                           (LED glow, etc.)
 *     </g>
 *     <g> hover chrome (label + status + role dots)       (below the shape)
 *   </g>
 *
 * Shape center in canvas coords always equals (x + naturalW/2, y +
 * naturalH/2) because the rotation pivots on the natural center — so wire
 * anchors line up for every rotation.
 * ===================================================================== */

interface PlacedComponentViewProps {
  comp: PlacedComponent
  selected: boolean
  pinout: BoardPinout
  onSelect: () => void
  onBeginWireDrag: (
    componentId: string,
    role: string,
    kind: HardwareKind,
    sx: number,
    sy: number
  ) => void
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number }
  zoom: number
  snap: boolean
  activeDragRole: string | null
}

function PlacedComponentView({
  comp,
  selected,
  pinout,
  onSelect,
  onBeginWireDrag,
  toCanvas,
  zoom,
  snap,
  activeDragRole
}: PlacedComponentViewProps) {
  const moveHardware = useEditorStore((s) => s.moveHardware)
  const rotation = rotationOf(comp)
  const nat = shapeSizeCanvas(comp.kind)
  const [hovered, setHovered] = useState(false)

  // Rotated bounds (used for the selection outline).
  const swap = rotation === 90 || rotation === 270
  const boundW = swap ? nat.h : nat.w
  const boundH = swap ? nat.w : nat.h

  const snapRef = useRef(snap)
  snapRef.current = snap

  /* ----- Component drag (position) — window-level listeners. ----- */
  const dragStateRef = useRef<{
    startClient: { x: number; y: number }
    startPos: { x: number; y: number }
  } | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current
      if (!st) return
      const p0 = toCanvas(st.startClient.x, st.startClient.y)
      const p1 = toCanvas(e.clientX, e.clientY)
      let nx = st.startPos.x + (p1.x - p0.x)
      let ny = st.startPos.y + (p1.y - p0.y)
      if (snapRef.current && !e.altKey) {
        nx = snapToGrid(nx)
        ny = snapToGrid(ny)
      }
      moveHardware(comp.id, { x: nx, y: ny })
    }
    const onUp = () => {
      if (dragStateRef.current) {
        useEditorStore.getState().endTransaction()
        dragStateRef.current = null
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [comp.id, moveHardware, toCanvas])

  const onShapePointerDown = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      if (e.button !== 0) return
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

  /* ----- Activity hook — mutate CSS custom props on this <g>. ----- */
  const groupRef = useRef<SVGGElement>(null)
  const activityFlashUntilRef = useRef<number>(0)
  const lastLevelRef = useRef<number>(0.5)
  const [shapeLevel, setShapeLevel] = useState<number>(0.5)

  useHardwareActivity(comp.id, (frame: ActivityFrame) => {
    const el = groupRef.current
    if (!el) return
    const level = frame.level
    el.style.setProperty('--hw-activity-level', level.toFixed(3))
    if (frame.risingEdge) activityFlashUntilRef.current = frame.tMs + 220
    const now = frame.tMs
    const until = activityFlashUntilRef.current
    const flash = until > now ? Math.max(0, (until - now) / 220) : 0
    el.style.setProperty('--hw-activity-flash', flash.toFixed(3))
    if (Math.abs(level - lastLevelRef.current) > 0.02 || frame.risingEdge) {
      lastLevelRef.current = level
      setShapeLevel(level)
    }
  })

  /* ----- Derived pieces for the chrome (visible on hover / select). ----- */
  const requiredRoles = KIND_ROLES[comp.kind]
  const allBound = requiredRoles.every((r) => !!comp.pins[r])
  const chromeVisible = selected || hovered

  const selectionStroke = selected
    ? 'var(--dp-accent)'
    : hovered
      ? 'color-mix(in srgb, var(--dp-accent) 50%, transparent)'
      : 'transparent'
  const selectionSW = Math.max(0.8, 1.25 / zoom)

  // Role dots: one per required role, placed below the chrome label.
  // Only rendered when chromeVisible. Strip is centered under the rotated
  // bounds box.
  const ROLE_DOT_R = 5
  const ROLE_DOT_GAP = 4
  const rolesCount = requiredRoles.length
  const roleStripW =
    rolesCount * ROLE_DOT_R * 2 + Math.max(0, rolesCount - 1) * ROLE_DOT_GAP

  return (
    <g
      ref={groupRef}
      className={`${styles.componentGroup} ${activityStyles.card}`}
      transform={`translate(${comp.position.x}, ${comp.position.y})`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* Rotation group — pivots on the natural center so the rotated
          bounding box's top-left is (boundW-nat.w)/2, (boundH-nat.h)/2
          when placed inside a parent offset... For simplicity we instead
          rotate the shape itself and place hit/outline rects on the
          rotated bounds around it explicitly. */}
      <g
        transform={`rotate(${rotation}, ${nat.w / 2}, ${nat.h / 2})`}
        pointerEvents="none"
      >
        {renderComponentShape(comp, shapeLevel)}
      </g>

      {/* Selection outline + click-catcher rects in ROTATED BOUNDS frame.
          The rotated bounding box is centered on (nat.w/2, nat.h/2) —
          same canvas point as the natural center — because rotation
          pivots there. We draw bounds box spanning
          (nat.w/2 - boundW/2, nat.h/2 - boundH/2) to the opposite corner. */}
      <rect
        x={nat.w / 2 - boundW / 2 - 2}
        y={nat.h / 2 - boundH / 2 - 2}
        width={boundW + 4}
        height={boundH + 4}
        rx={3}
        fill="none"
        stroke={selectionStroke}
        strokeWidth={selectionSW}
        pointerEvents="none"
        style={{ transition: 'stroke 120ms var(--dp-ease)' }}
      />
      <rect
        className={styles.componentHit}
        x={nat.w / 2 - boundW / 2}
        y={nat.h / 2 - boundH / 2}
        width={boundW}
        height={boundH}
        fill="transparent"
        onPointerDown={onShapePointerDown}
      />

      {/* Activity overlays — small SVG circles/rects styled via CSS vars
          on the group. Component shapes already animate pot/LED; these are
          extra cues for buttons/jacks that don't morph. */}
      {comp.kind === 'led' ? (
        <circle
          cx={nat.w / 2}
          cy={nat.h / 2}
          r={Math.max(nat.w, nat.h) * 0.7}
          fill="color-mix(in srgb, var(--dp-signal-audio) calc(var(--hw-activity-level) * 70%), transparent)"
          opacity={0.45}
          pointerEvents="none"
          style={{ filter: 'blur(2px)' }}
        />
      ) : null}
      {comp.kind === 'button' || comp.kind === 'gate_jack' ? (
        <rect
          x={nat.w / 2 - boundW / 2 - 1}
          y={nat.h / 2 - boundH / 2 - 1}
          width={boundW + 2}
          height={boundH + 2}
          rx={3}
          fill="none"
          stroke="color-mix(in srgb, var(--dp-signal-gate) calc(var(--hw-activity-flash) * 70%), transparent)"
          strokeWidth={Math.max(1, 1.25 / zoom)}
          pointerEvents="none"
        />
      ) : null}
      {comp.kind === 'midi_jack' ||
      comp.kind === 'i2s_codec' ||
      comp.kind === 'pcm5102a' ||
      comp.kind === 'max98357a' ? (
        <circle
          cx={nat.w / 2 - boundW / 2 + 6}
          cy={nat.h / 2 - boundH / 2 + 6}
          r={3}
          fill="color-mix(in srgb, var(--dp-signal-gate) calc(20% + var(--hw-activity-flash) * 80%), var(--dp-surface-sunken))"
          pointerEvents="none"
        />
      ) : null}

      {/* Hover chrome — label + status + role dots. Rendered under the
          rotated bounding box, centered. Coordinates are in the unrotated
          canvas frame of the component's <g>. Since we're rendering below
          the bounds box in visual (not shape) space, position everything
          relative to (nat.w/2, nat.h/2) center. */}
      {chromeVisible ? (
        <g pointerEvents="none">
          {/* Label + status plate. */}
          <ChromeLabel
            cx={nat.w / 2}
            y={nat.h / 2 + boundH / 2 + 6}
            label={comp.label}
            status={allBound ? 'WIRED' : 'PINS?'}
            statusOk={allBound}
          />
          {/* Role dot strip — sits below the label plate. */}
          <g
            transform={`translate(${nat.w / 2 - roleStripW / 2}, ${nat.h / 2 + boundH / 2 + 32})`}
            pointerEvents="auto"
          >
            {requiredRoles.map((role, i) => {
              const cx = i * (ROLE_DOT_R * 2 + ROLE_DOT_GAP) + ROLE_DOT_R
              const cy = ROLE_DOT_R
              const pin = comp.pins[role]
              const isActive = activeDragRole === role
              return (
                <RoleDot
                  key={role}
                  cx={cx}
                  cy={cy}
                  r={ROLE_DOT_R}
                  role={role}
                  pin={pin ?? null}
                  isActive={isActive}
                  pinout={pinout}
                  componentId={comp.id}
                  kind={comp.kind}
                  onBeginWireDrag={onBeginWireDrag}
                  toCanvas={toCanvas}
                />
              )
            })}
          </g>
        </g>
      ) : null}
    </g>
  )
}

/* =====================================================================
 * ChromeLabel — label pill with status badge.
 * ===================================================================== */

function ChromeLabel({
  cx,
  y,
  label,
  status,
  statusOk
}: {
  cx: number
  y: number
  label: string
  status: string
  statusOk: boolean
}) {
  // Approximate width from label length — SVG doesn't lay out text like
  // DOM, so size a backing plate generously and let text overflow if the
  // user names something very long.
  const approxW = Math.min(260, Math.max(80, label.length * 6 + 62))
  const h = 18
  const plateX = cx - approxW / 2
  return (
    <g>
      <rect
        x={plateX}
        y={y}
        width={approxW}
        height={h}
        rx={h / 2}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 92%, transparent)"
        stroke="var(--dp-border)"
        strokeWidth="0.75"
      />
      <text
        x={plateX + 10}
        y={y + h / 2 + 3.5}
        fontFamily="var(--dp-font-sans)"
        fontSize="10"
        fill="var(--dp-text)"
        dominantBaseline="middle"
      >
        {label}
      </text>
      <g>
        <rect
          x={plateX + approxW - 50}
          y={y + 3}
          width={44}
          height={h - 6}
          rx={(h - 6) / 2}
          fill={
            statusOk
              ? 'color-mix(in srgb, var(--dp-success) 12%, transparent)'
              : 'color-mix(in srgb, var(--dp-warning) 14%, transparent)'
          }
        />
        <text
          x={plateX + approxW - 50 + 22}
          y={y + h / 2 + 3.5}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="8"
          letterSpacing="0.12em"
          fill={statusOk ? 'var(--dp-success)' : 'var(--dp-warning)'}
          dominantBaseline="middle"
        >
          {status}
        </text>
      </g>
    </g>
  )
}

/* =====================================================================
 * RoleDot — small draggable circle next to a component, used to wire a
 * role to a pin. Pointer handlers match the prior RoleBadge: on first
 * move past threshold we hand off to the top-level window listeners
 * registered in `HardwareViewInner`.
 * ===================================================================== */

function RoleDot({
  cx,
  cy,
  r,
  role,
  pin,
  isActive,
  pinout,
  componentId,
  kind,
  onBeginWireDrag,
  toCanvas
}: {
  cx: number
  cy: number
  r: number
  role: string
  pin: BoardPin | null
  isActive: boolean
  pinout: BoardPinout
  componentId: string
  kind: HardwareKind
  onBeginWireDrag: (
    componentId: string,
    role: string,
    kind: HardwareKind,
    sx: number,
    sy: number
  ) => void
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number }
}) {
  void pinout
  const setHardwarePin = useEditorStore((s) => s.setHardwarePin)
  const pressRef = useRef<{
    startClient: { x: number; y: number }
    capturedPointerId: number | null
    startedDrag: boolean
  } | null>(null)

  const DRAG_THRESHOLD = 3

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
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
    (e: React.PointerEvent<SVGCircleElement>) => {
      const st = pressRef.current
      if (!st || st.startedDrag) return
      const dx = e.clientX - st.startClient.x
      const dy = e.clientY - st.startClient.y
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
      st.startedDrag = true
      if (st.capturedPointerId !== null) {
        try {
          ;(e.currentTarget as Element).releasePointerCapture(st.capturedPointerId)
        } catch {
          /* noop */
        }
      }
      // Compute the dot's current canvas coord as the drag source so the
      // preview wire starts exactly at the dot.
      const bcr = (e.currentTarget as SVGCircleElement).getBoundingClientRect()
      const cxClient = bcr.left + bcr.width / 2
      const cyClient = bcr.top + bcr.height / 2
      const p = toCanvas(cxClient, cyClient)
      onBeginWireDrag(componentId, role, kind, p.x, p.y)
    },
    [componentId, kind, onBeginWireDrag, role, toCanvas]
  )

  const onPointerUp = useCallback(() => {
    pressRef.current = null
  }, [])

  const onContextMenu = useCallback(
    (e: React.MouseEvent<SVGCircleElement>) => {
      if (!pin) return
      e.preventDefault()
      e.stopPropagation()
      useEditorStore.getState().beginTransaction()
      setHardwarePin(componentId, role, null)
      useEditorStore.getState().endTransaction()
    },
    [componentId, pin, role, setHardwarePin]
  )

  const fill = pin
    ? 'var(--dp-success)'
    : 'color-mix(in srgb, var(--dp-warning) 80%, var(--dp-bg))'
  const stroke = isActive ? 'var(--dp-accent)' : 'var(--dp-border-strong)'
  const sw = isActive ? 1.5 : 0.75

  return (
    <g>
      <circle
        className={styles.roleDot}
        cx={cx}
        cy={cy}
        r={r}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
      >
        <title>
          {pin
            ? `${roleLabel(kind, role)} → ${pin} (drag to rewire, right-click to clear)`
            : `${roleLabel(kind, role)} (drag to a pin)`}
        </title>
      </circle>
      <text
        x={cx}
        y={cy + r + 8}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="7"
        letterSpacing="0.08em"
        fill="var(--dp-text-muted)"
        pointerEvents="none"
      >
        {roleLabel(kind, role)}
      </text>
    </g>
  )
}
