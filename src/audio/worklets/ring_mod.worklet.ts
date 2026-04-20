/// <reference path="./worklet.d.ts" />

/**
 * Ring modulator — out = lerp(a, a*b, mix). At mix=0 the dry A passes
 * through; at mix=1 the output is the full a*b product. Either input
 * unpatched is treated as 0 for the corresponding factor; dry tap still
 * follows A so unpatching B at mix=0 still gives audible dry A.
 * Registered as `'dp-ring-mod'`.
 */

class RingModProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const aCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const bCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    let mix = parameters.mix[0] ?? 1
    if (mix < 0) mix = 0
    else if (mix > 1) mix = 1
    const inv = 1 - mix

    const n = out.length
    for (let i = 0; i < n; i++) {
      const a = aCh ? aCh[i] : 0
      const b = bCh ? bCh[i] : 0
      out[i] = a * inv + (a * b) * mix
    }

    for (let c = 1; c < (outputs[0]?.length ?? 1); c++) outputs[0][c].set(out)
    return true
  }
}

registerProcessor('dp-ring-mod', RingModProcessor)
