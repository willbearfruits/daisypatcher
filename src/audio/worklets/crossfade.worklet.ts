/// <reference path="./worklet.d.ts" />

/**
 * Crossfade between A and B. Blend `t` in [0,1]: 0 = all A, 1 = all B.
 * When CV is connected, t = clamp(cv + mix, 0, 1); otherwise t = mix.
 * Equal-power crossfade using sin/cos of t*π/2.
 * Registered as `'dp-crossfade'`.
 */

const XF_HALF_PI = Math.PI * 0.5

class CrossfadeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
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

    const a = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const b = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const cv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const mix = parameters.mix[0] ?? 0.5

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      let t = cv ? cv[i] + mix : mix
      if (t < 0) t = 0
      else if (t > 1) t = 1
      const theta = t * XF_HALF_PI
      const ga = Math.cos(theta)
      const gb = Math.sin(theta)
      const va = a ? a[i] : 0
      const vb = b ? b[i] : 0
      outCh[i] = va * ga + vb * gb
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-crossfade', CrossfadeProcessor)
