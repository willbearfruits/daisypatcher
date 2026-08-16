/**
 * Rete.js editor for Daisypatcher. Thin view layer on top of the Zustand
 * `EditorStore`. Rules:
 *
 *   1. Store is canonical. Nothing in Rete holds state the store doesn't
 *      already own — positions, connections, selection, deletions all round
 *      trip through the store.
 *   2. Store -> Rete uses `diffGraph` so we only apply minimal mutations
 *      when the graph changes, with a `syncing` flag to prevent the editor's
 *      own internal events (which fire during node/connection creation) from
 *      calling back into the store.
 *   3. Rete -> store is wired through the editor's and area's signal
 *      pipelines — translation, connection creation, node/connection removal
 *      each dispatch the matching store action.
 */

import { useEffect, useImperativeHandle, useRef, forwardRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import {
  NodeEditor,
  ClassicPreset,
  type GetSchemes
} from 'rete'
import { AreaPlugin, AreaExtensions, Drag } from 'rete-area-plugin'
import { CANVAS_COMMAND_EVENT, type CanvasCommand } from '@/hooks/useMenuCommands'
import {
  ConnectionPlugin,
  ClassicFlow,
  type SocketData
} from 'rete-connection-plugin'
import {
  ReactPlugin,
  Presets as ReactPresets,
  type ReactArea2D
} from 'rete-react-plugin'

import type { AudioGraph, NodeKind } from '@/types/graph'
import { useEditorStore } from '@/state/store'

import { DaisyNode, createNode } from './nodes'
import { SignalSocket, canConnectSockets } from './sockets'
import { CustomNode } from './CustomNode'
import { CustomSocket } from './CustomSocket'
import { CustomConnection, type SignalConnectionData } from './CustomConnection'
import { VisualNode } from './VisualNode'
import { OledNode } from './OledNode'
import { MenuNode } from './MenuNode'
import { EncoderNode } from './EncoderNode'
import { CodeNode } from './CodeNode'
import { diffGraph } from './sync'
import { CANVAS_CONTEXT_MENU_EVENT, type ContextMenuDetail, type ContextTarget } from './CanvasContextMenu'

/** Node kinds whose Rete body is rendered by `VisualNode` instead of `CustomNode`. */
const VISUAL_KINDS: Set<NodeKind> = new Set<NodeKind>(['scope', 'vu', 'spectrum_scope'])

import './style.css'

/* ---------- schema ---------- */

type DaisyConnection = ClassicPreset.Connection<DaisyNode, DaisyNode> & SignalConnectionData
type Schemes = GetSchemes<DaisyNode, DaisyConnection>
type AreaExtra = ReactArea2D<Schemes>

/* ---------- public API ---------- */

/** Lightweight snapshot of the area-plugin transform, consumed by the minimap. */
export interface AreaTransformSnapshot {
  /** Translation in container (screen) pixels. */
  x: number
  y: number
  /** Zoom factor (1 = 100%). */
  k: number
  /** Current container (viewport) size in CSS pixels. */
  containerW: number
  containerH: number
}

export interface ReteEditorHandle {
  /** Convert a palette drop at (clientX, clientY) into an `addNode` call. */
  onDropNode: (kind: NodeKind, clientX: number, clientY: number) => void
  /**
   * Subscribe to pan/zoom/resize changes. The callback fires immediately with
   * the current transform and again on every subsequent translate/zoom.
   * Returns an unsubscribe function.
   */
  subscribeTransform: (cb: (t: AreaTransformSnapshot) => void) => () => void
  /**
   * Pan the area so that the given world coordinate is at the container
   * center. Used by the minimap's click-to-jump.
   */
  centerOn: (worldX: number, worldY: number) => void
}

export interface ReteEditorProps {
  /** Optional external handle — alternative to forwarding a ref. */
  onReady?: (handle: ReteEditorHandle) => void
}

/* ---------- helpers ---------- */

function signalOfSocket(s: ClassicPreset.Socket | undefined): SignalConnectionData['signal'] {
  return s instanceof SignalSocket ? s.signal : undefined
}

/**
 * Resolve a {@link SocketData} (as emitted by rete-connection-plugin during
 * drag) to the actual socket instance on the node so we can run a type-based
 * compatibility check. Returns undefined if the node/side/key cannot be found.
 */
function resolveSocket(
  editor: NodeEditor<Schemes>,
  sd: SocketData
): ClassicPreset.Socket | undefined {
  const node = editor.getNode(sd.nodeId)
  if (!node) return undefined
  if (sd.side === 'output') return node.outputs[sd.key]?.socket
  return node.inputs[sd.key]?.socket
}

/** Duration of the refused-drop socket flash; matches --dp-motion-slow. */
const REJECT_FLASH_MS = 320

/**
 * Brief danger flash on the socket that refused a drop. The attribute lands
 * on the `RefSocket` wrapper (`SocketData.element`); styles live in
 * style.css. Cleared by timeout rather than `animationend` so reduced-motion
 * users — whose flash is a static color swap — get the same duration.
 */
function flashRejectedSocket(element: HTMLElement): void {
  element.removeAttribute('data-dp-reject')
  // Force a style flush so re-adding the attribute restarts the CSS
  // animation when the user re-drops on the same socket in quick succession.
  void element.offsetWidth
  element.setAttribute('data-dp-reject', '')
  window.setTimeout(() => {
    element.removeAttribute('data-dp-reject')
  }, REJECT_FLASH_MS)
}

function clientToCanvas(
  container: HTMLElement,
  transform: { x: number; y: number; k: number },
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const { left, top } = container.getBoundingClientRect()
  return {
    x: (clientX - left - transform.x) / transform.k,
    y: (clientY - top - transform.y) / transform.k
  }
}

/**
 * Is this pointer event on empty canvas rather than a node or a cable?
 *
 * Nodes and connections stop propagation before the area sees the event in
 * most paths, but not all of them — the SVG cable layer in particular
 * bubbles — so the check is explicit: the target has to BE one of the
 * background elements, not merely be contained by one.
 */
function isBackgroundTarget(target: EventTarget | null, container: HTMLElement, holder: HTMLElement): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target === container || target === holder || target.classList.contains('dp-rete-root')
}

/** Last pointer position over the canvas, in canvas space. Drives paste-here. */
let lastCanvasPointer: { x: number; y: number } | null = null

/**
 * Where a paste with no explicit position should land.
 *
 * `paste()` accepts a position but the keyboard binding had nothing to give
 * it, so every paste landed at a fixed +40,+40 from the original — which
 * stacks into an unreadable pile the third time you press it. The canvas
 * records the pointer as it moves and the binding reads it here.
 */
export function canvasPastePosition(): { x: number; y: number } | undefined {
  return lastCanvasPointer ?? undefined
}

/* ---------- component ---------- */

export const ReteEditor = forwardRef<ReteEditorHandle, ReteEditorProps>(function ReteEditor(
  { onReady },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<NodeEditor<Schemes> | null>(null)
  const areaRef = useRef<AreaPlugin<Schemes, AreaExtra> | null>(null)

  /**
   * When true, the editor is mid-way through applying a store-driven mutation.
   * Any events emitted during that window must NOT call back into the store.
   */
  const syncingRef = useRef(false)

  /**
   * True while a drag transaction is open (between nodepicked and
   * nodedragged). Used to ensure we never leave a dangling transaction if
   * an unusual event ordering occurs.
   */
  const dragOpenRef = useRef(false)

  /**
   * The node the user actually grabbed for the current drag.
   *
   * Rete moves only the picked node. To drag a whole selection we mirror
   * the leader's per-event delta onto the other selected nodes — but the
   * `area.translate()` calls that does emit their OWN `nodetranslated`
   * events, so only the leader is allowed to fan out. Comparing against
   * this ref is what stops that from recursing.
   */
  const dragLeaderRef = useRef<string | null>(null)

  /**
   * Did the pick land on a node that was already selected, with no modifier?
   * If so the selection is held for the duration of the gesture and only
   * collapsed on release, and only if the node never actually moved.
   */
  const pickWasInSelectionRef = useRef(false)
  /** True once a drag has produced any movement at all. */
  const dragMovedRef = useRef(false)

  /** Rete's selector / selectable handles — used to drive two-way sync. */
  const selectorRef = useRef<ReturnType<typeof AreaExtensions.selector> | null>(null)
  const selectableRef = useRef<ReturnType<typeof AreaExtensions.selectableNodes> | null>(null)
  /**
   * Single instance of the ctrl-accumulator. We read `.active()` from it
   * inside pipes to decide whether a click was modifier-held; making a new
   * one each time would leak keyboard listeners.
   */
  const accumulatorRef = useRef<ReturnType<typeof AreaExtensions.accumulateOnCtrl> | null>(null)

  /**
   * Reentrancy guard: when we push store-selection into Rete, Rete fires
   * `nodepicked`; we must not round-trip that back into the store.
   */
  const selectionApplyingRef = useRef(false)

  /** Last graph we successfully mirrored into Rete. Used by the diff. */
  const lastGraphRef = useRef<AudioGraph | null>(null)

  /**
   * Transform-change subscribers (minimap, etc). Populated via the handle's
   * `subscribeTransform`; fired from the area pipe on translate/zoom and
   * from a ResizeObserver when the container itself changes size.
   */
  const transformListenersRef = useRef<Set<(t: AreaTransformSnapshot) => void>>(new Set())

  /* ----- mount / teardown ----- */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false

    const editor = new NodeEditor<Schemes>()
    const area = new AreaPlugin<Schemes, AreaExtra>(container)
    const connection = new ConnectionPlugin<Schemes, AreaExtra>()
    const render = new ReactPlugin<Schemes, AreaExtra>({ createRoot })

    editorRef.current = editor
    areaRef.current = area

    // Classic flow, but fronted by a socket-compat gate so mismatched signal
    // kinds are rejected AT DRAG TIME (no provisional connection, visible
    // snap-back) rather than silently after a store commit.
    connection.addPreset(
      () =>
        new ClassicFlow({
          canMakeConnection: (from: SocketData, to: SocketData) => {
            // Reject same-side drags (output->output, input->input) — the
            // default preset does this via getSourceTarget; since we're
            // replacing it, we replicate the guard here.
            if (from.side === to.side) return false
            const fromSocket = resolveSocket(editor, from)
            const toSocket = resolveSocket(editor, to)
            if (!canConnectSockets(fromSocket, toSocket)) {
              useEditorStore
                .getState()
                .setStatus({ kind: 'warn', message: 'signal type mismatch' })
              // Same-side drops were already rejected silently above; this
              // branch is a real "tried to plug it in, wrong signal" refusal.
              flashRejectedSocket(to.element)
              return false
            }
            return true
          }
        })
    )

    /* ----- drag-time socket compatibility highlight ----- */

    // While a cable drag is in flight, the picked socket's signal kind and
    // side are stamped on the editor root; CSS in style.css dims every socket
    // that `canMakeConnection` would reject (wrong signal kind, or same side
    // as the pick). The origin socket is marked so it stays lit. Cleared on
    // `connectiondrop`, which fires on every drag-end path (created, dropped
    // on empty canvas, or a declined existing-connection re-pick) — a drop
    // refused on a socket keeps click-to-connect mode alive, so the
    // highlight correctly persists there.
    let dragOriginEl: HTMLElement | null = null
    const clearDragHighlight = (): void => {
      container.removeAttribute('data-dp-drag-signal')
      container.removeAttribute('data-dp-drag-side')
      if (dragOriginEl) {
        dragOriginEl.removeAttribute('data-dp-drag-origin')
        dragOriginEl = null
      }
    }
    connection.addPipe((ctx) => {
      if (ctx.type === 'connectionpick') {
        const sd = ctx.data.socket
        const picked = resolveSocket(editor, sd)
        if (picked instanceof SignalSocket) {
          container.setAttribute('data-dp-drag-signal', picked.signal)
          container.setAttribute('data-dp-drag-side', sd.side)
          dragOriginEl = sd.element
          dragOriginEl.setAttribute('data-dp-drag-origin', '')
        }
      }
      if (ctx.type === 'connectiondrop') {
        clearDragHighlight()
      }
      return ctx
    })

    render.addPreset(
      ReactPresets.classic.setup({
        customize: {
          node: (context) => {
            const payload = context.payload as DaisyNode
            if (payload.kind === 'oled') {
              return OledNode as unknown as React.ComponentType<unknown>
            }
            if (payload.kind === 'menu') {
              return MenuNode as unknown as React.ComponentType<unknown>
            }
            if (payload.kind === 'encoder_in') {
              return EncoderNode as unknown as React.ComponentType<unknown>
            }
            if (payload.kind === 'code') {
              return CodeNode as unknown as React.ComponentType<unknown>
            }
            if (VISUAL_KINDS.has(payload.kind)) {
              return VisualNode as unknown as React.ComponentType<unknown>
            }
            return CustomNode as unknown as React.ComponentType<unknown>
          },
          connection: () => CustomConnection as unknown as React.ComponentType<unknown>,
          socket: () => CustomSocket as unknown as React.ComponentType<unknown>
        }
      })
    )

    editor.use(area)
    area.use(connection)
    area.use(render)

    const selector = AreaExtensions.selector()
    const accumulator = AreaExtensions.accumulateOnCtrl()
    const selectable = AreaExtensions.selectableNodes(area, selector, {
      accumulating: accumulator
    })
    selectorRef.current = selector
    selectableRef.current = selectable
    accumulatorRef.current = accumulator
    AreaExtensions.simpleNodesOrder(area)

    /* ----- transform-change plumbing for external consumers (minimap) ----- */
    const readTransform = (): AreaTransformSnapshot => {
      const t = area.area.transform
      const rect = container.getBoundingClientRect()
      return { x: t.x, y: t.y, k: t.k, containerW: rect.width, containerH: rect.height }
    }
    const emitTransform = (): void => {
      if (transformListenersRef.current.size === 0) return
      const snap = readTransform()
      for (const cb of transformListenersRef.current) {
        try {
          cb(snap)
        } catch {
          /* subscriber errors must not break the pipe */
        }
      }
    }
    const resizeObserver = new ResizeObserver(() => emitTransform())
    resizeObserver.observe(container)

    /* ----- background grid ----- */
    /*
     * Drawn in CSS from three custom properties rather than as canvas
     * elements: the grid then costs one repaint on pan instead of N DOM
     * nodes, and it can never end up in front of a cable. The offsets are
     * the area transform reduced modulo the pitch, so the pattern scrolls
     * with the content without the background box ever growing.
     */
    const applyGridVars = (): void => {
      const { gridShow, gridSize } = useEditorStore.getState().layout
      container.toggleAttribute('data-dp-grid', gridShow)
      if (!gridShow) return
      const t = area.area.transform
      const step = gridSize * t.k
      container.style.setProperty('--dp-grid-step', `${step}px`)
      container.style.setProperty('--dp-grid-x', `${t.x % step}px`)
      container.style.setProperty('--dp-grid-y', `${t.y % step}px`)
    }
    applyGridVars()

    /* ----- pan / marquee gesture split ----- */
    /*
     * Rete's default is left-drag-to-pan, which leaves no gesture for
     * rubber-band selection — the thing you reach for constantly once a
     * patch is past a handful of nodes. So left-drag on empty canvas draws a
     * selection rectangle and panning moves to middle-drag or space-drag,
     * both of which are the standard second gesture in every editor that
     * makes the same trade. `marqueeSelect` puts it back for anyone who
     * prefers the old behaviour.
     */
    let spaceHeld = false
    const onSpaceDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld = true
    }
    const onSpaceUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld = false
    }
    // `blur` catches the case where the window loses focus mid-hold and the
    // keyup is delivered to someone else, which would otherwise leave the
    // canvas permanently in pan mode.
    const onWindowBlur = () => {
      spaceHeld = false
    }
    window.addEventListener('keydown', onSpaceDown)
    window.addEventListener('keyup', onSpaceUp)
    window.addEventListener('blur', onWindowBlur)

    area.area.setDragHandler(
      new Drag({
        down: (e) => {
          // Middle button and space-drag always pan.
          if (e.button === 1 || spaceHeld) return true
          if (e.button !== 0) return false
          if (!useEditorStore.getState().layout.marqueeSelect) return true
          // Left-drag on background belongs to the marquee below.
          return !isBackgroundTarget(e.target, container, area.area.content.holder)
        },
        move: () => true
      })
    )

    /* ----- marquee ----- */
    const marquee = document.createElement('div')
    marquee.className = 'dp-marquee'
    marquee.hidden = true
    container.appendChild(marquee)

    let marqueeStart: { x: number; y: number; clientX: number; clientY: number } | null = null
    let marqueeMode: 'replace' | 'add' | 'toggle' = 'replace'
    let marqueeBase: string[] = []
    let marqueeFrame = 0

    /** Node bounds in canvas space, read from the live DOM once per drag. */
    const nodeBounds = (): { id: string; x: number; y: number; w: number; h: number }[] => {
      const out: { id: string; x: number; y: number; w: number; h: number }[] = []
      for (const [id, view] of area.nodeViews) {
        const el = view.element
        // offsetWidth is unscaled layout size, which is what we want: the
        // node's extent in canvas units is independent of zoom.
        out.push({
          id,
          x: view.position.x,
          y: view.position.y,
          w: el.offsetWidth,
          h: el.offsetHeight
        })
      }
      return out
    }

    const applyMarquee = (clientX: number, clientY: number): void => {
      if (!marqueeStart) return
      const rect = container.getBoundingClientRect()
      const x0 = Math.min(marqueeStart.clientX, clientX) - rect.left
      const y0 = Math.min(marqueeStart.clientY, clientY) - rect.top
      const x1 = Math.max(marqueeStart.clientX, clientX) - rect.left
      const y1 = Math.max(marqueeStart.clientY, clientY) - rect.top
      marquee.style.left = `${x0}px`
      marquee.style.top = `${y0}px`
      marquee.style.width = `${x1 - x0}px`
      marquee.style.height = `${y1 - y0}px`
      marquee.hidden = false

      const a = marqueeStart
      const b = clientToCanvas(container, area.area.transform, clientX, clientY)
      const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }
      const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }

      // Intersection, not containment: catching a node by clipping its
      // corner is the behaviour every editor has, and requiring full
      // enclosure makes selecting a row of wide nodes near-impossible.
      const hits = nodeBounds()
        .filter((n) => n.x < hi.x && n.x + n.w > lo.x && n.y < hi.y && n.y + n.h > lo.y)
        .map((n) => n.id)

      /*
       * Resolve to a FINAL set and publish once. Additive and toggle both
       * work from the selection as it was when the drag began, so sweeping
       * back over a node undoes it rather than flickering it on and off
       * frame by frame — and doing the arithmetic here rather than as two
       * `select()` calls means the store publishes one selection per frame
       * instead of two, so nothing ever renders the intermediate state.
       */
      let next: string[]
      if (marqueeMode === 'replace') {
        next = hits
      } else if (marqueeMode === 'add') {
        next = [...new Set([...marqueeBase, ...hits])]
      } else {
        const base = new Set(marqueeBase)
        for (const id of hits) {
          if (base.has(id)) base.delete(id)
          else base.add(id)
        }
        next = [...base]
      }
      useEditorStore.getState().select(next, 'replace')
    }

    const onMarqueeMove = (e: PointerEvent): void => {
      if (!marqueeStart) return
      e.preventDefault()
      if (marqueeFrame) cancelAnimationFrame(marqueeFrame)
      const { clientX, clientY } = e
      marqueeFrame = requestAnimationFrame(() => {
        marqueeFrame = 0
        applyMarquee(clientX, clientY)
      })
    }

    const endMarquee = (): void => {
      if (marqueeFrame) {
        cancelAnimationFrame(marqueeFrame)
        marqueeFrame = 0
      }
      marqueeStart = null
      marqueeBase = []
      marquee.hidden = true
      window.removeEventListener('pointermove', onMarqueeMove)
      window.removeEventListener('pointerup', endMarquee)
      window.removeEventListener('pointercancel', endMarquee)
    }

    const onContainerPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || spaceHeld) return
      if (!useEditorStore.getState().layout.marqueeSelect) return
      if (!isBackgroundTarget(e.target, container, area.area.content.holder)) return

      marqueeMode = e.shiftKey ? 'add' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace'
      marqueeBase = Array.from(useEditorStore.getState().selection)
      const world = clientToCanvas(container, area.area.transform, e.clientX, e.clientY)
      marqueeStart = { ...world, clientX: e.clientX, clientY: e.clientY }
      // A plain click clears; the existing `pointerdown` pipe would do this
      // too, but it runs for pan drags as well and we want the clear to be
      // this gesture's own.
      if (marqueeMode === 'replace') useEditorStore.getState().select(null)
      window.addEventListener('pointermove', onMarqueeMove)
      window.addEventListener('pointerup', endMarquee)
      window.addEventListener('pointercancel', endMarquee)
    }
    container.addEventListener('pointerdown', onContainerPointerDown)

    /* ----- pointer tracking for paste-here ----- */
    const onPointerTrack = (e: PointerEvent): void => {
      lastCanvasPointer = clientToCanvas(container, area.area.transform, e.clientX, e.clientY)
    }
    container.addEventListener('pointermove', onPointerTrack)

    /* ----- right-click ----- */
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      const target = e.target as HTMLElement | null
      let detailTarget: ContextTarget = { kind: 'canvas' }

      // Walk up for a node or connection element. Rete stamps neither, so
      // we match against the views it owns — cheap at these counts and it
      // survives any change to the renderers' markup.
      if (target) {
        for (const [id, view] of area.nodeViews) {
          if (view.element.contains(target)) {
            detailTarget = { kind: 'node', id }
            break
          }
        }
        if (detailTarget.kind === 'canvas') {
          for (const [id, view] of area.connectionViews) {
            if (view.element.contains(target)) {
              detailTarget = { kind: 'connection', id }
              break
            }
          }
        }
      }

      /*
       * Normalise the selection BEFORE opening the menu, not while building
       * it: the menu's item list is computed during render, and mutating the
       * store from there is how you get "cannot update a component while
       * rendering a different component". Right-clicking a node outside the
       * current selection selects it; right-clicking one inside leaves the
       * multi-selection alone so the menu can act on all of it.
       */
      if (detailTarget.kind === 'node' && !useEditorStore.getState().selection.has(detailTarget.id)) {
        useEditorStore.getState().select(detailTarget.id, 'replace')
      }

      window.dispatchEvent(
        new CustomEvent<ContextMenuDetail>(CANVAS_CONTEXT_MENU_EVENT, {
          detail: {
            x: e.clientX,
            y: e.clientY,
            target: detailTarget,
            world: clientToCanvas(container, area.area.transform, e.clientX, e.clientY)
          }
        })
      )
    }
    container.addEventListener('contextmenu', onContextMenu)

    /* ----- Rete -> store wiring ----- */

    // Track node translations. Also open/close the store transaction on
    // drag start (nodepicked) / drag end (nodedragged) so a single drag
    // gesture becomes a single undo step. Ctrl/cmd-click toggles multi-
    // select; plain click replaces selection.
    area.addPipe((ctx) => {
      if (syncingRef.current) return ctx

      /*
       * Snap. Rewriting `nodetranslate` (the cancellable event, before the
       * move is applied) rather than correcting afterwards means the node is
       * never drawn off-grid for a frame, and the store only ever sees
       * snapped coordinates — so a saved patch is snapped too.
       */
      if (ctx.type === 'nodetranslate') {
        const { gridSnap, gridSize } = useEditorStore.getState().layout
        if (gridSnap && gridSize > 0) {
          const { position } = ctx.data
          return {
            ...ctx,
            data: {
              ...ctx.data,
              position: {
                x: Math.round(position.x / gridSize) * gridSize,
                y: Math.round(position.y / gridSize) * gridSize
              }
            }
          }
        }
      }

      if (ctx.type === 'nodetranslated') {
        const { id, position, previous } = ctx.data
        const store = useEditorStore.getState()
        if (position.x !== previous.x || position.y !== previous.y) {
          dragMovedRef.current = true
        }
        store.moveNode(id, { x: position.x, y: position.y })

        // Followers just record their own move (see dragLeaderRef).
        if (id === dragLeaderRef.current) {
          const sel = store.selection
          if (sel.size > 1 && sel.has(id)) {
            const dx = position.x - previous.x
            const dy = position.y - previous.y
            if (dx !== 0 || dy !== 0) {
              for (const otherId of sel) {
                if (otherId === id) continue
                const n = store.graph.nodes.find((x) => x.id === otherId)
                if (!n) continue
                // area.translate is the single source of truth for on-screen
                // position; its echoed nodetranslated writes the store.
                void area.translate(otherId, {
                  x: n.position.x + dx,
                  y: n.position.y + dy
                })
              }
            }
          }
        }
      }

      if (ctx.type === 'nodepicked') {
        // Re-entry guard: `selectable.select()` calls from our
        // subscription also fire `nodepicked`; we must not round-trip.
        if (selectionApplyingRef.current) return ctx
        const id = ctx.data.id
        const accumulate = accumulatorRef.current?.active() ?? false
        const store = useEditorStore.getState()

        /*
         * Grabbing a node that is ALREADY selected keeps the selection.
         *
         * Replacing it unconditionally is what made marquee selection look
         * broken: select six nodes, drag one, and the plain `'replace'`
         * collapsed the set to that one before the first move event — so
         * the multi-drag fan-out below saw a selection of one and moved a
         * single node. Every editor behaves the way this now does: dragging
         * a member of a selection moves the whole selection, and a click
         * with no drag collapses to the one you clicked (handled on
         * `nodedragged`, since only then do we know it was a click).
         */
        if (accumulate) store.select(id, 'toggle')
        else if (!store.selection.has(id)) store.select(id, 'replace')

        pickWasInSelectionRef.current = !accumulate && store.selection.has(id)
        dragMovedRef.current = false
        // Open a transaction — any subsequent `nodetranslated` events
        // belong to this drag and should coalesce into one undo step.
        useEditorStore.getState().beginTransaction()
        dragOpenRef.current = true
        dragLeaderRef.current = id
      }

      if (ctx.type === 'nodedragged') {
        if (dragOpenRef.current) {
          useEditorStore.getState().endTransaction()
          dragOpenRef.current = false
        }
        // A click, not a drag: NOW collapse to the node that was clicked.
        // Deferring it to here is what lets the same gesture mean both
        // "move this whole selection" and "select just this one".
        if (pickWasInSelectionRef.current && !dragMovedRef.current && dragLeaderRef.current) {
          useEditorStore.getState().select(dragLeaderRef.current, 'replace')
        }
        pickWasInSelectionRef.current = false
        dragLeaderRef.current = null
      }

      if (ctx.type === 'translated' || ctx.type === 'zoomed') {
        emitTransform()
        applyGridVars()
      }

      if (ctx.type === 'pointerdown') {
        // Click on empty canvas clears the selection — but only when the
        // marquee is NOT the one handling this gesture, or the clear would
        // fight the shift-drag additive path above.
        if (!useEditorStore.getState().layout.marqueeSelect || spaceHeld) {
          if (isBackgroundTarget(ctx.data.event.target, container, area.area.content.holder)) {
            useEditorStore.getState().select(null)
          }
        }
      }

      return ctx
    })

    // Track connection creation / removal from the editor itself.
    editor.addPipe((ctx) => {
      if (syncingRef.current) return ctx

      if (ctx.type === 'connectioncreated') {
        const c = ctx.data
        const store = useEditorStore.getState()

        // Commit user-drawn connection into the store. The store owns ids, so
        // we always remove Rete's provisional instance and let the store->Rete
        // subscription re-add it with the canonical id. If the store rejects,
        // the removal still sticks — the editor visibly snaps back.
        const committed = store.connect(
          { nodeId: c.source, socketId: String(c.sourceOutput) },
          { nodeId: c.target, socketId: String(c.targetInput) }
        )

        if (!committed) {
          store.setStatus({ kind: 'warn', message: 'signal type mismatch' })
        }

        const provisionalId = c.id
        queueMicrotask(() => {
          if (disposed) return
          if (!editor.getConnection(provisionalId)) return
          syncingRef.current = true
          editor
            .removeConnection(provisionalId)
            .finally(() => {
              syncingRef.current = false
              // Ensure the Rete scene reflects the latest store state (which
              // now includes the committed connection under its canonical id).
              if (committed) {
                scheduleApply(useEditorStore.getState().graph, true)
              }
            })
        })
      }

      if (ctx.type === 'connectionremoved') {
        const c = ctx.data
        useEditorStore.getState().disconnect(c.id)
      }

      if (ctx.type === 'noderemoved') {
        useEditorStore.getState().removeNode(ctx.data.id)
      }

      return ctx
    })

    /*
     * Every store -> Rete apply goes through one queue.
     *
     * `applyStoreToRete` is async and was fired with `void` from three
     * places, so two could interleave: both would diff against the same
     * stale `lastGraphRef`, and — worse — the first one's `finally` would
     * clear `syncingRef` while the second was still mutating, letting the
     * editor's own events (noderemoved, connectionremoved) fall through to
     * the store as if the USER had made them. Opening a patch is exactly
     * the case that fires several graph changes back to back.
     */
    let applyQueue: Promise<void> = Promise.resolve()
    const scheduleApply = (graph: AudioGraph, remeasure = false, fit = false): void => {
      applyQueue = applyQueue
        .then(() => applyStoreToRete(graph, editor, area, syncingRef, lastGraphRef))
        .then(() => (remeasure ? remeasureSockets() : undefined))
        .then(() => (fit ? fitToContent() : undefined))
        .catch((err) => {
          // A failed apply must not poison the queue, or the canvas stops
          // tracking the store for the rest of the session.
          console.error('[ReteEditor] failed to apply graph', err)
          syncingRef.current = false
        })
    }

    /**
     * Re-render every node so Rete recomputes its socket positions.
     *
     * Cables are drawn from positions Rete measures off the socket DOM once,
     * when the socket renders. Any measurement taken while the canvas was
     * not laid out is wrong (or never taken at all), and nothing retries it
     * — the cable then hangs at a stale endpoint and ignores the node it is
     * attached to. Forcing a re-render is the supported way to ask for a
     * fresh measurement.
     *
     * Called on the two occasions a measurement could have been taken
     * badly: a bulk load, and returning to the Patch tab.
     */
    /**
     * Frame the whole patch in the viewport.
     *
     * Opening a file left the camera wherever it had been, so a patch
     * saved with its nodes at (-700, -500) opened as an empty-looking
     * canvas with the work off the top-left edge — the minimap showed it,
     * the viewport did not, and "the example is blank" was the read.
     * Only called on a LOAD; an ordinary edit must never move the camera.
     */
    const fitToContent = async (): Promise<void> => {
      const nodes = editor.getNodes()
      if (nodes.length === 0) return
      await AreaExtensions.zoomAt(area, nodes)
    }

    const remeasureSockets = async (): Promise<void> => {
      for (const id of [...area.nodeViews.keys()]) {
        await area.update('node', id)
      }
    }

    container.tabIndex = 0

    /* ----- initial paint + subscription ----- */
    scheduleApply(useEditorStore.getState().graph)

    const unsubscribe = useEditorStore.subscribe((s, prev) => {
      if (s.graph !== prev.graph) {
        /*
         * Treat a wholesale change of node identity as a load rather than
         * an edit, and remeasure after it. Adding one node from the palette
         * does not need it; opening a file replaces every node at once and
         * is exactly when a stale measurement slips through.
         */
        const ids = new Set(prev.graph.nodes.map((n) => n.id))
        const bulk = s.graph.nodes.filter((n) => !ids.has(n.id)).length > 1
        /*
         * A file open replaces the whole graph AND changes `filePath` in the
         * same set; a starter/example load replaces the whole graph from an
         * empty one. Both deserve a fresh camera. A paste of several nodes
         * is also `bulk` but keeps `filePath` and starts non-empty, and must
         * NOT recentre — you pasted where you were looking.
         */
        const isLoad = bulk && (s.filePath !== prev.filePath || prev.graph.nodes.length === 0)
        scheduleApply(s.graph, bulk, isLoad)
      }
      // Returning to the Patch tab: anything measured while it was hidden
      // is suspect, so measure again now that it is laid out.
      if (s.view === 'patch' && prev.view !== 'patch') {
        applyQueue = applyQueue.then(() => remeasureSockets()).catch(() => undefined)
      }
      // Grid pitch / visibility is a layout preference, so it changes
      // outside the transform pipe and needs its own trigger.
      if (s.layout !== prev.layout) {
        applyGridVars()
      }
      // Sync store selection into Rete's visual selector. Guarded by
      // `selectionApplyingRef` so the nodepicked events that `select()`
      // emits don't round-trip back into the store.
      if (s.selection !== prev.selection) {
        const desired = s.selection
        const current = selectorRef.current
        if (!current) return
        selectionApplyingRef.current = true
        try {
          // Unselect anything no longer in the desired set.
          for (const id of Array.from(current.entities.keys())) {
            const entity = current.entities.get(id)
            if (!entity) continue
            if (entity.label !== 'node') continue
            if (!desired.has(entity.id)) {
              void selectableRef.current?.unselect(entity.id)
            }
          }
          // Select anything new.
          for (const id of desired) {
            void selectableRef.current?.select(id, true)
          }
        } finally {
          selectionApplyingRef.current = false
        }
      }
    })

    /* ----- expose drop handler ----- */
    const handle: ReteEditorHandle = {
      onDropNode: (kind, clientX, clientY) => {
        const pos = clientToCanvas(container, area.area.transform, clientX, clientY)
        useEditorStore.getState().addNode(kind, pos)
      },
      subscribeTransform: (cb) => {
        transformListenersRef.current.add(cb)
        // Fire immediately so the caller gets the current transform on mount.
        try {
          cb(readTransform())
        } catch {
          /* ignore */
        }
        return () => {
          transformListenersRef.current.delete(cb)
        }
      },
      centerOn: (worldX, worldY) => {
        const rect = container.getBoundingClientRect()
        const k = area.area.transform.k
        // container -> world: world = (screen - t) / k, so for world to land
        // at center, translate = center - world * k.
        const tx = rect.width / 2 - worldX * k
        const ty = rect.height / 2 - worldY * k
        void area.area.translate(tx, ty)
      }
    }
    if (onReady) onReady(handle)
    currentHandleRef.current = handle

    /*
     * Zoom commands from the application menu. The store cannot answer
     * these — the viewport transform is Rete's, not the patch's — so the
     * menu bridge fires a window event and this is where it lands.
     */
    const onCanvasCommand = (ev: Event) => {
      const cmd = (ev as CustomEvent<CanvasCommand>).detail
      if (cmd === 'zoom_reset') {
        void area.area.zoom(1, 0, 0)
        return
      }
      if (cmd === 'zoom_fit') {
        const nodes = editor.getNodes()
        if (nodes.length === 0) {
          void area.area.zoom(1, 0, 0)
          void area.area.translate(0, 0)
          return
        }
        void AreaExtensions.zoomAt(area, nodes)
      }
    }
    window.addEventListener(CANVAS_COMMAND_EVENT, onCanvasCommand)

    return () => {
      disposed = true
      window.removeEventListener(CANVAS_COMMAND_EVENT, onCanvasCommand)
      // Close a dangling drag transaction (shouldn't happen in practice,
      // but prevents a leaked history slot if teardown races a drag).
      if (dragOpenRef.current) {
        useEditorStore.getState().endTransaction()
        dragOpenRef.current = false
      }
      unsubscribe()
      resizeObserver.disconnect()
      clearDragHighlight()
      endMarquee()
      marquee.remove()
      container.removeEventListener('pointerdown', onContainerPointerDown)
      container.removeEventListener('pointermove', onPointerTrack)
      container.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onSpaceDown)
      window.removeEventListener('keyup', onSpaceUp)
      window.removeEventListener('blur', onWindowBlur)
      lastCanvasPointer = null
      transformListenersRef.current.clear()
      accumulatorRef.current?.destroy()
      area.destroy()
      editorRef.current = null
      areaRef.current = null
      selectorRef.current = null
      selectableRef.current = null
      accumulatorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ----- imperative handle ----- */
  const currentHandleRef = useRef<ReteEditorHandle | null>(null)
  useImperativeHandle(
    ref,
    (): ReteEditorHandle => ({
      onDropNode: (kind, x, y) => currentHandleRef.current?.onDropNode(kind, x, y),
      subscribeTransform: (cb) =>
        currentHandleRef.current?.subscribeTransform(cb) ?? (() => undefined),
      centerOn: (x, y) => currentHandleRef.current?.centerOn(x, y)
    }),
    []
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  return <div ref={containerRef} className="dp-rete-root" onDragOver={onDragOver} />
})

/* ---------- store -> rete apply ---------- */

/**
 * Apply a graph snapshot to the Rete scene by diffing against the last
 * snapshot. Sets `syncingRef` while mutating so the editor's own pipes don't
 * re-emit back into the store.
 */
async function applyStoreToRete(
  graph: AudioGraph,
  editor: NodeEditor<Schemes>,
  area: AreaPlugin<Schemes, AreaExtra>,
  syncingRef: React.MutableRefObject<boolean>,
  lastGraphRef: React.MutableRefObject<AudioGraph | null>
): Promise<void> {
  const diff = diffGraph(lastGraphRef.current, graph)
  syncingRef.current = true
  try {
    // Remove connections first so deleted nodes' connections don't dangle.
    for (const c of diff.connections.removed) {
      if (editor.getConnection(c.id)) {
        await editor.removeConnection(c.id)
      }
    }
    for (const n of diff.nodes.removed) {
      if (editor.getNode(n.id)) {
        await editor.removeNode(n.id)
      }
    }
    for (const n of diff.nodes.added) {
      if (editor.getNode(n.id)) continue
      const rn = createNode(n.kind as NodeKind, n.id)
      await editor.addNode(rn)
      await area.translate(n.id, { x: n.position.x, y: n.position.y })
    }
    for (const { prev, next } of diff.nodes.modified) {
      if (prev.position.x !== next.position.x || prev.position.y !== next.position.y) {
        await area.translate(next.id, { x: next.position.x, y: next.position.y })
      }
    }
    for (const c of diff.connections.added) {
      if (editor.getConnection(c.id)) continue
      const source = editor.getNode(c.from.nodeId)
      const target = editor.getNode(c.to.nodeId)
      if (!source || !target) continue

      const output = source.outputs[c.from.socketId]
      const input = target.inputs[c.to.socketId]
      if (!output || !input) continue
      if (!canConnectSockets(output.socket, input.socket)) continue

      const classicConn: DaisyConnection = Object.assign(
        new ClassicPreset.Connection(source, c.from.socketId, target, c.to.socketId),
        { id: c.id, signal: signalOfSocket(output.socket) }
      )
      await editor.addConnection(classicConn)
    }
    lastGraphRef.current = graph
  } finally {
    syncingRef.current = false
  }
}

export default ReteEditor
