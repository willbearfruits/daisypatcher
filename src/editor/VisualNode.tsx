/**
 * Visual Rete node renderer — scope, VU, spectrum. Shares the Signal Lab
 * node-shell look with `CustomNode` but replaces the body with a live
 * `<canvas>` painted from frames delivered by `AudioEngine.tap()`.
 *
 * Rules:
 *   - Tap is created on mount and torn down on unmount.
 *   - Rendering runs entirely off the tap's rAF callback — no extra loops.
 *   - All colors come from `--dp-*` CSS variables, read via
 *     `getComputedStyle()` on mount (re-read if the theme changes).
 *   - devicePixelRatio scaling keeps the trace crisp on HiDPI displays.
 *   - Degrades gracefully: no engine -> empty meter / flat line.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme, RenderEmit } from 'rete-react-plugin'

import { DaisyNode } from './nodes/base'
import type { SignalSocket } from './sockets'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import { useEditorStore } from '@/state/store'
import type { NodeKind } from '@/types/graph'
import type { ScopeFrame } from '@/types/store'
import { CollapseButton, useHeaderDoubleClick } from './CustomNode'
import styles from './VisualNode.module.css'

const { RefSocket } = Presets.classic

type Props<S extends ClassicScheme> = {
  data: S['Node']
  emit: RenderEmit<S>
}

interface Dimensions {
  width: number
  height: number
}

function dimensionsFor(kind: NodeKind): Dimensions {
  switch (kind) {
    case 'vu':
      return { width: 120, height: 60 }
    case 'spectrum_scope':
    case 'scope':
    default:
      return { width: 240, height: 80 }
  }
}

interface ThemeColors {
  audio: string
  cv: string
  border: string
  textDim: string
}

function readThemeColors(el: HTMLElement): ThemeColors {
  const s = getComputedStyle(el)
  const pick = (name: string, fallback: string): string => {
    const v = s.getPropertyValue(name).trim()
    return v || fallback
  }
  return {
    audio: pick('--dp-signal-audio', '#22d3ee'),
    cv: pick('--dp-signal-cv', '#f472b6'),
    border: pick('--dp-border', '#1a2230'),
    textDim: pick('--dp-text-dim', '#5a6472')
  }
}

export function VisualNode<S extends ClassicScheme>(props: Props<S>): React.JSX.Element {
  const { data, emit } = props
  const selected = data.selected ?? false
  const isDaisy = data instanceof DaisyNode
  const kind = (isDaisy ? data.kind : undefined) as NodeKind | undefined
  const def = kind ? NODE_DEFINITIONS[kind] : undefined

  const collapsed = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return n?.collapsed === true
  })
  const onHeaderDoubleClick = useHeaderDoubleClick(data.id)

  if (!isDaisy || !kind || !def) {
    // Fall back to a simple shell if definitions haven't been merged yet.
    return (
      <div className={`${styles.node} ${selected ? styles.selected : ''}`} data-testid="node">
        <div className={styles.header}>
          <span className={styles.accent} aria-hidden />
          {data.label || (kind ?? 'visual')}
        </div>
      </div>
    )
  }

  const inputs = Object.entries(data.inputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]
  const outputs = Object.entries(data.outputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]

  const activeInputs = inputs.filter((e): e is [string, { socket: SignalSocket; label?: string }] => e[1] !== undefined)
  const activeOutputs = outputs.filter((e): e is [string, { socket: SignalSocket; label?: string }] => e[1] !== undefined)

  const dims = dimensionsFor(kind)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const engine = useAudioEngine()

  // Subscribe to just this node's params (selector-level) so re-renders are
  // scoped. If the node isn't in the store yet, `params` is undefined.
  const params = useEditorStore((s) => s.graph.nodes.find((n) => n.id === data.id)?.params)

  const paramsRef = React.useRef<Record<string, number | string> | undefined>(params)
  React.useEffect(() => {
    paramsRef.current = params
  }, [params])

  React.useEffect(() => {
    // When collapsed the canvas element isn't in the DOM at all, so there's
    // nothing to paint and no tap to open. Skipping the tap also releases
    // the analyser — the engine's node stays connected, just no branch.
    if (collapsed) return
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const cssW = dims.width
    const cssH = dims.height
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const colors = readThemeColors(canvas)

    // VU: peak hold state, persists across frames.
    let peakHold = 0
    let peakHoldTimer = 0
    let lastT = performance.now()

    const drawIdle = (): void => {
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.strokeStyle = colors.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, cssH / 2)
      ctx.lineTo(cssW, cssH / 2)
      ctx.stroke()
    }

    const drawScope = (frame: ScopeFrame): void => {
      const data = frame.timeDomain
      ctx.clearRect(0, 0, cssW, cssH)
      // Center reference line.
      ctx.strokeStyle = colors.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, cssH / 2)
      ctx.lineTo(cssW, cssH / 2)
      ctx.stroke()

      const gainParam = paramsRef.current?.gain
      const gain = typeof gainParam === 'number' ? gainParam : 1

      ctx.strokeStyle = colors.audio
      ctx.lineWidth = 1
      ctx.beginPath()
      const n = data.length
      for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, data[i] * gain))
        const x = (i / (n - 1)) * cssW
        const y = cssH / 2 - v * (cssH / 2 - 1)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    const drawVu = (frame: ScopeFrame, dt: number): void => {
      const data = frame.timeDomain
      let sumSq = 0
      let peak = 0
      for (let i = 0; i < data.length; i++) {
        const v = data[i]
        sumSq += v * v
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
      }
      const rms = Math.sqrt(sumSq / data.length)

      // Peak hold: rise instantly, hold 1s, then release at 50 dB/s (~amp 0.01/s).
      if (peak >= peakHold) {
        peakHold = peak
        peakHoldTimer = 1.0
      } else {
        peakHoldTimer -= dt
        if (peakHoldTimer <= 0) {
          // 50 dB/s in amplitude: factor = 10^(-50 * dt / 20) = 10^(-2.5 * dt)
          const decay = Math.pow(10, -2.5 * dt)
          peakHold *= decay
          if (peakHold < 0.0005) peakHold = 0
        }
      }

      ctx.clearRect(0, 0, cssW, cssH)
      // Meter track background frame.
      ctx.strokeStyle = colors.border
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1)

      const barH = cssH - 10
      const barY = 5
      const rmsW = Math.min(cssW - 4, Math.max(0, rms) * (cssW - 4))

      // RMS gradient from audio toward cv at the top end.
      const grad = ctx.createLinearGradient(0, 0, cssW, 0)
      grad.addColorStop(0, colors.audio)
      grad.addColorStop(0.75, colors.audio)
      grad.addColorStop(1, colors.cv)
      ctx.fillStyle = grad
      ctx.fillRect(2, barY, rmsW, barH)

      // Peak-hold tick.
      const peakX = 2 + Math.min(cssW - 4, peakHold * (cssW - 4))
      ctx.strokeStyle = colors.cv
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(peakX + 0.5, barY)
      ctx.lineTo(peakX + 0.5, barY + barH)
      ctx.stroke()
    }

    const drawSpectrum = (frame: ScopeFrame): void => {
      const freq = frame.frequency
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.strokeStyle = colors.border
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1)

      if (!freq || freq.length === 0) return

      const scale = paramsRef.current?.scale === 'linear' ? 'linear' : 'log'
      const n = freq.length
      const bars = 64
      const barW = (cssW - 2) / bars
      const grad = ctx.createLinearGradient(0, 0, cssW, 0)
      grad.addColorStop(0, colors.audio)
      grad.addColorStop(1, colors.cv)
      ctx.fillStyle = grad

      for (let i = 0; i < bars; i++) {
        let srcIndex: number
        if (scale === 'log') {
          // Map [0..bars-1] logarithmically into [1..n-1] so low freqs are
          // emphasised without skipping bin 0 (which is DC-ish).
          const t = i / (bars - 1)
          const logIndex = Math.pow(n - 1, t)
          srcIndex = Math.min(n - 1, Math.max(0, Math.floor(logIndex)))
        } else {
          srcIndex = Math.min(n - 1, Math.floor((i / bars) * n))
        }
        const v = Math.max(0, Math.min(1, freq[srcIndex]))
        const h = v * (cssH - 4)
        const x = 1 + i * barW
        ctx.fillRect(x, cssH - 2 - h, Math.max(1, barW - 1), h)
      }
    }

    const onFrame = (frame: ScopeFrame): void => {
      const now = performance.now()
      const dt = Math.min(0.25, Math.max(0, (now - lastT) / 1000))
      lastT = now
      if (!kind) return
      if (kind === 'scope') drawScope(frame)
      else if (kind === 'vu') drawVu(frame, dt)
      else if (kind === 'spectrum_scope') drawSpectrum(frame)
    }

    // No engine yet? Paint an idle frame so the node isn't blank.
    if (!engine) {
      drawIdle()
      return
    }

    const tap = engine.tap(data.id, onFrame, {
      wantFrequency: kind === 'spectrum_scope'
    })

    return () => {
      tap.stop()
    }
  }, [engine, data.id, kind, dims.width, dims.height, collapsed])

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
            {activeInputs.length}&rarr;{activeOutputs.length}
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
        {collapsed ? (
          <div className={styles.headerSocketsRight} aria-hidden>
            {activeOutputs.map(([key, output]) => (
              <div key={`chout-${key}`} className={styles.headerSocketCell}>
                <RefSocket
                  name="output-socket"
                  side="output"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={output.socket}
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
          <div className={styles.canvasWrap}>
            <canvas ref={canvasRef} className={styles.canvas} />
          </div>
          {activeOutputs.map(([key, output]) => (
            <div
              key={`out-${key}`}
              className={`${styles.row} ${styles['row-output']}`}
              data-testid={`output-${key}`}
            >
              <span className={styles.socketLabel}>{output.label ?? key}</span>
              <div className={styles.socketCell}>
                <RefSocket
                  name="output-socket"
                  side="output"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={output.socket}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
