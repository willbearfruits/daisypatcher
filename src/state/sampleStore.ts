/**
 * Sample library — the renderer half.
 *
 * The library is app-global, not per-patch: a kick you imported once should
 * be available to every patch you open, the way a font is. So it lives in
 * its own store rather than in the editor store, and it is deliberately NOT
 * part of undo history — importing a file is not a patch edit, and having
 * Ctrl+Z delete an asset two other patches reference would be a bad
 * surprise.
 *
 * DECODING LIVES HERE. Chromium's `decodeAudioData` handles wav, mp3, flac,
 * ogg and m4a; the main process gets raw interleaved Float32 and never has
 * to know what a container is. See `electron/main/sampleService.ts` for why
 * that split is the way round it is.
 *
 * PCM IS CACHED IN MEMORY once read, because three things want it at
 * different times — the worklet on graph rebuild, the waveform thumbnail on
 * render, and codegen on build — and re-reading megabytes off disk for each
 * would make selecting a sample feel slow for no reason. The cache is keyed
 * by content hash, so it can never go stale.
 */

import { create } from 'zustand'

export interface SampleMeta {
  id: string
  name: string
  sampleRate: number
  channels: number
  frames: number
  duration: number
  importedAt: number
}

/** Deinterleaved PCM, one Float32Array per channel. */
export interface SamplePcm {
  channels: Float32Array[]
  sampleRate: number
  frames: number
}

interface SampleApi {
  list(): Promise<SampleMeta[]>
  store(input: {
    name: string
    sampleRate: number
    channels: number
    pcm: ArrayBuffer
  }): Promise<SampleMeta>
  read(id: string): Promise<ArrayBuffer | null>
  rename(id: string, name: string): Promise<SampleMeta[]>
  remove(id: string): Promise<SampleMeta[]>
}

function api(): SampleApi | null {
  const w = window as unknown as { daisy?: { samples?: SampleApi } }
  return w.daisy?.samples ?? null
}

/**
 * How long a sample may be.
 *
 * Not a technical limit — it is a "you will not fit this on the device"
 * limit, enforced at import so you find out while choosing the file rather
 * than at the end of a two-minute build. 30 s mono at 48 kHz is 2.8 MB of
 * flash, which is already most of an ESP32 partition.
 */
export const MAX_SAMPLE_SECONDS = 30

interface SampleState {
  samples: SampleMeta[]
  /** id -> decoded PCM. Populated lazily; never invalidated (see header). */
  pcm: Map<string, SamplePcm>
  loading: boolean
  error: string | null

  refresh(): Promise<void>
  /** Decode and store a file. Returns the new (or existing) metadata. */
  importFile(file: File, targetRate?: number): Promise<SampleMeta | null>
  /** PCM for a sample, reading from disk on first request. */
  getPcm(id: string): Promise<SamplePcm | null>
  /** Cached PCM only — for render paths that must not await. */
  peekPcm(id: string): SamplePcm | null
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
  clearError(): void
}

/**
 * Decode any container the browser knows into Float32 at `targetRate`.
 *
 * `OfflineAudioContext` does the resampling, which matters more than it
 * looks: a 44.1 kHz sample played by a 48 kHz engine without resampling is
 * about a semitone sharp, and that is exactly the kind of bug that gets
 * blamed on the oscillator.
 */
async function decodeToRate(bytes: ArrayBuffer, targetRate: number): Promise<AudioBuffer> {
  // A short-lived context purely for decoding; `decodeAudioData` needs one
  // and resampling to the target rate is the whole point of the second pass.
  const probe = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await probe.decodeAudioData(bytes.slice(0))
  } finally {
    void probe.close()
  }
  if (Math.abs(decoded.sampleRate - targetRate) < 0.5) return decoded

  const off = new OfflineAudioContext(
    decoded.numberOfChannels,
    Math.ceil((decoded.length * targetRate) / decoded.sampleRate),
    targetRate
  )
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  return off.startRendering()
}

function interleave(buf: AudioBuffer, maxChannels = 2): ArrayBuffer {
  const channels = Math.min(buf.numberOfChannels, maxChannels)
  const out = new Float32Array(buf.length * channels)
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c)
    for (let i = 0; i < buf.length; i++) out[i * channels + c] = data[i]
  }
  return out.buffer
}

function deinterleave(raw: ArrayBuffer, channels: number, sampleRate: number): SamplePcm {
  const flat = new Float32Array(raw)
  const frames = Math.floor(flat.length / channels)
  const out: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(frames)
    for (let i = 0; i < frames; i++) ch[i] = flat[i * channels + c]
    out.push(ch)
  }
  return { channels: out, sampleRate, frames }
}

export const useSampleStore = create<SampleState>((set, get) => ({
  samples: [],
  pcm: new Map(),
  loading: false,
  error: null,

  clearError: () => set({ error: null }),

  async refresh() {
    const a = api()
    if (!a) return
    set({ loading: true })
    try {
      set({ samples: await a.list(), loading: false })
    } catch (err) {
      set({ loading: false, error: `could not read the sample library: ${(err as Error).message}` })
    }
  },

  async importFile(file, targetRate = 48000) {
    const a = api()
    if (!a) {
      set({ error: 'sample library unavailable — running outside the desktop app' })
      return null
    }
    set({ loading: true, error: null })
    try {
      const bytes = await file.arrayBuffer()
      const buf = await decodeToRate(bytes, targetRate)

      if (buf.duration > MAX_SAMPLE_SECONDS) {
        set({
          loading: false,
          error:
            `"${file.name}" is ${buf.duration.toFixed(1)} s — the limit is ` +
            `${MAX_SAMPLE_SECONDS} s, because samples are compiled into the firmware ` +
            `and this one would not fit in flash. Trim it and try again.`
        })
        return null
      }

      const channels = Math.min(buf.numberOfChannels, 2)
      const meta = await a.store({
        name: file.name.replace(/\.[^.]+$/, ''),
        sampleRate: buf.sampleRate,
        channels,
        pcm: interleave(buf, 2)
      })

      // Seed the cache from what we just decoded rather than reading it
      // straight back off disk.
      const pcm = new Map(get().pcm)
      pcm.set(meta.id, {
        channels: Array.from({ length: channels }, (_, c) => buf.getChannelData(c).slice()),
        sampleRate: buf.sampleRate,
        frames: buf.length
      })

      const samples = await a.list()
      set({ samples, pcm, loading: false })
      return meta
    } catch (err) {
      set({
        loading: false,
        error: `could not decode "${file.name}": ${(err as Error).message}`
      })
      return null
    }
  },

  async getPcm(id) {
    const cached = get().pcm.get(id)
    if (cached) return cached
    const a = api()
    if (!a) return null
    const meta = get().samples.find((s) => s.id === id)
    if (!meta) return null
    const raw = await a.read(id)
    if (!raw) return null
    const decoded = deinterleave(raw, meta.channels, meta.sampleRate)
    const pcm = new Map(get().pcm)
    pcm.set(id, decoded)
    set({ pcm })
    return decoded
  },

  peekPcm(id) {
    return get().pcm.get(id) ?? null
  },

  async rename(id, name) {
    const a = api()
    if (!a) return
    set({ samples: await a.rename(id, name) })
  },

  async remove(id) {
    const a = api()
    if (!a) return
    const samples = await a.remove(id)
    const pcm = new Map(get().pcm)
    pcm.delete(id)
    set({ samples, pcm })
  }
}))
