/**
 * Custom Rete connection renderer. Paints the cable with the source socket's
 * signal color and a soft Gaussian bloom for the Signal Lab "quiet bloom" look.
 *
 * The source signal is stashed on the connection instance as `signal` by the
 * sync layer — that avoids chasing the editor graph from inside React.
 *
 * Signal-specific animation (Phase 5) — active ONLY while the emulator is
 * playing (`store.isPlaying`) and the user hasn't asked for reduced motion:
 *   - audio : opacity + stroke-width bloom follows the source RMS, with a
 *             gentle exponential saturation so hot signals don't peg the cable
 *   - gate  : brief bright flash on each rising edge (~180ms decay)
 *   - clock : softer, shorter periodic tick flash on each edge
 *   - cv    : slow luminance follow of the (rectified) value
 *
 * Each connection registers at most ONE `AudioEngine.tap` on its SOURCE node —
 * the same "tap the connection's source" pattern as `tapInput()` in
 * `OledNode.tsx`, except a connection already knows its source id so no graph
 * walk is needed. Frames arrive from the engine's single shared rAF loop
 * (reused typed arrays, no allocation per frame) and are flushed to the SVG
 * imperatively via refs — the component never re-renders per frame. When the
 * engine stops, every tap is torn down; the engine's rAF loop exits once its
 * tap map is empty, so a stopped patch costs exactly nothing.
 *
 * Note the engine reaches this component through the module-level singleton in
 * `AudioEngineContext` — React Context does not cross Rete's per-element
 * `createRoot` boundary.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme } from 'rete-react-plugin'
import type { SignalKind } from '@/theme'
import type { ScopeFrame } from '@/types/store'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import { useEditorStore } from '@/state/store'
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

/** Fallbacks if the computed baseline can't be read (detached element). */
const FALLBACK_BASE_OPACITY = 0.55
const FALLBACK_BASE_WIDTH = 2

/** Gate pulse duration (ms) once a rising edge is detected. */
const GATE_PULSE_MS = 180
/** Clock ticks are softer and shorter than gate pulses. */
const CLOCK_TICK_MS = 140
const CLOCK_TICK_PEAK = 0.55

/** Audio bloom: fraction of the remaining opacity headroom + width gain. */
const AUDIO_GLOW_SPAN = 0.85
const AUDIO_WIDTH_GAIN = 0.3

/** CV luminance follow: smoothing per frame + max glow span (kept subtle). */
const CV_SMOOTH = 0.06
const CV_GLOW_SPAN = 0.55

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
 * `prefers-reduced-motion: reduce` as a live boolean. When true the cable
 * renders its static baseline only — no taps, no per-frame attribute writes.
 */
function usePrefersReducedMotion(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return React.useSyncExternalStore(subscribe, () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Live animation state, mutated inside the tap callback and never seen by
 * React. Recreated whenever a tap (re)attaches.
 */
interface AnimState {
  /** Last rising-edge timestamp (ms) for gate / clock flashes. */
  lastRise: number
  /** Last sample of the previous frame, for cross-frame edge detection. */
  prevSample: number
  /** Smoothed RMS for audio signals. */
  rmsSmoothed: number
  /** Slow-followed CV level (0..1). */
  cvSmoothed: number
  /** Last glow amount written to the DOM, to skip redundant style writes. */
  lastGlow: number
}

export function CustomConnection<S extends ClassicScheme>(
  props: Props<S>
): React.JSX.Element | null {
  const { start, end, path } = useConnection()
  const engine = useAudioEngine()
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const reducedMotion = usePrefersReducedMotion()

  // Ref used to mutate SVG attributes each frame without triggering React
  // re-renders. Keeping React out of the animation loop is important —
  // every connection would otherwise re-render at rAF rate.
  const mainPathRef = React.useRef<SVGPathElement | null>(null)

  const signal = props.data.signal
  const sourceId = props.data.source
  const isPseudo = !!props.data.isPseudo

  // A cable animates only when: the engine exists, the emulator is playing,
  // motion is allowed, and this is a real (non-drag) connection with a known
  // signal kind. Everything else renders the calm static baseline.
  const live =
    !!engine && isPlaying && !reducedMotion && !isPseudo && !!signal && !!sourceId

  // Subscribe to source-node analyser frames while live. The effect tears the
  // tap down on stop / unmount / reduced-motion, restoring baseline styling.
  React.useEffect(() => {
    if (!live || !engine || !signal || !sourceId) return

    // Read the token-derived baseline once per activation so the animation
    // modulates whatever the current skin says a cable looks like.
    let baseOpacity = FALLBACK_BASE_OPACITY
    let baseWidth = FALLBACK_BASE_WIDTH
    const el0 = mainPathRef.current
    if (el0) {
      const cs = getComputedStyle(el0)
      const o = parseFloat(cs.opacity)
      if (Number.isFinite(o) && o > 0) baseOpacity = o
      const w = parseFloat(cs.strokeWidth)
      if (Number.isFinite(w) && w > 0) baseWidth = w
    }

    const anim: AnimState = {
      lastRise: 0,
      prevSample: 0,
      rmsSmoothed: 0,
      cvSmoothed: 0,
      lastGlow: -1
    }

    /**
     * Flush a glow amount (0..1) to the path. Opacity climbs from the skin
     * baseline toward 1; width optionally blooms by `widthGain` * glow.
     * Skips the DOM write when the value hasn't visibly changed (idle gate /
     * clock cables write nothing between edges).
     */
    const setGlow = (glow: number, widthGain: number): void => {
      if (Math.abs(glow - anim.lastGlow) < 0.003) return
      anim.lastGlow = glow
      const el = mainPathRef.current
      if (!el) return
      el.style.opacity = (baseOpacity + (1 - baseOpacity) * glow).toFixed(3)
      if (widthGain > 0) {
        el.style.strokeWidth = `${(baseWidth * (1 + widthGain * glow)).toFixed(2)}px`
      }
    }

    /** Scan the frame for a 0.5-upward crossing (gate / clock edges). */
    const detectRisingEdge = (data: Float32Array): boolean => {
      let rose = false
      let prev = anim.prevSample
      for (let i = 0; i < data.length; i++) {
        const v = data[i]
        if (prev < 0.5 && v >= 0.5) rose = true
        prev = v
      }
      anim.prevSample = prev
      return rose
    }

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
        const a = rms > anim.rmsSmoothed ? 0.5 : 0.12
        anim.rmsSmoothed += (rms - anim.rmsSmoothed) * a
        // Gentle saturation — approaches 1 asymptotically, no hard knee.
        const t = 1 - Math.exp(-3.2 * anim.rmsSmoothed)
        setGlow(t * AUDIO_GLOW_SPAN, AUDIO_WIDTH_GAIN)
      } else if (signal === 'gate') {
        if (detectRisingEdge(data)) anim.lastRise = now
        const dt = now - anim.lastRise
        const t = dt < GATE_PULSE_MS ? 1 - dt / GATE_PULSE_MS : 0
        setGlow(t, 0.2)
      } else if (signal === 'clock') {
        if (detectRisingEdge(data)) anim.lastRise = now
        const dt = now - anim.lastRise
        const t = dt < CLOCK_TICK_MS ? 1 - dt / CLOCK_TICK_MS : 0
        setGlow(t * CLOCK_TICK_PEAK, 0)
      } else {
        // cv: slow luminance follow of the rectified frame mean.
        let sum = 0
        for (let i = 0; i < n; i++) sum += data[i]
        const level = Math.min(1, Math.abs(sum / n))
        anim.cvSmoothed += (level - anim.cvSmoothed) * CV_SMOOTH
        setGlow(anim.cvSmoothed * CV_GLOW_SPAN, 0)
      }
    }

    const tap = engine.tap(sourceId, onFrame, { wantFrequency: false })
    return () => {
      tap.stop()
      // Reset live-mutated attributes so the cable snaps back to the skin
      // baseline (the CSS vars take over again).
      const el = mainPathRef.current
      if (el) {
        el.style.opacity = ''
        el.style.strokeWidth = ''
      }
    }
  }, [live, engine, sourceId, signal])

  if (!start || !end) return null

  // Fall back to rete's computed path; if unavailable synth one so the pseudo
  // connection (while dragging) still has a line to show.
  const d = path ?? buildPath(start.x, start.y, end.x, end.y)

  const strokeColor = signal ? signalColorVar(signal) : 'var(--dp-text-muted)'
  const pathClass = [
    styles.path,
    isPseudo ? styles['path-pseudo'] : '',
    live ? styles.pathLive : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <svg className={styles.svg} data-testid="connection">
      <defs>
        {/*
         * Single shared filter id matching the CSS rule in CustomConnection.module.css.
         * Each connection's SVG has its own copy; filter-url resolution is scoped to
         * the containing SVG so there's no cross-cable bleed. We don't per-cable
         * animate blur — only opacity / width — so a fixed id is sufficient.
         */}
        <filter id="dp-cable-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path ref={mainPathRef} className={pathClass} d={d} style={{ color: strokeColor }} />
    </svg>
  )
}
