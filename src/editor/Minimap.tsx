/**
 * Minimap — a low-res overview of the whole graph in the top-right corner of
 * the canvas. Shows all node rectangles (scaled to an approximate size), the
 * connections between them as thin lines, and a viewport rectangle
 * representing the portion of world space currently visible in the Rete
 * canvas.
 *
 * Click (or drag) on the minimap to jump the viewport so the clicked point
 * becomes the center of the visible area.
 *
 * Implementation notes:
 *   - Reads node positions from the store (stable ref — no new arrays).
 *   - Reads transform via the ReteEditor's `subscribeTransform` handle.
 *   - Renders on a plain canvas; redrawn on any input change or when
 *     the canvas itself is resized.
 */

import * as React from 'react'
import { useEditorStore } from '@/state/store'
import type { ReteEditorHandle, AreaTransformSnapshot } from './ReteEditor'
import styles from './Minimap.module.css'

/** Approximate node footprint in world coordinates. Matches typical Rete node. */
const NODE_W = 200
const NODE_H = 90
/** Padding around graph bounds so nodes don't clip the minimap edge. */
const WORLD_PAD = 120

interface Props {
  reteRef: React.RefObject<ReteEditorHandle | null>
}

interface ViewportBox {
  x: number
  y: number
  w: number
  h: number
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * World-space bounds that encompass both all nodes and the current viewport
 * rectangle. Including the viewport means the indicator is always visible
 * even when the user has panned far from any node.
 */
function computeBounds(
  nodes: { position: { x: number; y: number } }[],
  viewport: ViewportBox | null
): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const n of nodes) {
    const x1 = n.position.x
    const y1 = n.position.y
    const x2 = x1 + NODE_W
    const y2 = y1 + NODE_H
    if (x1 < minX) minX = x1
    if (y1 < minY) minY = y1
    if (x2 > maxX) maxX = x2
    if (y2 > maxY) maxY = y2
  }

  if (viewport) {
    if (viewport.x < minX) minX = viewport.x
    if (viewport.y < minY) minY = viewport.y
    if (viewport.x + viewport.w > maxX) maxX = viewport.x + viewport.w
    if (viewport.y + viewport.h > maxY) maxY = viewport.y + viewport.h
  }

  if (!isFinite(minX)) {
    // Empty graph + no viewport — default to a neutral world-origin box.
    return { minX: -500, minY: -300, maxX: 500, maxY: 300 }
  }

  return {
    minX: minX - WORLD_PAD,
    minY: minY - WORLD_PAD,
    maxX: maxX + WORLD_PAD,
    maxY: maxY + WORLD_PAD
  }
}

function readColor(el: HTMLElement, varName: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(varName).trim()
  return v || fallback
}

export function Minimap(props: Props): React.JSX.Element {
  const { reteRef } = props
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)

  // Stable selector — returns the same array reference when unchanged.
  const nodes = useEditorStore((s) => s.graph.nodes)
  const connections = useEditorStore((s) => s.graph.connections)

  const [transform, setTransform] = React.useState<AreaTransformSnapshot | null>(null)

  // Subscribe to the Rete area's transform. The handle fires immediately
  // with the current value, then on every subsequent translate/zoom/resize.
  React.useEffect(() => {
    const handle = reteRef.current
    if (!handle) return
    const unsub = handle.subscribeTransform((t) => setTransform(t))
    return unsub
    // Ref deps intentionally omitted — handles are stable per ReteEditor mount.
  }, [reteRef])

  const viewport: ViewportBox | null = React.useMemo(() => {
    if (!transform || transform.k === 0) return null
    return {
      x: -transform.x / transform.k,
      y: -transform.y / transform.k,
      w: transform.containerW / transform.k,
      h: transform.containerH / transform.k
    }
  }, [transform])

  const bounds = React.useMemo(() => computeBounds(nodes, viewport), [nodes, viewport])

  // Build a lookup from node id to position for fast connection drawing.
  const nodePos = React.useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const n of nodes) m.set(n.id, n.position)
    return m
  }, [nodes])

  // Redraw on every state change.
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW === 0 || cssH === 0) return

    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const colors = {
      bg: readColor(canvas, '--dp-surface-sunken', '#0f1319'),
      border: readColor(canvas, '--dp-border', '#1a2230'),
      node: readColor(canvas, '--dp-node-bg', '#141a22'),
      nodeBorder: readColor(canvas, '--dp-accent-muted', '#3d6880'),
      conn: readColor(canvas, '--dp-border-strong', '#2a3442'),
      viewport: readColor(canvas, '--dp-accent', '#22d3ee'),
      viewportFill: readColor(canvas, '--dp-accent-muted', '#3d6880')
    }

    const worldW = bounds.maxX - bounds.minX
    const worldH = bounds.maxY - bounds.minY
    if (worldW === 0 || worldH === 0) return

    // Uniform scale, letterboxed inside the minimap canvas.
    const scale = Math.min(cssW / worldW, cssH / worldH)
    const offX = (cssW - worldW * scale) / 2
    const offY = (cssH - worldH * scale) / 2

    const toMx = (wx: number): number => offX + (wx - bounds.minX) * scale
    const toMy = (wy: number): number => offY + (wy - bounds.minY) * scale

    // Background.
    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, cssW, cssH)

    // Connections — skip if the graph is huge to keep draw cheap.
    if (connections.length < 400) {
      ctx.strokeStyle = colors.conn
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const c of connections) {
        const a = nodePos.get(c.from.nodeId)
        const b = nodePos.get(c.to.nodeId)
        if (!a || !b) continue
        const ax = toMx(a.x + NODE_W)
        const ay = toMy(a.y + NODE_H / 2)
        const bx = toMx(b.x)
        const by = toMy(b.y + NODE_H / 2)
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
      }
      ctx.stroke()
    }

    // Nodes.
    ctx.fillStyle = colors.node
    ctx.strokeStyle = colors.nodeBorder
    ctx.lineWidth = 1
    for (const n of nodes) {
      const x = toMx(n.position.x)
      const y = toMy(n.position.y)
      const w = Math.max(3, NODE_W * scale)
      const h = Math.max(2, NODE_H * scale)
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
    }

    // Viewport rect.
    if (viewport) {
      const vx = toMx(viewport.x)
      const vy = toMy(viewport.y)
      const vw = Math.max(4, viewport.w * scale)
      const vh = Math.max(4, viewport.h * scale)
      ctx.save()
      ctx.fillStyle = colors.viewportFill
      ctx.globalAlpha = 0.25
      ctx.fillRect(vx, vy, vw, vh)
      ctx.globalAlpha = 1
      ctx.strokeStyle = colors.viewport
      ctx.lineWidth = 1.25
      ctx.strokeRect(vx + 0.5, vy + 0.5, vw - 1, vh - 1)
      ctx.restore()
    }
  }, [nodes, connections, nodePos, bounds, viewport])

  // Jump handler — translates minimap coords back to world coords and asks
  // the Rete handle to center the viewport there.
  const onPointer = React.useCallback(
    (clientX: number, clientY: number): void => {
      const canvas = canvasRef.current
      const handle = reteRef.current
      if (!canvas || !handle) return
      const rect = canvas.getBoundingClientRect()
      const mx = clientX - rect.left
      const my = clientY - rect.top

      const cssW = canvas.clientWidth
      const cssH = canvas.clientHeight
      const worldW = bounds.maxX - bounds.minX
      const worldH = bounds.maxY - bounds.minY
      if (worldW === 0 || worldH === 0) return

      const scale = Math.min(cssW / worldW, cssH / worldH)
      const offX = (cssW - worldW * scale) / 2
      const offY = (cssH - worldH * scale) / 2

      const worldX = (mx - offX) / scale + bounds.minX
      const worldY = (my - offY) / scale + bounds.minY
      handle.centerOn(worldX, worldY)
    },
    [bounds, reteRef]
  )

  const draggingRef = React.useRef(false)

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      draggingRef.current = true
      onPointer(e.clientX, e.clientY)
    },
    [onPointer]
  )

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!draggingRef.current) return
      onPointer(e.clientX, e.clientY)
    },
    [onPointer]
  )

  const onPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      draggingRef.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    },
    []
  )

  return (
    <div className={styles.root} aria-label="Minimap">
      <span className={styles.header}>map</span>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
}
