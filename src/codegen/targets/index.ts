/**
 * Target backend registry. Adding a board = add another entry here + a
 * sibling file in this directory implementing the same contract. The
 * rest of the app (build service, flash service, topbar, SDK modal)
 * stays target-agnostic by reading from this table.
 */
import type { AudioGraph } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import type { BoardId } from '../../../shared/boards'
import { isEsp32Family } from '../../../shared/boards'
import type { GenerateOptions, GeneratedProject } from '../generateProject'
import { daisySeedTarget } from './daisySeed'
import { esp32S3Target, esp32C3SuperMiniTarget, esp32S3SuperMiniTarget } from './esp32s3'

/**
 * A compile target IS a board — the two used to be separate unions joined
 * by a fallback ternary, which meant a new board silently compiled as a
 * Daisy. Kept as a named alias because ~40 call sites read better as
 * "target" than "board id"; they are the same type.
 */
export type BoardTarget = BoardId

export interface ToolCheckEntry {
  name: string
  command: string
  required: boolean
  installHint: string
}

export interface TargetBackend {
  id: BoardTarget
  label: string
  /** Compact label for the TopBar switcher, where four boards must fit. */
  shortLabel: string
  description: string
  /**
   * Pure function: graph + hardware → project files. `options` carries
   * target-specific knobs (e.g. Daisy's flash mode); targets ignore
   * fields they don't care about.
   */
  generate(
    graph: AudioGraph,
    hardware: HardwareLayout,
    projectName?: string,
    options?: GenerateOptions
  ): GeneratedProject
  /** Command the build service will run. */
  buildCommand(): { bin: string; args: string[]; env?: Record<string, string> }
  /** Human-readable "what you need installed" list. */
  toolchainCheck(): ToolCheckEntry[]
  /** Path inside the built project dir where the flashable binary lives. */
  binaryArtifact(projectName: string): string
  /** Command the flash service will run. */
  flashCommand(binaryPath: string): { bin: string; args: string[] }
  /** Default file extension of the build artifact (bin, elf, hex). */
  artifactExtension: 'bin' | 'elf' | 'hex'
}

export const TARGETS = {
  daisy_seed: daisySeedTarget,
  esp32_s3_devkitc: esp32S3Target,
  esp32_c3_supermini: esp32C3SuperMiniTarget,
  esp32_s3_supermini: esp32S3SuperMiniTarget
} satisfies Record<BoardTarget, TargetBackend>

/**
 * No `?? daisy_seed` fallback on purpose. The table is total, so a miss is
 * impossible unless an invalid id came in from deserialization — and
 * silently compiling Daisy firmware for an ESP32 layout is far worse than
 * failing loudly. Untrusted ids are narrowed by `coerceBoardId` at the two
 * boundaries that can produce them (`.dpatch` load and IPC).
 */
export function getTarget(id: BoardTarget): TargetBackend {
  return TARGETS[id]
}

/**
 * Board and target are the same value now; these two remain as identity
 * functions so the ~15 existing call sites keep reading intentionally.
 *
 * @deprecated They are identity — prefer using the id directly.
 */
export const targetForBoard = (board: HardwareLayout['board']): BoardTarget => board
/** @deprecated Identity — see {@link targetForBoard}. */
export const boardForTarget = (target: BoardTarget): HardwareLayout['board'] => target

/**
 * Targets that are an Espressif part — built with PlatformIO, flashed over
 * serial, and able to drive an external I2S peripheral.
 *
 * Prefer this over `target === 'esp32_s3_devkitc'`.
 */
export function isEsp32Target(target: BoardTarget): boolean {
  return isEsp32Family(target)
}
