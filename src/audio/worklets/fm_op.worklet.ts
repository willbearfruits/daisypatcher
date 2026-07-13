/// <reference path="./worklet.d.ts" />

/**
 * Single FM operator. One sine oscillator with phase-mod input and a
 * feedback tap on its own previous output. Registered as `'dp-fm-op'`.
 *
 *   out = sin(phase + mod_in + feedback * last_out) * amplitude
 *
 * Inputs:
 *   0  mod          — audio-rate phase-mod signal
 *   1  pitch_cv     — 1 V/oct style exponential pitch mod (offset semantics, preserved)
 *   2  cv_amp       — replaces sidebar `amplitude` (0..1)
 *   3  cv_mod_index — replaces sidebar `feedback` (self-FM depth 0..1)
 */

class FmOpProcessor extends AudioWorkletProcessor {
  private readonly TWO_PI = Math.PI * 2

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 1, minValue: 0.125, maxValue: 16, automationRate: 'k-rate' },
      { name: 'amplitude', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private phase = 0
  private lastOut = 0

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const modCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const pitchCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const ampCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const modIdxCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    const baseFreq = parameters.frequency[0] ?? 220
    const ratio = parameters.ratio[0] ?? 1
    const sidebarAmp = parameters.amplitude[0] ?? 0.7
    const sidebarFb = parameters.feedback[0] ?? 0

    const twoPi = this.TWO_PI
    const n = outCh.length
    for (let i = 0; i < n; i++) {
      let freq = baseFreq * ratio
      if (pitchCv) freq *= Math.pow(2, pitchCv[i])
      if (freq < 0) freq = 0
      else if (freq > sampleRate * 0.5) freq = sampleRate * 0.5

      // Replace-semantics: CV overrides sidebar amp/feedback when connected.
      let amp = sidebarAmp
      if (ampCv) {
        amp = ampCv[i]
        if (amp < 0) amp = 0
        else if (amp > 1) amp = 1
      }
      let fb = sidebarFb
      if (modIdxCv) {
        fb = modIdxCv[i]
        if (fb < 0) fb = 0
        else if (fb > 1) fb = 1
      }

      const inc = (twoPi * freq) / sampleRate
      const modIn = modCh ? modCh[i] : 0
      let y = Math.sin(this.phase + modIn + fb * this.lastOut) * amp
      if (!isFinite(y)) y = 0
      if (y > 1) y = 1
      else if (y < -1) y = -1
      this.lastOut = y
      outCh[i] = y

      this.phase += inc
      if (this.phase >= twoPi) this.phase -= twoPi
      else if (this.phase < 0) this.phase += twoPi
    }

    if (!isFinite(this.phase)) this.phase = 0
    if (!isFinite(this.lastOut)) this.lastOut = 0

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-fm-op', FmOpProcessor)
