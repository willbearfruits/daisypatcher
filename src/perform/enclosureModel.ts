/**
 * enclosureModel — pure geometric model of the physical stompbox implied
 * by a HardwareLayout. NO rendering concerns live here: the Perform view's
 * Powder-coat renderer, a future Silkscreen mode, and the drill-template
 * export all consume this same model.
 *
 * Everything is in MILLIMETERS. `PlacedComponent.position` is stored in
 * hardware-view canvas units (MM_PER_UNIT = 3 canvas units per mm — see
 * `src/hardware/componentShapes.tsx`); this module converts once on the
 * way in and never thinks in canvas units again.
 *
 * Auto-sizing: the bounding box of all placed components (rotated bounds)
 * plus `FACE_PADDING_MM` per side, snapped UP to the smallest standard
 * Hammond enclosure that fits — both orientations are tried. If nothing
 * fits, the padded bounding box is used directly ("custom" enclosure).
 * Components keep their true relative positions; the enclosure is centered
 * around them.
 */

import type { HardwareKind, HardwareLayout, PlacedComponent } from '@/types/hardware'
import { MM_PER_UNIT, SHAPE_DIMENSIONS, rotationOf } from '@/hardware/componentShapes'

/** Whitespace between the component bounding box and the enclosure edge. */
export const FACE_PADDING_MM = 10

/**
 * Standard Hammond die-cast sizes (face length x width, mm), smallest
 * first. The fitter tries both orientations of each.
 */
export const STANDARD_ENCLOSURES: ReadonlyArray<{ name: string; w: number; h: number }> = [
  { name: '1590A', w: 92, h: 38.5 },
  { name: '1590B', w: 112, h: 60 },
  { name: '125B', w: 122, h: 66.5 },
  { name: '1590BB', w: 119, h: 94 },
  { name: '1590XX', w: 145, h: 121 },
  { name: '1590DD', w: 188, h: 119.5 }
]

/** Panel drill diameter (mm) per component kind. 0 = no faceplate hole. */
const HOLE_DIAMETER_MM: Record<HardwareKind, number> = {
  pot: 7, // 16mm Alpha bushing
  slider: 0, // slot cutout instead (see cutout below)
  touch_ribbon: 0, // surface-mounted on the face
  ldr: 5,
  button: 12, // 3PDT footswitch
  switch_3way: 6.35, // 1/4" toggle bushing
  encoder: 7,
  led: 5,
  electret: 6,
  piezo: 0, // internal, glued to the lid
  gate_jack: 6, // 3.5mm jack bushing
  cv_jack: 6,
  audio_jack: 9.5, // 1/4" jack
  midi_jack: 14.5, // DIN5 panel hole
  oled_ssd1306: 0, // rectangular window cutout instead
  i2s_codec: 0, // internal board, no faceplate presence
  gyroscope: 0,
  magnetometer: 0,
  tof: 4 // sensor window
}

/** Rectangular cutouts (mm) for kinds whose hole isn't a drill. */
function cutoutFor(kind: HardwareKind): { w: number; h: number } | null {
  switch (kind) {
    case 'oled_ssd1306':
      // 0.96" SSD1306 visible area is ~21.7 x 10.9; window with margin.
      return { w: 25, h: 13 }
    case 'slider': {
      // Travel slot: narrow, along the long axis of the footprint.
      const d = SHAPE_DIMENSIONS.slider
      return { w: 4, h: Math.max(20, d.h - 12) }
    }
    default:
      return null
  }
}

export interface EnclosureComponent {
  comp: PlacedComponent
  /** Shape center in enclosure mm space (0,0 = enclosure top-left). */
  cx: number
  cy: number
  rotation: 0 | 90 | 180 | 270
  /** Natural (unrotated) footprint in mm. */
  size: { w: number; h: number }
  /** Axis-aligned bounds of the rotated footprint in mm. */
  bounds: { w: number; h: number }
}

export interface EnclosureHole {
  componentId: string
  kind: HardwareKind
  /** Hole center in enclosure mm space. */
  cx: number
  cy: number
  /** Drill diameter (mm); 0 when the hole is a rectangular cutout. */
  diameter: number
  /**
   * Rectangular cutout (mm), pre-rotation (rotates with `rotation` about
   * the center). Present for OLED windows and slider slots.
   */
  cutout: { w: number; h: number } | null
  rotation: 0 | 90 | 180 | 270
}

export interface EnclosureModel {
  /** Faceplate size in mm. */
  width: number
  height: number
  /** Matched standard enclosure name, or null for a custom size. */
  standard: string | null
  /**
   * Translation (mm) from the hardware view's coordinate frame into
   * enclosure space: `enclosure_cx = raw_cx + offsetX`. Exposed so the
   * Perform view's ARRANGE drag can freeze the frame for the duration of
   * a gesture (see `EnclosureFrame`) and keep 1:1 cursor tracking while
   * the content bounding box changes underneath it.
   */
  offsetX: number
  offsetY: number
  components: EnclosureComponent[]
  /** Faceplate holes/cutouts — the drill template. */
  holes: EnclosureHole[]
}

/**
 * A frozen enclosure viewport: face size + the hardware→enclosure offset,
 * without per-component data. Captured at ARRANGE-drag start so the face
 * and every non-dragged component hold still while one component moves;
 * the full model (Hammond re-snap + re-center) is rebuilt on release.
 */
export interface EnclosureFrame {
  width: number
  height: number
  standard: string | null
  offsetX: number
  offsetY: number
}

/**
 * Stage raw placed components into enclosure space under a given offset.
 * Pure; used by `buildEnclosureModel` (with its computed centering offset)
 * and by the Perform view's drag path (with a frozen `EnclosureFrame`).
 */
export function stageComponents(
  components: PlacedComponent[],
  offsetX: number,
  offsetY: number
): EnclosureComponent[] {
  return components.map((comp) => {
    const size = SHAPE_DIMENSIONS[comp.kind] ?? { w: 10, h: 10 }
    const rotation = rotationOf(comp)
    const bounds = rotatedBounds(comp.kind, rotation)
    // position is the shape's top-left in canvas units; rotation pivots on
    // the natural center, so center = position + natural size / 2.
    const cx = (comp.position.x + (size.w * MM_PER_UNIT) / 2) / MM_PER_UNIT + offsetX
    const cy = (comp.position.y + (size.h * MM_PER_UNIT) / 2) / MM_PER_UNIT + offsetY
    return { comp, cx, cy, rotation, size, bounds }
  })
}

/** Rotated axis-aligned bounds of a kind's footprint. */
function rotatedBounds(
  kind: HardwareKind,
  rotation: 0 | 90 | 180 | 270
): { w: number; h: number } {
  const d = SHAPE_DIMENSIONS[kind]
  const swap = rotation === 90 || rotation === 270
  return swap ? { w: d.h, h: d.w } : { w: d.w, h: d.h }
}

/**
 * Pick the smallest standard enclosure that contains `w x h` (content plus
 * padding), trying both orientations. Returns the oriented face size, or
 * null when nothing fits.
 */
function fitStandard(
  w: number,
  h: number
): { name: string; width: number; height: number } | null {
  for (const enc of STANDARD_ENCLOSURES) {
    const fitsUpright = w <= enc.w && h <= enc.h
    const fitsRotated = w <= enc.h && h <= enc.w
    if (!fitsUpright && !fitsRotated) continue
    if (fitsUpright && fitsRotated) {
      // Both orientations fit — orient the face to match the content
      // (tall content gets the portrait face).
      const portrait = h >= w
      const [lo, hi] = enc.w <= enc.h ? [enc.w, enc.h] : [enc.h, enc.w]
      return portrait
        ? { name: enc.name, width: lo, height: hi }
        : { name: enc.name, width: hi, height: lo }
    }
    return fitsUpright
      ? { name: enc.name, width: enc.w, height: enc.h }
      : { name: enc.name, width: enc.h, height: enc.w }
  }
  return null
}

/**
 * Build the enclosure model from a hardware layout. Pure function of its
 * argument — safe to memoize on the layout's `components` array identity.
 */
export function buildEnclosureModel(layout: HardwareLayout): EnclosureModel {
  const placed = layout.components

  if (placed.length === 0) {
    // Nothing placed: return the classic pedal blank so callers that DO
    // render an empty enclosure have a sane default.
    return {
      width: 112,
      height: 60,
      standard: '1590B',
      offsetX: 0,
      offsetY: 0,
      components: [],
      holes: []
    }
  }

  // 1. Component centers + rotated bounds, in the hardware view's mm frame.
  const staged = stageComponents(placed, 0, 0)

  // 2. Content bounding box (mm).
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of staged) {
    minX = Math.min(minX, s.cx - s.bounds.w / 2)
    maxX = Math.max(maxX, s.cx + s.bounds.w / 2)
    minY = Math.min(minY, s.cy - s.bounds.h / 2)
    maxY = Math.max(maxY, s.cy + s.bounds.h / 2)
  }
  const contentW = maxX - minX
  const contentH = maxY - minY
  const neededW = contentW + FACE_PADDING_MM * 2
  const neededH = contentH + FACE_PADDING_MM * 2

  // 3. Snap up to a standard enclosure, or fall back to the padded box.
  const std = fitStandard(neededW, neededH)
  const width = std ? std.width : neededW
  const height = std ? std.height : neededH

  // 4. Center the content on the face: translate hardware-frame mm coords
  //    into enclosure space.
  const offsetX = (width - contentW) / 2 - minX
  const offsetY = (height - contentH) / 2 - minY

  const components: EnclosureComponent[] = staged.map((s) => ({
    ...s,
    cx: s.cx + offsetX,
    cy: s.cy + offsetY
  }))

  // 5. Holes — one per component that penetrates the faceplate.
  const holes: EnclosureHole[] = []
  for (const c of components) {
    const diameter = HOLE_DIAMETER_MM[c.comp.kind] ?? 0
    const cutout = cutoutFor(c.comp.kind)
    if (diameter <= 0 && !cutout) continue
    holes.push({
      componentId: c.comp.id,
      kind: c.comp.kind,
      cx: c.cx,
      cy: c.cy,
      diameter: cutout ? 0 : diameter,
      cutout,
      rotation: c.rotation
    })
  }

  return {
    width,
    height,
    standard: std ? std.name : null,
    offsetX,
    offsetY,
    components,
    holes
  }
}
