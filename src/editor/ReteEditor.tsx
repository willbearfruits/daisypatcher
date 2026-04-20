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
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin'
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
import { diffGraph } from './sync'

/** Node kinds whose Rete body is rendered by `VisualNode` instead of `CustomNode`. */
const VISUAL_KINDS: Set<NodeKind> = new Set<NodeKind>(['scope', 'vu', 'spectrum_scope'])

import './style.css'

/* ---------- schema ---------- */

type DaisyConnection = ClassicPreset.Connection<DaisyNode, DaisyNode> & SignalConnectionData
type Schemes = GetSchemes<DaisyNode, DaisyConnection>
type AreaExtra = ReactArea2D<Schemes>

/* ---------- public API ---------- */

export interface ReteEditorHandle {
  /** Convert a palette drop at (clientX, clientY) into an `addNode` call. */
  onDropNode: (kind: NodeKind, clientX: number, clientY: number) => void
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
              return false
            }
            return true
          }
        })
    )

    render.addPreset(
      ReactPresets.classic.setup({
        customize: {
          node: (context) => {
            const payload = context.payload as DaisyNode
            if (payload.kind === 'oled') {
              return OledNode as unknown as React.ComponentType<unknown>
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

    /* ----- Rete -> store wiring ----- */

    // Track node translations. Also open/close the store transaction on
    // drag start (nodepicked) / drag end (nodedragged) so a single drag
    // gesture becomes a single undo step. Ctrl/cmd-click toggles multi-
    // select; plain click replaces selection.
    area.addPipe((ctx) => {
      if (syncingRef.current) return ctx

      if (ctx.type === 'nodetranslated') {
        const { id, position } = ctx.data
        useEditorStore
          .getState()
          .moveNode(id, { x: position.x, y: position.y })
      }

      if (ctx.type === 'nodepicked') {
        // Re-entry guard: `selectable.select()` calls from our
        // subscription also fire `nodepicked`; we must not round-trip.
        if (selectionApplyingRef.current) return ctx
        const id = ctx.data.id
        const accumulate = accumulatorRef.current?.active() ?? false
        useEditorStore
          .getState()
          .select(id, accumulate ? 'toggle' : 'replace')
        // Open a transaction — any subsequent `nodetranslated` events
        // belong to this drag and should coalesce into one undo step.
        useEditorStore.getState().beginTransaction()
        dragOpenRef.current = true
      }

      if (ctx.type === 'nodedragged') {
        if (dragOpenRef.current) {
          useEditorStore.getState().endTransaction()
          dragOpenRef.current = false
        }
      }

      if (ctx.type === 'pointerdown') {
        // Click on empty canvas (no node / connection under the pointer).
        // We detect this by checking whether the target is the container
        // itself or its immediate content holder — both are "background".
        const target = ctx.data.event.target as HTMLElement | null
        const isBackground =
          !!target &&
          (target === container ||
            target === area.area.content.holder ||
            target.classList?.contains('dp-rete-root'))
        if (isBackground) {
          useEditorStore.getState().select(null)
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
                void applyStoreToRete(
                  useEditorStore.getState().graph,
                  editor,
                  area,
                  syncingRef,
                  lastGraphRef
                )
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

    container.tabIndex = 0

    /* ----- initial paint + subscription ----- */
    void applyStoreToRete(useEditorStore.getState().graph, editor, area, syncingRef, lastGraphRef)

    const unsubscribe = useEditorStore.subscribe((s, prev) => {
      if (s.graph !== prev.graph) {
        void applyStoreToRete(s.graph, editor, area, syncingRef, lastGraphRef)
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
      }
    }
    if (onReady) onReady(handle)
    currentHandleRef.current = handle

    return () => {
      disposed = true
      // Close a dangling drag transaction (shouldn't happen in practice,
      // but prevents a leaked history slot if teardown races a drag).
      if (dragOpenRef.current) {
        useEditorStore.getState().endTransaction()
        dragOpenRef.current = false
      }
      unsubscribe()
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
      onDropNode: (kind, x, y) => currentHandleRef.current?.onDropNode(kind, x, y)
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
