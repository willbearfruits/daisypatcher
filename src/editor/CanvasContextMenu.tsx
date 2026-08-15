/**
 * Right-click menu for the patch canvas.
 *
 * Lives outside the Rete tree and is driven by a DOM CustomEvent, for the
 * same reason the command palette is: Rete mounts each node in its own
 * `createRoot`, so a menu rendered from inside a node could not be portaled
 * above its siblings or share the app's React context. The editor detects
 * the `contextmenu`, works out what is under the pointer, and dispatches;
 * this component owns everything else.
 *
 * Three targets, three menus:
 *   - node       — acts on the selection when the clicked node is part of it,
 *                  so right-clicking one of six selected nodes and choosing
 *                  Delete removes six, which is what the gesture implies.
 *   - connection — cut the cable.
 *   - canvas     — paste, select all, and the grid toggles.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@/state/store'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import styles from './CanvasContextMenu.module.css'

export const CANVAS_CONTEXT_MENU_EVENT = 'dp-canvas-context-menu'

export type ContextTarget =
  | { kind: 'node'; id: string }
  | { kind: 'connection'; id: string }
  | { kind: 'canvas' }

export interface ContextMenuDetail {
  /** Viewport coordinates of the click. */
  x: number
  y: number
  target: ContextTarget
  /** Canvas-space position of the click, for paste-here. */
  world: { x: number; y: number }
}

interface Item {
  id: string
  label: string
  hint?: string
  disabled?: boolean
  danger?: boolean
  /** Renders as a checkable row. */
  checked?: boolean
  run: () => void
}

/** Menu width + margin used to keep the panel inside the viewport. */
const MENU_W = 208
const MENU_MIN_H = 120

export function CanvasContextMenu() {
  const [detail, setDetail] = useState<ContextMenuDetail | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<ContextMenuDetail>).detail
      if (d) setDetail(d)
    }
    window.addEventListener(CANVAS_CONTEXT_MENU_EVENT, onOpen)
    return () => window.removeEventListener(CANVAS_CONTEXT_MENU_EVENT, onOpen)
  }, [])

  const close = useCallback(() => setDetail(null), [])

  // Dismiss on anything that is not a click inside the menu. `pointerdown`
  // rather than `click` so the menu is gone before the underlying canvas
  // starts a drag.
  useEffect(() => {
    if (!detail) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [detail, close])

  if (!detail) return null

  const items = buildItems(detail, close)
  if (items.length === 0) return null

  // Flip the panel back inside the viewport rather than letting it clip.
  const x = Math.min(detail.x, window.innerWidth - MENU_W - 8)
  const y = Math.min(detail.y, Math.max(8, window.innerHeight - MENU_MIN_H - 8))

  return (
    <div
      ref={rootRef}
      className={styles.menu}
      style={{ left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px`, width: `${MENU_W}px` }}
      role="menu"
    >
      {items.map((item) =>
        item.id.startsWith('sep') ? (
          <div key={item.id} className={styles.sep} role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`${styles.item} ${item.danger ? styles.danger : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.run()
              close()
            }}
          >
            <span className={styles.check} aria-hidden>
              {item.checked ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M2.5 6.5L4.8 8.8L9.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </span>
            <span className={styles.label}>{item.label}</span>
            {item.hint ? <kbd className={styles.hint}>{item.hint}</kbd> : null}
          </button>
        )
      )}
    </div>
  )
}

const MOD = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'

function buildItems(detail: ContextMenuDetail, close: () => void): Item[] {
  const s = useEditorStore.getState()

  if (detail.target.kind === 'connection') {
    const id = detail.target.id
    return [
      {
        id: 'disconnect',
        label: 'Disconnect',
        hint: 'Del',
        danger: true,
        run: () => s.disconnect(id)
      }
    ]
  }

  if (detail.target.kind === 'node') {
    const id = detail.target.id
    /*
     * Right-clicking a node that is already part of a multi-selection acts
     * on the whole selection; right-clicking outside it selects that node
     * first — the editor does that normalisation when it dispatches, so by
     * the time we get here the selection already reflects the click.
     * Anything else makes "Delete" ambiguous at the moment the user is
     * least able to check what it will hit.
     */
    const targets = s.selection.has(id) ? Array.from(s.selection) : [id]
    const n = targets.length
    const plural = n > 1 ? ` (${n})` : ''
    const node = s.graph.nodes.find((x) => x.id === id)
    const anyExpanded = s.graph.nodes.some((x) => targets.includes(x.id) && !x.collapsed)

    return [
      {
        id: 'copy',
        label: `Copy${plural}`,
        hint: `${MOD}+C`,
        run: () => s.copySelection()
      },
      {
        id: 'cut',
        label: `Cut${plural}`,
        hint: `${MOD}+X`,
        run: () => s.cutSelection()
      },
      {
        id: 'duplicate',
        label: `Duplicate${plural}`,
        run: () => {
          s.copySelection()
          s.paste()
        }
      },
      { id: 'sep1', label: '', run: () => undefined },
      {
        id: 'collapse',
        label: anyExpanded ? `Collapse${plural}` : `Expand${plural}`,
        hint: `${MOD}+.`,
        run: () => s.setCollapsed(targets, anyExpanded)
      },
      {
        id: 'disconnect-all',
        label: 'Disconnect cables',
        disabled: !s.graph.connections.some(
          (c) => targets.includes(c.from.nodeId) || targets.includes(c.to.nodeId)
        ),
        run: () => {
          s.beginTransaction()
          for (const c of s.graph.connections) {
            if (targets.includes(c.from.nodeId) || targets.includes(c.to.nodeId)) {
              s.disconnect(c.id)
            }
          }
          s.endTransaction()
        }
      },
      { id: 'sep2', label: '', run: () => undefined },
      /*
       * Nesting. The single-node case offers enter/expand; a multi-node
       * selection offers collapse. Both live here because the selection is
       * the subject of the gesture and this is the menu about it.
       */
      ...(n === 1 && (node?.kind === 'subpatch' || node?.kind === 'poly')
        ? [
            {
              id: 'enter',
              label: node.kind === 'poly' ? 'Edit voice' : 'Enter subpatch',
              hint: 'Dbl-click',
              run: () => s.enterSubpatch(id)
            },
            ...(node.kind === 'subpatch'
              ? [
                  {
                    id: 'expand',
                    label: 'Expand into this patch',
                    run: () => s.expandSubpatchNode(id)
                  }
                ]
              : [])
          ]
        : [
            {
              id: 'collapse',
              label: `Collapse into subpatch${plural}`,
              hint: `${MOD}+G`,
              run: () => s.collapseSelectionToSubpatch()
            }
          ]),
      { id: 'sep2b', label: '', run: () => undefined },
      {
        id: 'delete',
        label: `Delete${plural}`,
        hint: 'Del',
        danger: true,
        run: () => s.deleteSelection()
      },
      ...(node && NODE_DEFINITIONS[node.kind]
        ? [
            { id: 'sep3', label: '', run: () => undefined },
            {
              id: 'info',
              label: NODE_DEFINITIONS[node.kind].label,
              disabled: true,
              run: () => undefined
            }
          ]
        : [])
    ]
  }

  // Canvas.
  const layout = s.layout
  return [
    {
      id: 'paste',
      label: 'Paste here',
      hint: `${MOD}+V`,
      disabled: s.clipboard === null,
      run: () => s.paste(detail.world)
    },
    {
      id: 'select-all',
      label: 'Select all',
      hint: `${MOD}+A`,
      disabled: s.graph.nodes.length === 0,
      run: () => s.selectAll()
    },
    { id: 'sep1', label: '', run: () => undefined },
    {
      id: 'grid',
      label: 'Show grid',
      checked: layout.gridShow,
      run: () => s.setCanvasPrefs({ gridShow: !layout.gridShow })
    },
    {
      id: 'snap',
      label: 'Snap to grid',
      checked: layout.gridSnap,
      run: () => s.setCanvasPrefs({ gridSnap: !layout.gridSnap })
    },
    {
      id: 'marquee',
      label: 'Drag selects',
      checked: layout.marqueeSelect,
      run: () => s.setCanvasPrefs({ marqueeSelect: !layout.marqueeSelect })
    },
    { id: 'sep2', label: '', run: () => undefined },
    {
      id: 'close',
      label: 'Close menu',
      hint: 'Esc',
      run: close
    }
  ]
}
