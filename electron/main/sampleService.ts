/**
 * The sample library.
 *
 * Samples are the one asset in this app that is too big to live in the
 * patch file. A second of 48 kHz mono 16-bit audio is 96 KB; base64'd into
 * a `.dpatch` that becomes 128 KB of JSON per second, and a patch with four
 * drum hits stops being a document you can open in a text editor or diff.
 * So the library is content-addressed on disk and the patch stores ids.
 *
 * CONTENT-ADDRESSED, not name-addressed. The id is a hash of the PCM, so
 * importing the same file twice costs nothing, two patches referencing the
 * same kick share one copy, and a sample can never silently change under a
 * patch that used it. The tradeoff is that renaming is metadata-only, which
 * is the right way round.
 *
 * DECODING HAPPENS IN THE RENDERER. This module never parses an audio file.
 * The renderer already has a full codec set in `AudioContext.decodeAudioData`
 * — wav, mp3, flac, ogg, m4a, whatever Chromium ships — and reimplementing
 * even one of those here to save an IPC hop would be a decoder we own and
 * have to fix. What arrives is Float32 PCM plus a rate; what is stored is
 * the same, interleaved, little-endian.
 *
 * The `.pcm` files are raw and headerless on purpose: the manifest carries
 * the rate and channel count, and a header would be a second source of
 * truth for facts the manifest already holds.
 */

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface SampleMeta {
  /** Content hash of the PCM — also the filename stem. */
  id: string
  /** Display name. Editable; not part of identity. */
  name: string
  sampleRate: number
  channels: number
  /** Frames per channel. */
  frames: number
  /** Seconds, derived — stored so the UI need not recompute it constantly. */
  duration: number
  importedAt: number
}

interface Manifest {
  version: 1
  samples: SampleMeta[]
}

function libDir(): string {
  return path.join(app.getPath('userData'), 'samples')
}

function manifestPath(): string {
  return path.join(libDir(), 'manifest.json')
}

function pcmPath(id: string): string {
  return path.join(libDir(), `${id}.pcm`)
}

function ensureDir(): void {
  const d = libDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

function readManifest(): Manifest {
  ensureDir()
  const p = manifestPath()
  if (!existsSync(p)) return { version: 1, samples: [] }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Manifest>
    if (!Array.isArray(raw.samples)) return { version: 1, samples: [] }
    // Drop entries whose PCM has gone missing — a manifest that lies about
    // what is on disk produces a node that plays silence with no explanation.
    const samples = raw.samples.filter(
      (s): s is SampleMeta => typeof s?.id === 'string' && existsSync(pcmPath(s.id))
    )
    return { version: 1, samples }
  } catch {
    // A corrupt manifest must not take the library with it; the PCM files
    // are still there and re-importing rebuilds the entry.
    return { version: 1, samples: [] }
  }
}

function writeManifest(m: Manifest): void {
  ensureDir()
  writeFileSync(manifestPath(), JSON.stringify(m, null, 2), 'utf8')
}

export function listSamples(): SampleMeta[] {
  return readManifest().samples.sort((a, b) => b.importedAt - a.importedAt)
}

export interface StoreSampleInput {
  name: string
  sampleRate: number
  channels: number
  /** Interleaved Float32 PCM, as an ArrayBuffer over the IPC boundary. */
  pcm: ArrayBuffer
}

/**
 * Store PCM and return its metadata.
 *
 * Re-importing identical audio returns the existing entry rather than a
 * duplicate — the name of the first import wins, because renaming an asset
 * two patches already point at is a decision the user should make
 * explicitly, not a side effect of dragging a file in again.
 */
export function storeSample(input: StoreSampleInput): SampleMeta {
  ensureDir()
  const bytes = Buffer.from(input.pcm)
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16)

  const manifest = readManifest()
  const existing = manifest.samples.find((s) => s.id === id)
  if (existing) return existing

  const channels = Math.max(1, Math.min(2, Math.round(input.channels)))
  const frames = Math.floor(bytes.length / 4 / channels)
  const meta: SampleMeta = {
    id,
    name: input.name || 'sample',
    sampleRate: input.sampleRate,
    channels,
    frames,
    duration: input.sampleRate > 0 ? frames / input.sampleRate : 0,
    importedAt: Date.now()
  }

  writeFileSync(pcmPath(id), bytes)
  manifest.samples.push(meta)
  writeManifest(manifest)
  return meta
}

/** Raw interleaved Float32 PCM, or null if the id is unknown. */
export function readSamplePcm(id: string): ArrayBuffer | null {
  const p = pcmPath(id)
  if (!existsSync(p)) return null
  const buf = readFileSync(p)
  // Copy into a fresh ArrayBuffer: Node may hand back a view into a larger
  // pooled buffer, and structured-cloning that ships the whole pool.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export function renameSample(id: string, name: string): SampleMeta[] {
  const m = readManifest()
  const s = m.samples.find((x) => x.id === id)
  if (s) {
    s.name = name.trim() || s.name
    writeManifest(m)
  }
  return m.samples
}

export function deleteSample(id: string): SampleMeta[] {
  const m = readManifest()
  m.samples = m.samples.filter((s) => s.id !== id)
  writeManifest(m)
  try {
    rmSync(pcmPath(id), { force: true })
  } catch {
    // The manifest entry is gone either way; a stray file is recoverable
    // and an exception here would fail an operation that mostly succeeded.
  }
  return m.samples
}
