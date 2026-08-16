/**
 * CanvasShell — the main canvas surface. Hosts the Rete.js editor via
 * `children` (mounted by App at all times), accepts palette drag-drops,
 * and overlays a first-run empty state — crosshair, hints, and a
 * "load a starter patch" action — whenever the patch has zero nodes.
 */

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import type { NodeKind } from '@/types/graph'
import { useEditorStore } from '@/state/store'
import { loadStarterPatch } from '@/state/starterPatch'
import { openPatchFromPath } from '@/state/patchFile'
import { requestConfirm } from './ConfirmDialog'
import { openAppModal } from './AppModals'
import { NODE_DRAG_MIME } from './Palette'
import styles from './CanvasShell.module.css'

interface CanvasShellProps {
  children?: ReactNode
  onDropNode?: (kind: NodeKind, clientX: number, clientY: number) => void
}

export function CanvasShell({ children, onDropNode }: CanvasShellProps) {
  const [isDragOver, setDragOver] = useState(false)

  // Select the stable nodes array and derive emptiness from it (never
  // compute fresh objects inside a selector — see CLAUDE.md). Overlay
  // flash during `.dpatch` loads isn't a concern: openPatch swaps the
  // graph atomically via loadGraph, so the store never passes through a
  // zero-node state mid-load. The CSS fade-in delay guards the rest.
  const nodes = useEditorStore((s) => s.graph.nodes)
  const isEmpty = nodes.length === 0

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Our own node payload, or a file from the OS (a .dpatch to open).
    if (e.dataTransfer.types.includes(NODE_DRAG_MIME) || e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    }
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // only clear when leaving the shell, not when crossing children
    if (e.currentTarget === e.target) setDragOver(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      const kind = e.dataTransfer.getData(NODE_DRAG_MIME) as NodeKind | ''
      if (kind) {
        onDropNode?.(kind, e.clientX, e.clientY)
        return
      }
      /*
       * A file from the OS. Only .dpatch is meaningful here — the preload
       * helper returns null for anything else, and main grants the path
       * on the same terms as a dialog pick, so this widens nothing. Same
       * "discard unsaved changes?" as Open…, because dropping a file onto
       * work you meant to keep is exactly the accident to guard.
       */
      const file = e.dataTransfer.files?.[0]
      if (!file) return
      const w = window as unknown as {
        daisy?: { pathForDroppedPatch?: (f: File) => Promise<string | null> }
      }
      void (async () => {
        const path = await w.daisy?.pathForDroppedPatch?.(file)
        if (!path) {
          useEditorStore.getState().setStatus({ kind: 'warn', message: `not a .dpatch: ${file.name}` })
          return
        }
        const st = useEditorStore.getState()
        if (st.isDirty || st.history.past.length > 0) {
          const ok = await requestConfirm({
            title: 'Open patch',
            message: 'Discard unsaved changes?',
            confirmLabel: 'Discard',
            danger: true
          })
          if (!ok) return
        }
        await openPatchFromPath(path)
      })()
    },
    [onDropNode]
  )

  return (
    <div
      className={`${styles.root} ${isDragOver ? styles.dropActive : ''}`}
      data-dp-canvas="true"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className={styles.overlay} aria-hidden />
      <div className={styles.children}>{children}</div>
      {isEmpty ? (
        // pointer-events: none except the button — Rete panning and
        // palette drag-drop pass straight through the overlay.
        <div className={styles.empty}>
          <div className={styles.crosshair} aria-hidden />
          <span className={styles.emptyText}>drag a node from the palette</span>
          <span className={styles.emptyKeys}>
            or <kbd>cmd/ctrl+k</kbd> for the command palette
          </span>
          <button
            type="button"
            className={styles.starterButton}
            onClick={() => loadStarterPatch()}
          >
            load a starter patch
          </button>
          <button
            type="button"
            className={styles.starterButton}
            onClick={() => openAppModal('examples')}
          >
            open an example
          </button>
        </div>
      ) : null}
    </div>
  )
}
