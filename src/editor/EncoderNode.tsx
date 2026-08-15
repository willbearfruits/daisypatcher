/**
 * Encoder node body — a usable encoder in the emulator.
 *
 * A rotary encoder is a gesture device, and driving one from a slider in
 * the side inspector loses everything that matters about it: detents, and
 * the difference between a click, a hold and a double-click.
 *
 * So this body gives it the real gestures:
 *   - scroll wheel over the dial, or the two arrow buttons, step a detent
 *   - drag the dial vertically for a fast sweep
 *   - the PRESS button reports pointer DOWN and UP separately
 *
 * That last point is what makes long-press and double-click work without
 * any special handling here: the switch param follows the real press
 * duration, and the menu runtime's click classifier — the same one the
 * firmware uses — turns it into click / long / double. Holding the button
 * really is a long press.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme, RenderEmit } from 'rete-react-plugin'

import { DaisyNode } from './nodes/base'
import type { SignalSocket } from './sockets'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { useEditorStore } from '@/state/store'
import { CollapseButton, useHeaderDoubleClick } from './CustomNode'
import styles from './EncoderNode.module.css'

const { RefSocket } = Presets.classic

type Props<S extends ClassicScheme> = {
  data: S['Node']
  emit: RenderEmit<S>
}

/** Pixels of vertical drag per detent. */
const DRAG_PX_PER_DETENT = 8

const stopDrag = (e: React.PointerEvent): void => e.stopPropagation()

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function EncoderNode<S extends ClassicScheme>(props: Props<S>): React.JSX.Element {
  const { data, emit } = props
  const selected = data.selected ?? false
  const isDaisy = data instanceof DaisyNode
  const kind = isDaisy ? data.kind : undefined
  const def = kind ? NODE_DEFINITIONS[kind] : undefined

  const outputs = Object.entries(data.outputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]

  const collapsed = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return n?.collapsed === true
  })
  const onHeaderDoubleClick = useHeaderDoubleClick(data.id)
  const setParam = useEditorStore((s) => s.setParam)

  // Primitive selector — see the Zustand note in CLAUDE.md.
  const value = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return num(n?.params.value, 0.5)
  })
  const step = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return num(n?.params.step, 0.02)
  })
  const wrap = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return String(n?.params.wrap ?? 'clamp')
  })
  const pressed = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return num(n?.params.sw_value, 0) >= 0.5
  })

  const turn = React.useCallback(
    (detents: number) => {
      if (detents === 0) return
      let v = value + detents * step
      if (wrap === 'wrap') v = v - Math.floor(v)
      else v = v < 0 ? 0 : v > 1 ? 1 : v
      setParam(data.id, 'value', v)
    },
    [data.id, setParam, step, value, wrap]
  )

  /* ---- wheel + drag on the dial ---- */
  const dragRef = React.useRef<{ id: number; lastY: number; acc: number } | null>(null)

  const onWheel = React.useCallback(
    (e: React.WheelEvent) => {
      e.stopPropagation()
      turn(e.deltaY < 0 ? 1 : -1)
    },
    [turn]
  )

  const onDialDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    dragRef.current = { id: e.pointerId, lastY: e.clientY, acc: 0 }
  }
  const onDialMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.id) return
    e.stopPropagation()
    d.acc += d.lastY - e.clientY
    d.lastY = e.clientY
    while (Math.abs(d.acc) >= DRAG_PX_PER_DETENT) {
      const dir = d.acc > 0 ? 1 : -1
      turn(dir)
      d.acc -= dir * DRAG_PX_PER_DETENT
    }
  }
  const onDialUp = (e: React.PointerEvent): void => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
  }

  /* ---- switch: down/up mirror the real press ---- */
  const press = (down: boolean) => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setParam(data.id, 'sw_value', down ? 1 : 0)
  }

  const angle = -140 + Math.max(0, Math.min(1, value)) * 280

  if (collapsed) {
    return (
      <div className={`${styles.node} ${selected ? styles.selected : ''} ${styles.collapsed}`} data-testid="node">
        <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
          <CollapseButton nodeId={data.id} collapsed />
          <span className={styles.title}>{def?.label ?? 'Encoder'}</span>
        </div>
        <div className={styles.collapsedSockets}>
          {outputs.map(([key, output]) =>
            output ? (
              <div className={styles.collapsedOut} key={key}>
                <RefSocket name="output-socket" side="output" emit={emit} socketKey={key} nodeId={data.id} payload={output.socket} />
              </div>
            ) : null
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`${styles.node} ${selected ? styles.selected : ''}`} data-testid="node">
      <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
        <CollapseButton nodeId={data.id} collapsed={false} />
        <span className={styles.title}>{def?.label ?? 'Encoder'}</span>
      </div>

      <div className={styles.body}>
        <div className={styles.dialRow} onPointerDown={stopDrag}>
          <div
            className={styles.dial}
            onWheel={onWheel}
            onPointerDown={onDialDown}
            onPointerMove={onDialMove}
            onPointerUp={onDialUp}
            onPointerCancel={onDialUp}
            title="Scroll or drag to turn"
          >
            <div className={styles.dialFace}>
              <div className={styles.dialMark} style={{ transform: `rotate(${angle}deg)` }} />
            </div>
          </div>
          <div className={styles.readout}>
            <span className={styles.value}>{value.toFixed(3)}</span>
            <span className={styles.hint}>scroll / drag</span>
          </div>
        </div>

        <div className={styles.controls} onPointerDown={stopDrag}>
          <button type="button" className={styles.turnBtn} onClick={() => turn(-1)} title="Anticlockwise one detent">↺</button>
          <button
            type="button"
            className={`${styles.pressBtn} ${pressed ? styles.pressBtnDown : ''}`}
            onPointerDown={press(true)}
            onPointerUp={press(false)}
            onPointerLeave={(e) => { if (pressed) press(false)(e) }}
            title="Press and hold for a long press; two quick presses for a double click"
          >
            {pressed ? 'HELD' : 'PRESS'}
          </button>
          <button type="button" className={styles.turnBtn} onClick={() => turn(1)} title="Clockwise one detent">↻</button>
        </div>

        <div className={styles.sockets}>
          {outputs.map(([key, output]) =>
            output ? (
              <div className={styles.socketRow} key={key}>
                <span className={styles.socketLabel}>{output.label ?? key}</span>
                <RefSocket name="output-socket" side="output" emit={emit} socketKey={key} nodeId={data.id} payload={output.socket} />
              </div>
            ) : null
          )}
        </div>
      </div>
    </div>
  )
}
