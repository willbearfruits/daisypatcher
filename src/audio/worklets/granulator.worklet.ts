/// <reference path="./worklet.d.ts" />

/**
 * Granulator — 4s circular capture buffer. At `density` Hz spawns a new
 * grain with a Hann envelope, random-ish playback position (jittered by
 * `jitter`), playing back at a pitch-shifted rate (`pitch` semitones ±
 * jittered detune). Up to 8 grains sum in parallel. Wet mixed with dry.
 * Registered as `'dp-granulator'`.
 */

const GRAN_BUF_SECONDS = 4
const GRAN_MAX_GRAINS = 8

class GranulatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'grain_size', defaultValue: 80, minValue: 10, maxValue: 200, automationRate: 'k-rate' },
      { name: 'density', defaultValue: 8, minValue: 1, maxValue: 30, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' },
      { name: 'jitter', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private buffer: Float32Array
  private writeIdx = 0
  private spawnCountdown = 0
  // Per-grain state, SoA for allocation avoidance.
  private grainActive: Uint8Array = new Uint8Array(GRAN_MAX_GRAINS)
  private grainPos: Float32Array = new Float32Array(GRAN_MAX_GRAINS)
  private grainStart: Float32Array = new Float32Array(GRAN_MAX_GRAINS)
  private grainLen: Float32Array = new Float32Array(GRAN_MAX_GRAINS)
  private grainRate: Float32Array = new Float32Array(GRAN_MAX_GRAINS)

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.buffer = new Float32Array(Math.ceil(GRAN_BUF_SECONDS * sampleRate) + 2)
  }

  private spawnGrain(size: number, pitch: number, jitter: number, _sr: number): void {
    let slot = -1
    for (let s = 0; s < GRAN_MAX_GRAINS; s++) {
      if (!this.grainActive[s]) { slot = s; break }
    }
    if (slot < 0) return
    const bufLen = this.buffer.length
    // Position: behind writeIdx by a random offset in [grain_len, buf_len - 1].
    const jit = (Math.random() * 2 - 1) * jitter
    const back = size * (1 + 2 * jitter) + Math.random() * jitter * (bufLen - size - 2)
    let start = this.writeIdx - size - back
    while (start < 0) start += bufLen
    while (start >= bufLen) start -= bufLen
    const pitchJit = pitch + jit * 2
    const rate = Math.pow(2, pitchJit / 12)
    this.grainActive[slot] = 1
    this.grainPos[slot] = 0
    this.grainStart[slot] = start
    this.grainLen[slot] = size
    this.grainRate[slot] = rate
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

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const grainSizeCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const densityCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const pitchCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined
    const sprayCv = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined

    const grainMsBase = parameters.grain_size[0] ?? 80
    const densityBase = parameters.density[0] ?? 8
    const pitchBase = parameters.pitch[0] ?? 0
    const jitterBase = parameters.jitter[0] ?? 0.3
    const mix = parameters.mix[0] ?? 1

    const sr = sampleRate
    const buf = this.buffer
    const bufLen = buf.length

    const TWO_PI = Math.PI * 2

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      // Write input into circular buffer.
      buf[this.writeIdx] = x
      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0

      let grainMs = grainMsBase
      if (grainSizeCv) {
        grainMs = grainSizeCv[i]
        if (grainMs < 10) grainMs = 10
        else if (grainMs > 200) grainMs = 200
      }
      let density = densityBase
      if (densityCv) {
        density = densityCv[i]
        if (density < 1) density = 1
        else if (density > 30) density = 30
      }
      let pitch = pitchBase
      if (pitchCv) {
        pitch = pitchCv[i]
        if (pitch < -12) pitch = -12
        else if (pitch > 12) pitch = 12
      }
      let jitter = jitterBase
      if (sprayCv) {
        jitter = sprayCv[i]
        if (jitter < 0) jitter = 0
        else if (jitter > 1) jitter = 1
      }
      const grainSamples = Math.max(1, (grainMs / 1000) * sr)
      const spawnInterval = sr / Math.max(0.001, density)

      // Spawn grain if countdown elapsed.
      this.spawnCountdown -= 1
      if (this.spawnCountdown <= 0) {
        this.spawnGrain(grainSamples, pitch, jitter, sr)
        this.spawnCountdown += spawnInterval
      }

      // Mix active grains.
      let wet = 0
      for (let s = 0; s < GRAN_MAX_GRAINS; s++) {
        if (!this.grainActive[s]) continue
        const pos = this.grainPos[s]
        const len = this.grainLen[s]
        if (pos >= len) {
          this.grainActive[s] = 0
          continue
        }
        let readPos = this.grainStart[s] + pos
        while (readPos >= bufLen) readPos -= bufLen
        while (readPos < 0) readPos += bufLen
        const r0 = Math.floor(readPos)
        const frac = readPos - r0
        const r1 = (r0 + 1) % bufLen
        const sample = buf[r0] * (1 - frac) + buf[r1] * frac
        // Hann window.
        const env = 0.5 - 0.5 * Math.cos((TWO_PI * pos) / len)
        wet += sample * env
        this.grainPos[s] = pos + this.grainRate[s]
      }

      if (!isFinite(wet)) wet = 0
      outCh[i] = x * (1 - mix) + wet * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-granulator', GranulatorProcessor)
