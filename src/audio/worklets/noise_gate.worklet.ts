/// <reference path="./worklet.d.ts" />

/**
 * Noise gate — envelope follower on `key` (falls back to in). Opens when
 * the envelope crosses `threshold`; once below, waits `hold` seconds before
 * closing. The 0/1 gate signal is smoothed by attack on opening and
 * release on closing. Output = in * gate_smoothed.
 * Registered as `'dp-noise-gate'`.
 */

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'threshold', defaultValue: -40, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.005, minValue: 0.001, maxValue: 0.1, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0.05, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.01, maxValue: 2, automationRate: 'k-rate' }
    ]
  }

  private env = 0
  private gate = 0 // smoothed gate 0..1
  private holdRemaining = 0 // samples

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
    const keyCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    // Wave 2 CVs: cv_threshold idx 2, cv_attack idx 3, cv_release idx 4.
    const thrCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const atkCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined
    const relCv = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined
    const threshDbBase = parameters.threshold[0] ?? -40
    const attackBase = parameters.attack[0] ?? 0.005
    const hold = parameters.hold[0] ?? 0.05
    const releaseBase = parameters.release[0] ?? 0.1

    const sr = sampleRate
    // Block-rate coefs (overridden per-sample when CV is wired).
    const threshLinK = Math.pow(10, threshDbBase / 20)
    // Envelope follower: fast attack (1ms) slow release ~30ms as the
    // detector; gate smoothing uses user's attack/release.
    const detAtkCoef = 1 - Math.exp(-1 / (0.001 * sr))
    const detRelCoef = 1 - Math.exp(-1 / (0.03 * sr))
    const gateAtkCoefK = 1 - Math.exp(-1 / (attackBase * sr))
    const gateRelCoefK = 1 - Math.exp(-1 / (releaseBase * sr))
    const holdSamples = Math.floor(hold * sr)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const k = keyCh ? keyCh[i] : x
      const absK = k < 0 ? -k : k
      if (absK > this.env) this.env += (absK - this.env) * detAtkCoef
      else this.env += (absK - this.env) * detRelCoef
      if (!isFinite(this.env) || this.env < 0) this.env = 0

      let threshLin = threshLinK
      if (thrCv) {
        let tdb = thrCv[i]
        if (tdb < -80) tdb = -80
        else if (tdb > 0) tdb = 0
        threshLin = Math.pow(10, tdb / 20)
      }
      let gateAtkCoef = gateAtkCoefK
      if (atkCv) {
        let a = atkCv[i]
        if (a < 0.001) a = 0.001
        else if (a > 0.1) a = 0.1
        gateAtkCoef = 1 - Math.exp(-1 / (a * sr))
      }
      let gateRelCoef = gateRelCoefK
      if (relCv) {
        let r = relCv[i]
        if (r < 0.01) r = 0.01
        else if (r > 2) r = 2
        gateRelCoef = 1 - Math.exp(-1 / (r * sr))
      }

      let target: number
      if (this.env >= threshLin) {
        target = 1
        this.holdRemaining = holdSamples
      } else if (this.holdRemaining > 0) {
        target = 1
        this.holdRemaining--
      } else {
        target = 0
      }

      if (target > this.gate) this.gate += (target - this.gate) * gateAtkCoef
      else this.gate += (target - this.gate) * gateRelCoef
      if (!isFinite(this.gate)) this.gate = 0
      else if (this.gate < 0) this.gate = 0
      else if (this.gate > 1) this.gate = 1

      outCh[i] = x * this.gate
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-noise-gate', NoiseGateProcessor)
