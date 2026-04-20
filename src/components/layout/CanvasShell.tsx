/**
 * CanvasShell — the main canvas surface. For Phase 1 it's just a styled
 * drop-target with an empty state. The Rete.js editor will mount into
 * `children` later and will translate `clientX/Y` to canvas coordinates.
 */

import { useCallback, useState, Children } from 'react'
import type { ReactNode } from 'react'
import type { NodeKind } from '@/types/graph'
import { NODE_DRAG_MIME } from './Palette'
import styles from './CanvasShell.module.css'

interface CanvasShellProps {
  children?: ReactNode
  onDropNode?: (kind: NodeKind, clientX: number, clientY: number) => void
}

export function CanvasShell({ children, onDropNode }: CanvasShellProps) {
  const [isDragOver, setDragOver] = useState(false)

  const hasChildren = Children.count(children) > 0

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // accept only our payload
    if (e.dataTransfer.types.includes(NODE_DRAG_MIME)) {
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
      if (!kind) return
      onDropNode?.(kind, e.clientX, e.clientY)
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
      {hasChildren ? (
        <div className={styles.children}>{children}</div>
      ) : (
        <div className={styles.empty}>
          <div className={styles.crosshair} aria-hidden />
          <span className={styles.emptyText}>drop a node to begin</span>
        </div>
      )}
    </div>
  )
}
