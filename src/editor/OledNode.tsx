/**
 * OLED node body. Unlike the scope/vu/spectrum "visual" nodes (which only
 * show a waveform), this node carries a *live preview* of a 128x64 SSD1306
 * display composed from typed `DisplayElement`s. The elements bind to the
 * node's six input sockets (a..f) so the preview animates as upstream
 * signals change.
 *
 * Architecture:
 *   - Elements live in the node's `elements` param (JSON-serialized). The
 *     in-node designer (toolbar + list + inspector) is the only UI that
 *     edits this param.
 *   - Live input sampling: since `AudioEngine.tap(nodeId)` forks a node's
 *     OUTPUT, and we want the INPUT signal for each connected socket, we
 *     walk the store's connection list and tap each UPSTREAM node. The
 *     buffer is cached per-tick and passed to `renderFrame()`.
 *   - Rendering: `renderFrame()` writes into a 128x64 packed 1-bit bitmap
 *     we draw onto a canvas at 2x CSS scale. Pixels are filled squares
 *     coloured `--dp-signal-audio` against a `--dp-bg` background.
 *   - Click-to-select: we hit-test element bboxes on canvas click and
 *     select the topmost match.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme, RenderEmit } from 'rete-react-plugin'

import { DaisyNode } from './nodes/base'
import type { SignalSocket } from './sockets'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import { useEditorStore } from '@/state/store'
import type { Tap } from '@/types/store'
import { tapInput } from './oled/tapInput'
import {
  type BindingSource,
  type DisplayElement,
  type ElementKind,
  BINDING_VALUES,
  describeElement,
  elementBBox,
  makeDefaultElement,
  parseElements,
  serializeElements
} from './oled/elements'
import {
  OLED_BITMAP_BYTES,
  OLED_HEIGHT,
  OLED_WIDTH,
  getPixel,
  renderFrame,
  type InputMap
} from './oled/render'
import { CollapseButton, useHeaderDoubleClick } from './CustomNode'
import styles from './OledNode.module.css'

const { RefSocket } = Presets.classic

type Props<S extends ClassicScheme> = {
  data: S['Node']
  emit: RenderEmit<S>
}

/** CSS scale of the preview vs the 128x64 pixel grid. */
const PREVIEW_SCALE = 2
const PREVIEW_CSS_W = OLED_WIDTH * PREVIEW_SCALE
const PREVIEW_CSS_H = OLED_HEIGHT * PREVIEW_SCALE

const INPUT_SOCKETS: BindingSource[] = ['a', 'b', 'c', 'd', 'e', 'f']

const ELEMENT_BUTTONS: { kind: ElementKind; label: string; title: string }[] = [
  { kind: 'text', label: '+T', title: 'Add text' },
  { kind: 'value', label: '+V', title: 'Add value readout' },
  { kind: 'meter', label: '+M', title: 'Add meter' },
  { kind: 'scope', label: '+S', title: 'Add scope' },
  { kind: 'rect', label: '+R', title: 'Add rectangle' },
  { kind: 'circle', label: '+C', title: 'Add circle' },
  { kind: 'line', label: '+L', title: 'Add line' },
  { kind: 'pattern', label: '+P', title: 'Add pattern' }
]

interface ThemeColors {
  pixelOn: string
  pixelOff: string
  border: string
}

function readTheme(el: HTMLElement): ThemeColors {
  const s = getComputedStyle(el)
  const pick = (name: string, fallback: string): string => {
    const v = s.getPropertyValue(name).trim()
    return v || fallback
  }
  return {
    pixelOn: pick('--dp-signal-audio', '#22d3ee'),
    pixelOff: pick('--dp-bg', '#0a0f14'),
    border: pick('--dp-border-strong', '#3b4a5e')
  }
}

export function OledNode<S extends ClassicScheme>(props: Props<S>): React.JSX.Element {
  const { data, emit } = props
  const selected = data.selected ?? false
  const isDaisy = data instanceof DaisyNode
  const kind = isDaisy ? data.kind : undefined
  const def = kind ? NODE_DEFINITIONS[kind] : undefined

  const inputs = Object.entries(data.inputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]

  const engine = useAudioEngine()

  const collapsed = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return n?.collapsed === true
  })
  const onHeaderDoubleClick = useHeaderDoubleClick(data.id)

  // Subscribe to just the elements param so re-renders stay scoped.
  const elementsRaw = useEditorStore((s) => {
    const node = s.graph.nodes.find((n) => n.id === data.id)
    const v = node?.params.elements
    return typeof v === 'string' ? v : '[]'
  })
  const elements = React.useMemo(() => parseElements(elementsRaw), [elementsRaw])

  // Track which connections exist for each input socket so we can re-attach
  // taps only when connectivity changes (not on every param tweak).
  const connectivity = useEditorStore((s) => {
    const parts: string[] = []
    for (const sock of INPUT_SOCKETS) {
      const c = s.graph.connections.find(
        (x) => x.to.nodeId === data.id && x.to.socketId === sock
      )
      parts.push(c ? `${sock}:${c.from.nodeId}` : `${sock}:-`)
    }
    return parts.join('|')
  })

  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  // Keep a mutable ref to the latest elements so the rAF render loop reads
  // fresh values without restarting the taps.
  const elementsRef = React.useRef<DisplayElement[]>(elements)
  React.useEffect(() => {
    elementsRef.current = elements
  }, [elements])

  // Latest input buffers keyed by socket id. Scope elements read buffers;
  // meter/value/pattern/rect read the scalar reduction.
  const bufsRef = React.useRef<Record<string, Float32Array>>({})

  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  // Bounding boxes tracked for click-to-select, kept in node-pixel space.
  const bboxesRef = React.useRef<Array<{ id: string; x: number; y: number; w: number; h: number }>>([])

  /* ---------- tap lifecycle ---------- */
  React.useEffect(() => {
    if (!engine) return
    // Collapsed nodes don't have a canvas on screen — skip the taps and
    // the rAF draw loop to free CPU while the body is hidden.
    if (collapsed) return
    const taps: Tap[] = []
    const bufs = bufsRef.current
    // Start every input fresh as zero.
    for (const sock of INPUT_SOCKETS) {
      if (!bufs[sock]) bufs[sock] = new Float32Array(256)
      else bufs[sock].fill(0)
      const tap = tapInput(engine, data.id, sock, (values) => {
        // Copy into our fixed-length buffer; analyser ships 256 samples.
        const dst = bufs[sock]
        const n = Math.min(dst.length, values.length)
        for (let i = 0; i < n; i++) dst[i] = values[i]
        if (n < dst.length) dst.fill(0, n)
      })
      if (tap) taps.push(tap)
      // If tap is null, the socket is unconnected and the buffer stays
      // zero-filled — elements render at their zero-state.
    }
    return () => {
      for (const t of taps) t.stop()
    }
    // Re-run only when connectivity topology changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, data.id, connectivity, collapsed])

  /* ---------- canvas render loop ---------- */
  React.useEffect(() => {
    if (collapsed) return
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    canvas.width = Math.floor(PREVIEW_CSS_W * dpr)
    canvas.height = Math.floor(PREVIEW_CSS_H * dpr)
    canvas.style.width = `${PREVIEW_CSS_W}px`
    canvas.style.height = `${PREVIEW_CSS_H}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = false

    const theme = readTheme(canvas)
    const bitmap = new Uint8Array(OLED_BITMAP_BYTES)

    let raf = 0
    let stopped = false

    const draw = () => {
      if (stopped) return
      const els = elementsRef.current
      // Build input map: scalar RMS from buffer for signal-scaled elements,
      // and the buffer itself for scope elements. Unconnected sockets stay
      // zeroed (see tap effect).
      const inputMap: InputMap = {}
      for (const sock of INPUT_SOCKETS) {
        inputMap[sock] = bufsRef.current[sock] ?? new Float32Array(256)
      }
      renderFrame(els, inputMap, bitmap)

      // Paint background.
      ctx.fillStyle = theme.pixelOff
      ctx.fillRect(0, 0, PREVIEW_CSS_W, PREVIEW_CSS_H)
      ctx.fillStyle = theme.pixelOn
      for (let y = 0; y < OLED_HEIGHT; y++) {
        for (let x = 0; x < OLED_WIDTH; x++) {
          if (getPixel(bitmap, x, y)) {
            ctx.fillRect(x * PREVIEW_SCALE, y * PREVIEW_SCALE, PREVIEW_SCALE, PREVIEW_SCALE)
          }
        }
      }

      // Selected element outline (drawn in node-pixel space, scaled up).
      if (selectedId) {
        const el = els.find((e) => e.id === selectedId)
        if (el) {
          const bb = elementBBox(el)
          ctx.strokeStyle = theme.border
          ctx.lineWidth = 1
          ctx.strokeRect(
            bb.x * PREVIEW_SCALE + 0.5,
            bb.y * PREVIEW_SCALE + 0.5,
            Math.max(1, bb.w) * PREVIEW_SCALE - 1,
            Math.max(1, bb.h) * PREVIEW_SCALE - 1
          )
        }
      }

      // Track bboxes for hit testing. Back-to-front → reverse order picks topmost.
      bboxesRef.current = els.map((el) => ({ id: el.id, ...elementBBox(el) }))

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [selectedId, collapsed])

  /* ---------- mutations ---------- */
  const writeElements = React.useCallback(
    (next: DisplayElement[]) => {
      useEditorStore.getState().setParam(data.id, 'elements', serializeElements(next))
    },
    [data.id]
  )

  const addElement = React.useCallback(
    (k: ElementKind) => {
      const fresh = makeDefaultElement(k)
      const next = [...elements, fresh]
      writeElements(next)
      setSelectedId(fresh.id)
    },
    [elements, writeElements]
  )

  const deleteSelected = React.useCallback(() => {
    if (!selectedId) return
    writeElements(elements.filter((e) => e.id !== selectedId))
    setSelectedId(null)
  }, [elements, selectedId, writeElements])

  const patchSelected = React.useCallback(
    (patch: Partial<DisplayElement>) => {
      if (!selectedId) return
      const next = elements.map((e) =>
        e.id === selectedId ? ({ ...e, ...patch } as DisplayElement) : e
      )
      writeElements(next)
    },
    [elements, selectedId, writeElements]
  )

  /* ---------- canvas click: hit test ---------- */
  const onCanvasClick = React.useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const px = Math.floor((ev.clientX - rect.left) / PREVIEW_SCALE)
      const py = Math.floor((ev.clientY - rect.top) / PREVIEW_SCALE)
      // Top-most wins → iterate reverse.
      const boxes = bboxesRef.current
      for (let i = boxes.length - 1; i >= 0; i--) {
        const b = boxes[i]
        if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) {
          setSelectedId(b.id)
          return
        }
      }
      setSelectedId(null)
    },
    []
  )

  /* ---------- render ---------- */

  if (!isDaisy || !kind || !def) {
    return (
      <div className={`${styles.node} ${selected ? styles.selected : ''}`} data-testid="node">
        <div className={styles.header}>
          <span className={styles.accent} aria-hidden />
          {data.label || 'oled'}
        </div>
      </div>
    )
  }

  const selectedElement = selectedId ? elements.find((e) => e.id === selectedId) ?? null : null
  const activeInputs = inputs.filter((e): e is [string, { socket: SignalSocket; label?: string }] => e[1] !== undefined)

  return (
    <div
      className={`${styles.node} ${selected ? styles.selected : ''} ${collapsed ? styles.collapsed : ''}`}
      data-testid="node"
    >
      <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
        <span className={styles.accent} aria-hidden />
        <span className={styles.headerLabel}>{data.label}</span>
        {collapsed ? (
          <span className={styles.headerSummary} aria-hidden>
            {activeInputs.length}&rarr;0
          </span>
        ) : null}
        <CollapseButton nodeId={data.id} collapsed={collapsed} />
        {collapsed ? (
          <div className={styles.headerSocketsLeft} aria-hidden>
            {activeInputs.map(([key, input]) => (
              <div key={`chin-${key}`} className={styles.headerSocketCell}>
                <RefSocket
                  name="input-socket"
                  side="input"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={input.socket}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {collapsed ? null : (
      <div className={styles.body}>
        {activeInputs.map(([key, input]) => (
            <div
              key={`in-${key}`}
              className={`${styles.row} ${styles['row-input']}`}
              data-testid={`input-${key}`}
            >
              <div className={styles.socketCell}>
                <RefSocket
                  name="input-socket"
                  side="input"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={input.socket}
                />
              </div>
              <span className={styles.socketLabel}>{input.label ?? key}</span>
            </div>
        ))}
        <div className={styles.displayWrap}>
          <canvas
            ref={canvasRef}
            className={styles.displayCanvas}
            onClick={onCanvasClick}
            onPointerDown={(e) => e.stopPropagation()}
            data-testid="oled-preview"
          />
        </div>
        <div className={styles.toolbar} onPointerDown={(e) => e.stopPropagation()}>
          {ELEMENT_BUTTONS.map((b) => (
            <button
              key={b.kind}
              type="button"
              className={styles.toolBtn}
              title={b.title}
              onClick={() => addElement(b.kind)}
            >
              {b.label}
            </button>
          ))}
          <button
            type="button"
            className={`${styles.toolBtn} ${styles.toolBtnDanger}`}
            onClick={deleteSelected}
            disabled={!selectedId}
            title="Delete selected"
          >
            del
          </button>
        </div>
        <div className={styles.list} onPointerDown={(e) => e.stopPropagation()}>
          {elements.length === 0 ? (
            <div className={styles.listEmpty}>no elements — use the toolbar</div>
          ) : (
            elements.map((el) => (
              <div
                key={el.id}
                className={`${styles.listRow} ${el.id === selectedId ? styles.listRowSelected : ''}`}
                onClick={() => setSelectedId(el.id)}
              >
                <span>{describeElement(el)}</span>
                <span>
                  {el.x},{el.y}
                </span>
              </div>
            ))
          )}
        </div>
        {selectedElement ? (
          <ElementInspector
            element={selectedElement}
            onPatch={patchSelected}
          />
        ) : (
          <div className={styles.hint}>select an element to edit</div>
        )}
      </div>
      )}
    </div>
  )
}

/* ---------- inspector ---------- */

interface InspectorProps {
  element: DisplayElement
  onPatch: (patch: Partial<DisplayElement>) => void
}

function numberInput(
  value: number,
  onChange: (n: number) => void,
  opts?: { min?: number; max?: number; step?: number }
): React.JSX.Element {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={opts?.min}
      max={opts?.max}
      step={opts?.step ?? 1}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

function BindingSelect(props: {
  value: BindingSource
  onChange: (v: BindingSource) => void
}): React.JSX.Element {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as BindingSource)}
    >
      {BINDING_VALUES.map((b) => (
        <option key={b} value={b}>
          {b.toUpperCase()}
        </option>
      ))}
    </select>
  )
}

function ElementInspector({ element, onPatch }: InspectorProps): React.JSX.Element {
  return (
    <div className={styles.inspector} onPointerDown={(e) => e.stopPropagation()}>
      <label>x</label>
      {numberInput(element.x, (n) => onPatch({ x: Math.max(0, Math.min(127, n | 0)) } as Partial<DisplayElement>), {
        min: 0,
        max: 127
      })}
      <label>y</label>
      {numberInput(element.y, (n) => onPatch({ y: Math.max(0, Math.min(63, n | 0)) } as Partial<DisplayElement>), {
        min: 0,
        max: 63
      })}

      {element.kind === 'text' && (
        <>
          <label>text</label>
          <input
            type="text"
            value={element.text}
            maxLength={32}
            onChange={(e) => onPatch({ text: e.target.value } as Partial<DisplayElement>)}
          />
          <label>size</label>
          <select
            value={String(element.size)}
            onChange={(e) =>
              onPatch({ size: (Number(e.target.value) === 2 ? 2 : 1) } as Partial<DisplayElement>)
            }
          >
            <option value="1">1x</option>
            <option value="2">2x</option>
          </select>
        </>
      )}

      {element.kind === 'value' && (
        <>
          <label>bind</label>
          <BindingSelect
            value={element.binding}
            onChange={(v) => onPatch({ binding: v } as Partial<DisplayElement>)}
          />
          <label>dec</label>
          {numberInput(
            element.decimals,
            (n) => onPatch({ decimals: Math.max(0, Math.min(4, n | 0)) } as Partial<DisplayElement>),
            { min: 0, max: 4 }
          )}
          <label>unit</label>
          <input
            type="text"
            value={element.unit ?? ''}
            maxLength={4}
            onChange={(e) => onPatch({ unit: e.target.value } as Partial<DisplayElement>)}
          />
          <label>size</label>
          <select
            value={String(element.size)}
            onChange={(e) =>
              onPatch({ size: (Number(e.target.value) === 2 ? 2 : 1) } as Partial<DisplayElement>)
            }
          >
            <option value="1">1x</option>
            <option value="2">2x</option>
          </select>
        </>
      )}

      {element.kind === 'meter' && (
        <>
          <label>bind</label>
          <BindingSelect
            value={element.binding}
            onChange={(v) => onPatch({ binding: v } as Partial<DisplayElement>)}
          />
          <label>w</label>
          {numberInput(element.width, (n) => onPatch({ width: Math.max(2, Math.min(128, n | 0)) } as Partial<DisplayElement>), {
            min: 2,
            max: 128
          })}
          <label>h</label>
          {numberInput(element.height, (n) => onPatch({ height: Math.max(2, Math.min(64, n | 0)) } as Partial<DisplayElement>), {
            min: 2,
            max: 64
          })}
          <label>orient</label>
          <select
            value={element.orientation}
            onChange={(e) => onPatch({ orientation: e.target.value === 'v' ? 'v' : 'h' } as Partial<DisplayElement>)}
          >
            <option value="h">horiz</option>
            <option value="v">vert</option>
          </select>
        </>
      )}

      {element.kind === 'scope' && (
        <>
          <label>bind</label>
          <BindingSelect
            value={element.binding}
            onChange={(v) => onPatch({ binding: v } as Partial<DisplayElement>)}
          />
          <label>w</label>
          {numberInput(element.width, (n) => onPatch({ width: Math.max(8, Math.min(128, n | 0)) } as Partial<DisplayElement>), {
            min: 8,
            max: 128
          })}
          <label>h</label>
          {numberInput(element.height, (n) => onPatch({ height: Math.max(4, Math.min(64, n | 0)) } as Partial<DisplayElement>), {
            min: 4,
            max: 64
          })}
        </>
      )}

      {element.kind === 'rect' && (
        <>
          <label>w</label>
          {numberInput(element.width, (n) => onPatch({ width: Math.max(1, Math.min(128, n | 0)) } as Partial<DisplayElement>), {
            min: 1,
            max: 128
          })}
          <label>h</label>
          {numberInput(element.height, (n) => onPatch({ height: Math.max(1, Math.min(64, n | 0)) } as Partial<DisplayElement>), {
            min: 1,
            max: 64
          })}
          <label>fill</label>
          <input
            type="checkbox"
            checked={element.fill}
            onChange={(e) => onPatch({ fill: e.target.checked } as Partial<DisplayElement>)}
          />
          <label>bind</label>
          <BindingSelect
            value={element.binding ?? 'none'}
            onChange={(v) => onPatch({ binding: v } as Partial<DisplayElement>)}
          />
        </>
      )}

      {element.kind === 'circle' && (
        <>
          <label>r</label>
          {numberInput(element.radius, (n) => onPatch({ radius: Math.max(1, Math.min(32, n | 0)) } as Partial<DisplayElement>), {
            min: 1,
            max: 32
          })}
          <label>fill</label>
          <input
            type="checkbox"
            checked={element.fill}
            onChange={(e) => onPatch({ fill: e.target.checked } as Partial<DisplayElement>)}
          />
        </>
      )}

      {element.kind === 'line' && (
        <>
          <label>x2</label>
          {numberInput(element.x2, (n) => onPatch({ x2: Math.max(0, Math.min(127, n | 0)) } as Partial<DisplayElement>), {
            min: 0,
            max: 127
          })}
          <label>y2</label>
          {numberInput(element.y2, (n) => onPatch({ y2: Math.max(0, Math.min(63, n | 0)) } as Partial<DisplayElement>), {
            min: 0,
            max: 63
          })}
        </>
      )}

      {element.kind === 'pattern' && (
        <>
          <label>bind</label>
          <BindingSelect
            value={element.binding}
            onChange={(v) => onPatch({ binding: v } as Partial<DisplayElement>)}
          />
          <label>cols</label>
          {numberInput(element.cols, (n) => onPatch({ cols: Math.max(1, Math.min(32, n | 0)) } as Partial<DisplayElement>), {
            min: 1,
            max: 32
          })}
          <label>rows</label>
          {numberInput(element.rows, (n) => onPatch({ rows: Math.max(1, Math.min(8, n | 0)) } as Partial<DisplayElement>), {
            min: 1,
            max: 8
          })}
          <label>cell</label>
          {numberInput(element.cellSize, (n) => onPatch({ cellSize: Math.max(1, Math.min(16, n | 0)) } as Partial<DisplayElement>), {
            min: 1,
            max: 16
          })}
        </>
      )}
    </div>
  )
}
