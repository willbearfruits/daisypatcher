/// <reference path="./worklet.d.ts" />

/**
 * Overdrive — tanh-based saturator with a 1-pole low-pass tone control.
 * `drive` maps [0,1] → gain [1, 20]; `tone` [0,1] sets cutoff from dark
 * (~500 Hz) to bright (~10 kHz). Registered as `'dp-overdrive'`.
 */

class OverdriveProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'drive', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private lpZ = 0

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
    const drive = parameters.drive[0] ?? 0.3
    const tone = parameters.tone[0] ?? 0.5

    // Gain goes 1..20 so tanh has something to bite at high drive.
    const gain = 1 + drive * 19
    // Normalize post-saturation so low drive stays near unity.
    const normalize = 1 / Math.tanh(gain)

    // Tone: one-pole LP, cutoff from ~500 Hz to ~10 kHz.
    const cutoff = 500 + tone * 9500
    const rc = 1 / (2 * Math.PI * cutoff)
    const dt = 1 / sampleRate
    const alpha = dt / (rc + dt)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const sat = Math.tanh(x * gain) * normalize
      this.lpZ = this.lpZ + alpha * (sat - this.lpZ)
      outCh[i] = this.lpZ
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-overdrive', OverdriveProcessor)
