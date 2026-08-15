/**
 * Sample slot for a `sample_player` node.
 *
 * Renders in place of the generic enum control, for the same reason
 * `bindingId` does: the real choices are a runtime library, not a
 * compile-time option list, so the static stub would show one dead entry.
 *
 * The waveform is drawn from a min/max envelope rather than by plotting
 * every frame — a 30-second sample is 1.4 million points into a 240 pixel
 * strip, and plotting them all is both slow and less legible than the
 * envelope, which shows the shape you are actually trying to see.
 *
 * The start/end markers are live: they read the node's own params, so
 * dragging the sliders below shows you which part of the clip will play.
 * That is the whole reason to draw a waveform in a patcher at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeInstance } from '@/types/graph'
import { useEditorStore } from '@/state/store'
import { MAX_SAMPLE_SECONDS, useSampleStore } from '@/state/sampleStore'
import styles from './SamplePicker.module.css'

const WAVE_W = 240
const WAVE_H = 48

export function SamplePicker({ node }: { node: NodeInstance }) {
  const setParam = useEditorStore((s) => s.setParam)
  const samples = useSampleStore((s) => s.samples)
  const loading = useSampleStore((s) => s.loading)
  const error = useSampleStore((s) => s.error)
  const clearError = useSampleStore((s) => s.clearError)
  const importFile = useSampleStore((s) => s.importFile)
  const getPcm = useSampleStore((s) => s.getPcm)
  const removeSample = useSampleStore((s) => s.remove)

  const fileRef = useRef<HTMLInputElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [envelope, setEnvelope] = useState<Float32Array | null>(null)

  const id = typeof node.params.sampleId === 'string' ? node.params.sampleId : ''
  const meta = samples.find((s) => s.id === id) ?? null
  const start = Number(node.params.start ?? 0)
  const end = Number(node.params.end ?? 1)

  /*
   * Build the min/max envelope once per sample, not per render — it is the
   * expensive part and it never changes for a given id (the id IS the
   * content hash).
   */
  useEffect(() => {
    let cancelled = false
    if (!id) {
      setEnvelope(null)
      return
    }
    void getPcm(id).then((pcm) => {
      if (cancelled || !pcm || pcm.channels.length === 0) {
        if (!cancelled) setEnvelope(null)
        return
      }
      const src = pcm.channels[0]
      const env = new Float32Array(WAVE_W * 2)
      const per = Math.max(1, Math.floor(src.length / WAVE_W))
      for (let x = 0; x < WAVE_W; x++) {
        let lo = 1
        let hi = -1
        const from = x * per
        const to = Math.min(src.length, from + per)
        for (let i = from; i < to; i++) {
          const v = src[i]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        if (from >= to) {
          lo = 0
          hi = 0
        }
        env[x * 2] = lo
        env[x * 2 + 1] = hi
      }
      setEnvelope(env)
    })
    return () => {
      cancelled = true
    }
  }, [id, getPcm])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const css = getComputedStyle(cv)
    const ink = css.getPropertyValue('--dp-accent').trim() || '#7aa2f7'
    const dim = css.getPropertyValue('--dp-text-dim').trim() || '#666'
    const bg = css.getPropertyValue('--dp-surface-sunken').trim() || '#111'

    ctx.clearRect(0, 0, WAVE_W, WAVE_H)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, WAVE_W, WAVE_H)

    if (!envelope) {
      ctx.strokeStyle = dim
      ctx.beginPath()
      ctx.moveTo(0, WAVE_H / 2)
      ctx.lineTo(WAVE_W, WAVE_H / 2)
      ctx.stroke()
      return
    }

    // The playing window is drawn full-strength; everything outside it is
    // dimmed, so the trim sliders read at a glance.
    const sx = Math.round(Math.min(start, end) * WAVE_W)
    const ex = Math.round(Math.max(start, end) * WAVE_W)
    const mid = WAVE_H / 2
    for (let x = 0; x < WAVE_W; x++) {
      const inWindow = x >= sx && x <= ex
      ctx.strokeStyle = inWindow ? ink : dim
      ctx.globalAlpha = inWindow ? 1 : 0.35
      const lo = envelope[x * 2]
      const hi = envelope[x * 2 + 1]
      ctx.beginPath()
      ctx.moveTo(x + 0.5, mid - hi * mid)
      ctx.lineTo(x + 0.5, mid - lo * mid)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }, [envelope, start, end])

  const onPick = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0]
      if (!file) return
      const rate = useEditorStore.getState().graph.meta.sampleRate || 48000
      const imported = await importFile(file, rate)
      if (imported) setParam(node.id, 'sampleId', imported.id)
    },
    [importFile, node.id, setParam]
  )

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.label}>Sample</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.btn}
          onClick={() => fileRef.current?.click()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Import…'}
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className={styles.hiddenInput}
        onChange={(e) => {
          void onPick(e.target.files)
          // Clear so re-picking the same file fires change again.
          e.target.value = ''
        }}
      />

      <canvas
        ref={canvasRef}
        width={WAVE_W}
        height={WAVE_H}
        className={styles.wave}
        aria-label={meta ? `Waveform of ${meta.name}` : 'No sample selected'}
      />

      <select
        className={styles.select}
        value={id}
        onChange={(e) => setParam(node.id, 'sampleId', e.target.value)}
        aria-label="Sample"
      >
        <option value="">(none — silent)</option>
        {samples.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {s.duration.toFixed(2)}s
          </option>
        ))}
      </select>

      {meta ? (
        <div className={styles.meta}>
          <span>
            {meta.duration.toFixed(2)}s · {meta.channels === 1 ? 'mono' : 'stereo'} ·{' '}
            {((meta.frames * 2) / 1024).toFixed(0)} KB in flash
          </span>
          <button
            type="button"
            className={styles.link}
            onClick={() => void removeSample(meta.id)}
            title="Remove from the library — patches using it will go silent"
          >
            delete
          </button>
        </div>
      ) : (
        <p className={styles.hint}>
          Any audio file up to {MAX_SAMPLE_SECONDS}s. It is compiled into the
          firmware, so length costs flash.
        </p>
      )}

      {error ? (
        <p className={styles.error} onClick={clearError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
