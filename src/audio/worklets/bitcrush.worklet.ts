/// <reference path="./worklet.d.ts" />

/**
 * Bitcrusher — quantizes amplitude to `bits` levels and samples the input
 * at a reduced rate (`rate` fraction of the system sample rate). Output is
 * blended with dry input via `mix`. Registered as `'dp-bitcrush'`.
 */

class BitcrushProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 0.5, minValue: 0.01, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private phase = 0
  private held = 0

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
    const bits = Math.max(1, Math.min(16, Math.round(parameters.bits[0] ?? 8)))
    const rate = Math.max(0.01, Math.min(1, parameters.rate[0] ?? 0.5))
    const mix = parameters.mix[0] ?? 1

    const levels = Math.pow(2, bits - 1)
    const step = 1 / levels

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      // Advance the downsampling phase. When it crosses 1, we grab a new
      // sample, quantize, and hold it until the next crossing.
      this.phase += rate
      if (this.phase >= 1) {
        this.phase -= 1
        let q = Math.round(x / step) * step
        if (q > 1) q = 1
        else if (q < -1) q = -1
        this.held = q
      }

      outCh[i] = x * (1 - mix) + this.held * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-bitcrush', BitcrushProcessor)
