/**
 * Custom Rete connection renderer. Paints the cable with the source socket's
 * signal color and a soft Gaussian bloom for the Signal Lab "quiet bloom" look.
 *
 * The source signal is stashed on the connection instance as `signal` by the
 * sync layer — that avoids chasing the editor graph from inside React.
 *
 * Signal-specific animation (Phase 5):
 *   - audio  : cable brightness + bloom modulated by RMS of source output
 *   - gate   : 180ms pulse on rising edge (value crosses 0.5 going up)
 *   - clock  : slow-travelling dots along the path, tempo from edge rate
 *   - cv     : static (CV changes are not meaningful at cable scale)
 *
 * All animation subscribes to `AudioEngine.tap(sourceNodeId, ...)`. When the
 * engine is stopped or the source node isn't yet live, the tap silently
 * emits zero-frames and the cable renders in its calm baseline state.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme } from 'rete-react-plugin'
import type { SignalKind } from '@/theme'
import type { ScopeFrame } from '@/types/store'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import { signalColorVar } from './sockets'
import styles from './CustomConnection.module.css'

const { useConnection } = Presets.classic

export interface SignalConnectionData {
  signal?: SignalKind
  isPseudo?: boolean
  isLoop?: boolean
}

type Props<S extends ClassicScheme> = {
  data: S['Connection'] & SignalConnectionData
}

/** Baseline (idle) cable opacity — matches the skin token default visually. */
const AUDIO_BASE_OPACITY = 0.55
const AUDIO_PEAK_OPACITY = 1.0
const AUDIO_BASE_BLUR = 1.5
const AUDIO_PEAK_BLUR = 4

/** Gate pulse duration (ms) once a rising edge is detected. */
const GATE_PULSE_MS = 180

/** Fallback clock-dot animation period when no edges are detectable yet. */
const CLOCK_FALLBACK_PERIOD_MS = 1500

/**
 * Build a smooth cubic bezier with a small downward sag. The sag factor is
 * intentionally modest (~0.12) — Phase 1 doesn't do physical cables.
 */
function buildPath(sx: number, sy: number, ex: number, ey: number): string {
  const dx = Math.abs(ex - sx)
  const handle = Math.max(60, dx * 0.5)
  const sag = Math.max(0, (ex - sx) * 0) + Math.abs(ex - sx) * 0.12
  const c1x = sx + handle
  const c1y = sy + sag
  const c2x = ex - handle
  const c2y = ey + sag
  return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`
}

/**
 * Live animation state driven by the source node's analyser tap. Mutated
 * outside React and flushed to DOM via refs so the component only re-renders
 * on path / signal / selection changes — not every animation frame.
 */
interface AnimState {
  /** Last peak / rising-edge timestamp (ms). */
  lastRise: number
  /** Smoothed gate animation position (0..1). */
  gatePulse: number
  /** Last sample, for edge detection (gate / clock). */
  prevSample: number
  /** Rolling clock period estimate (ms between rising edges). */
  clockPeriodMs: number
  /** Timestamp (ms) of the last detected clock rising edge. */
  clockLastEdge: number
  /** Smoothed RMS for audio signals. */
  rmsSmoothed: number
}

function initialAnim(): AnimState {
  return {
    lastRise: 0,
    gatePulse: 0,
    prevSample: 0,
    clockPeriodMs: CLOCK_FALLBACK_PERIOD_MS,
    clockLastEdge: 0,
    rmsSmoothed: 0
  }
}

export function CustomConnection<S extends ClassicScheme>(
  props: Props<S>
): React.JSX.Element | null {
  const { start, end, path } = useConnection()
  const engine = useAudioEngine()

  // Refs used to mutate SVG attributes each frame without triggering React
  // re-renders. Keeping React out of the animation loop is important —
  // every connection would otherwise re-render at rAF rate.
  const mainPathRef = React.useRef<SVGPathElement | null>(null)
  const blurRef = React.useRef<SVGFEGaussianBlurElement | null>(null)
  const clockDotRef = React.useRef<SVGCircleElement | null>(null)
  const animateMotionRef = React.useRef<SVGAnimateMotionElement | null>(null)
  const animRef = React.useRef<AnimState>(initialAnim())

  const signal = props.data.signal
  const sourceId = props.data.source
  const isPseudo = !!props.data.isPseudo

  // Subscribe to source-node analyser frames. Pseudo connections (while
  // dragging) and connections with no source have nothing to animate.
  React.useEffect(() => {
    if (!engine || !sourceId || isPseudo) return
    if (!signal || signal === 'cv') return

    const anim = animRef.current

    const onFrame = (frame: ScopeFrame): void => {
      const data = frame.timeDomain
      const n = data.length
      if (n === 0) return
      const now = performance.now()

      if (signal === 'audio') {
        let sumSq = 0
        for (let i = 0; i < n; i++) {
          const v = data[i]
          sumSq += v * v
        }
        const rms = Math.sqrt(sumSq / n)
        // Attack fast, release slow, so percussive hits still bloom.
        const a = rms > anim.rmsSmoothed ? 0.6 : 0.15
        anim.rmsSmoothed = anim.rmsSmoothed * (1 - a) + rms * a

        const t = Math.min(1, anim.rmsSmoothed * 2.2)
        const opacity = AUDIO_BASE_OPACITY + (AUDIO_PEAK_OPACITY - AUDIO_BASE_OPACITY) * t
        const blur = AUDIO_BASE_BLUR + (AUDIO_PEAK_BLUR - AUDIO_BASE_BLUR) * t
        if (mainPathRef.current) mainPathRef.current.style.opacity = String(opacity)
        if (blurRef.current) blurRef.current.setAttribute('stdDeviation', blur.toFixed(2))
      } else if (signal === 'gate') {
        // Edge detect: look for any sample that crosses 0.5 upward in the
        // frame. We scan forward from the prev-last sample.
        let rose = false
        let prev = anim.prevSample
        for (let i = 0; i < n; i++) {
          const v = data[i]
          if (prev < 0.5 && v >= 0.5) {
            rose = true
          }
          prev = v
        }
        anim.prevSample = prev
        if (rose) anim.lastRise = now

        const dt = now - anim.lastRise
        const t = dt < GATE_PULSE_MS ? 1 - dt / GATE_PULSE_MS : 0
        anim.gatePulse = t
        const opacity = AUDIO_BASE_OPACITY + (AUDIO_PEAK_OPACITY - AUDIO_BASE_OPACITY) * t
        const blur = AUDIO_BASE_BLUR + (AUDIO_PEAK_BLUR - AUDIO_BASE_BLUR) * t
        if (mainPathRef.current) mainPathRef.current.style.opacity = String(opacity)
        if (blurRef.current) blurRef.current.setAttribute('stdDeviation', blur.toFixed(2))
      } else if (signal === 'clock') {
        // Detect rising edges and update the period estimate.
        let prev = anim.prevSample
        for (let i = 0; i < n; i++) {
          const v = data[i]
          if (prev < 0.5 && v >= 0.5) {
            if (anim.clockLastEdge > 0) {
              const dt = now - anim.clockLastEdge
              // Clamp to sane range (20ms..5s) to avoid runaway animations.
              const period = Math.min(5000, Math.max(20, dt))
              // Light smoothing across edges.
              anim.clockPeriodMs = anim.clockPeriodMs * 0.5 + period * 0.5
            }
            anim.clockLastEdge = now
          }
          prev = v
        }
        anim.prevSample = prev
        const motion = animateMotionRef.current
        if (motion) {
          const dur = (anim.clockPeriodMs / 1000).toFixed(3)
          if (motion.getAttribute('dur') !== `${dur}s`) {
            motion.setAttribute('dur', `${dur}s`)
            // Restart motion so the new duration takes effect cleanly.
            try {
              motion.beginElement()
            } catch {
              /* no-op on browsers that refuse mid-flight restart */
            }
          }
        }
      }
    }

    const tap = engine.tap(sourceId, onFrame)
    return () => {
      tap.stop()
      // Reset any live-mutated attributes so the cable snaps back to baseline.
      if (mainPathRef.current) mainPathRef.current.style.opacity = ''
      if (blurRef.current) blurRef.current.setAttribute('stdDeviation', '2')
      animRef.current = initialAnim()
    }
  }, [engine, sourceId, signal, isPseudo])

  if (!start || !end) return null

  // Fall back to rete's computed path; if unavailable synth one so the pseudo
  // connection (while dragging) still has a line to show.
  const d = path ?? buildPath(start.x, start.y, end.x, end.y)

  const strokeColor = signal ? signalColorVar(signal) : 'var(--dp-text-muted)'
  const showClockDot = signal === 'clock' && !isPseudo

  // Stable per-cable filter id so multiple cables don't collide on a global
  // `#dp-cable-glow`. That matters because different cables want different
  // stdDeviation values driven by their own tap state.
  const filterId = React.useMemo(
    () => `dp-cable-glow-${Math.random().toString(36).slice(2, 10)}`,
    []
  )

  return (
    <svg className={styles.svg} data-testid="connection">
      <defs>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur
            ref={blurRef}
            in="SourceGraphic"
            stdDeviation="2"
            result="blur"
          />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        ref={mainPathRef}
        className={`${styles.path} ${isPseudo ? styles['path-pseudo'] : ''}`}
        d={d}
        style={{ color: strokeColor, filter: `url(#${filterId})` }}
      />
      {showClockDot ? (
        <circle
          ref={clockDotRef}
          className={styles.clockDot}
          r={3}
          style={{ color: strokeColor }}
        >
          <animateMotion
            ref={animateMotionRef}
            dur={`${CLOCK_FALLBACK_PERIOD_MS / 1000}s`}
            repeatCount="indefinite"
            path={d}
            rotate="auto"
          />
        </circle>
      ) : null}
    </svg>
  )
}
