/**
 * PerformView — the third canvas: renders the HardwareLayout as the
 * physical stompbox it will become ("Powder-coat" 2.5D skeuomorph) and
 * makes it playable with the mouse.
 *
 *   - Geometry comes from `enclosureModel.ts` (pure mm-space model built
 *     from the same `HardwareLayout` the Hardware view edits — this view
 *     adds ZERO new layout state).
 *   - Everything renders inside one <svg> whose user units are
 *     MILLIMETERS; pan/zoom are pure viewBox updates (same discipline as
 *     HardwareView — `toCanvas` is input-only, never used for rendering).
 *   - Pots / faders / encoders sweep the bound node's emulated value via
 *     `setComponentValue01()` (the single write path a future MIDI-learn
 *     driver will reuse). Drags are bracketed in beginTransaction() /
 *     endTransaction() so a sweep is ONE undo entry.
 *   - Live activity (LED glow, OLED pixels) reuses the engine tap
 *     machinery: `HardwareActivityManager` for LEDs, `tapInput` + the
 *     OLED bitmap renderer for the screen. Both are gated on transport —
 *     when stopped, no taps are open and no rAF loop runs.
 *
 * PLAY / ARRANGE (see `performMode.ts`):
 *   - PLAY — the pedal is an instrument: sweep/press/cycle as above.
 *   - ARRANGE — the pedal is a workbench: a transparent hit layer sits on
 *     top of every component, so select/drag/rotate/nudge work without
 *     touching the control implementations (which never see events).
 *     Moves write the same `PlacedComponent.position` the Hardware view
 *     edits (one source of truth; selection shares `selectedHardwareId`).
 *     During a drag the enclosure frame is FROZEN (`EnclosureFrame`
 *     captured at drag start) so the cursor tracks 1:1 while the content
 *     bbox changes; the Hammond re-snap + re-center run once on release,
 *     smoothed by a transform transition on every component group.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useEditorStore } from '@/state/store'
import { getBoardPinout } from '@/hardware/boardPinout'
import { PresetBar } from '@/components/layout/PresetBar'
import type { HardwareKind } from '@/types/hardware'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import { HardwareActivityManager } from '@/hardware/HardwareActivity'
import activityStyles from '@/hardware/HardwareActivity.module.css'
import { tapInput } from '@/editor/oled/tapInput'
import { parseElements, type BindingSource, type DisplayElement } from '@/editor/oled/elements'
import { parseMenuTree } from '@/editor/menu/tree'
import { menuStateFor } from '@/state/menuRuntime'
import type { MenuMap } from '@/editor/oled/render'
import {
  getPixel,
  renderFrame,
  OLED_BITMAP_BYTES,
  OLED_HEIGHT,
  OLED_WIDTH,
  type InputMap
} from '@/editor/oled/render'
import type { Tap } from '@/types/store'
import { MM_PER_UNIT, nextRotation, rotationOf } from '@/hardware/componentShapes'
import {
  buildEnclosureModel,
  stageComponents,
  performVisible,
  type EnclosureComponent,
  type EnclosureFrame,
  type EnclosureModel
} from './enclosureModel'
import { usePerformMode } from './performMode'
import {
  controlValue01,
  cycleSwitchPosition,
  resetComponentValue,
  resolveBoundControl,
  setComponentValue01,
  switchPositionOf
} from './performControl'
import {
  ElectretShape,
  EncoderShape,
  FaderShape,
  FootswitchShape,
  GenericShape,
  InternalBadgeShape,
  JackShape,
  KnobShape,
  LdrShape,
  LedShape,
  MidiDinShape,
  OledWindowShape,
  RibbonShape,
  TofShape,
  ToggleShape
} from './performShapes'
import styles from './PerformView.module.css'

/* =====================================================================
 * Constants.
 * ===================================================================== */

/** Whitespace (mm) around the enclosure in the base viewBox. */
const MARGIN_MM = 26

/** Vertical pixels of pointer travel for a full 0..1 sweep. */
const SWEEP_PX = 160
/** Shift = fine: sweep gain multiplier. */
const FINE_GAIN = 0.2

/** ARRANGE grid: positions snap to 0.5 mm (Shift = free). Canvas units. */
const ARRANGE_SNAP_UNITS = 0.5 * MM_PER_UNIT
/** ARRANGE keyboard nudge steps (canvas units). */
const NUDGE_UNITS = 0.5 * MM_PER_UNIT
const NUDGE_UNITS_COARSE = 5 * MM_PER_UNIT

const INK = 'var(--dp-perform-ink)'

const OLED_INPUT_SOCKETS: BindingSource[] = ['a', 'b', 'c', 'd', 'e', 'f']

/**
 * What a control is called ON THE SURFACE.
 *
 * The silkscreen name and the performance name are not always the same
 * thing: a panel says "POT 3" because that is what is printed next to the
 * shaft, and the surface should say "Filter" because that is what you are
 * reaching for.
 */
function performLabel(comp: { label: string; perform?: { label?: string } }): string {
  const l = comp.perform?.label
  return l && l.trim() ? l : comp.label
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true
}

/**
 * Positioning style for a component group. Placement goes through a CSS
 * transform (px = SVG user units = mm here) instead of the `transform`
 * attribute so the post-drag re-center / Hammond re-snap animates — the
 * transition is suppressed for the component actively being dragged so it
 * tracks the cursor with zero lag.
 */
function groupStyle(ec: EnclosureComponent, animate: boolean): React.CSSProperties {
  return {
    transform: `translate(${ec.cx}px, ${ec.cy}px)`,
    transition: animate ? 'transform var(--dp-motion-normal) var(--dp-ease)' : 'none'
  }
}

/* =====================================================================
 * Top-level view.
 * ===================================================================== */

export function PerformView() {
  const hardware = useEditorStore((s) => s.hardware)
  const patchName = useEditorStore((s) => s.graph.meta.name)
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const setView = useEditorStore((s) => s.setView)
  const selectedHardwareId = useEditorStore((s) => s.selectedHardwareId)
  const engine = useAudioEngine()

  const mode = usePerformMode((s) => s.mode)
  const setMode = usePerformMode((s) => s.setMode)
  const arrange = mode === 'arrange'

  /* ---------- enclosure model (frozen frame while arranging) ---------- */
  const liveModel = useMemo(() => buildEnclosureModel(hardware), [hardware])

  // While a component drag is active, render with the frame captured at
  // drag start: face size and every other component hold still, so the
  // dragged component tracks the cursor 1:1 instead of fighting the
  // re-center. The real model (Hammond re-snap + centering) takes over on
  // release and the transform transitions smooth the shift.
  const [arrangeDrag, setArrangeDrag] = useState<{
    compId: string
    frame: EnclosureFrame
  } | null>(null)

  const model: EnclosureModel = useMemo(() => {
    if (!arrangeDrag) return liveModel
    const f = arrangeDrag.frame
    return {
      ...f,
      components: stageComponents(performVisible(hardware.components), f.offsetX, f.offsetY),
      holes: []
    }
  }, [liveModel, arrangeDrag, hardware])

  const empty = hardware.components.length === 0

  /* ---------- LED / gate activity taps (transport-gated) ---------- */
  const mgrRef = useRef<HardwareActivityManager | null>(null)
  if (mgrRef.current === null) mgrRef.current = new HardwareActivityManager(engine)
  const mgr = mgrRef.current

  useEffect(() => {
    mgr.setEngine(engine)
  }, [engine, mgr])

  // Stable connectivity key — same discipline as HardwareActivityProvider
  // (never build fresh objects inside a selector).
  const syncKey = useEditorStore((s) => {
    const parts: string[] = []
    for (const c of s.hardware.components) parts.push(`${c.id}:${c.kind}`)
    parts.push('|')
    for (const n of s.graph.nodes) {
      const bid = typeof n.params.bindingId === 'string' ? n.params.bindingId : ''
      if (bid) parts.push(`${n.id}:${n.kind}:${bid}`)
    }
    parts.push('|')
    for (const c of s.graph.connections) {
      parts.push(`${c.from.nodeId}>${c.to.nodeId}.${c.to.socketId}`)
    }
    return parts.join(',')
  })

  useEffect(() => {
    const { graph, hardware: hw } = useEditorStore.getState()
    if (isPlaying) {
      mgr.sync(hw, graph)
    } else {
      // Transport stopped: close every tap so the engine's rAF dispatcher
      // stops too — the Perform view must cost zero rAF at rest.
      mgr.sync({ ...hw, components: [] }, graph)
    }
  }, [syncKey, isPlaying, mgr, engine])

  useEffect(() => () => mgr.dispose(), [mgr])

  /* ---------- pan / zoom (HardwareView pattern, mm space) ---------- */
  const worldX = -MARGIN_MM
  const worldY = -MARGIN_MM
  const worldW = model.width + MARGIN_MM * 2
  const worldH = model.height + MARGIN_MM * 2

  const [zoom, setZoom] = useState(1)
  const [vbOrigin, setVbOrigin] = useState({ x: worldX, y: worldY })
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const vbOriginRef = useRef(vbOrigin)
  vbOriginRef.current = vbOrigin

  const svgRef = useRef<SVGSVGElement>(null)

  // Refit when the enclosure jumps to a different Hammond size class
  // (patch switch, or an ARRANGE drag growing the pedal). Deliberately
  // NOT keyed on raw width/height: custom (non-standard) enclosures change
  // dimensions continuously while nudging, and resetting the user's
  // pan/zoom on every 0.5 mm step would be hostile — those small changes
  // are absorbed by the viewBox math instead.
  useEffect(() => {
    setZoom(1)
    setVbOrigin({ x: -MARGIN_MM, y: -MARGIN_MM })
  }, [model.standard])

  /** Client → mm-space point. INPUT ONLY — never used for rendering. */
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

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const factor = Math.exp(-e.deltaY * 0.0015)
      const p = toCanvas(e.clientX, e.clientY)
      const z0 = zoomRef.current
      const z1 = Math.max(0.4, Math.min(6, z0 * factor))
      const vb0 = vbOriginRef.current
      setZoom(z1)
      setVbOrigin({
        x: p.x - (p.x - vb0.x) * (z0 / z1),
        y: p.y - (p.y - vb0.y) * (z0 / z1)
      })
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
      setVbOrigin({
        x: st.startOrigin.x - (e.clientX - st.startClient.x) * scale,
        y: st.startOrigin.y - (e.clientY - st.startClient.y) * scale
      })
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

  const fit = useCallback(() => {
    setZoom(1)
    setVbOrigin({ x: -MARGIN_MM, y: -MARGIN_MM })
  }, [])

  /* ---------- ARRANGE: move / select ---------- */

  // Mutable per-gesture data. `trueX/trueY` accumulate the UNSNAPPED
  // position so 0.5 mm grid snapping never eats slow movements, and
  // toggling Shift (free placement) mid-drag stays continuous.
  const moveDragRef = useRef<{
    pointerId: number
    compId: string
    lastX: number
    lastY: number
    trueX: number
    trueY: number
  } | null>(null)

  const beginArrangeDrag = useCallback(
    (ec: EnclosureComponent, e: React.PointerEvent<SVGRectElement>) => {
      if (e.button !== 0 || spaceHeldRef.current || moveDragRef.current) return
      e.stopPropagation()
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      const store = useEditorStore.getState()
      store.selectHardware(ec.comp.id)
      const comp = store.hardware.components.find((c) => c.id === ec.comp.id)
      if (!comp) return
      // Whole gesture = one undo entry (Inspector-slider pattern).
      store.beginTransaction()
      const p = toCanvas(e.clientX, e.clientY)
      moveDragRef.current = {
        pointerId: e.pointerId,
        compId: ec.comp.id,
        lastX: p.x,
        lastY: p.y,
        // Seed from the performance placement when there is one, so the
        // first drag continues from where the control is rather than
        // jumping back to its panel position.
        trueX: comp.perform?.x ?? comp.position.x,
        trueY: comp.perform?.y ?? comp.position.y
      }
      setArrangeDrag({
        compId: ec.comp.id,
        frame: {
          width: liveModel.width,
          height: liveModel.height,
          standard: liveModel.standard,
          offsetX: liveModel.offsetX,
          offsetY: liveModel.offsetY
        }
      })
    },
    [liveModel, toCanvas]
  )

  const moveArrangeDrag = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      const d = moveDragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      e.stopPropagation()
      const p = toCanvas(e.clientX, e.clientY)
      // toCanvas yields mm (the SVG's user units); positions store canvas
      // units (mm * MM_PER_UNIT). The frame is frozen during the drag so
      // this delta mapping stays exact.
      d.trueX += (p.x - d.lastX) * MM_PER_UNIT
      d.trueY += (p.y - d.lastY) * MM_PER_UNIT
      d.lastX = p.x
      d.lastY = p.y
      let nx = d.trueX
      let ny = d.trueY
      if (!e.shiftKey) {
        nx = Math.round(nx / ARRANGE_SNAP_UNITS) * ARRANGE_SNAP_UNITS
        ny = Math.round(ny / ARRANGE_SNAP_UNITS) * ARRANGE_SNAP_UNITS
      }
      // Arranging the SURFACE, not the panel. Moving a control here used
      // to move the drill hole with it — see `PerformPlacement`.
      useEditorStore.getState().setPerformPlacement(d.compId, { x: nx, y: ny })
    },
    [toCanvas]
  )

  const endArrangeDrag = useCallback((e: React.PointerEvent<SVGRectElement>) => {
    const d = moveDragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    moveDragRef.current = null
    // Unfreezing the frame rebuilds the real model: Hammond re-snap +
    // re-center happen HERE, once, animated by the group transitions.
    setArrangeDrag(null)
    useEditorStore.getState().endTransaction()
  }, [])

  /* ARRANGE keyboard: Esc deselect, arrows nudge 0.5 mm (Shift = 5 mm),
   * R rotates 90°. Guarded by the text-target check and only bound while
   * this view is mounted in arrange mode — mirrors HardwareView's map. */
  useEffect(() => {
    if (!arrange) return
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return
      const store = useEditorStore.getState()
      if (e.key === 'Escape') {
        store.selectHardware(null)
        return
      }
      const id = store.selectedHardwareId
      if (!id) return
      const comp = store.hardware.components.find((c) => c.id === id)
      if (!comp) return
      const step = e.shiftKey ? NUDGE_UNITS_COARSE : NUDGE_UNITS
      const baseX = comp.perform?.x ?? comp.position.x
      const baseY = comp.perform?.y ?? comp.position.y
      const move = (dx: number, dy: number) => {
        e.preventDefault()
        store.setPerformPlacement(id, { x: baseX + dx, y: baseY + dy })
      }
      if (e.key === 'ArrowLeft') move(-step, 0)
      else if (e.key === 'ArrowRight') move(step, 0)
      else if (e.key === 'ArrowUp') move(0, -step)
      else if (e.key === 'ArrowDown') move(0, step)
      else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        store.setHardwareConfig(id, 'rotation', nextRotation(rotationOf(comp)))
      }
      /*
       * Size and visibility are performance decisions, so they live on the
       * same keys you already have your hand on while arranging. `[`/`]`
       * step the weight; `h` takes a control off the surface without
       * removing the part from the panel.
       */
      else if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        const order = ['sm', 'md', 'lg'] as const
        const cur = comp.perform?.size ?? 'md'
        const i = order.indexOf(cur)
        const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === ']' ? 1 : -1)))]
        store.setPerformPlacement(id, { size: next })
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault()
        store.setPerformPlacement(id, { hidden: !(comp.perform?.hidden ?? false) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [arrange])

  // Data-driven: the ternary this replaces labelled every ESP32 board
  // "ESP32-S3", so a C3 SuperMini enclosure was captioned with the wrong
  // chip. Adding a board should never require editing this view.
  const boardLabel = getBoardPinout(hardware.board).label.toUpperCase()

  const cursorClass = isPanning ? styles.panning : spaceHeld ? styles.panReady : ''

  return (
    <div className={`${styles.root} ${cursorClass}`} onWheel={onWheel} onMouseDown={onPanStart}>
      {/*
        Presets on the surface, not only in the Inspector rail. A preset you
        have to leave the performance view to recall is a preset you will
        not use mid-song — which was most of what made this view feel like a
        drawing rather than an instrument. Hidden while arranging: laying
        out the face and playing it are different jobs.
      */}
      {!arrange && !empty ? (
        <div className={styles.presetDock}>
          <PresetBar compact />
        </div>
      ) : null}
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`${vbOrigin.x} ${vbOrigin.y} ${worldW / zoom} ${worldH / zoom}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={(e) => {
          // Background click in ARRANGE deselects. The enclosure layer is
          // pointer-events:none, so clicks on the bare face land on the
          // svg element itself.
          if (arrange && e.button === 0 && e.target === e.currentTarget) {
            useEditorStore.getState().selectHardware(null)
          }
        }}
      >
        <g opacity={empty ? 0.4 : 1}>
          <Enclosure model={model} patchName={patchName} boardLabel={boardLabel} />
          {model.components.map((ec) => (
            <PerformComponent
              key={ec.comp.id}
              ec={ec}
              mgr={mgr}
              isPlaying={isPlaying}
              animate={arrangeDrag?.compId !== ec.comp.id}
            />
          ))}
          {/* ARRANGE hit layer — on top of every control so PLAY
              interactions can't fire; each rect owns select + move. */}
          {arrange
            ? model.components.map((ec) => (
                <ArrangeOverlay
                  key={ec.comp.id}
                  ec={ec}
                  selected={ec.comp.id === selectedHardwareId}
                  dragging={arrangeDrag?.compId === ec.comp.id}
                  onDown={beginArrangeDrag}
                  onMove={moveArrangeDrag}
                  onEnd={endArrangeDrag}
                />
              ))
            : null}
        </g>
      </svg>

      {/*
        Arrange help. The surface-specific keys are new and there is nowhere
        else they could be discovered — an affordance nobody can find is the
        same as one that does not exist.
      */}
      {arrange ? (
        <div className={styles.arrangeHint}>
          <span><b>drag</b> move</span>
          <span><b>R</b> rotate</span>
          <span><b>[ ]</b> size</span>
          <span><b>H</b> hide from surface</span>
          <span><b>shift</b> free / coarse</span>
          <button
            type="button"
            className={styles.arrangeReset}
            onClick={() => useEditorStore.getState().resetPerformLayout()}
            title="Drop every performance placement — the surface mirrors the panel again"
          >
            reset surface
          </button>
        </div>
      ) : null}

      <div className={activityStyles.toolbar}>
        <button
          type="button"
          className={activityStyles.toolbarButton}
          data-active={!arrange ? 'true' : 'false'}
          onClick={() => setMode('play')}
          title="Play — controls are the instrument"
        >
          <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
            <path d="M5 3.5v9l7.5-4.5z" strokeLinejoin="round" />
          </svg>
          <span>play</span>
        </button>
        <button
          type="button"
          className={activityStyles.toolbarButton}
          data-active={arrange ? 'true' : 'false'}
          onClick={() => setMode('arrange')}
          title="Arrange the performance surface — drag, R rotates, arrows nudge, [ ] resize, H hides"
        >
          <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
            <path d="M8 2v12M2 8h12" strokeLinecap="round" />
            <path d="M6 4l2-2 2 2M6 12l2 2 2-2M4 6L2 8l2 2M12 6l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>arrange</span>
        </button>
        <button
          type="button"
          className={activityStyles.toolbarButton}
          onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}
          title="Zoom out"
        >
          <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
            <line x1="3" y1="8" x2="13" y2="8" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={activityStyles.toolbarButton}
          onClick={fit}
          title="Zoom 100%"
        >
          <span style={{ minWidth: 38, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        </button>
        <button
          type="button"
          className={activityStyles.toolbarButton}
          onClick={() => setZoom((z) => Math.min(6, z * 1.2))}
          title="Zoom in"
        >
          <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
            <line x1="3" y1="8" x2="13" y2="8" strokeLinecap="round" />
            <line x1="8" y1="3" x2="8" y2="13" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className={activityStyles.toolbarButton} onClick={fit} title="Fit enclosure">
          <svg className={activityStyles.toolbarIcon} viewBox="0 0 16 16" aria-hidden>
            <path d="M3 3h3M3 3v3M13 3h-3M13 3v3M3 13h3M3 13v-3M13 13h-3M13 13v-3" strokeLinecap="round" />
          </svg>
          <span>fit</span>
        </button>
      </div>

      {empty ? (
        <div className={styles.emptyHint}>
          <div className={styles.emptyMark} aria-hidden>
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="6" y="3" width="18" height="24" rx="3" />
              <circle cx="11" cy="11" r="2.5" />
              <circle cx="19" cy="11" r="2.5" />
              <circle cx="15" cy="21" r="3" />
            </svg>
          </div>
          <span className={styles.emptyTitle}>nothing on the faceplate yet</span>
          <span className={styles.emptySub}>
            place knobs, switches and jacks in the hardware view — this is the pedal they become
          </span>
          <button type="button" className={styles.emptyAction} onClick={() => setView('hardware')}>
            open hardware view
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* =====================================================================
 * Enclosure — powder-coat face, corner screws, silkscreen name.
 * ===================================================================== */

function Enclosure({
  model,
  patchName,
  boardLabel
}: {
  model: EnclosureModel
  patchName: string
  boardLabel: string
}) {
  const w = model.width
  const h = model.height
  const screwInset = 4.6
  const screws: Array<[number, number, number]> = [
    [screwInset, screwInset, 45],
    [w - screwInset, screwInset, -45],
    [screwInset, h - screwInset, -45],
    [w - screwInset, h - screwInset, 45]
  ]
  return (
    <g pointerEvents="none">
      <defs>
        {/* Static ids are safe here — exactly one Enclosure exists per view. */}
        <linearGradient id="pf-enclosure-coat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="color-mix(in srgb, var(--dp-perform-coat) 78%, white 22%)" />
          <stop offset="0.08" stopColor="color-mix(in srgb, var(--dp-perform-coat) 93%, white 7%)" />
          <stop offset="0.9" stopColor="color-mix(in srgb, var(--dp-perform-coat) 62%, var(--dp-perform-coat-deep) 38%)" />
          <stop offset="1" stopColor="var(--dp-perform-coat-deep)" />
        </linearGradient>
      </defs>

      {/* ground shadow */}
      <ellipse cx={w / 2} cy={h + 2.6} rx={w * 0.48} ry={3.2} fill="color-mix(in srgb, black 45%, transparent)" />

      {/* faceplate */}
      <rect width={w} height={h} rx={4.5} fill="url(#pf-enclosure-coat)" />
      <rect
        width={w}
        height={h}
        rx={4.5}
        fill="none"
        stroke="color-mix(in srgb, white 32%, transparent)"
        strokeWidth="0.4"
      />
      {/* top edge sheen */}
      <rect
        x={1.4}
        y={1.1}
        width={w - 2.8}
        height={2.4}
        rx={1.2}
        fill="color-mix(in srgb, white 22%, transparent)"
      />

      {/* corner screws */}
      {screws.map(([sx, sy, rot], i) => (
        <g key={i} transform={`translate(${sx} ${sy})`}>
          <circle
            r={1.7}
            fill="color-mix(in srgb, var(--dp-perform-coat) 68%, black 32%)"
            stroke="color-mix(in srgb, var(--dp-perform-coat-deep) 70%, black 30%)"
            strokeWidth="0.3"
          />
          <line
            transform={`rotate(${rot})`}
            x1={-1.1}
            x2={1.1}
            stroke="color-mix(in srgb, black 55%, var(--dp-perform-coat-deep))"
            strokeWidth="0.45"
            strokeLinecap="round"
          />
        </g>
      ))}

      {/* silkscreen: patch name + build line */}
      <text
        x={w / 2}
        y={9.2}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontWeight="700"
        fontSize="4.4"
        letterSpacing="0.28em"
        fill={INK}
      >
        {patchName.toUpperCase()}
      </text>
      <text
        x={w / 2}
        y={13.2}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="1.9"
        letterSpacing="0.3em"
        fill={INK}
        opacity="0.55"
      >
        {`${model.standard ?? 'CUSTOM'} · ${boardLabel}`}
      </text>
    </g>
  )
}

/* =====================================================================
 * ARRANGE overlay — one transparent hit rect per component, rendered
 * above the control layer. It swallows every pointer event in arrange
 * mode (disabling PLAY interactions by construction) and implements
 * select + move. The selection ring lives here too so it tracks the
 * component through the post-drag re-center animation.
 * ===================================================================== */

function ArrangeOverlay({
  ec,
  selected,
  dragging,
  onDown,
  onMove,
  onEnd
}: {
  ec: EnclosureComponent
  selected: boolean
  dragging: boolean
  onDown: (ec: EnclosureComponent, e: React.PointerEvent<SVGRectElement>) => void
  onMove: (e: React.PointerEvent<SVGRectElement>) => void
  onEnd: (e: React.PointerEvent<SVGRectElement>) => void
}) {
  // Hit area covers the rotated bounds with padding, floored to 8 mm so
  // tiny parts (a 5 mm LED) stay grabbable.
  const hitW = Math.max(ec.bounds.w + 3, 8)
  const hitH = Math.max(ec.bounds.h + 3, 8)
  const ringW = ec.bounds.w + 4.4
  const ringH = ec.bounds.h + 4.4
  return (
    <g style={groupStyle(ec, !dragging)}>
      {selected ? (
        <rect
          x={-ringW / 2}
          y={-ringH / 2}
          width={ringW}
          height={ringH}
          rx={1.6}
          className={styles.selectionRing}
        />
      ) : null}
      <rect
        x={-hitW / 2}
        y={-hitH / 2}
        width={hitW}
        height={hitH}
        rx={1.2}
        fill="transparent"
        className={dragging ? styles.arrangeHitDragging : styles.arrangeHit}
        onPointerDown={(e) => onDown(ec, e)}
        onPointerMove={onMove}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onLostPointerCapture={onEnd}
      />
    </g>
  )
}

/* =====================================================================
 * Per-component dispatch.
 * ===================================================================== */

/** Silkscreen label under a control. */
function SilkLabel({ text, y, dim = false }: { text: string; y: number; dim?: boolean }) {
  if (!text) return null
  return (
    <text
      y={y}
      textAnchor="middle"
      fontFamily="var(--dp-font-mono)"
      fontSize="2.4"
      letterSpacing="0.2em"
      fill={INK}
      opacity={dim ? 0.45 : 0.85}
      pointerEvents="none"
    >
      {text.toUpperCase()}
    </text>
  )
}

const BADGE_KINDS: Partial<Record<HardwareKind, true>> = {
  i2s_codec: true,
  pcm5102a: true,
  max98357a: true,
  gyroscope: true,
  magnetometer: true,
  piezo: true
}

function PerformComponent({
  ec,
  mgr,
  isPlaying,
  animate
}: {
  ec: EnclosureComponent
  mgr: HardwareActivityManager
  isPlaying: boolean
  /** False only for the component actively being ARRANGE-dragged. */
  animate: boolean
}) {
  const kind = ec.comp.kind
  const labelY = ec.bounds.h / 2 + 4.2

  let body: React.ReactNode
  switch (kind) {
    case 'pot':
    case 'encoder':
    case 'slider':
      return <SweepControl ec={ec} labelY={labelY} animate={animate} />
    case 'button':
      return <PressControl ec={ec} labelY={labelY} animate={animate} />
    case 'switch_3way':
      return <ToggleControl ec={ec} labelY={labelY} animate={animate} />
    case 'led':
      return <LedControl ec={ec} mgr={mgr} isPlaying={isPlaying} labelY={labelY} animate={animate} />
    case 'oled_ssd1306':
      return <OledControl ec={ec} isPlaying={isPlaying} labelY={labelY} animate={animate} />
    case 'gate_jack':
      body = <JackShape hexR={4.4} boreR={1.6} ringVar="var(--dp-signal-gate)" />
      break
    case 'cv_jack':
      body = <JackShape hexR={4.4} boreR={1.6} ringVar="var(--dp-signal-cv)" />
      break
    case 'audio_jack':
      body = <JackShape hexR={6.4} boreR={3} ringVar="var(--dp-signal-audio)" />
      break
    case 'midi_jack':
      body = <MidiDinShape />
      break
    case 'touch_ribbon':
      body = <RibbonShape lengthMm={Math.max(30, ec.size.h - 4)} />
      break
    case 'ldr':
      body = <LdrShape />
      break
    case 'electret':
      body = <ElectretShape />
      break
    case 'tof':
      body = <TofShape />
      break
    default:
      body = BADGE_KINDS[kind] ? (
        <InternalBadgeShape wMm={ec.size.w} hMm={ec.size.h} text={performLabel(ec.comp)} />
      ) : (
        <GenericShape />
      )
      break
  }

  const showLabel = !BADGE_KINDS[kind]
  return (
    <g style={groupStyle(ec, animate)} pointerEvents="none">
      <g transform={ec.rotation ? `rotate(${ec.rotation})` : undefined}>{body}</g>
      {showLabel ? <SilkLabel text={performLabel(ec.comp)} y={labelY} /> : null}
    </g>
  )
}

/* =====================================================================
 * Sweep control — pot / encoder / fader. Vertical drag, Shift = fine,
 * double-click = reset to param default. Whole gesture = one undo entry.
 * ===================================================================== */

function SweepControl({
  ec,
  labelY,
  animate
}: {
  ec: EnclosureComponent
  labelY: number
  animate: boolean
}) {
  const comp = ec.comp
  const value01 = useEditorStore((s) => controlValue01(s.graph, comp.id))
  const bound = value01 !== null
  const v = value01 ?? 0.5

  const [engaged, setEngaged] = useState(false)
  const dragRef = useRef<{ pointerId: number; lastY: number; acc: number } | null>(null)

  /*
   * Push-encoder switch.
   *
   * The knob body drags to turn, so the press needs its own target — a
   * centre cap, which is also where you'd push a real encoder. Down and up
   * are reported separately so the press duration is real, which is what
   * lets the shared click classifier tell a click from a hold from a
   * double without any extra plumbing here.
   */
  const isEncoder = comp.kind === 'encoder'
  const swDown = useEditorStore((s) => {
    if (comp.kind !== 'encoder') return false
    const n = s.graph.nodes.find((x) => x.params.bindingId === comp.id)
    const v = n?.params.sw_value
    return typeof v === 'number' && v >= 0.5
  })
  const setSwitch = useCallback(
    (down: boolean) => {
      const st = useEditorStore.getState()
      const node = st.graph.nodes.find((n) => n.params.bindingId === comp.id)
      if (!node || node.kind !== 'encoder_in') return
      st.setParam(node.id, 'sw_value', down ? 1 : 0)
    },
    [comp.id]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      if (e.button !== 0 || !bound || dragRef.current) return
      e.stopPropagation()
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      useEditorStore.getState().beginTransaction()
      dragRef.current = {
        pointerId: e.pointerId,
        lastY: e.clientY,
        acc: controlValue01(useEditorStore.getState().graph, comp.id) ?? 0
      }
      setEngaged(true)
    },
    [bound, comp.id]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      e.stopPropagation()
      const dy = d.lastY - e.clientY
      d.lastY = e.clientY
      const gain = (e.shiftKey ? FINE_GAIN : 1) / SWEEP_PX
      d.acc = clamp01(d.acc + dy * gain)
      setComponentValue01(comp.id, d.acc)
    },
    [comp.id]
  )

  const endDrag = useCallback((e: React.PointerEvent<SVGGElement>) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    dragRef.current = null
    setEngaged(false)
    // Closing the drag's transaction commits ONE history entry for the
    // whole sweep. Safe no-op if it already closed (lost capture, etc.).
    useEditorStore.getState().endTransaction()
  }, [])

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<SVGGElement>) => {
      if (!bound) return
      e.stopPropagation()
      resetComponentValue(comp.id)
    },
    [bound, comp.id]
  )

  // While engaged, show the actual param value as a readout.
  const readout = useEditorStore((s) => {
    if (!engaged) return null
    const bc = resolveBoundControl(s.graph, comp.id)
    if (!bc) return null
    const raw = bc.node.params[bc.param.id]
    return typeof raw === 'number' ? raw : null
  })

  const shape =
    comp.kind === 'encoder' ? (
      <EncoderShape value01={v} engaged={engaged} bound={bound} />
    ) : comp.kind === 'slider' ? (
      <FaderShape value01={v} engaged={engaged} bound={bound} travelMm={Math.max(24, ec.size.h - 12)} />
    ) : (
      <KnobShape value01={v} engaged={engaged} bound={bound} />
    )

  return (
    <g style={groupStyle(ec, animate)}>
      <g
        className={bound ? styles.sweepable : undefined}
        transform={ec.rotation ? `rotate(${ec.rotation})` : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={onDoubleClick}
      >
        {shape}
      </g>
      {isEncoder ? (
        <circle
          r={Math.max(1.6, ec.size.w * 0.16)}
          fill={swDown ? 'var(--dp-accent)' : 'var(--dp-perform-hardware)'}
          fillOpacity={swDown ? 0.9 : 0.001}
          stroke={swDown ? 'var(--dp-accent)' : 'none'}
          strokeWidth={0.3}
          style={{ cursor: 'pointer' }}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
            setSwitch(true)
          }}
          onPointerUp={(e) => {
            e.stopPropagation()
            setSwitch(false)
          }}
          onPointerCancel={() => setSwitch(false)}
          onLostPointerCapture={() => setSwitch(false)}
        >
          <title>Push (hold for long press, tap twice for double)</title>
        </circle>
      ) : null}
      <SilkLabel text={performLabel(comp)} y={labelY} dim={!bound} />
      {readout !== null ? (
        <text
          y={labelY + 3.4}
          textAnchor="middle"
          fontFamily="var(--dp-font-mono)"
          fontSize="2.2"
          letterSpacing="0.08em"
          fill="var(--dp-accent)"
          pointerEvents="none"
        >
          {formatReadout(readout)}
        </text>
      ) : null}
    </g>
  )
}

function formatReadout(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1000) return v.toFixed(0)
  if (abs >= 100) return v.toFixed(1)
  return v.toFixed(2)
}

/* =====================================================================
 * Press control — footswitch. pointerdown = 1, pointerup/cancel = 0.
 * ===================================================================== */

function PressControl({
  ec,
  labelY,
  animate
}: {
  ec: EnclosureComponent
  labelY: number
  animate: boolean
}) {
  const comp = ec.comp
  const bound = useEditorStore((s) => controlValue01(s.graph, comp.id) !== null)
  const [pressed, setPressed] = useState(false)
  const pressRef = useRef<number | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      if (e.button !== 0 || !bound || pressRef.current !== null) return
      e.stopPropagation()
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      pressRef.current = e.pointerId
      useEditorStore.getState().beginTransaction()
      setComponentValue01(comp.id, 1)
      setPressed(true)
    },
    [bound, comp.id]
  )

  const release = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      if (pressRef.current === null || e.pointerId !== pressRef.current) return
      pressRef.current = null
      setComponentValue01(comp.id, 0)
      setPressed(false)
      useEditorStore.getState().endTransaction()
    },
    [comp.id]
  )

  return (
    <g style={groupStyle(ec, animate)}>
      <g
        className={bound ? styles.pressable : undefined}
        transform={ec.rotation ? `rotate(${ec.rotation})` : undefined}
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <FootswitchShape pressed={pressed} bound={bound} />
      </g>
      <SilkLabel text={performLabel(comp)} y={labelY} dim={!bound} />
    </g>
  )
}

/* =====================================================================
 * Toggle control — click cycles -1 → 0 → +1.
 * ===================================================================== */

function ToggleControl({
  ec,
  labelY,
  animate
}: {
  ec: EnclosureComponent
  labelY: number
  animate: boolean
}) {
  const comp = ec.comp
  const position = useEditorStore((s) => switchPositionOf(s.graph, comp.id))
  const bound = useEditorStore((s) =>
    s.graph.nodes.some((n) => n.params.bindingId === comp.id)
  )

  const onClick = useCallback(
    (e: React.MouseEvent<SVGGElement>) => {
      if (!bound) return
      e.stopPropagation()
      cycleSwitchPosition(comp.id)
    },
    [bound, comp.id]
  )

  return (
    <g style={groupStyle(ec, animate)}>
      <g
        className={bound ? styles.pressable : undefined}
        transform={ec.rotation ? `rotate(${ec.rotation})` : undefined}
        onClick={onClick}
        onPointerDown={(e) => {
          if (bound && e.button === 0) e.stopPropagation()
        }}
      >
        <ToggleShape position={position} bound={bound} />
      </g>
      <SilkLabel text={performLabel(comp)} y={labelY} dim={!bound} />
    </g>
  )
}

/* =====================================================================
 * LED — glow driven per-frame via the activity manager (ref mutation,
 * zero React state). Dark when the transport is stopped.
 * ===================================================================== */

function ledColorVar(color: unknown): string {
  switch (String(color ?? 'white')) {
    case 'red':
      return 'var(--dp-danger)'
    case 'green':
      return 'var(--dp-signal-clock)'
    case 'blue':
    case 'cyan':
      return 'var(--dp-signal-audio)'
    case 'amber':
    case 'yellow':
    case 'orange':
      return 'var(--dp-signal-gate)'
    case 'white':
    default:
      return 'var(--dp-text)'
  }
}

function LedControl({
  ec,
  mgr,
  isPlaying,
  labelY,
  animate
}: {
  ec: EnclosureComponent
  mgr: HardwareActivityManager
  isPlaying: boolean
  labelY: number
  animate: boolean
}) {
  const comp = ec.comp
  const glowRef = useRef<SVGCircleElement>(null)
  const litRef = useRef<SVGCircleElement>(null)

  useEffect(() => {
    if (!isPlaying) {
      glowRef.current?.setAttribute('opacity', '0')
      litRef.current?.setAttribute('opacity', '0')
      return
    }
    return mgr.subscribe(comp.id, (frame) => {
      const lv = frame.level
      glowRef.current?.setAttribute('opacity', String(Math.min(1, lv * 1.25)))
      litRef.current?.setAttribute('opacity', String(Math.min(1, lv * 0.9 + (lv > 0.02 ? 0.15 : 0))))
    })
  }, [mgr, comp.id, isPlaying])

  return (
    <g style={groupStyle(ec, animate)} pointerEvents="none">
      <g transform={ec.rotation ? `rotate(${ec.rotation})` : undefined}>
        <LedShape colorVar={ledColorVar(comp.config.color)} glowRef={glowRef} litRef={litRef} />
      </g>
      <SilkLabel text={performLabel(comp)} y={labelY} />
    </g>
  )
}

/* =====================================================================
 * OLED — recessed window running the bound oled node's element list
 * through the shared 1-bit renderer. Taps + rAF only while playing;
 * stopped renders one static frame (zero inputs) and idles.
 * ===================================================================== */

function OledControl({
  ec,
  isPlaying,
  labelY,
  animate
}: {
  ec: EnclosureComponent
  isPlaying: boolean
  labelY: number
  animate: boolean
}) {
  const comp = ec.comp
  const engine = useAudioEngine()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const boundNodeId = useEditorStore((s) => {
    const n = s.graph.nodes.find(
      (x) => x.kind === 'oled' && x.params.bindingId === comp.id
    )
    return n ? n.id : null
  })

  const elementsRaw = useEditorStore((s) => {
    if (!boundNodeId) return '[]'
    const n = s.graph.nodes.find((x) => x.id === boundNodeId)
    const v = n?.params.elements
    return typeof v === 'string' ? v : '[]'
  })
  const elements = useMemo(() => parseElements(elementsRaw), [elementsRaw])
  const elementsRef = useRef<DisplayElement[]>(elements)
  useEffect(() => {
    elementsRef.current = elements
  }, [elements])

  // Connectivity key so taps reopen when the OLED's inputs are rewired.
  const connectivity = useEditorStore((s) => {
    if (!boundNodeId) return ''
    const parts: string[] = []
    for (const sock of OLED_INPUT_SOCKETS) {
      const c = s.graph.connections.find(
        (x) => x.to.nodeId === boundNodeId && x.to.socketId === sock
      )
      parts.push(c ? `${sock}:${c.from.nodeId}` : `${sock}:-`)
    }
    return parts.join('|')
  })

  const bufsRef = useRef<Record<string, Float32Array>>({})

  /* Taps — only while the transport runs. */
  useEffect(() => {
    if (!engine || !isPlaying || !boundNodeId) return
    const taps: Tap[] = []
    const bufs = bufsRef.current
    for (const sock of OLED_INPUT_SOCKETS) {
      if (!bufs[sock]) bufs[sock] = new Float32Array(256)
      else bufs[sock].fill(0)
      const tap = tapInput(engine, boundNodeId, sock, (values) => {
        const dst = bufs[sock]
        const n = Math.min(dst.length, values.length)
        for (let i = 0; i < n; i++) dst[i] = values[i]
        if (n < dst.length) dst.fill(0, n)
      })
      if (tap) taps.push(tap)
    }
    return () => {
      for (const t of taps) t.stop()
    }
  }, [engine, boundNodeId, connectivity, isPlaying])

  /* Draw — rAF loop while playing, single static frame when stopped. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const SCALE = 2
    canvas.width = OLED_WIDTH * SCALE
    canvas.height = OLED_HEIGHT * SCALE
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false

    const cs = getComputedStyle(canvas)
    const pixelOn = cs.getPropertyValue('--dp-signal-audio').trim() || '#22d3ee'
    const pixelOff = cs.getPropertyValue('--dp-bg').trim() || '#0a0f14'

    const bitmap = new Uint8Array(OLED_BITMAP_BYTES)

    const paint = () => {
      const inputMap: InputMap = {}
      for (const sock of OLED_INPUT_SOCKETS) {
        inputMap[sock] = isPlaying ? bufsRef.current[sock] ?? 0 : 0
      }
      /*
       * Same live-menu lookup as the in-node preview. Without it a `menu`
       * element renders "NO MENU BOUND" here — the enclosure would show a
       * blank screen while the patch canvas showed a working menu.
       */
      let menus: MenuMap | undefined
      if (elementsRef.current.some((e) => e.kind === 'menu')) {
        menus = {}
        for (const n of useEditorStore.getState().graph.nodes) {
          if (n.kind !== 'menu') continue
          menus[n.id] = { tree: parseMenuTree(n.params.tree), state: menuStateFor(n.id) }
        }
      }
      renderFrame(elementsRef.current, inputMap, bitmap, menus)
      ctx.fillStyle = pixelOff
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = pixelOn
      for (let y = 0; y < OLED_HEIGHT; y++) {
        for (let x = 0; x < OLED_WIDTH; x++) {
          if (getPixel(bitmap, x, y)) {
            ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE)
          }
        }
      }
    }

    if (!isPlaying) {
      // One static frame — zero rAF cost at rest.
      paint()
      return
    }

    let raf = 0
    let stopped = false
    const loop = () => {
      if (stopped) return
      paint()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [isPlaying, elements])

  return (
    <g style={groupStyle(ec, animate)} pointerEvents="none">
      <g transform={ec.rotation ? `rotate(${ec.rotation})` : undefined}>
        <OledWindowShape canvasRef={canvasRef} />
      </g>
      <SilkLabel text={performLabel(comp)} y={labelY} />
    </g>
  )
}
