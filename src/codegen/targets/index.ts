/**
 * Target backend registry. Adding a board = add another entry here + a
 * sibling file in this directory implementing the same contract. The
 * rest of the app (build service, flash service, topbar, SDK modal)
 * stays target-agnostic by reading from this table.
 */
import type { AudioGraph } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import type { GeneratedProject } from '../generateProject'
import { daisySeedTarget } from './daisySeed'
import { esp32S3Target } from './esp32s3'

export type BoardTarget = 'daisy_seed' | 'esp32_s3'

export interface ToolCheckEntry {
  name: string
  command: string
  required: boolean
  installHint: string
}

export interface TargetBackend {
  id: BoardTarget
  label: string
  description: string
  /** Pure function: graph + hardware → project files. */
  generate(
    graph: AudioGraph,
    hardware: HardwareLayout,
    projectName?: string
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

export const TARGETS: Record<BoardTarget, TargetBackend> = {
  daisy_seed: daisySeedTarget,
  esp32_s3: esp32S3Target
}

export function getTarget(id: BoardTarget): TargetBackend {
  return TARGETS[id] ?? TARGETS.daisy_seed
}

/** Map a hardware layout's `board` field to its target. */
export function targetForBoard(board: HardwareLayout['board']): BoardTarget {
  return board === 'esp32_s3_devkitc' ? 'esp32_s3' : 'daisy_seed'
}

/** Map a target id back to the canonical HardwareLayout board id. */
export function boardForTarget(target: BoardTarget): HardwareLayout['board'] {
  return target === 'esp32_s3' ? 'esp32_s3_devkitc' : 'daisy_seed'
}
