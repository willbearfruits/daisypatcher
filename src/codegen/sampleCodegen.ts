/**
 * Samples, compiled into the firmware.
 *
 * A sample has to get onto the device somehow, and there are three ways:
 * stream it from an SD card, write it to QSPI at flash time as a separate
 * blob, or link it into the binary as a const array. This does the third.
 *
 * WHY THE SIMPLEST ONE. An SD card is extra hardware the patch never asked
 * for and a filesystem to get wrong; a separate QSPI blob means a second
 * flash step, a second thing to be out of date, and a device that boots to
 * silence if you flash one and not the other. A const array is one binary,
 * one flash, and the audio is as reliable as the code. The price is size,
 * and size is exactly the thing a person can see and decide about — which
 * is why the length cap lives at import time, in the picker, rather than
 * as a build error.
 *
 * FORMAT: 16-bit signed, mono. Float32 would double the flash for precision
 * nobody hears through a Daisy's codec, and stereo doubles it again for a
 * one-shot that is nearly always mono anyway. Multi-channel samples are
 * downmixed at emit time and the caller warns.
 *
 * The emitted array is `static const int16_t`, which lands in `.rodata` and
 * therefore in flash rather than RAM. Getting that wrong — `static float`,
 * say — puts a two-megabyte sample in a 512 KB SRAM and the link fails with
 * an error that does not mention samples at all.
 */

import type { AudioGraph, NodeInstance } from '@/types/graph'
import { nodeVar } from './graphWalk'

/** Deinterleaved PCM, as the renderer's sample store holds it. */
export interface SamplePcmInput {
  channels: Float32Array[]
  sampleRate: number
  frames: number
}

/** What a build hands codegen: sample id -> PCM. */
export type SampleBank = Record<string, SamplePcmInput>

export interface EmittedSample {
  nodeId: string
  varName: string
  frames: number
  sampleRate: number
  /** Flash cost in bytes. */
  bytes: number
}

/**
 * Flash budgets, in bytes of sample data.
 *
 * Deliberately well under the true partition size — the patch's own code,
 * libDaisy and DaisySP all have to fit too, and a build that links but
 * leaves no room for a delay line is not a success. These are the numbers
 * at which the user gets told, not the numbers at which the linker gives
 * up.
 */
const FLASH_BUDGET: Record<string, number> = {
  daisy_seed: 6 * 1024 * 1024, // 8 MB QSPI, minus the app
  esp32_s3_devkitc: 2 * 1024 * 1024, // default 4 MB app partition
  esp32_s3_supermini: 2 * 1024 * 1024,
  esp32_c3_supermini: 1 * 1024 * 1024 // 4 MB flash, smaller app partition
}

/** Downmix to mono. Stereo one-shots are the common case and rarely need width. */
function toMono(pcm: SamplePcmInput): Float32Array {
  if (pcm.channels.length === 1) return pcm.channels[0]
  const n = pcm.frames
  const out = new Float32Array(n)
  const chans = pcm.channels
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < chans.length; c++) sum += chans[c][i] ?? 0
    out[i] = sum / chans.length
  }
  return out
}

/**
 * The C array literal for one sample.
 *
 * Wrapped at 16 values per line: a single-line array of a million ints is
 * technically valid and makes the Code view — and every editor anyone opens
 * the ejected project in — unusable.
 */
function emitPcmArray(varName: string, mono: Float32Array): string[] {
  const lines: string[] = []
  lines.push(`static const int16_t ${varName}[${mono.length}] = {`)
  const PER_LINE = 16
  let row: string[] = []
  for (let i = 0; i < mono.length; i++) {
    let v = Math.round(mono[i] * 32767)
    if (v > 32767) v = 32767
    else if (v < -32768) v = -32768
    row.push(String(v))
    if (row.length === PER_LINE) {
      lines.push('    ' + row.join(', ') + ',')
      row = []
    }
  }
  if (row.length > 0) lines.push('    ' + row.join(', '))
  lines.push('};')
  return lines
}

export interface SampleEmission {
  /** File-scope declarations: the PCM arrays. */
  declLines: string[]
  /** nodeId -> what was emitted for it, for the node emitters to reference. */
  byNode: Map<string, EmittedSample>
}

/**
 * Emit every referenced sample once, keyed by node.
 *
 * Two nodes pointing at the same sample share one array — the id is a
 * content hash, so this is safe by construction, and a drum patch with the
 * same hit on two lanes should not pay for it twice.
 */
export function emitSamples(
  graph: AudioGraph,
  bank: SampleBank,
  target: string,
  warn: (msg: string) => void
): SampleEmission {
  const declLines: string[] = []
  const byNode = new Map<string, EmittedSample>()
  /** sample id -> the variable already emitted for it. */
  const emitted = new Map<string, { varName: string; frames: number; sampleRate: number }>()
  let totalBytes = 0

  const players = graph.nodes.filter((n: NodeInstance) => n.kind === 'sample_player')
  if (players.length === 0) return { declLines, byNode }

  for (const node of players) {
    const id = typeof node.params.sampleId === 'string' ? node.params.sampleId : ''
    if (!id) {
      warn(`sample player ${node.id} has no sample selected — it will be silent`)
      continue
    }
    const pcm = bank[id]
    if (!pcm || pcm.frames === 0) {
      warn(
        `sample player ${node.id} references a sample that is not in the library — ` +
          `it will be silent. Re-import it, or pick another.`
      )
      continue
    }

    const already = emitted.get(id)
    if (already) {
      byNode.set(node.id, {
        nodeId: node.id,
        varName: already.varName,
        frames: already.frames,
        sampleRate: already.sampleRate,
        bytes: 0 // shared; already counted
      })
      continue
    }

    const mono = toMono(pcm)
    if (pcm.channels.length > 1) {
      warn(
        `sample on ${node.id} is ${pcm.channels.length}-channel and was downmixed to mono ` +
          `for the device (stereo would double the flash it uses)`
      )
    }
    const varName = `dp_smp_${nodeVar(node.id, 'sample_player')}`
    declLines.push(...emitPcmArray(varName, mono))
    const bytes = mono.length * 2
    totalBytes += bytes
    emitted.set(id, { varName, frames: mono.length, sampleRate: pcm.sampleRate })
    byNode.set(node.id, {
      nodeId: node.id,
      varName,
      frames: mono.length,
      sampleRate: pcm.sampleRate,
      bytes
    })
  }

  const budget = FLASH_BUDGET[target] ?? 1024 * 1024
  if (totalBytes > budget) {
    warn(
      `samples total ${(totalBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(budget / 1024 / 1024).toFixed(1)} MB this board has room for once the patch ` +
        `itself is in flash — the build will probably fail to link. Shorten or remove some.`
    )
  } else if (totalBytes > 0) {
    warn(
      `samples use ${(totalBytes / 1024).toFixed(0)} KB of flash ` +
        `(${((totalBytes / budget) * 100).toFixed(0)}% of the budget for this board)`
    )
  }

  return { declLines, byNode }
}
