/**
 * Custom Rete connection renderer. Paints the cable with the source socket's
 * signal color and renders the active skin's full cable personality
 * (`Skin.cable` in src/theme/types.ts):
 *
 *   - width / opacity — straight from `--dp-cable-*` vars (CSS, unchanged).
 *   - glow — the shared Gaussian filter's stdDeviation is driven by
 *     `--dp-cable-glow` (6px Signal Lab quiet bloom, 3px Studio Rack,
 *     10px CRT phosphor). The filter keeps the single fixed `dp-cable-glow`
 *     id — a per-connection randomized id broke cable visibility once
 *     (see a8603ea). Every connection's copy of the filter reads the same
 *     theme snapshot, so all copies stay identical and the shared id stays
 *     correct. Blur is theme-level only, never animated per frame.
 *   - sag — the cable path is computed HERE from the endpoint coordinates
 *     (Rete's own path string is ignored), with a control-point drop of
 *     horizontal distance × `--dp-cable-sag`.
 *   - rendering — 'smooth' (Signal Lab): long horizontal exit handles;
 *     'physical' (Studio Rack): control points at the horizontal thirds so
 *     the belly hangs below both jacks and the cable reads as having weight;
 *     'crackle' (CRT): short taut handles plus a subtle low-frequency
 *     perpendicular beam jitter while the emulator plays.
 *
 * Skin cable values are read via getComputedStyle on :root and cached at
 * module scope; a MutationObserver on the root's data-theme/style attributes
 * (both stamped by ThemeProvider on skin change) invalidates the cache and
 * re-renders subscribed cables. React Context can't carry the theme here —
 * this component mounts inside Rete's per-element `createRoot` (CLAUDE.md).
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
 * The crackle jitter rides the same mechanism: it retargets inside the tap
 * callback, so it shares the engine's single rAF loop and disappears with it.
 *
 * Each connection registers at most ONE `AudioEngine.tap` on its SOURCE node —
 * the same "tap the connection's source" pattern as `tapInput()` in
 * `OledNode.tsx`, except a connection already knows its source id so no graph
 * walk is needed. Frames arrive from the engine's single shared rAF loop
 * (reused typed arrays, no allocation per frame) and are flushed to the SVG
 * imperatively via refs — the component never re-renders per frame. When the
 * engine stops, every tap is torn down; the engine's rAF loop exits once its
 * tap map is empty, so a stopped patch costs exactly nothing (jitter included).
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

/** Crackle beam jitter: max perpendicular control-point displacement (px). */
const JITTER_AMP = 1.6
/** Crackle beam jitter retarget interval — low frequency, NOT per-frame. */
const JITTER_MIN_MS = 90
const JITTER_VAR_MS = 140

/* ------------------------------------------------------------------ */
/* Per-skin cable style, read from --dp-cable-* vars and cached        */
/* ------------------------------------------------------------------ */

type CableRendering = 'smooth' | 'crackle' | 'physical'

interface CableSkinStyle {
  /** Bloom radius in px (--dp-cable-glow); filter stdDeviation = glow / 2. */
  glow: number
  /** Sag factor (--dp-cable-sag): control-point drop = |dx| * sag. */
  sag: number
  /** Path-shape mode (--dp-cable-rendering). */
  rendering: CableRendering
}

const FALLBACK_CABLE_STYLE: CableSkinStyle = { glow: 4, sag: 0.12, rendering: 'smooth' }

let cachedCableStyle: CableSkinStyle | null = null
const cableStyleListeners = new Set<() => void>()
let cableStyleObserver: MutationObserver | null = null

function readCableStyle(): CableSkinStyle {
  const cs = getComputedStyle(document.documentElement)
  const glow = parseFloat(cs.getPropertyValue('--dp-cable-glow'))
  const sag = parseFloat(cs.getPropertyValue('--dp-cable-sag'))
  const renderingRaw = cs.getPropertyValue('--dp-cable-rendering').trim()
  const rendering: CableRendering =
    renderingRaw === 'physical' || renderingRaw === 'crackle' ? renderingRaw : 'smooth'
  return {
    glow: Number.isFinite(glow) && glow >= 0 ? glow : FALLBACK_CABLE_STYLE.glow,
    sag: Number.isFinite(sag) && sag >= 0 ? sag : FALLBACK_CABLE_STYLE.sag,
    rendering
  }
}

function getCableStyleSnapshot(): CableSkinStyle {
  if (!cachedCableStyle) cachedCableStyle = readCableStyle()
  return cachedCableStyle
}

/**
 * Subscribe to skin cable-style changes. A single module-level
 * MutationObserver watches :root's `data-theme` + `style` attributes (both
 * written by ThemeProvider when the skin swaps). It is created lazily and
 * kept for the app's lifetime — one observer on one element is effectively
 * free, and never disconnecting means the cache can't go stale while no
 * cable is mounted.
 */
function subscribeCableStyle(onChange: () => void): () => void {
  cableStyleListeners.add(onChange)
  if (!cableStyleObserver) {
    cableStyleObserver = new MutationObserver(() => {
      const next = readCableStyle()
      const prev = cachedCableStyle
      if (
        prev &&
        prev.glow === next.glow &&
        prev.sag === next.sag &&
        prev.rendering === next.rendering
      ) {
        return
      }
      cachedCableStyle = next
      for (const cb of cableStyleListeners) cb()
    })
    cableStyleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style']
    })
  }
  return () => {
    cableStyleListeners.delete(onChange)
  }
}

function useCableSkinStyle(): CableSkinStyle {
  return React.useSyncExternalStore(subscribeCableStyle, getCableStyleSnapshot)
}

/* ------------------------------------------------------------------ */
/* Path geometry                                                       */
/* ------------------------------------------------------------------ */

/**
 * Cubic-bezier cable geometry plus the unit perpendicular of the endpoint
 * axis (used to displace control points for the crackle beam jitter).
 */
interface CableGeometry {
  sx: number
  sy: number
  ex: number
  ey: number
  c1x: number
  c1y: number
  c2x: number
  c2y: number
  px: number
  py: number
}

/**
 * Compute the control points for the active rendering mode. All modes share
 * the sag contract: both control points drop by |dx| × sag, so the cable
 * hangs more the further it spans horizontally.
 */
function cableGeometry(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  sag: number,
  rendering: CableRendering
): CableGeometry {
  const dx = ex - sx
  const adx = Math.abs(dx)
  const drop = adx * sag
  let c1x: number
  let c2x: number
  if (rendering === 'physical') {
    // Hanging wire: control points at the horizontal thirds, so the belly
    // sinks below both jacks — gravity, not routing.
    c1x = sx + dx / 3
    c2x = ex - dx / 3
  } else if (rendering === 'crackle') {
    // Taut patchbay trace: short exit handles, near-straight run.
    const handle = Math.max(24, adx * 0.25)
    c1x = sx + handle
    c2x = ex - handle
  } else {
    // smooth: generous horizontal exit handles (the Signal Lab look).
    const handle = Math.max(60, adx * 0.5)
    c1x = sx + handle
    c2x = ex - handle
  }
  const c1y = sy + drop
  const c2y = ey + drop
  const len = Math.hypot(ex - sx, ey - sy) || 1
  return {
    sx,
    sy,
    ex,
    ey,
    c1x,
    c1y,
    c2x,
    c2y,
    px: -(ey - sy) / len,
    py: dx / len
  }
}

/** Serialize geometry to a path, optionally jittering the control points. */
function cablePath(g: CableGeometry, j1 = 0, j2 = 0): string {
  const c1x = g.c1x + g.px * j1
  const c1y = g.c1y + g.py * j1
  const c2x = g.c2x + g.px * j2
  const c2y = g.c2y + g.py * j2
  return `M ${g.sx} ${g.sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${g.ex} ${g.ey}`
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
  /** Next crackle-jitter retarget timestamp (ms). */
  jitterNextAt: number
}

export function CustomConnection<S extends ClassicScheme>(
  props: Props<S>
): React.JSX.Element | null {
  const { start, end } = useConnection()
  const engine = useAudioEngine()
  const isPlaying = useEditorStore((s) => s.isPlaying)
  const reducedMotion = usePrefersReducedMotion()
  const cable = useCableSkinStyle()

  // Ref used to mutate SVG attributes each frame without triggering React
  // re-renders. Keeping React out of the animation loop is important —
  // every connection would otherwise re-render at rAF rate.
  const mainPathRef = React.useRef<SVGPathElement | null>(null)
  // Latest geometry, for the jitter writer inside the tap callback (the
  // endpoints move on node drag; the callback must not close over stale ones).
  const geomRef = React.useRef<CableGeometry | null>(null)

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

    const crackle = cable.rendering === 'crackle'

    const anim: AnimState = {
      lastRise: 0,
      prevSample: 0,
      rmsSmoothed: 0,
      cvSmoothed: 0,
      lastGlow: -1,
      jitterNextAt: 0
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

      // CRT beam jitter: retarget the control points every ~90–230ms with a
      // small perpendicular offset. Riding the tap callback means the jitter
      // shares the engine's single rAF loop and costs zero when stopped —
      // identical lifecycle to the glow animation above.
      if (crackle && now >= anim.jitterNextAt) {
        anim.jitterNextAt = now + JITTER_MIN_MS + Math.random() * JITTER_VAR_MS
        const g = geomRef.current
        const el = mainPathRef.current
        if (g && el) {
          el.setAttribute(
            'd',
            cablePath(
              g,
              (Math.random() * 2 - 1) * JITTER_AMP,
              (Math.random() * 2 - 1) * JITTER_AMP
            )
          )
        }
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
        if (crackle) {
          // React won't rewrite `d` unless the geometry changed, so undo the
          // last jitter write explicitly.
          const g = geomRef.current
          if (g) el.setAttribute('d', cablePath(g))
        }
      }
    }
  }, [live, engine, sourceId, signal, cable])

  if (!start || !end) return null

  // Own the path: build it from the endpoint coordinates with the skin's sag
  // and rendering mode. Rete's precomputed path string is deliberately unused —
  // it can't express per-skin geometry.
  const geom = cableGeometry(start.x, start.y, end.x, end.y, cable.sag, cable.rendering)
  geomRef.current = geom
  const d = cablePath(geom)

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
         * Each connection's SVG has its own copy; all copies read the same theme
         * snapshot so they stay identical and the fixed id is safe (a8603ea).
         * stdDeviation is theme-level (--dp-cable-glow / 2) — we never animate
         * blur per cable or per frame; only opacity / width move.
         */}
        <filter id="dp-cable-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur
            in="SourceGraphic"
            stdDeviation={Math.max(0.5, cable.glow / 2)}
            result="blur"
          />
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
