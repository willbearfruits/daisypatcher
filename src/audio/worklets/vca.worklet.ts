/// <reference path="./worklet.d.ts" />

/**
 * VCA worklet — audio × (cv + bias). Input 0 is audio, input 1 is CV.
 * If CV is disconnected, falls through as if CV were unity (so plain gain
 * control via `bias` still works). Registered as `'dp-vca'`.
 */

class VcaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'bias',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      }
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

    const inAudio = inputs[0]
    const inCv = inputs[1]
    const bias = parameters.bias[0] ?? 0

    const audioCh = inAudio && inAudio.length > 0 ? inAudio[0] : undefined
    const cvCh = inCv && inCv.length > 0 ? inCv[0] : undefined

    if (!audioCh) {
      outCh.fill(0)
    } else {
      const n = outCh.length
      if (cvCh) {
        for (let i = 0; i < n; i++) {
          const g = cvCh[i] + bias
          outCh[i] = audioCh[i] * g
        }
      } else {
        // No CV connected → pure bias (0 by default = silent VCA).
        for (let i = 0; i < n; i++) {
          outCh[i] = audioCh[i] * bias
        }
      }
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-vca', VcaProcessor)
