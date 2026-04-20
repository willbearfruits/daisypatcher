/// <reference path="./worklet.d.ts" />

/**
 * Wavetable morph oscillator. 4 pre-computed 2048-sample tables:
 *   0: sine
 *   1: harmonic (saw-like, first 8 harmonics)
 *   2: odd (square-like, first 8 odd harmonics)
 *   3: complex (mixed inharmonic partials)
 *
 * Morph selects a pair and blends linearly. Phase is fractional and read
 * with linear interpolation inside each table. Registered as `'dp-wavetable'`.
 */

class WavetableProcessor extends AudioWorkletProcessor {
  private readonly TABLE_SIZE = 2048
  private readonly TWO_PI = Math.PI * 2
  private readonly tables: Float32Array[]
  private phase = 0 // in [0, TABLE_SIZE)

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'amplitude', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'morph', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const size = this.TABLE_SIZE
    const t0 = new Float32Array(size)
    const t1 = new Float32Array(size)
    const t2 = new Float32Array(size)
    const t3 = new Float32Array(size)
    const twoPi = this.TWO_PI
    let maxT1 = 0
    let maxT2 = 0
    let maxT3 = 0
    for (let i = 0; i < size; i++) {
      const ph = (i / size) * twoPi
      t0[i] = Math.sin(ph)
      // Saw-like: sum of first 8 harmonics with 1/n weighting.
      let s1 = 0
      for (let h = 1; h <= 8; h++) s1 += Math.sin(ph * h) / h
      t1[i] = s1
      if (Math.abs(s1) > maxT1) maxT1 = Math.abs(s1)
      // Square-like: odd harmonics only.
      let s2 = 0
      for (let h = 1; h <= 15; h += 2) s2 += Math.sin(ph * h) / h
      t2[i] = s2
      if (Math.abs(s2) > maxT2) maxT2 = Math.abs(s2)
      // Complex: mix of a few inharmonic partials.
      const s3 = Math.sin(ph) * 0.6
        + Math.sin(ph * 2.17) * 0.3
        + Math.sin(ph * 3.41) * 0.25
        + Math.sin(ph * 5.63) * 0.15
        + Math.sin(ph * 7.11) * 0.1
      t3[i] = s3
      if (Math.abs(s3) > maxT3) maxT3 = Math.abs(s3)
    }
    // Normalize non-sine tables to ±1.
    if (maxT1 > 0) for (let i = 0; i < size; i++) t1[i] /= maxT1
    if (maxT2 > 0) for (let i = 0; i < size; i++) t2[i] /= maxT2
    if (maxT3 > 0) for (let i = 0; i < size; i++) t3[i] /= maxT3
    this.tables = [t0, t1, t2, t3]
  }

  private readTable(tbl: Float32Array, phase: number): number {
    const size = this.TABLE_SIZE
    const i0 = Math.floor(phase)
    const frac = phase - i0
    const a = tbl[i0 % size]
    const b = tbl[(i0 + 1) % size]
    return a * (1 - frac) + b * frac
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

    const pitchCv = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const morphCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    const baseFreq = parameters.frequency[0] ?? 220
    const amp = parameters.amplitude[0] ?? 0.5
    const baseMorph = parameters.morph[0] ?? 0

    const tables = this.tables
    const size = this.TABLE_SIZE
    const sr = sampleRate
    const nyquist = sr * 0.5
    const n = outCh.length

    for (let i = 0; i < n; i++) {
      let freq = baseFreq
      if (pitchCv) freq = baseFreq * Math.pow(2, pitchCv[i])
      if (freq < 0) freq = 0
      else if (freq > nyquist) freq = nyquist

      let m = baseMorph + (morphCv ? morphCv[i] : 0)
      if (m < 0) m = 0
      else if (m > 1) m = 1

      // Scale morph across 4 tables → position in [0,3].
      const pos = m * 3
      const idx = Math.floor(pos)
      const frac = pos - idx
      const a = tables[idx]
      const b = tables[idx < 3 ? idx + 1 : 3]
      const sa = this.readTable(a, this.phase)
      const sb = this.readTable(b, this.phase)
      let y = (sa * (1 - frac) + sb * frac) * amp
      if (!isFinite(y)) y = 0
      if (y > 1) y = 1
      else if (y < -1) y = -1
      outCh[i] = y

      const inc = (freq * size) / sr
      this.phase += inc
      while (this.phase >= size) this.phase -= size
      while (this.phase < 0) this.phase += size
    }

    if (!isFinite(this.phase)) this.phase = 0

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-wavetable', WavetableProcessor)
