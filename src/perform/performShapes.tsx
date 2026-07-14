/**
 * performShapes — skeuomorphic SVG control shapes for the Perform view
 * ("Powder-coat" art direction: machined knobs with a white pointer,
 * chrome footswitch, glowing LED lens, recessed OLED window, hex-nut
 * jacks, silkscreen mono ink).
 *
 * All geometry is in MILLIMETERS, centered on (0,0). The PerformView
 * places each shape with `translate(cx cy) rotate(r)` inside its mm-space
 * SVG, so shapes never think about layout.
 *
 * Color rules:
 *   - Every hue comes from theme tokens: `--dp-perform-*` for the pedal's
 *     physical build, `--dp-signal-*` / `--dp-text` / `--dp-accent` for
 *     functional accents.
 *   - Pure `white` / `black` appear ONLY inside `color-mix()` as specular
 *     highlight and shade over those tokens — light and shadow, not palette.
 *   - SVG gradient ids are made globally unique per instance via `useId()`
 *     (sanitized — React 19 ids contain characters `url(#…)` chokes on).
 *     Colliding filter/gradient ids have bitten this app before (a8603ea);
 *     never share literal ids between component instances.
 */

import * as React from 'react'

const HW = 'var(--dp-perform-hardware)'
const INK = 'var(--dp-perform-ink)'
/** Soft contact shadow under raised parts. */
const SHADE = 'color-mix(in srgb, black 40%, transparent)'
/** Hairline dark edge around machined parts. */
const EDGE = 'color-mix(in srgb, black 55%, transparent)'

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Sanitized per-instance id prefix for gradient defs. */
function useSvgId(prefix: string): string {
  const raw = React.useId()
  return `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

/* =====================================================================
 * Knob (pot) — machined body, darker cap, white pointer, 270° travel.
 * ===================================================================== */

export function KnobShape({
  value01,
  engaged = false,
  bound = true,
  bodyR = 8
}: {
  value01: number
  engaged?: boolean
  bound?: boolean
  bodyR?: number
}): React.JSX.Element {
  const uid = useSvgId('pfk')
  const angle = -135 + clamp01(value01) * 270
  const capR = bodyR * 0.72
  return (
    <g opacity={bound ? 1 : 0.55}>
      <defs>
        <radialGradient id={`${uid}-body`} cx="0.38" cy="0.3" r="1">
          <stop offset="0" stopColor={`color-mix(in srgb, ${HW} 74%, white 26%)`} />
          <stop offset="0.55" stopColor={HW} />
          <stop offset="1" stopColor={`color-mix(in srgb, ${HW} 55%, black 45%)`} />
        </radialGradient>
        <radialGradient id={`${uid}-cap`} cx="0.4" cy="0.32" r="0.9">
          <stop offset="0" stopColor={`color-mix(in srgb, ${HW} 86%, white 14%)`} />
          <stop offset="1" stopColor={`color-mix(in srgb, ${HW} 78%, black 22%)`} />
        </radialGradient>
      </defs>
      {/* faceplate travel ticks — silkscreen ink at the 270° end stops */}
      <g stroke={INK} strokeWidth="0.45" strokeLinecap="round" opacity="0.6">
        <line transform="rotate(-135)" y1={-(bodyR + 1.2)} y2={-(bodyR + 2.6)} />
        <line transform="rotate(135)" y1={-(bodyR + 1.2)} y2={-(bodyR + 2.6)} />
        <line y1={-(bodyR + 1.2)} y2={-(bodyR + 2.6)} opacity="0.5" />
      </g>
      <ellipse cy={bodyR * 0.3} rx={bodyR} ry={bodyR * 0.34} fill={SHADE} />
      <circle r={bodyR} fill={`url(#${uid}-body)`} stroke={EDGE} strokeWidth="0.3" />
      <circle r={capR} fill={`url(#${uid}-cap)`} />
      <g transform={`rotate(${angle})`}>
        <rect
          x={-0.55}
          y={-bodyR * 0.92}
          width={1.1}
          height={bodyR * 0.48}
          rx={0.55}
          fill="var(--dp-text)"
        />
      </g>
      <circle
        r={bodyR + 1.7}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth="0.5"
        opacity={engaged ? 0.9 : 0}
        style={{ transition: 'opacity var(--dp-motion-fast) var(--dp-ease)' }}
      />
    </g>
  )
}

/* =====================================================================
 * Encoder — knurled edge, flat cap, dot marker, NO end stops (360°).
 * ===================================================================== */

export function EncoderShape({
  value01,
  engaged = false,
  bound = true
}: {
  value01: number
  engaged?: boolean
  bound?: boolean
}): React.JSX.Element {
  const uid = useSvgId('pfe')
  const bodyR = 7.4
  const angle = clamp01(value01) * 360
  return (
    <g opacity={bound ? 1 : 0.55}>
      <defs>
        <radialGradient id={`${uid}-body`} cx="0.38" cy="0.3" r="1">
          <stop offset="0" stopColor={`color-mix(in srgb, ${HW} 76%, white 24%)`} />
          <stop offset="0.6" stopColor={HW} />
          <stop offset="1" stopColor={`color-mix(in srgb, ${HW} 58%, black 42%)`} />
        </radialGradient>
      </defs>
      <ellipse cy={bodyR * 0.3} rx={bodyR} ry={bodyR * 0.32} fill={SHADE} />
      <circle r={bodyR} fill={`url(#${uid}-body)`} stroke={EDGE} strokeWidth="0.3" />
      {/* knurl — dashed ring hugging the rim */}
      <circle
        r={bodyR - 0.5}
        fill="none"
        stroke="color-mix(in srgb, black 45%, transparent)"
        strokeWidth="1"
        strokeDasharray="0.7 0.75"
      />
      <circle r={bodyR * 0.62} fill={`color-mix(in srgb, ${HW} 84%, black 16%)`} />
      <g transform={`rotate(${angle})`}>
        <circle cy={-bodyR * 0.44} r={0.85} fill="var(--dp-text)" />
      </g>
      <circle
        r={bodyR + 1.7}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth="0.5"
        opacity={engaged ? 0.9 : 0}
        style={{ transition: 'opacity var(--dp-motion-fast) var(--dp-ease)' }}
      />
    </g>
  )
}

/* =====================================================================
 * Fader (slider) — travel slot, machined cap with grip line.
 * Natural footprint is 14x60 mm; travel ≈ 48 mm.
 * ===================================================================== */

export function FaderShape({
  value01,
  engaged = false,
  bound = true,
  travelMm = 48
}: {
  value01: number
  engaged?: boolean
  bound?: boolean
  travelMm?: number
}): React.JSX.Element {
  const uid = useSvgId('pff')
  const half = travelMm / 2
  const capY = half - clamp01(value01) * travelMm
  return (
    <g opacity={bound ? 1 : 0.55}>
      <defs>
        <linearGradient id={`${uid}-cap`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`color-mix(in srgb, ${HW} 72%, white 28%)`} />
          <stop offset="0.5" stopColor={HW} />
          <stop offset="1" stopColor={`color-mix(in srgb, ${HW} 60%, black 40%)`} />
        </linearGradient>
      </defs>
      {/* silkscreen scale ticks */}
      <g stroke={INK} strokeWidth="0.35" opacity="0.55">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line
            key={t}
            x1={-5.4}
            x2={-4}
            y1={half - t * travelMm}
            y2={half - t * travelMm}
          />
        ))}
      </g>
      {/* travel slot */}
      <rect
        x={-1.4}
        y={-half - 1.4}
        width={2.8}
        height={travelMm + 2.8}
        rx={1.4}
        fill={`color-mix(in srgb, ${HW} 62%, black 38%)`}
        stroke={EDGE}
        strokeWidth="0.3"
      />
      {/* cap */}
      <g transform={`translate(0 ${capY})`}>
        <ellipse cy={1.1} rx={5.6} ry={1.7} fill={SHADE} />
        <rect
          x={-5.4}
          y={-3.2}
          width={10.8}
          height={6.4}
          rx={1}
          fill={`url(#${uid}-cap)`}
          stroke={EDGE}
          strokeWidth="0.3"
        />
        <rect x={-4.4} y={-0.5} width={8.8} height={1} rx={0.5} fill="var(--dp-text)" opacity="0.9" />
      </g>
      <rect
        x={-7.4}
        y={-half - 4.4}
        width={14.8}
        height={travelMm + 8.8}
        rx={2}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth="0.5"
        opacity={engaged ? 0.9 : 0}
        style={{ transition: 'opacity var(--dp-motion-fast) var(--dp-ease)' }}
      />
    </g>
  )
}

/* =====================================================================
 * Footswitch / button — chrome stack, presses down.
 * ===================================================================== */

export function FootswitchShape({
  pressed = false,
  bound = true,
  r = 7
}: {
  pressed?: boolean
  bound?: boolean
  r?: number
}): React.JSX.Element {
  const uid = useSvgId('pfb')
  return (
    <g opacity={bound ? 1 : 0.55}>
      <defs>
        <linearGradient id={`${uid}-chrome`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`color-mix(in srgb, white 90%, ${HW})`} />
          <stop offset="0.5" stopColor={`color-mix(in srgb, white 58%, ${HW})`} />
          <stop offset="0.55" stopColor={`color-mix(in srgb, white 42%, ${HW})`} />
          <stop offset="1" stopColor={`color-mix(in srgb, white 72%, ${HW})`} />
        </linearGradient>
      </defs>
      <ellipse cy={r * 0.16} rx={r + 0.5} ry={r * 0.36} fill={SHADE} />
      <circle r={r} fill={`url(#${uid}-chrome)`} stroke={EDGE} strokeWidth="0.35" />
      <circle
        r={r * 0.66}
        fill={`color-mix(in srgb, white 68%, ${HW})`}
        stroke={`color-mix(in srgb, white 40%, ${HW})`}
        strokeWidth="0.3"
      />
      <circle
        r={r * 0.5}
        cy={pressed ? 0.6 : -r * 0.1}
        fill={`color-mix(in srgb, white ${pressed ? 66 : 84}%, ${HW})`}
        style={{ transition: 'cy 60ms var(--dp-ease)' }}
      />
      {pressed ? <circle r={r} fill="color-mix(in srgb, black 16%, transparent)" /> : null}
    </g>
  )
}

/* =====================================================================
 * 3-way toggle — hex bushing nut + bat lever (up / center / down).
 * ===================================================================== */

function hexPoints(r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 6; i++) {
    const a = ((i * 60 + 30) * Math.PI) / 180
    pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

export function ToggleShape({
  position,
  bound = true
}: {
  /** -1 (down) | 0 (center) | 1 (up). */
  position: number
  bound?: boolean
}): React.JSX.Element {
  const uid = useSvgId('pft')
  const chrome = `url(#${uid}-chrome)`
  return (
    <g opacity={bound ? 1 : 0.55}>
      <defs>
        <linearGradient id={`${uid}-chrome`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`color-mix(in srgb, white 82%, ${HW})`} />
          <stop offset="0.55" stopColor={`color-mix(in srgb, white 44%, ${HW})`} />
          <stop offset="1" stopColor={`color-mix(in srgb, white 64%, ${HW})`} />
        </linearGradient>
      </defs>
      <ellipse cy={0.8} rx={4.6} ry={1.7} fill={SHADE} />
      <polygon points={hexPoints(4)} fill={chrome} stroke={EDGE} strokeWidth="0.3" />
      <circle r={2.5} fill={`color-mix(in srgb, white 36%, ${HW})`} stroke={EDGE} strokeWidth="0.25" />
      {position === 0 ? (
        <>
          <circle r={1.9} fill={chrome} stroke={EDGE} strokeWidth="0.25" />
          <circle r={0.8} cy={-0.4} fill={`color-mix(in srgb, white 88%, ${HW})`} />
        </>
      ) : (
        <g transform={position > 0 ? undefined : 'rotate(180)'}>
          {/* bat lever pointing "up" in local space */}
          <rect x={-1.25} y={-7.6} width={2.5} height={7.6} rx={1.25} fill={chrome} stroke={EDGE} strokeWidth="0.25" />
          <circle cy={-7.2} r={1.8} fill={`color-mix(in srgb, white 78%, ${HW})`} stroke={EDGE} strokeWidth="0.25" />
        </g>
      )}
    </g>
  )
}

/* =====================================================================
 * LED — bezel + lens + radial glow. Glow/lit opacity is ref-mutated per
 * frame by the activity subscription (never React state).
 * ===================================================================== */

export function LedShape({
  colorVar,
  glowRef,
  litRef
}: {
  colorVar: string
  glowRef?: React.Ref<SVGCircleElement>
  litRef?: React.Ref<SVGCircleElement>
}): React.JSX.Element {
  const uid = useSvgId('pfl')
  return (
    <g>
      <defs>
        <radialGradient id={`${uid}-glow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={colorVar} stopOpacity="0.9" />
          <stop offset="1" stopColor={colorVar} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle ref={glowRef} r={6} fill={`url(#${uid}-glow)`} opacity="0" />
      <circle r={2.3} fill={`color-mix(in srgb, ${HW} 70%, black 30%)`} stroke={EDGE} strokeWidth="0.3" />
      <circle r={1.6} fill={`color-mix(in srgb, ${colorVar} 32%, ${HW})`} />
      <circle ref={litRef} r={1.6} fill={colorVar} opacity="0" />
      <circle cx={-0.5} cy={-0.5} r={0.4} fill="color-mix(in srgb, white 75%, transparent)" />
    </g>
  )
}

/* =====================================================================
 * Jacks — hex nut + washer + barrel + dark bore, with a silkscreened
 * signal-color ring so IN/OUT/CV read at a glance.
 * ===================================================================== */

export function JackShape({
  hexR,
  boreR,
  ringVar
}: {
  hexR: number
  boreR: number
  ringVar: string
}): React.JSX.Element {
  const uid = useSvgId('pfj')
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-nut`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`color-mix(in srgb, white 80%, ${HW})`} />
          <stop offset="0.55" stopColor={`color-mix(in srgb, white 46%, ${HW})`} />
          <stop offset="1" stopColor={`color-mix(in srgb, white 62%, ${HW})`} />
        </linearGradient>
      </defs>
      <circle r={hexR + 1.3} fill="none" stroke={ringVar} strokeWidth="0.5" opacity="0.6" />
      <ellipse cy={hexR * 0.14} rx={hexR + 0.3} ry={hexR * 0.4} fill={SHADE} />
      <polygon points={hexPoints(hexR)} fill={`url(#${uid}-nut)`} stroke={EDGE} strokeWidth="0.3" />
      <circle r={hexR * 0.72} fill={`color-mix(in srgb, white 34%, ${HW})`} stroke={EDGE} strokeWidth="0.25" />
      <circle r={boreR + 0.9} fill={`color-mix(in srgb, ${HW} 82%, black 18%)`} />
      <circle r={boreR} fill={`color-mix(in srgb, black 85%, ${HW})`} />
    </g>
  )
}

/* =====================================================================
 * MIDI DIN-5 — metal shield, dark face, 5 pins on the arc + key notch.
 * ===================================================================== */

export function MidiDinShape(): React.JSX.Element {
  const uid = useSvgId('pfd')
  const pinAngles = [-64, -32, 0, 32, 64]
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-shield`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`color-mix(in srgb, white 78%, ${HW})`} />
          <stop offset="0.55" stopColor={`color-mix(in srgb, white 42%, ${HW})`} />
          <stop offset="1" stopColor={`color-mix(in srgb, white 60%, ${HW})`} />
        </linearGradient>
      </defs>
      <ellipse cy={1.4} rx={10.2} ry={3.4} fill={SHADE} />
      <circle r={10} fill={`url(#${uid}-shield)`} stroke={EDGE} strokeWidth="0.35" />
      <circle r={7.6} fill={`color-mix(in srgb, black 78%, ${HW})`} stroke={EDGE} strokeWidth="0.3" />
      {/* key notch at the bottom */}
      <rect x={-1.6} y={5.6} width={3.2} height={1.9} rx={0.5} fill={`color-mix(in srgb, black 78%, ${HW})`} />
      {/* pins along the upper arc */}
      {pinAngles.map((a) => {
        const rad = (a * Math.PI) / 180
        return (
          <circle
            key={a}
            cx={4.8 * Math.sin(rad)}
            cy={-4.8 * Math.cos(rad)}
            r={0.95}
            fill={`color-mix(in srgb, white 60%, ${HW})`}
            stroke="color-mix(in srgb, black 60%, transparent)"
            strokeWidth="0.2"
          />
        )
      })}
    </g>
  )
}

/* =====================================================================
 * Touch ribbon — long soft strip with an active track and sheen.
 * ===================================================================== */

export function RibbonShape({ lengthMm = 76 }: { lengthMm?: number }): React.JSX.Element {
  const half = lengthMm / 2
  return (
    <g>
      <rect
        x={-4}
        y={-half}
        width={8}
        height={lengthMm}
        rx={4}
        fill={`color-mix(in srgb, ${HW} 88%, black 12%)`}
        stroke={EDGE}
        strokeWidth="0.3"
      />
      <rect
        x={-2}
        y={-half + 3}
        width={4}
        height={lengthMm - 6}
        rx={2}
        fill={`color-mix(in srgb, ${HW} 90%, white 10%)`}
      />
      <rect
        x={-1.4}
        y={-half + 4}
        width={0.8}
        height={lengthMm - 8}
        rx={0.4}
        fill="color-mix(in srgb, white 14%, transparent)"
      />
    </g>
  )
}

/* =====================================================================
 * LDR — light-sensing dome with serpentine track.
 * ===================================================================== */

export function LdrShape(): React.JSX.Element {
  const uid = useSvgId('pfr')
  return (
    <g>
      <defs>
        <radialGradient id={`${uid}-dome`} cx="0.4" cy="0.32" r="0.9">
          <stop offset="0" stopColor={`color-mix(in srgb, var(--dp-warning) 34%, ${HW})`} />
          <stop offset="1" stopColor={`color-mix(in srgb, var(--dp-warning) 12%, ${HW})`} />
        </radialGradient>
      </defs>
      <circle r={2.9} fill={`url(#${uid}-dome)`} stroke={EDGE} strokeWidth="0.3" />
      <g stroke="color-mix(in srgb, black 55%, transparent)" strokeWidth="0.4" strokeLinecap="round">
        <line x1={-1.9} y1={-1.1} x2={1.9} y2={-1.1} />
        <line x1={-1.9} y1={0} x2={1.9} y2={0} />
        <line x1={-1.9} y1={1.1} x2={1.9} y2={1.1} />
      </g>
    </g>
  )
}

/* =====================================================================
 * Electret mic — metal capsule with mesh grid.
 * ===================================================================== */

export function ElectretShape(): React.JSX.Element {
  return (
    <g>
      <circle r={4.5} fill={`color-mix(in srgb, ${HW} 68%, black 32%)`} stroke={EDGE} strokeWidth="0.35" />
      <g stroke="color-mix(in srgb, white 22%, transparent)" strokeWidth="0.3">
        <line x1={-3.4} y1={-1.5} x2={3.4} y2={-1.5} />
        <line x1={-3.8} y1={0} x2={3.8} y2={0} />
        <line x1={-3.4} y1={1.5} x2={3.4} y2={1.5} />
        <line x1={-1.5} y1={-3.4} x2={-1.5} y2={3.4} />
        <line x1={0} y1={-3.8} x2={0} y2={3.8} />
        <line x1={1.5} y1={-3.4} x2={1.5} y2={3.4} />
      </g>
    </g>
  )
}

/* =====================================================================
 * ToF sensor — two dark optical windows behind a silkscreen outline.
 * ===================================================================== */

export function TofShape(): React.JSX.Element {
  return (
    <g>
      <rect
        x={-4}
        y={-9}
        width={8}
        height={18}
        rx={1.2}
        fill="none"
        stroke={INK}
        strokeWidth="0.4"
        opacity="0.45"
      />
      {[-2.8, 2.8].map((y) => (
        <g key={y}>
          <circle cy={y} r={2.1} fill={`color-mix(in srgb, ${HW} 80%, black 20%)`} stroke={EDGE} strokeWidth="0.3" />
          <circle cy={y} r={1.3} fill={`color-mix(in srgb, black 88%, ${HW})`} />
        </g>
      ))}
    </g>
  )
}

/* =====================================================================
 * Internal parts (i2s codec, IMU, magnetometer, piezo) — no faceplate
 * presence; a dashed silkscreen badge marks where they live inside.
 * ===================================================================== */

export function InternalBadgeShape({
  wMm,
  hMm,
  text
}: {
  wMm: number
  hMm: number
  text: string
}): React.JSX.Element {
  return (
    <g>
      <rect
        x={-wMm / 2}
        y={-hMm / 2}
        width={wMm}
        height={hMm}
        rx={1.4}
        fill="none"
        stroke={INK}
        strokeWidth="0.4"
        strokeDasharray="1.6 1.2"
        opacity="0.35"
      />
      <text
        y={0.9}
        textAnchor="middle"
        fontFamily="var(--dp-font-mono)"
        fontSize="2.3"
        letterSpacing="0.12em"
        fill={INK}
        opacity="0.5"
      >
        {text.toUpperCase()}
      </text>
    </g>
  )
}

/* =====================================================================
 * Generic fallback — silkscreen circle for unknown kinds.
 * ===================================================================== */

export function GenericShape(): React.JSX.Element {
  return (
    <g opacity="0.7">
      <circle r={3} fill="none" stroke={INK} strokeWidth="0.5" />
      <circle r={0.7} fill={INK} />
    </g>
  )
}

/* =====================================================================
 * OLED — recessed dark window; live pixels drawn on a <canvas> inside a
 * foreignObject so the bitmap renderer (editor/oled/render.ts) is reused
 * verbatim. Everything stays in the same SVG coordinate space.
 * ===================================================================== */

/** Visible glass size in mm (2:1 to match the 128x64 pixel grid). */
export const OLED_GLASS_W_MM = 24
export const OLED_GLASS_H_MM = 12

export function OledWindowShape({
  canvasRef
}: {
  canvasRef: React.Ref<HTMLCanvasElement>
}): React.JSX.Element {
  const gw = OLED_GLASS_W_MM
  const gh = OLED_GLASS_H_MM
  return (
    <g>
      {/* recess: dark bezel sunk into the coat */}
      <rect
        x={-gw / 2 - 1.6}
        y={-gh / 2 - 1.6}
        width={gw + 3.2}
        height={gh + 3.2}
        rx={1.2}
        fill={`color-mix(in srgb, black 68%, ${HW})`}
        stroke={EDGE}
        strokeWidth="0.7"
      />
      {/* inner lip highlight — the recess catches light on its lower edge */}
      <rect
        x={-gw / 2 - 1}
        y={-gh / 2 - 1}
        width={gw + 2}
        height={gh + 2}
        rx={0.9}
        fill="none"
        stroke="color-mix(in srgb, white 14%, transparent)"
        strokeWidth="0.25"
      />
      <foreignObject x={-gw / 2} y={-gh / 2} width={gw} height={gh}>
        <div style={{ width: '100%', height: '100%' }}>
          <canvas
            ref={canvasRef}
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              imageRendering: 'pixelated'
            }}
          />
        </div>
      </foreignObject>
    </g>
  )
}
