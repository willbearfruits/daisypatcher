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
    const threshold = parameters.threshold[0] ?? -20
    const ratio = parameters.ratio[0] ?? 4
    const attack = parameters.attack[0] ?? 0.01
    const release = parameters.release[0] ?? 0.1
    const makeup = parameters.makeup[0] ?? 0

    const sr = sampleRate
    // One-pole coefs: y += (x - y) * coef. coef = 1 - exp(-1/(t*sr))
    const atkCoef = 1 - Math.exp(-1 / Math.max(0.0001, attack) / sr)
    const relCoef = 1 - Math.exp(-1 / Math.max(0.0001, release) / sr)
    const slope = 1 - 1 / Math.max(1.0001, ratio)
    const makeupLin = Math.pow(10, makeup / 20)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const absX = x < 0 ? -x : x
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
