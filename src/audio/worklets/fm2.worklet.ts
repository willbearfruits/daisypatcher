/// <reference path="./worklet.d.ts" />

/**
 * 2-operator FM — an internal modulator phase-modulates the carrier.
 * Classic DX7-style voice.
 *
 *   mod = sin(modPhase) * mod_index
 *   out = sin(carrierPhase + mod) * carrier_amp
 *
 * Inputs:
 *   0  pitch_cv     — 1 V/oct style exponential pitch mod (offset semantics, preserved)
 *   1  amp_cv       — VCA-style amp scaling (offset semantics, preserved)
 *   2  cv_mod_index — replaces sidebar `mod_index` (0..20)
 *
 * Registered as `'dp-fm2'`.
 */

class Fm2Processor extends AudioWorkletProcessor {
  private readonly TWO_PI = Math.PI * 2

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 8000, automationRate: 'k-rate' },
      { name: 'mod_ratio', defaultValue: 2, minValue: 0.125, maxValue: 16, automationRate: 'k-rate' },
      { name: 'mod_index', defaultValue: 3, minValue: 0, maxValue: 20, automationRate: 'k-rate' },
      { name: 'carrier_amp', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private carrierPhase = 0
  private modPhase = 0

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
    const ampCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const modIdxCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    const baseFreq = parameters.frequency[0] ?? 220
    const modRatio = parameters.mod_ratio[0] ?? 2
    const sidebarModIndex = parameters.mod_index[0] ?? 3
    const baseAmp = parameters.carrier_amp[0] ?? 0.7

    const twoPi = this.TWO_PI
    const nyquist = sampleRate * 0.5
    const n = outCh.length

    for (let i = 0; i < n; i++) {
      const cvPitch = pitchCv ? pitchCv[i] : 0
      const cvAmp = ampCv ? ampCv[i] : 0

      let carrierFreq = baseFreq * Math.pow(2, cvPitch)
      if (carrierFreq < 0) carrierFreq = 0
      else if (carrierFreq > nyquist) carrierFreq = nyquist
      let modFreq = carrierFreq * modRatio
      if (modFreq > nyquist) modFreq = nyquist

      const cInc = (twoPi * carrierFreq) / sampleRate
      const mInc = (twoPi * modFreq) / sampleRate

      // Replace-semantics: CV overrides sidebar mod_index when connected.
      let modIndex = sidebarModIndex
      if (modIdxCv) {
        modIndex = modIdxCv[i]
        if (modIndex < 0) modIndex = 0
        else if (modIndex > 20) modIndex = 20
      }

      const mod = Math.sin(this.modPhase) * modIndex
      let amp = baseAmp
      if (ampCv) amp = baseAmp * (cvAmp > 0 ? cvAmp : 0)
      let y = Math.sin(this.carrierPhase + mod) * amp
      if (!isFinite(y)) y = 0
      if (y > 1) y = 1
      else if (y < -1) y = -1
      outCh[i] = y

      this.carrierPhase += cInc
      if (this.carrierPhase >= twoPi) this.carrierPhase -= twoPi
      else if (this.carrierPhase < 0) this.carrierPhase += twoPi
      this.modPhase += mInc
      if (this.modPhase >= twoPi) this.modPhase -= twoPi
      else if (this.modPhase < 0) this.modPhase += twoPi
    }

    if (!isFinite(this.carrierPhase)) this.carrierPhase = 0
    if (!isFinite(this.modPhase)) this.modPhase = 0

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-fm2', Fm2Processor)
