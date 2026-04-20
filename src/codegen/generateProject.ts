/**
 * Project-generator dispatcher.
 *
 * The original Daisy-only implementation now lives at
 * `src/codegen/targets/daisySeed.ts`. This file is the thin entry point
 * that forwards to the right target backend based on the caller's
 * choice, defaulting to Daisy Seed for back-compat.
 *
 * `GeneratedProject` is kept as a named export so existing importers
 * (`compileState.ts`, tests) don't need to change.
 */
import type { AudioGraph } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import { emptyHardwareLayout } from '@/types/hardware'
import { TARGETS, type BoardTarget } from './targets'

/**
 * File map emitted by a target. Keys are project-relative paths — the
 * build service writes each one verbatim. Existing Daisy emitters use
 * a flat top-level shape (`main.cpp`, `Makefile`, `project.json`), the
 * ESP32 target emits `platformio.ini`, `src/main.cpp`, `project.json`.
 *
 * Targets may add more entries; callers must not assume a fixed key set.
 */
export interface GeneratedProject {
  projectName: string
  files: Record<string, string>
  warnings: string[]
}

export function generateProject(
  graph: AudioGraph,
  hardware: HardwareLayout = emptyHardwareLayout(),
  projectName?: string,
  target: BoardTarget = 'daisy_seed'
): GeneratedProject {
  return TARGETS[target].generate(graph, hardware, projectName)
}
