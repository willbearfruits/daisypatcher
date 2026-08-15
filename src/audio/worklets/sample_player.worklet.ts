/// <reference path="./worklet.d.ts" />

/**
 * Sample player.
 *
 * The PCM arrives over the port as a transferred `Float32Array` — the
 * engine reads it from the library and posts it on graph build and whenever
 * `sampleId` changes. Nothing is fetched from here: a worklet has no
 * network, no filesystem, and no imports.
 *
 * Playback is linear-interpolated so `speed` is continuous rather than
 * stepping between integer ratios. That matches what the firmware emitter
 * does, which is the point — this is a preview of that.
 *
 * Three modes, and the difference between them is entirely about what the
 * trigger means:
 *   - `oneshot` — a rising edge starts playback; it runs to the end and
 *     stops, ignoring the gate going low.
 *   - `loop`    — a rising edge starts playback; it wraps at the end
 *     forever, and a low gate does not stop it.
 *   - `gate`    — plays while the gate is high, stops when it falls. This
 *     is the one you want for a keyboard.
 *
 * `eoc` fires for one sample when playback reaches the end, including on
 * each wrap in loop mode — that is what makes it useful as a clock.
 *
 * Inputs:
 *   0  trigger  — gate
 *   1  cv_speed — replaces sidebar `speed`
 *   2  cv_start — replaces sidebar `start` (0..1 of the clip)
 *   3  cv_level — replaces sidebar `level`
 *
 * Registered as `'dp-sample-player'`.
 */

class SamplePlayerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'speed', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'start', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'end', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'level', defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private pcm: Float32Array | null = null
  /**
   * Rate the PCM was captured at, over the engine's rate.
   *
   * The library resamples on import so this is normally 1, but a patch
   * opened at a different engine rate would otherwise play sharp or flat —
   * the exact bug that gets blamed on the oscillator.
   */
  private rateRatio = 1

  private mode: 'oneshot' | 'loop' | 'gate' = 'oneshot'
  private playing = false
  private pos = 0
  private trigHigh = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as {
        type?: string
        paramId?: string
        value?: unknown
        pcm?: Float32Array
        sampleRate?: number
      }
      if (d?.type === 'sample') {
        // A null/empty payload clears the slot — picking "(none)" must
        // actually silence the node, not leave the last sample loaded.
        this.pcm = d.pcm && d.pcm.length > 0 ? d.pcm : null
        this.rateRatio = d.sampleRate && d.sampleRate > 0 ? d.sampleRate / sampleRate : 1
        this.playing = false
        this.pos = 0
        return
      }
      if (d?.type === 'param' && d.paramId === 'mode') {
        const v = d.value
        this.mode = v === 'loop' ? 'loop' : v === 'gate' ? 'gate' : 'oneshot'
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true
    const eocOut = outputs[1]?.[0]

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const speedCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const startCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const levelCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    const pcm = this.pcm
    const n = outCh.length

    if (!pcm || pcm.length < 2) {
      outCh.fill(0)
      if (eocOut) eocOut.fill(0)
      for (let c = 1; c < output.length; c++) output[c].set(outCh)
      return true
    }

    let speed = parameters.speed[0] ?? 1
    if (speedCv) speed = speedCv[0]
    if (speed < 0.25) speed = 0.25
    else if (speed > 4) speed = 4
    let start = parameters.start[0] ?? 0
    if (startCv) start = startCv[0]
    if (start < 0) start = 0
    else if (start > 1) start = 1
    let end = parameters.end[0] ?? 1
    if (end < 0) end = 0
    else if (end > 1) end = 1
    let level = parameters.level[0] ?? 0.8
    if (levelCv) level = levelCv[0]
    if (level < 0) level = 0
    else if (level > 1) level = 1

    const len = pcm.length
    let startFrame = Math.floor(start * (len - 1))
    let endFrame = Math.floor(end * (len - 1))
    // An inverted or empty window would spin the read pointer forever;
    // treat it as "play to the end" rather than as a hang.
    if (endFrame <= startFrame) endFrame = len - 1
    if (startFrame >= len - 1) startFrame = 0

    const step = speed * this.rateRatio

    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      const rising = nowHigh && !this.trigHigh
      const falling = !nowHigh && this.trigHigh
      this.trigHigh = nowHigh

      if (rising) {
        this.playing = true
        this.pos = startFrame
      } else if (falling && this.mode === 'gate') {
        this.playing = false
      }

      let sample = 0
      let eoc = 0

      if (this.playing) {
        const i0 = Math.floor(this.pos)
        const frac = this.pos - i0
        const i1 = i0 + 1 <= endFrame ? i0 + 1 : startFrame
        sample = (pcm[i0] * (1 - frac) + pcm[i1] * frac) * level

        this.pos += step
        if (this.pos >= endFrame) {
          eoc = 1
          if (this.mode === 'loop') {
            this.pos = startFrame + (this.pos - endFrame)
            if (this.pos >= endFrame) this.pos = startFrame
          } else {
            this.playing = false
            this.pos = startFrame
          }
        }
      }

      if (!isFinite(sample)) sample = 0
      outCh[i] = sample
      if (eocOut) eocOut[i] = eoc
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-sample-player', SamplePlayerProcessor)
