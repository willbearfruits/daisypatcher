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

export interface BoardPinout {
  id: BoardId
  label: string
  pins: PinCapabilities[]
  pinCaps: Record<string, PinCapabilities>
  physicalLayout: BoardPhysicalPinPosition[]
  pinsInOrder: string[]
  pinsForRole(role: string, kind: string): string[]
  /** -1 if not ADC-capable. ESP32 returns 0..9 for ADC1, 100..107 for ADC2. */
  adcChannelOf(pin: string): number
}

const SEED_BOARD: BoardPinout = {
  id: 'daisy_seed',
  label: 'Daisy Seed',
  pins: DAISY_SEED_PINS,
  pinCaps: PIN_CAPS as unknown as Record<string, PinCapabilities>,
  physicalLayout: PHYSICAL_PIN_LAYOUT as ReadonlyArray<PhysicalPinPosition> as BoardPhysicalPinPosition[],
  pinsInOrder: SEED_PINS_IN_ORDER as string[],
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
  pinsForRole: esp32PinsForRole,
  adcChannelOf: esp32AdcChannelOf
}

const PINOUTS: Record<BoardId, BoardPinout> = {
  daisy_seed: SEED_BOARD,
  esp32_s3_devkitc: ESP32_BOARD
}

export function getBoardPinout(id: BoardId): BoardPinout {
  return PINOUTS[id] ?? SEED_BOARD
}
