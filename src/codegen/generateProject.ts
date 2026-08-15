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
import type { DaisyFlashMode } from '@/types/store'
import type { Preset } from '@/state/presets'
import type { SampleBank } from './sampleCodegen'
import { flattenGraph } from '@/state/subpatch'
import type { Provenance } from './provenance'
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
  /**
   * Which node emitted which lines of the main source file.
   *
   * Optional because it is a view concern: the build service does not need
   * it, and a target is free not to produce one. When present it is what
   * lets the code view highlight a node's lines and a compile error name
   * the node that caused it.
   */
  provenance?: Provenance
}

/**
 * Target-agnostic options bag. Each target backend picks out the fields
 * it cares about; unknown fields are ignored. Keeping this loose lets us
 * add new knobs (e.g. ESP32 partition table) without churning the
 * TargetBackend contract for every implementation.
 */
export interface GenerateOptions {
  /** Daisy-only — flash mode selected in the TopBar / StatusBar popover. */
  daisyFlashMode?: DaisyFlashMode
  /**
   * Captured presets, baked into the firmware as a table.
   *
   * Passed in rather than read off the graph because presets are store
   * state, not patch topology — they describe positions WITHIN a circuit
   * and recalling one must never rewire anything. See presetCodegen.ts.
   */
  presets?: readonly Preset[]
  /**
   * Sample PCM, keyed by the id a `sample_player` node stores.
   *
   * Same reasoning as `presets`: the library is app state, not patch
   * topology, and a graph that carried megabytes of audio would stop being
   * a document you can read. See `codegen/sampleCodegen.ts`.
   */
  samples?: SampleBank
}

export function generateProject(
  graph: AudioGraph,
  hardware: HardwareLayout = emptyHardwareLayout(),
  projectName?: string,
  target: BoardTarget = 'daisy_seed',
  options: GenerateOptions = {}
): GeneratedProject {
  /*
   * Subpatches are expanded HERE, once, before any backend sees the graph.
   *
   * That is the whole design: the emitters, the topological sort, the
   * connection index and the audio engine all consume a flat `AudioGraph`
   * and none of them has to learn that nesting exists. A subpatch
   * therefore costs nothing at runtime and cannot introduce a bug class the
   * flat path does not already have. See state/subpatch.ts.
   */
  return TARGETS[target].generate(flattenGraph(graph), hardware, projectName, options)
}
