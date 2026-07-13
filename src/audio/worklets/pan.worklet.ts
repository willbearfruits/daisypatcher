/// <reference path="./worklet.d.ts" />

/**
 * Stereo panner — equal-power pan law. Input 0 is audio, input 1 is optional
 * CV that adds to the `pan` param. Output 0 = left, output 1 = right.
 * Registered as `'dp-pan'`.
 */

const HALF_PI = Math.PI * 0.5

class PanProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'pan',
        defaultValue: 0,
        minValue: -1,
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
    const outL = outputs[0]?.[0]
    const outR = outputs[1]?.[0]
    if (!outL || !outR) return true

    const inAudio = inputs[0]
    const inCv = inputs[1]
    const audioCh = inAudio && inAudio.length > 0 ? inAudio[0] : undefined
    const cvCh = inCv && inCv.length > 0 ? inCv[0] : undefined
    // Wave 2 cv_pan at index 2 — replace-semantics override of `pan`.
    const panCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    const basePan = parameters.pan[0] ?? 0
    const n = outL.length

    if (!audioCh) {
      outL.fill(0)
      outR.fill(0)
      return true
    }

    for (let i = 0; i < n; i++) {
      // cv_pan replaces sidebar directly; legacy `cv` still adds as offset.
      let root = basePan
      if (panCv) {
        root = panCv[i]
        if (root < -1) root = -1
        else if (root > 1) root = 1
      }
      let p = root + (cvCh ? cvCh[i] : 0)
      if (p > 1) p = 1
      else if (p < -1) p = -1
      // p in [-1,1] → angle in [0, π/2]. Equal-power.
      const theta = (p + 1) * 0.5 * HALF_PI
      const s = audioCh[i]
      outL[i] = s * Math.cos(theta)
      outR[i] = s * Math.sin(theta)
    }

    return true
  }
}

registerProcessor('dp-pan', PanProcessor)
