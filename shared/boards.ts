/**
 * boards — the single source of truth for which boards exist.
 *
 * This module is deliberately dependency-free so BOTH tsconfig projects can
 * include it: the renderer (`tsconfig.web.json`, which only knows `src/**`
 * and the `@/*` alias) and the Electron main/preload bundle
 * (`tsconfig.node.json`, which only knows `electron/**`). Import it by
 * relative path from either side.
 *
 * Why it exists: the board identity used to be TWO unions — `BoardId` (the
 * hardware layout's board, persisted in `.dpatch`) and `BoardTarget` (the
 * codegen/build target) — joined by a pair of fallback ternaries, and then
 * independently re-declared four more times across `electron/`. Every
 * consumer was a binary ternary or an `=== 'esp32_s3'` check, so widening
 * the set produced ZERO compile errors and silently routed new boards down
 * the Daisy branch. With three ESP32 boards that is not survivable.
 *
 * The two unions are now one. `BoardId`'s spelling won because it is the
 * one written into `.dpatch` files on disk — user data we must not break —
 * and because it names a *board* (`esp32_s3_devkitc`) rather than a *chip*
 * (`esp32_s3`), which matters the moment two different boards carry the
 * same chip. See WORKSPACE_DIR / VERIFICATION_ALIASES below for how the
 * old `'esp32_s3'` spelling is kept alive where it was already persisted.
 */

export const BOARD_IDS = [
  'daisy_seed',
  'esp32_s3_devkitc',
  'esp32_c3_supermini',
  'esp32_s3_supermini'
] as const

export type BoardId = (typeof BOARD_IDS)[number]

export type BoardFamily = 'daisy' | 'esp32'

export const BOARD_FAMILY = {
  daisy_seed: 'daisy',
  esp32_s3_devkitc: 'esp32',
  esp32_c3_supermini: 'esp32',
  esp32_s3_supermini: 'esp32'
} satisfies Record<BoardId, BoardFamily>

/**
 * True for every Espressif part: built with PlatformIO, flashed over
 * serial, able to drive an external I2S peripheral.
 *
 * Prefer this over `target === 'esp32_s3'`. Almost every target branch in
 * the app is really a family question ("is this a pio build?", "does this
 * flash over serial?", "can this drive a PCM5102A?"), and writing them as
 * exact-id checks is what made adding a board a whack-a-mole exercise.
 */
export function isEsp32Family(b: BoardId): boolean {
  return BOARD_FAMILY[b] === 'esp32'
}

export function isDaisyFamily(b: BoardId): boolean {
  return BOARD_FAMILY[b] === 'daisy'
}

/**
 * PlatformIO `board =` value and build-env name. `null` for non-pio boards.
 *
 * This is the ONLY place these strings live. The artifact path
 * `.pio/build/<env>/firmware.bin` used to be hardcoded independently in
 * both `src/codegen/targets/esp32s3.ts` and
 * `electron/main/buildService.ts` — two copies that had to be edited
 * together or flashing would silently pick up a stale binary.
 */
export const PIO_ENV = {
  daisy_seed: null,
  esp32_s3_devkitc: 'esp32-s3-devkitc-1',
  // The C3 SuperMini is a bare ESP32-C3 module; the DevKitM-1 definition is
  // the standard 4MB no-PSRAM C3 profile and is what the community uses.
  esp32_c3_supermini: 'esp32-c3-devkitm-1',
  esp32_s3_supermini: 'esp32-s3-devkitc-1'
} satisfies Record<BoardId, string | null>

/**
 * Build workspace sub-directory under `~/.config/daisypatcher/workspace/`.
 *
 * Each board gets its own so a `board =` change can't meet a warm `.pio`
 * cache from a different chip — a classic source of "it built the wrong
 * thing". The first two values are the pre-existing directory names and
 * are preserved verbatim so nobody's current workspace is orphaned.
 */
export const WORKSPACE_DIR = {
  daisy_seed: 'seed',
  esp32_s3_devkitc: 'esp32',
  esp32_c3_supermini: 'esp32_c3_supermini',
  esp32_s3_supermini: 'esp32_s3_supermini'
} satisfies Record<BoardId, string>

/**
 * Legacy target ids that were persisted before boards and targets merged.
 *
 * `verificationStore` keys records as `${nodeKind}:${target}` in
 * localStorage and `~/.config/daisypatcher/verified.json`. Those files
 * predate this rename, so a record saved as `osc:esp32_s3` has to keep
 * resolving after the id became `esp32_s3_devkitc` — otherwise every
 * hardware-verified node silently reverts to unverified.
 */
export const LEGACY_BOARD_IDS: Record<string, BoardId> = {
  esp32_s3: 'esp32_s3_devkitc'
}

export function isBoardId(x: unknown): x is BoardId {
  return typeof x === 'string' && (BOARD_IDS as readonly string[]).includes(x)
}

/**
 * Narrow an untrusted value to a BoardId.
 *
 * Use at deserialization boundaries ONLY — `.dpatch` load and the IPC
 * handlers. Everywhere else the type system guarantees validity, and the
 * lookup tables are total (`satisfies Record<BoardId, …>`), so an
 * unrecognised id should be impossible rather than quietly coerced.
 */
export function coerceBoardId(x: unknown, fallback: BoardId = 'daisy_seed'): BoardId {
  if (isBoardId(x)) return x
  if (typeof x === 'string' && x in LEGACY_BOARD_IDS) return LEGACY_BOARD_IDS[x]
  return fallback
}

/** Exhaustiveness guard for switches over BoardId. */
export function assertNeverBoard(x: never): never {
  throw new Error(`unhandled board: ${String(x)}`)
}
