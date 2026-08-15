/**
 * Board-agnostic pinout facade. Returns the active board's pin table,
 * physical layout, and role-lookup helpers so the hardware view /
 * inspector / codegen all stay board-agnostic.
 *
 * The idea is simple: call `getBoardPinout(boardId)` once and use the
 * returned object instead of importing `daisySeedPinout` directly. This
 * is the same pattern as the codegen `TARGETS` table — one per board.
 */
import type { BoardId, PinCapabilities } from '@/types/hardware'
import {
  DAISY_SEED_PINS,
  PHYSICAL_PIN_LAYOUT,
  PIN_CAPS,
  SEED_PINS_IN_ORDER,
  pinsForRole as seedPinsForRole,
  adcChannelOf as seedAdcChannelOf
} from './daisySeedPinout'
import type { PhysicalPinPosition } from './daisySeedPinout'
import {
  ESP32_S3_PINS,
  ESP32_S3_PHYSICAL_LAYOUT,
  ESP32_S3_PIN_CAPS,
  ESP32_S3_PINS_IN_ORDER,
  esp32PinsForRole,
  esp32AdcChannelOf
} from './esp32s3Pinout'
import type { Esp32PhysicalPinPosition } from './esp32s3Pinout'
import {
  ESP32_C3_SM_PINS,
  ESP32_C3_SM_PIN_CAPS,
  ESP32_C3_SM_PHYSICAL_LAYOUT,
  ESP32_C3_SM_PINS_IN_ORDER,
  ESP32_C3_SM_GEOMETRY,
  esp32C3SmPinsForRole,
  esp32C3SmAdcChannelOf
} from './esp32C3SuperMiniPinout'
import {
  ESP32_S3_SM_PINS,
  ESP32_S3_SM_PIN_CAPS,
  ESP32_S3_SM_PHYSICAL_LAYOUT,
  ESP32_S3_SM_PINS_IN_ORDER,
  ESP32_S3_SM_GEOMETRY,
  esp32S3SmPinsForRole,
  esp32S3SmAdcChannelOf
} from './esp32S3SuperMiniPinout'

/**
 * Geometry for the two original boards. Values lifted verbatim from the
 * old `HardwareView.tsx` module constants so their rendering is unchanged.
 */
const CLASSIC_GEOMETRY = {
  boardW: 260,
  boardH: 1000,
  boardY: 240,
  pinEdgeInset: 14,
  rowTopMargin: 30,
  rowBottomMargin: 30,
  leftColumnBottomUp: true
} as const

/** Unified physical-pin-position shape. */
export interface BoardPhysicalPinPosition {
  pin: string
  /** `left`/`right` for the two main header columns; `bottom` for
   *  off-header test pads (e.g. Daisy Seed D0 / Seed 2 DFM D31). */
  side: 'left' | 'right' | 'bottom'
  index: number
  label: string
  /** Physical pin number on the board header as silkscreened (1..40 on
   *  Seed). Only present on Seed rows today; optional per-board. */
  pinNumber?: number
}

/**
 * How a board is drawn. Used to live as module constants in
 * `HardwareView.tsx` (`BOARD_W`, `BOARD_H`, `ROWS_PER_SIDE = 20`), which
 * worked only because both original boards happened to have exactly 20
 * pins per side. A SuperMini has 8.
 *
 * Note what is NOT here: the row count. It is derived from
 * `physicalLayout` (see `resolveGeometry`) so the drawing can never drift
 * out of sync with the pin list — the row count IS the pin list.
 */
export interface BoardGeometry {
  /** Silhouette box in canvas units. X is centred by `resolveGeometry`. */
  boardW: number
  boardH: number
  boardY: number
  /** Board edge → pin-dot centre. */
  pinEdgeInset: number
  rowTopMargin: number
  rowBottomMargin: number
  /**
   * Render the left column bottom-up (index 0 at the BOTTOM).
   *
   * True for Daisy Seed and the S3 DevKitC. Both of those data files
   * comment their left column as running top-to-bottom, yet the original
   * renderer reversed it — so the Seed's pin 40 has always drawn at the
   * bottom. That may well be a long-standing bug, but flipping it now
   * would silently invert the mental map of every existing patch, so it
   * is preserved per-board rather than "fixed". New boards declare their
   * own truth.
   */
  leftColumnBottomUp: boolean
  /** Which silhouette artwork to draw. */
  silhouette: 'seed' | 'esp32_devkit' | 'esp32_supermini'
}

export interface BoardPinout {
  id: BoardId
  label: string
  pins: PinCapabilities[]
  pinCaps: Record<string, PinCapabilities>
  physicalLayout: BoardPhysicalPinPosition[]
  pinsInOrder: string[]
  geometry: BoardGeometry
  pinsForRole(role: string, kind: string): string[]
  /** -1 if not ADC-capable. ESP32 returns 0..9 for ADC1, 100..107 for ADC2. */
  adcChannelOf(pin: string): number
  /**
   * Set when the pin table is a best guess rather than a documented one.
   *
   * A board whose silkscreen order we could not confirm still has to be
   * usable, but the user must be able to SEE that it is unconfirmed — a
   * caveat that only exists in a source comment reaches nobody holding the
   * board. The hardware view captions the board with this string.
   */
  provisional?: string
}

/** Geometry with the derived values the view actually draws with. */
export interface ResolvedGeometry extends BoardGeometry {
  boardX: number
  leftCount: number
  rightCount: number
  /** Vertical distance between adjacent pins, in canvas units. */
  pitch: number
}

/**
 * Derive drawing values from a board's declared geometry + pin list.
 *
 * For the two original boards (20 left, 20 right, boardH 1000, margins 30)
 * `pitch` evaluates to `(1000 - 30 - 30) / 19` — the identical expression
 * the old module-level `PIN_SPACING` used, so their rendering is unchanged
 * to the pixel.
 */
export function resolveGeometry(p: BoardPinout, canvasW: number): ResolvedGeometry {
  const g = p.geometry
  let leftCount = 0
  let rightCount = 0
  for (const x of p.physicalLayout) {
    if (x.side === 'left') leftCount++
    else if (x.side === 'right') rightCount++
  }
  const rows = Math.max(leftCount, rightCount)
  const pitch = rows > 1 ? (g.boardH - g.rowTopMargin - g.rowBottomMargin) / (rows - 1) : 0
  return {
    ...g,
    boardX: (canvasW - g.boardW) / 2,
    leftCount,
    rightCount,
    pitch
  }
}

const SEED_BOARD: BoardPinout = {
  id: 'daisy_seed',
  label: 'Daisy Seed',
  pins: DAISY_SEED_PINS,
  pinCaps: PIN_CAPS as unknown as Record<string, PinCapabilities>,
  physicalLayout: PHYSICAL_PIN_LAYOUT as ReadonlyArray<PhysicalPinPosition> as BoardPhysicalPinPosition[],
  pinsInOrder: SEED_PINS_IN_ORDER as string[],
  geometry: { ...CLASSIC_GEOMETRY, silhouette: 'seed' },
  pinsForRole: (role, kind) => seedPinsForRole(role, kind) as string[],
  adcChannelOf: (pin) => seedAdcChannelOf(pin as Parameters<typeof seedAdcChannelOf>[0])
}

const ESP32_BOARD: BoardPinout = {
  id: 'esp32_s3_devkitc',
  label: 'ESP32-S3 DevKitC',
  pins: ESP32_S3_PINS,
  pinCaps: ESP32_S3_PIN_CAPS,
  physicalLayout: ESP32_S3_PHYSICAL_LAYOUT as ReadonlyArray<Esp32PhysicalPinPosition> as BoardPhysicalPinPosition[],
  pinsInOrder: ESP32_S3_PINS_IN_ORDER,
  geometry: { ...CLASSIC_GEOMETRY, silhouette: 'esp32_devkit' },
  pinsForRole: esp32PinsForRole,
  adcChannelOf: esp32AdcChannelOf
}

const ESP32_C3_SM_BOARD: BoardPinout = {
  id: 'esp32_c3_supermini',
  label: 'ESP32-C3 SuperMini',
  pins: ESP32_C3_SM_PINS,
  pinCaps: ESP32_C3_SM_PIN_CAPS,
  physicalLayout: ESP32_C3_SM_PHYSICAL_LAYOUT,
  pinsInOrder: ESP32_C3_SM_PINS_IN_ORDER,
  geometry: ESP32_C3_SM_GEOMETRY,
  pinsForRole: esp32C3SmPinsForRole,
  adcChannelOf: esp32C3SmAdcChannelOf
}

const ESP32_S3_SM_BOARD: BoardPinout = {
  id: 'esp32_s3_supermini',
  label: 'ESP32-S3 SuperMini',
  pins: ESP32_S3_SM_PINS,
  pinCaps: ESP32_S3_SM_PIN_CAPS,
  physicalLayout: ESP32_S3_SM_PHYSICAL_LAYOUT,
  pinsInOrder: ESP32_S3_SM_PINS_IN_ORDER,
  geometry: ESP32_S3_SM_GEOMETRY,
  pinsForRole: esp32S3SmPinsForRole,
  adcChannelOf: esp32S3SmAdcChannelOf,
  /*
   * "ESP32-S3 SuperMini" is not a standardised board. No authoritative
   * pinout exists, the two published sources contradict each other, and one
   * lists GPIO26-32 as free when those are flash/PSRAM pins on every S3.
   * The table shipped here is the conservative intersection: GPIOs safe on
   * any ESP32-S3-WROOM-1.
   *
   * Correcting it is one data file — `esp32S3SuperMiniPinout.ts`.
   */
  provisional: 'pin order unverified — check against your board'
}

/**
 * `satisfies` rather than an annotation: adding an id to `BOARD_IDS`
 * without a pinout becomes a compile error here, instead of silently
 * hitting a Daisy fallback and rendering an ESP32 as a Seed.
 */
const PINOUTS = {
  daisy_seed: SEED_BOARD,
  esp32_s3_devkitc: ESP32_BOARD,
  esp32_c3_supermini: ESP32_C3_SM_BOARD,
  esp32_s3_supermini: ESP32_S3_SM_BOARD
} satisfies Record<BoardId, BoardPinout>

/** No fallback — the table is total. See `getTarget` for the same reasoning. */
export function getBoardPinout(id: BoardId): BoardPinout {
  return PINOUTS[id]
}
