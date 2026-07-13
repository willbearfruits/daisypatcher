/// <reference path="./worklet.d.ts" />

/**
 * Moog-style 4-pole ladder lowpass (Stilson/Smith flavor).
 * Four cascaded 1-pole LP stages with negative feedback from stage 4 into the
 * input, scaled by resonance*4. Tanh is applied to the feedback for character
 * and implicit saturation — prevents the ladder from blowing up at high res.
 *
 * Cutoff prewarp: f = 2 * sin(PI * fc / sr), clamped to sr*0.45.
 * CV at input index 1 is per-sample octave scaling; bypassed if no cable.
 *
 * Registered as `'dp-filter-moog'`.
 */

class FilterMoogProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'a-rate' }
    ]
  }

  private s1 = 0
  private s2 = 0
  private s3 = 0
  private s4 = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (_event: MessageEvent) => {
      /* no enum params for Moog LP */
    }
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

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const freqCv = inputs[1]?.[0]
    const hasCv = !!(freqCv && freqCv.length > 0)
    // Wave 2 replace-semantics CV.
    const cutoffCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const resCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    const freqArr = parameters.frequency
    const resArr = parameters.resonance
    const freqIsA = freqArr.length > 1
    const resIsA = resArr.length > 1

    const maxFreq = sampleRate * 0.45

    let fCoeff = 0
    let kCoeff = 0
    const perSample = hasCv || freqIsA || resIsA || !!cutoffCv || !!resCv
    if (!perSample) {
      let freq = freqArr[0]
      if (freq < 20) freq = 20
      else if (freq > maxFreq) freq = maxFreq
      fCoeff = 2 * Math.sin((Math.PI * freq) / sampleRate)
      if (fCoeff > 1) fCoeff = 1
      let r = resArr[0]
      if (r < 0) r = 0
      else if (r > 1) r = 1
      kCoeff = r * 4
    }

    let s1 = this.s1
    let s2 = this.s2
    let s3 = this.s3
    let s4 = this.s4

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      let f = fCoeff
      let k = kCoeff
      if (perSample) {
        // cv_cutoff replaces sidebar directly; freq_cv still applies as
        // octave-scaling on top (legacy behavior).
        let freq = cutoffCv ? cutoffCv[i] : (freqIsA ? freqArr[i] : freqArr[0])
        if (hasCv) freq = freq * Math.pow(2, freqCv![i])
        if (freq < 20) freq = 20
        else if (freq > maxFreq) freq = maxFreq
        f = 2 * Math.sin((Math.PI * freq) / sampleRate)
        if (f > 1) f = 1
        let r = resCv ? resCv[i] : (resIsA ? resArr[i] : resArr[0])
        if (r < 0) r = 0
        else if (r > 1) r = 1
        k = r * 4
      }

      // Feedback from 4th stage, soft-clipped via tanh for stability/character.
      const fb = Math.tanh(s4) * k
      const input = x - fb

      s1 = s1 + f * (input - s1)
      s2 = s2 + f * (s1 - s2)
      s3 = s3 + f * (s2 - s3)
      s4 = s4 + f * (s3 - s4)

      // NaN / runaway guards.
      if (!isFinite(s1) || s1 > 100 || s1 < -100) s1 = 0
      if (!isFinite(s2) || s2 > 100 || s2 < -100) s2 = 0
      if (!isFinite(s3) || s3 > 100 || s3 < -100) s3 = 0
      if (!isFinite(s4) || s4 > 100 || s4 < -100) s4 = 0

      outCh[i] = s4
    }

    this.s1 = s1
    this.s2 = s2
    this.s3 = s3
    this.s4 = s4

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-filter-moog', FilterMoogProcessor)
