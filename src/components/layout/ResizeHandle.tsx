/**
 * ResizeHandle — a thin, invisible-until-hover bar the user drags to resize
 * the adjacent shell panel.
 *
 * The handle is placed by its parent (after the palette, before the inspector,
 * above the build log, etc.) and fires `onResize(delta)` with the pixel delta
 * since the previous pointermove. Callers translate that delta into a store
 * setter — clamping lives in the store so every consumer benefits.
 *
 * While dragging:
 *   - We capture the pointer on the handle element so we keep receiving
 *     `pointermove` / `pointerup` even if the cursor leaves the bar.
 *   - `document.body`'s cursor is swapped for the whole gesture — otherwise
 *     the cursor flickers to the hover shape on each element crossed.
 *   - `user-select: none` is applied to body so text selection can't race
 *     with the drag.
 *
 * Double-click resets the panel to its default via the optional `onReset`
 * prop — the store's setters re-clamp, so callers pass the default literal.
 *
 * Pure pointer events, no deps. Must sit at the shell level (not inside the
 * Rete canvas) so it never competes with Rete's own drag pipeline.
 */

import * as React from 'react'
import styles from './ResizeHandle.module.css'

export interface ResizeHandleProps {
  /** 'vertical' = a vertical bar you drag left/right. 'horizontal' = a bar you drag up/down. */
  orientation: 'vertical' | 'horizontal'
  /** Called on every pointermove with the delta since the last callback. */
  onResize: (delta: number) => void
  /** Double-click handler — typically resets the target panel to default. */
  onReset?: () => void
  /** Accessible label for screen readers. */
  ariaLabel?: string
}

export function ResizeHandle(props: ResizeHandleProps): React.JSX.Element {
  const { orientation, onResize, onReset, ariaLabel } = props
  const ref = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef<{ lastX: number; lastY: number; pointerId: number } | null>(null)
  const [dragging, setDragging] = React.useState(false)

  const onPointerDown = React.useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      // Only react to primary button / single-touch gestures.
      if (ev.button !== 0) return
      const el = ref.current
      if (!el) return
      ev.preventDefault()
      // Capture so the drag survives moving off the 4px handle.
      try {
        el.setPointerCapture(ev.pointerId)
      } catch {
        // Safari sometimes throws if the element hasn't hit-tested yet — harmless.
      }
      dragRef.current = {
        lastX: ev.clientX,
        lastY: ev.clientY,
        pointerId: ev.pointerId
      }
      setDragging(true)
      // Apply cursor + selection lock to body for the whole gesture. Saved
      // so we can restore exactly what was there before (don't assume '').
      const body = document.body
      body.dataset.dpResizePrevCursor = body.style.cursor || ''
      body.dataset.dpResizePrevUserSelect = body.style.userSelect || ''
      body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
      body.style.userSelect = 'none'
    },
    [orientation]
  )

  const onPointerMove = React.useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      const state = dragRef.current
      if (!state) return
      if (ev.pointerId !== state.pointerId) return
      if (orientation === 'vertical') {
        const dx = ev.clientX - state.lastX
        state.lastX = ev.clientX
        if (dx !== 0) onResize(dx)
      } else {
        const dy = ev.clientY - state.lastY
        state.lastY = ev.clientY
        if (dy !== 0) onResize(dy)
      }
    },
    [onResize, orientation]
  )

  const endDrag = React.useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    const state = dragRef.current
    if (!state) return
    if (ev.pointerId !== state.pointerId) return
    const el = ref.current
    if (el) {
      try {
        el.releasePointerCapture(state.pointerId)
      } catch {
        // already released — ignore
      }
    }
    dragRef.current = null
    setDragging(false)
    // Restore body styles to whatever they were before we locked them.
    const body = document.body
    body.style.cursor = body.dataset.dpResizePrevCursor ?? ''
    body.style.userSelect = body.dataset.dpResizePrevUserSelect ?? ''
    delete body.dataset.dpResizePrevCursor
    delete body.dataset.dpResizePrevUserSelect
  }, [])

  // Tear-down guard for the body-cursor lock if the component unmounts
  // mid-drag. Restore only if we're the ones who set it.
  React.useEffect(() => {
    return () => {
      const body = document.body
      if (body.dataset.dpResizePrevCursor !== undefined) {
        body.style.cursor = body.dataset.dpResizePrevCursor ?? ''
        delete body.dataset.dpResizePrevCursor
      }
      if (body.dataset.dpResizePrevUserSelect !== undefined) {
        body.style.userSelect = body.dataset.dpResizePrevUserSelect ?? ''
        delete body.dataset.dpResizePrevUserSelect
      }
    }
  }, [])

  const onDoubleClick = React.useCallback(() => {
    onReset?.()
  }, [onReset])

  const className = [
    styles.handle,
    orientation === 'vertical' ? styles.vertical : styles.horizontal,
    dragging ? styles.dragging : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={ref}
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={className}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      <span className={styles.line} aria-hidden />
    </div>
  )
}

export default ResizeHandle
