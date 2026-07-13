/// <reference path="./worklet.d.ts" />

/**
 * Compressor — peak-detector feedforward compressor. Envelope follows |in|
 * with asymmetric attack/release (fast attack on rising, slow release on
 * falling). Gain reduction in dB = max(0, (lvlDb - threshold) * (1 - 1/ratio)).
 * Final gain = 10^((-GR + makeup) / 20). Registered as `'dp-compressor'`.
 */

class CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'threshold', defaultValue: -20, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.01, minValue: 0.001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.01, maxValue: 3, automationRate: 'k-rate' },
      { name: 'makeup', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: 'k-rate' }
    ]
  }

  private env = 0 // peak-follower linear amplitude

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
    // Wave 2 CVs: 1=thr, 2=ratio, 3=attack, 4=release, 5=makeup.
    const thrCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const ratioCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const atkCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined
    const relCv = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined
    const makeCv = inputs[5] && inputs[5].length > 0 ? inputs[5][0] : undefined

    const thrBase = parameters.threshold[0] ?? -20
    const ratioBase = parameters.ratio[0] ?? 4
    const atkBase = parameters.attack[0] ?? 0.01
    const relBase = parameters.release[0] ?? 0.1
    const makeBase = parameters.makeup[0] ?? 0

    const sr = sampleRate
    // Block-rate coefs when no CV is connected for that param.
    const atkCoefK = 1 - Math.exp(-1 / Math.max(0.0001, atkBase) / sr)
    const relCoefK = 1 - Math.exp(-1 / Math.max(0.0001, relBase) / sr)
    const slopeK = 1 - 1 / Math.max(1.0001, ratioBase)
    const makeupLinK = Math.pow(10, makeBase / 20)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const absX = x < 0 ? -x : x

      // Per-sample effective params (replace semantics when CV is wired).
      let threshold = thrBase
      if (thrCv) {
        threshold = thrCv[i]
        if (threshold < -60) threshold = -60
        else if (threshold > 0) threshold = 0
      }
      let slope = slopeK
      if (ratioCv) {
        let r = ratioCv[i]
        if (r < 1) r = 1
        else if (r > 20) r = 20
        slope = 1 - 1 / Math.max(1.0001, r)
      }
      let atkCoef = atkCoefK
      if (atkCv) {
        let a = atkCv[i]
        if (a < 0.001) a = 0.001
        else if (a > 0.5) a = 0.5
        atkCoef = 1 - Math.exp(-1 / Math.max(0.0001, a) / sr)
      }
      let relCoef = relCoefK
      if (relCv) {
        let r = relCv[i]
        if (r < 0.01) r = 0.01
        else if (r > 3) r = 3
        relCoef = 1 - Math.exp(-1 / Math.max(0.0001, r) / sr)
      }
      let makeupLin = makeupLinK
      if (makeCv) {
        let m = makeCv[i]
        if (m < 0) m = 0
        else if (m > 24) m = 24
        makeupLin = Math.pow(10, m / 20)
      }

      // Asymmetric envelope tracking.
      if (absX > this.env) this.env += (absX - this.env) * atkCoef
      else this.env += (absX - this.env) * relCoef
      if (!isFinite(this.env) || this.env < 0) this.env = 0

      const lvlDb = this.env > 1e-9 ? 20 * Math.log10(this.env) : -180
      let grDb = (lvlDb - threshold) * slope
      if (grDb < 0) grDb = 0
      const gainLin = Math.pow(10, -grDb / 20) * makeupLin
      let y = x * gainLin
      if (!isFinite(y)) y = 0
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-compressor', CompressorProcessor)
