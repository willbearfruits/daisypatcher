/**
 * Where a component goes when nobody dropped it anywhere in particular.
 *
 * Two paths create components without a pointer position: dropping a
 * hardware-category NODE in the patch view (the auto-link), and anything a
 * script or the assistant places. Those used to cascade from (100, 100) —
 * i.e. into the pin-label column on the left of the board, on top of the
 * text, so the first knob you added sat across the labels of D15–D18.
 *
 * The one place guaranteed clear on every board is the band BELOW it: no
 * pins, no labels, and the wires drop straight down to their pins. Fill it
 * left to right, at a pitch that keeps knobs from touching, and start a
 * new row when the band is full. Existing components are respected —
 * the next slot is the first one nothing already occupies.
 *
 * Dependency-free (types + the two geometry helpers) so the store and the
 * example builder can both use it.
 */
import type { HardwareKind, HardwareLayout } from '@/types/hardware'
import { getBoardPinout, resolveGeometry } from './boardPinout'
import { shapeSizeCanvas } from './componentShapes'

/** Must match `HardwareView.tsx`'s canvas width; only used to centre. */
const CANVAS_W = 1400
const PITCH = 65
const ROW_GAP = 90
const COLS = 12

export function nextFreePosition(
  layout: HardwareLayout,
  kind: HardwareKind
): { x: number; y: number } {
  const g = resolveGeometry(getBoardPinout(layout.board), CANVAS_W)
  const sz = shapeSizeCanvas(kind)
  // Row baseline: under the board with room for the USB shell, plus half
  // the part so its top edge clears the board.
  const y0 = g.boardY + g.boardH + 60 + sz.h / 2
  const x0 = g.boardX - 200 // start under the left label column
  const taken = layout.components.map((c) => c.position)
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = x0 + col * PITCH
      const y = y0 + row * ROW_GAP
      const clash = taken.some((p) => Math.abs(p.x - x) < PITCH * 0.6 && Math.abs(p.y - y) < ROW_GAP * 0.6)
      if (!clash) return { x, y }
    }
  }
  // Absurd fallback — ninety-six parts already under the board.
  return { x: x0, y: y0 + 8 * ROW_GAP }
}
