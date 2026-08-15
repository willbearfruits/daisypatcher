/**
 * componentShapes — realistic 2D SVG renderings of each hardware kind,
 * sized in millimeter-ish canvas units so a side-by-side layout gives the
 * user an honest sense of physical fit. Drawn flat / front-panel-CAD
 * style, not photoreal. All colors resolved from `--dp-*` tokens.
 *
 * The unit system:
 *   - `MM_PER_UNIT = 3` canvas units per millimeter. So a 7mm knob is
 *     21 canvas units across, a 128×64px OLED breakout (~28 × 14 mm)
 *     lands near 84 × 42 units. The hardware view's SVG viewBox is
 *     1400 × 1500 units, so even a 30mm component fits comfortably.
 *   - `SHAPE_DIMENSIONS[kind]` returns the component's physical footprint
 *     in mm. `shapeSizeCanvas(kind)` converts to canvas units and drives
 *     both the click-overlay bounding box and the SVG size.
 *
 * Components render into a fixed-size SVG that the parent overlays onto
 * the canvas. They read `rotation` (0 | 90 | 180 | 270) from the placed
 * component's config so the user can orient sliders and ribbons along
 * whichever axis the panel calls for.
 */

import type { ReactElement } from 'react'
import type { HardwareKind, PlacedComponent } from '@/types/hardware'

/** Canvas units per millimeter. Tune this to taste. */
export const MM_PER_UNIT = 3

/** Physical footprint per kind (mm). Used for SVG size + click hit area. */
export const SHAPE_DIMENSIONS: Record<HardwareKind, { w: number; h: number }> = {
  pot:          { w: 18, h: 18 }, // Alpha/Alps 16mm body + skirt
  slider:       { w: 14, h: 60 }, // track incl. cap
  touch_ribbon: { w: 10, h: 80 }, // SoftPot SP-L-0100
  ldr:          { w: 6,  h: 6 },
  button:       { w: 14, h: 14 }, // 12mm tactile w/ cap
  switch_3way:  { w: 8,  h: 22 },
  encoder:      { w: 18, h: 18 },
  led:          { w: 5,  h: 5 },
  electret:     { w: 10, h: 10 },
  piezo:        { w: 27, h: 27 }, // 27mm piezo disc
  gate_jack:    { w: 10, h: 10 }, // 3.5mm mono jack top plate
  cv_jack:      { w: 10, h: 10 },
  audio_jack:   { w: 14, h: 14 }, // 1/4"
  midi_jack:    { w: 22, h: 22 },
  oled_ssd1306: { w: 28, h: 28 },
  i2s_codec:    { w: 20, h: 14 },
  pcm5102a:     { w: 27, h: 19 }, // GY-PCM5102 purple board w/ 3.5mm jack
  max98357a:    { w: 22, h: 17 }, // Adafruit MAX98357A breakout (21.2×16.6)
  gyroscope:    { w: 15, h: 15 },
  magnetometer: { w: 14, h: 14 },
  tof:          { w: 11, h: 21 }
}

/** 0.1" header pitch — the pad spacing on every breakout we draw. */
export const HEADER_PITCH_MM = 2.54

/** Convert the mm footprint to canvas (SVG) units. */
export function shapeSizeCanvas(kind: HardwareKind): { w: number; h: number } {
  const d = SHAPE_DIMENSIONS[kind]
  return { w: d.w * MM_PER_UNIT, h: d.h * MM_PER_UNIT }
}

/** Read the stored rotation from config. Defaults to 0. */
export function rotationOf(comp: PlacedComponent): 0 | 90 | 180 | 270 {
  const r = comp.config.rotation
  const n = typeof r === 'number' ? r : 0
  if (n === 90 || n === 180 || n === 270) return n
  return 0
}

/** Next rotation step (clockwise). */
export function nextRotation(r: 0 | 90 | 180 | 270): 0 | 90 | 180 | 270 {
  return ((r + 90) % 360) as 0 | 90 | 180 | 270
}

/* =====================================================================
 * Shape components — each draws its shape into an SVG sized to its
 * physical footprint (mm × MM_PER_UNIT). Parent handles positioning and
 * rotation.
 * ===================================================================== */

interface ShapeProps {
  comp: PlacedComponent
  /** Live-activity level (0..1); shapes may choose to reflect this (LEDs, etc.). */
  level?: number
}

function ShapeSvg({
  kind,
  children
}: {
  kind: HardwareKind
  children: React.ReactNode
}) {
  const { w, h } = shapeSizeCanvas(kind)
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ overflow: 'visible' }}
      aria-hidden
    >
      {children}
    </svg>
  )
}

/* --- Pot (knob). 16mm body with skirt + indicator line. ------------- */

function PotShape({ comp, level }: ShapeProps) {
  const { w, h } = shapeSizeCanvas('pot')
  const cx = w / 2
  const cy = h / 2
  const outer = Math.min(w, h) * 0.46
  const inner = outer * 0.7
  // Rotation: 0..1 level maps to -135..+135 degrees.
  const deg = ((level ?? 0.5) - 0.5) * 270
  return (
    <ShapeSvg kind="pot">
      {/* skirt */}
      <circle
        cx={cx}
        cy={cy}
        r={outer}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 80%, var(--dp-border-strong))"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />
      {/* cap */}
      <circle
        cx={cx}
        cy={cy}
        r={inner}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 90%, var(--dp-bg))"
        stroke="var(--dp-border)"
        strokeWidth="0.75"
      />
      {/* indicator line */}
      <g transform={`rotate(${deg} ${cx} ${cy})`}>
        <line
          x1={cx}
          y1={cy}
          x2={cx}
          y2={cy - inner + 1.5}
          stroke="var(--dp-accent)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>
      {/* tick marks around the skirt (3/6/9/12 o'clock hints) */}
      {[0, 90, 180, 270].map((a) => (
        <g key={a} transform={`rotate(${a + 45} ${cx} ${cy})`}>
          <line
            x1={cx}
            y1={cy + outer - 1}
            x2={cx}
            y2={cy + outer + 1.5}
            stroke="var(--dp-text-dim)"
            strokeWidth="0.6"
            opacity="0.6"
          />
        </g>
      ))}
      {comp.label ? null : null}
    </ShapeSvg>
  )
}

/* --- Slider. 14×54mm track with a 10×18 cap. Orientation config flips
 *     the container; rotation prop handles 90deg cases separately. --- */

function SliderShape({ comp, level }: ShapeProps) {
  void comp
  const { w, h } = shapeSizeCanvas('slider')
  const trackW = Math.min(w, h) * 0.28
  const trackH = Math.max(w, h) * 0.9
  const trackX = (w - trackW) / 2
  const trackY = (h - trackH) / 2
  const capW = w * 0.9
  const capH = 18 * MM_PER_UNIT * 0.22
  const capX = (w - capW) / 2
  // Cap position along track: top = max, bottom = min.
  const pos = Math.max(0, Math.min(1, level ?? 0.5))
  const capTravel = trackH - capH
  const capY = trackY + capTravel * (1 - pos)
  return (
    <ShapeSvg kind="slider">
      {/* body plate */}
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        rx={2}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 70%, var(--dp-surface-sunken))"
        stroke="var(--dp-border)"
        strokeWidth="0.75"
      />
      {/* track slot */}
      <rect
        x={trackX}
        y={trackY}
        width={trackW}
        height={trackH}
        rx={trackW / 2}
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* cap */}
      <rect
        x={capX}
        y={capY}
        width={capW}
        height={capH}
        rx={2}
        fill="color-mix(in srgb, var(--dp-accent) 25%, var(--dp-surface-elevated))"
        stroke="var(--dp-accent)"
        strokeWidth="1"
      />
      <line
        x1={capX + 2}
        y1={capY + capH / 2}
        x2={capX + capW - 2}
        y2={capY + capH / 2}
        stroke="var(--dp-accent)"
        strokeWidth="0.8"
        opacity="0.7"
      />
    </ShapeSvg>
  )
}

/* --- Touch ribbon (SoftPot style). A thin strip with a contact dot. -- */

function TouchRibbonShape({ comp, level }: ShapeProps) {
  void comp
  const { w, h } = shapeSizeCanvas('touch_ribbon')
  const pos = Math.max(0, Math.min(1, level ?? 0.5))
  const dotY = h * (1 - pos)
  return (
    <ShapeSvg kind="touch_ribbon">
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        rx={w / 2}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 80%, var(--dp-bg))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      <rect
        x={2}
        y={2}
        width={w - 4}
        height={h - 4}
        rx={(w - 4) / 2}
        fill="none"
        stroke="color-mix(in srgb, var(--dp-accent) 25%, transparent)"
        strokeWidth="0.5"
      />
      {/* the 'touched' contact dot */}
      <circle
        cx={w / 2}
        cy={dotY}
        r={w * 0.28}
        fill="color-mix(in srgb, var(--dp-accent) 70%, transparent)"
        stroke="var(--dp-accent)"
        strokeWidth="0.75"
        opacity={(level ?? 0) > 0.01 ? 0.9 : 0.25}
      />
    </ShapeSvg>
  )
}

/* --- LDR. Circle with a serpentine trace inside (cadmium sulfide squiggle). */

function LdrShape() {
  const { w, h } = shapeSizeCanvas('ldr')
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) / 2 - 0.5
  // Serpentine path in the middle of the disc.
  const amp = r * 0.45
  const path = `M ${cx - r * 0.7} ${cy} q ${r * 0.18} -${amp} ${r * 0.36} 0 t ${r * 0.36} 0 t ${r * 0.36} 0 t ${r * 0.36} 0`
  return (
    <ShapeSvg kind="ldr">
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 70%, var(--dp-warning) 10%)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      <path
        d={path}
        fill="none"
        stroke="color-mix(in srgb, var(--dp-text-dim) 85%, var(--dp-warning))"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
    </ShapeSvg>
  )
}

/* --- Button (tactile) ------------------------------------------------- */

function ButtonShape({ level }: ShapeProps) {
  const { w, h } = shapeSizeCanvas('button')
  const cx = w / 2
  const cy = h / 2
  const body = Math.min(w, h) * 0.46
  const cap = body * 0.66
  const pressed = (level ?? 0) > 0.5
  return (
    <ShapeSvg kind="button">
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={1.5}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 80%, var(--dp-border))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      <circle
        cx={cx}
        cy={cy}
        r={body}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 80%, var(--dp-bg))"
        stroke="var(--dp-border)"
        strokeWidth="0.75"
      />
      <circle
        cx={cx}
        cy={cy}
        r={cap}
        fill={pressed ? 'var(--dp-signal-gate)' : 'color-mix(in srgb, var(--dp-accent) 15%, var(--dp-surface-elevated))'}
        stroke="var(--dp-accent)"
        strokeWidth={pressed ? 1.25 : 0.75}
        opacity={pressed ? 1 : 0.85}
      />
    </ShapeSvg>
  )
}

/* --- 3-way switch (SPDT / SP3T) -------------------------------------- */

function SwitchShape() {
  const { w, h } = shapeSizeCanvas('switch_3way')
  return (
    <ShapeSvg kind="switch_3way">
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={1.5}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 80%, var(--dp-bg))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* shaft */}
      <rect
        x={w / 2 - 1.5}
        y={h * 0.18}
        width={3}
        height={h * 0.34}
        rx={1.5}
        fill="var(--dp-border-strong)"
      />
      <circle cx={w / 2} cy={h * 0.18} r={2} fill="var(--dp-border-strong)" />
      {/* detent indicators */}
      <circle cx={w / 2} cy={h * 0.65} r={0.9} fill="var(--dp-text-dim)" />
      <circle cx={w / 2} cy={h * 0.78} r={0.9} fill="var(--dp-text-dim)" />
      <circle cx={w / 2} cy={h * 0.91} r={0.9} fill="var(--dp-text-dim)" />
    </ShapeSvg>
  )
}

/* --- Rotary encoder (knob body with shaft + switch contacts) --------- */

function EncoderShape({ level }: ShapeProps) {
  const { w, h } = shapeSizeCanvas('encoder')
  const cx = w / 2
  const cy = h / 2
  const outer = Math.min(w, h) * 0.46
  const inner = outer * 0.68
  const deg = ((level ?? 0.5) - 0.5) * 360
  return (
    <ShapeSvg kind="encoder">
      <circle
        cx={cx}
        cy={cy}
        r={outer}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 85%, var(--dp-bg))"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />
      {/* knurled ring */}
      {Array.from({ length: 24 }).map((_, i) => {
        const a = (i * Math.PI * 2) / 24
        const x1 = cx + Math.cos(a) * (outer - 1)
        const y1 = cy + Math.sin(a) * (outer - 1)
        const x2 = cx + Math.cos(a) * (outer - 2.5)
        const y2 = cy + Math.sin(a) * (outer - 2.5)
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="var(--dp-border)"
            strokeWidth="0.5"
            opacity="0.7"
          />
        )
      })}
      <circle
        cx={cx}
        cy={cy}
        r={inner}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 85%, var(--dp-border))"
        stroke="var(--dp-border)"
        strokeWidth="0.5"
      />
      <g transform={`rotate(${deg} ${cx} ${cy})`}>
        <line
          x1={cx}
          y1={cy - inner + 1.5}
          x2={cx}
          y2={cy - outer + 0.5}
          stroke="var(--dp-accent)"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      </g>
    </ShapeSvg>
  )
}

/* --- LED (surface-mount style, with lens) ---------------------------- */

function LedShape({ comp, level }: ShapeProps) {
  const { w, h } = shapeSizeCanvas('led')
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) / 2 - 0.5
  const color = colorOfLed(comp)
  const lit = Math.max(0, Math.min(1, level ?? 0))
  return (
    <ShapeSvg kind="led">
      <circle
        cx={cx}
        cy={cy}
        r={r + 1.2}
        fill={color}
        opacity={0.08 + lit * 0.45}
      />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 60%, var(--dp-bg))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.6"
      />
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.66}
        fill={color}
        opacity={0.25 + lit * 0.75}
      />
      <circle
        cx={cx - r * 0.18}
        cy={cy - r * 0.18}
        r={r * 0.18}
        fill="var(--dp-text)"
        opacity="0.3"
      />
    </ShapeSvg>
  )
}

function colorOfLed(comp: PlacedComponent): string {
  switch (String(comp.config.color ?? '')) {
    case 'red':   return 'var(--dp-danger)'
    case 'amber': return 'var(--dp-warning)'
    case 'green': return 'var(--dp-success)'
    case 'blue':  return 'var(--dp-signal-cv)'
    default:      return 'var(--dp-text)'
  }
}

/* --- Electret mic capsule (9.7mm disc + dotted grille) --------------- */

function ElectretShape() {
  const { w, h } = shapeSizeCanvas('electret')
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) / 2 - 0.5
  // Grille dots.
  const dots: { x: number; y: number }[] = []
  const step = r * 0.42
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const x = cx + i * step * 0.6
      const y = cy + j * step * 0.6
      if ((i * i + j * j) * step * step * 0.36 > r * r * 0.7) continue
      dots.push({ x, y })
    }
  }
  return (
    <ShapeSvg kind="electret">
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 85%, var(--dp-text-dim))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.8}
        fill="none"
        stroke="var(--dp-border)"
        strokeWidth="0.5"
      />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={0.6} fill="var(--dp-border-strong)" />
      ))}
    </ShapeSvg>
  )
}

/* --- Piezo disc. Bronze ring + inner plate + wire tails. ------------- */

function PiezoShape() {
  const { w, h } = shapeSizeCanvas('piezo')
  const cx = w / 2
  const cy = h / 2
  const outer = Math.min(w, h) / 2 - 1
  const inner = outer * 0.66
  return (
    <ShapeSvg kind="piezo">
      <circle
        cx={cx}
        cy={cy}
        r={outer}
        fill="color-mix(in srgb, var(--dp-warning) 35%, var(--dp-surface-elevated))"
        stroke="color-mix(in srgb, var(--dp-warning) 80%, var(--dp-border-strong))"
        strokeWidth="1"
      />
      <circle
        cx={cx}
        cy={cy}
        r={inner}
        fill="color-mix(in srgb, var(--dp-surface-elevated) 85%, var(--dp-border))"
        stroke="var(--dp-border)"
        strokeWidth="0.6"
      />
      <circle
        cx={cx}
        cy={cy}
        r={inner * 0.4}
        fill="color-mix(in srgb, var(--dp-border-strong) 70%, var(--dp-surface-sunken))"
      />
      {/* two solder pads / wire tails */}
      <circle cx={cx - inner * 0.55} cy={cy} r={1.2} fill="var(--dp-border-strong)" />
      <line
        x1={cx - inner * 0.55}
        y1={cy}
        x2={cx - outer - 3}
        y2={cy + 2}
        stroke="color-mix(in srgb, var(--dp-danger) 60%, var(--dp-border))"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy - inner * 0.1} r={0.9} fill="var(--dp-border-strong)" />
      <line
        x1={cx}
        y1={cy - inner * 0.1}
        x2={cx - outer - 3}
        y2={cy - 2}
        stroke="color-mix(in srgb, var(--dp-text-dim) 70%, var(--dp-border))"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
    </ShapeSvg>
  )
}

/* --- Jacks (gate, CV, audio, MIDI) ----------------------------------- */

function JackShape({ kind, withMidiRing }: { kind: HardwareKind; withMidiRing?: boolean }) {
  const { w, h } = shapeSizeCanvas(kind)
  const cx = w / 2
  const cy = h / 2
  const outer = Math.min(w, h) / 2 - 0.75
  return (
    <ShapeSvg kind={kind}>
      <circle
        cx={cx}
        cy={cy}
        r={outer}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 60%, var(--dp-border-strong))"
        stroke="var(--dp-border-strong)"
        strokeWidth="1"
      />
      <circle
        cx={cx}
        cy={cy}
        r={outer * 0.6}
        fill="var(--dp-bg)"
        stroke="var(--dp-border)"
        strokeWidth="0.5"
      />
      <circle cx={cx} cy={cy} r={outer * 0.22} fill="var(--dp-border-strong)" />
      {withMidiRing ? (
        <>
          {[60, 120, 180, 240, 300].map((a) => {
            const r = outer * 0.55
            const x = cx + Math.cos((a * Math.PI) / 180) * r
            const y = cy + Math.sin((a * Math.PI) / 180) * r
            return <circle key={a} cx={x} cy={y} r={0.6} fill="var(--dp-text-dim)" />
          })}
        </>
      ) : null}
    </ShapeSvg>
  )
}

/* --- OLED 128x64 breakout (roughly 27 × 27 mm incl. header) ---------- */

function OledShape() {
  const { w, h } = shapeSizeCanvas('oled_ssd1306')
  const padX = w * 0.08
  const padY = h * 0.12
  return (
    <ShapeSvg kind="oled_ssd1306">
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={2}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 90%, var(--dp-border-strong))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* display area */}
      <rect
        x={padX}
        y={padY}
        width={w - padX * 2}
        height={(w - padX * 2) * 0.5}
        fill="var(--dp-bg)"
        stroke="var(--dp-border)"
        strokeWidth="0.5"
      />
      {/* scan lines — faint hint of pixels */}
      {Array.from({ length: 4 }).map((_, i) => (
        <line
          key={i}
          x1={padX + 2}
          y1={padY + (i + 1) * 2}
          x2={w - padX - 2}
          y2={padY + (i + 1) * 2}
          stroke="var(--dp-accent)"
          strokeWidth="0.5"
          opacity="0.35"
        />
      ))}
      {/* header pins along the bottom */}
      {Array.from({ length: 4 }).map((_, i) => (
        <rect
          key={i}
          x={w * 0.25 + i * (w * 0.125)}
          y={h - padY * 0.6}
          width={2}
          height={2}
          fill="var(--dp-border-strong)"
        />
      ))}
    </ShapeSvg>
  )
}

/* --- I2S codec breakout (e.g. PCM5102) ------------------------------- */

function I2sShape() {
  const { w, h } = shapeSizeCanvas('i2s_codec')
  return (
    <ShapeSvg kind="i2s_codec">
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={1.5}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 85%, var(--dp-border))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* chip silhouette */}
      <rect
        x={w * 0.25}
        y={h * 0.25}
        width={w * 0.5}
        height={h * 0.5}
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.6"
      />
      <circle cx={w * 0.29} cy={h * 0.29} r="0.6" fill="var(--dp-border-strong)" />
    </ShapeSvg>
  )
}

/* =====================================================================
 * Labelled pad rows — shared by the pin-accurate breakout modules.
 *
 * Unlike the older shapes (which hint at a header with a few anonymous
 * rects at fractional offsets), these draw pads at real 0.1" pitch with
 * their silkscreen text, so a user can count pads against the board in
 * front of them. Pin 1 is square, the rest round — standard PCB
 * convention.
 *
 * Everything is `pointerEvents="none"`: the whole shape group already is
 * (HardwareView renders a separate transparent hit rect), so labels can
 * never steal a click from the component drag handler.
 * ===================================================================== */

/** Pad pitch in canvas units. */
const PITCH = HEADER_PITCH_MM * MM_PER_UNIT

const PAD_R = 2.4
const PAD_HOLE_R = 1.1
const PAD_FONT = 4.2

function Pad({ cx, cy, first }: { cx: number; cy: number; first?: boolean }) {
  return (
    <>
      {first ? (
        <rect
          x={cx - PAD_R}
          y={cy - PAD_R}
          width={PAD_R * 2}
          height={PAD_R * 2}
          fill="var(--dp-warning)"
          opacity="0.85"
        />
      ) : (
        <circle cx={cx} cy={cy} r={PAD_R} fill="var(--dp-border-strong)" />
      )}
      <circle cx={cx} cy={cy} r={PAD_HOLE_R} fill="var(--dp-bg)" />
    </>
  )
}

/**
 * A row (or column) of labelled header pads.
 *
 * `x`/`y` is the center of the first pad. `dir` is the direction pads
 * advance. `labelDir` pushes the text away from the pad — use the side
 * that points into the board body so labels don't collide with the
 * component's role dots, which live outside the silhouette.
 */
function PadRow({
  x,
  y,
  labels,
  dir = 'row',
  labelDir = 'down'
}: {
  x: number
  y: number
  labels: string[]
  dir?: 'row' | 'col'
  labelDir?: 'up' | 'down' | 'left' | 'right'
}) {
  const dx = dir === 'row' ? PITCH : 0
  const dy = dir === 'col' ? PITCH : 0
  const off = PAD_R + 1.4
  const tx = labelDir === 'left' ? -off : labelDir === 'right' ? off : 0
  const ty = labelDir === 'up' ? -off : labelDir === 'down' ? off + PAD_FONT * 0.5 : 0
  const anchor =
    labelDir === 'left' ? 'end' : labelDir === 'right' ? 'start' : 'middle'

  return (
    <g pointerEvents="none">
      {labels.map((label, i) => {
        const cx = x + dx * i
        const cy = y + dy * i
        return (
          <g key={`${label}-${i}`}>
            <Pad cx={cx} cy={cy} first={i === 0} />
            <text
              x={cx + tx}
              y={cy + ty}
              fontSize={PAD_FONT}
              fontFamily="var(--dp-font-mono)"
              fill="var(--dp-text-dim)"
              textAnchor={anchor}
              dominantBaseline={dir === 'col' ? 'middle' : 'auto'}
            >
              {label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/* --- GY-PCM5102 line-out DAC (27×19 mm purple board + 3.5mm jack) ----
 *
 * Two 6-pad headers on the long edges. The I2S/power row carries the
 * three pads we actually bind (BCK/LCK/DIN); the opposite row is the
 * config strapping (FLT/DEMP/XSMT/FMT) plus analog supply, drawn but not
 * bindable — those are jumper-set, not wired to the MCU.
 *
 * Silkscreen ORDER here follows the ordering cited consistently across
 * the community wiring guides. Worth an eyeball against a physical board:
 * the pad SET and their functions are well established, the left-to-right
 * sequence is not authoritatively published anywhere I could find.
 */
function Pcm5102aShape() {
  const { w, h } = shapeSizeCanvas('pcm5102a')
  const rowW = PITCH * 5
  const x0 = (w - rowW) / 2

  return (
    <ShapeSvg kind="pcm5102a">
      {/* board */}
      <rect
        x={0.75}
        y={0.75}
        width={w - 1.5}
        height={h - 1.5}
        rx={2}
        fill="color-mix(in srgb, var(--dp-accent) 16%, var(--dp-surface-sunken))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* PCM5102A chip (TSSOP-20) */}
      <rect
        x={w * 0.3}
        y={h * 0.38}
        width={w * 0.28}
        height={h * 0.24}
        rx={0.6}
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.5"
      />
      <circle cx={w * 0.33} cy={h * 0.43} r="0.7" fill="var(--dp-border-strong)" />
      {/* 3.5mm jack barrel on the right edge */}
      <rect
        x={w - 7.5}
        y={h * 0.34}
        width={6.75}
        height={h * 0.32}
        rx={1.5}
        fill="var(--dp-surface)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.6"
      />
      <circle
        cx={w - 4.1}
        cy={h * 0.5}
        r="2"
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.5"
      />
      {/* four config solder jumpers (H1L..H4L) */}
      {Array.from({ length: 4 }).map((_, i) => (
        <rect
          key={i}
          x={w * 0.18 + i * 3.2}
          y={h - 20}
          width={2}
          height={3}
          rx={0.4}
          fill="var(--dp-border)"
        />
      ))}
      {/* I2S + power header (bindable side) */}
      <PadRow
        x={x0}
        y={5}
        labels={['SCK', 'BCK', 'DIN', 'LCK', 'GND', 'VIN']}
        labelDir="down"
      />
      {/* config / analog header */}
      <PadRow
        x={x0}
        y={h - 5}
        labels={['FLT', 'DEMP', 'XSMT', 'FMT', 'A3V3', 'AGND']}
        labelDir="up"
      />
    </ShapeSvg>
  )
}

/* --- MAX98357A I2S class-D mono amp (Adafruit 21.2×16.6 mm) ----------
 *
 * One 7-pad header (LRC/BCLK/DIN/GAIN/SD/GND/Vin) and a 2-pole screw
 * terminal for the bridge-tied speaker output. GAIN and SD are drawn but
 * not bindable — see the KIND_ROLES note; they are resistor-strapped, and
 * the inspector exposes them as config.
 */
function Max98357aShape() {
  const { w, h } = shapeSizeCanvas('max98357a')
  const rowW = PITCH * 6
  const x0 = (w - rowW) / 2

  return (
    <ShapeSvg kind="max98357a">
      <rect
        x={0.75}
        y={0.75}
        width={w - 1.5}
        height={h - 1.5}
        rx={2}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 88%, var(--dp-border))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* MAX98357A chip (TQFN-16) */}
      <rect
        x={w * 0.36}
        y={h * 0.4}
        width={w * 0.24}
        height={h * 0.22}
        rx={0.6}
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.5"
      />
      <circle cx={w * 0.39} cy={h * 0.45} r="0.7" fill="var(--dp-border-strong)" />
      {/* speaker screw terminal, top edge */}
      <rect
        x={w * 0.26}
        y={2}
        width={w * 0.48}
        height={5.5}
        rx={0.8}
        fill="var(--dp-surface)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.6"
      />
      {[0.36, 0.64].map((f) => (
        <circle
          key={f}
          cx={w * f}
          cy={4.75}
          r="1.5"
          fill="var(--dp-bg)"
          stroke="var(--dp-border-strong)"
          strokeWidth="0.4"
        />
      ))}
      <text
        x={w / 2}
        y={11.5}
        fontSize={PAD_FONT}
        fontFamily="var(--dp-font-mono)"
        fill="var(--dp-text-dim)"
        textAnchor="middle"
        pointerEvents="none"
      >
        SPK +/-
      </text>
      {/* signal + power header, bottom edge */}
      <PadRow
        x={x0}
        y={h - 5}
        labels={['LRC', 'BCLK', 'DIN', 'GAIN', 'SD', 'GND', 'Vin']}
        labelDir="up"
      />
    </ShapeSvg>
  )
}

/* --- Gyro / IMU breakout (15×15 mm square PCB) ----------------------- */

function GyroShape() {
  const { w, h } = shapeSizeCanvas('gyroscope')
  return (
    <ShapeSvg kind="gyroscope">
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={1}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 90%, var(--dp-signal-gate) 6%)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      <rect
        x={w * 0.3}
        y={h * 0.3}
        width={w * 0.4}
        height={h * 0.4}
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.5"
      />
      {/* pin 1 marker */}
      <circle cx={w * 0.18} cy={h * 0.18} r="0.8" fill="var(--dp-border-strong)" />
      {/* stylised axis arcs */}
      <path
        d={`M ${w * 0.35} ${h * 0.5} q ${w * 0.15} -${h * 0.18} ${w * 0.3} 0`}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth="0.6"
        opacity="0.7"
      />
      <path
        d={`M ${w * 0.5} ${h * 0.35} q ${w * 0.18} ${h * 0.15} 0 ${h * 0.3}`}
        fill="none"
        stroke="var(--dp-accent)"
        strokeWidth="0.6"
        opacity="0.7"
      />
    </ShapeSvg>
  )
}

/* --- Magnetometer breakout ------------------------------------------- */

function MagnetometerShape() {
  const { w, h } = shapeSizeCanvas('magnetometer')
  return (
    <ShapeSvg kind="magnetometer">
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={1}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 90%, var(--dp-signal-cv) 5%)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* compass rose */}
      <circle
        cx={w / 2}
        cy={h / 2}
        r={Math.min(w, h) * 0.28}
        fill="none"
        stroke="var(--dp-border)"
        strokeWidth="0.5"
      />
      <path
        d={`M ${w / 2} ${h * 0.22} L ${w * 0.56} ${h / 2} L ${w / 2} ${h / 2} Z`}
        fill="var(--dp-accent)"
        opacity="0.85"
      />
      <path
        d={`M ${w / 2} ${h / 2} L ${w * 0.44} ${h / 2} L ${w / 2} ${h * 0.78} Z`}
        fill="var(--dp-text-dim)"
        opacity="0.6"
      />
    </ShapeSvg>
  )
}

/* --- Time-of-flight distance sensor (VL53L0X). 11×21 mm breakout. ---- */

function TofShape() {
  const { w, h } = shapeSizeCanvas('tof')
  return (
    <ShapeSvg kind="tof">
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={1}
        fill="color-mix(in srgb, var(--dp-surface-sunken) 90%, var(--dp-border))"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.75"
      />
      {/* Emitter/receiver window — a dark circle offset near the top */}
      <circle
        cx={w / 2}
        cy={h * 0.28}
        r={Math.min(w * 0.42, 6)}
        fill="var(--dp-bg)"
        stroke="var(--dp-border-strong)"
        strokeWidth="0.5"
      />
      {/* Subtle pin header hint */}
      {Array.from({ length: 4 }).map((_, i) => (
        <rect
          key={i}
          x={w * 0.2 + i * w * 0.2}
          y={h - 3}
          width={1.2}
          height={1.8}
          fill="var(--dp-border-strong)"
        />
      ))}
    </ShapeSvg>
  )
}

/* =====================================================================
 * Public: render the shape for a placed component.
 * ===================================================================== */

export function renderComponentShape(comp: PlacedComponent, level?: number): ReactElement {
  switch (comp.kind) {
    case 'pot':          return <PotShape comp={comp} level={level} />
    case 'slider':       return <SliderShape comp={comp} level={level} />
    case 'touch_ribbon': return <TouchRibbonShape comp={comp} level={level} />
    case 'ldr':          return <LdrShape />
    case 'button':       return <ButtonShape comp={comp} level={level} />
    case 'switch_3way':  return <SwitchShape />
    case 'encoder':      return <EncoderShape comp={comp} level={level} />
    case 'led':          return <LedShape comp={comp} level={level} />
    case 'electret':     return <ElectretShape />
    case 'piezo':        return <PiezoShape />
    case 'gate_jack':    return <JackShape kind="gate_jack" />
    case 'cv_jack':      return <JackShape kind="cv_jack" />
    case 'audio_jack':   return <JackShape kind="audio_jack" />
    case 'midi_jack':    return <JackShape kind="midi_jack" withMidiRing />
    case 'oled_ssd1306': return <OledShape />
    case 'i2s_codec':    return <I2sShape />
    case 'pcm5102a':     return <Pcm5102aShape />
    case 'max98357a':    return <Max98357aShape />
    case 'gyroscope':    return <GyroShape />
    case 'magnetometer': return <MagnetometerShape />
    case 'tof':          return <TofShape />
  }
}
