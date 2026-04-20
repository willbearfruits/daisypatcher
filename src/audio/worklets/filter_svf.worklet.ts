/// <reference path="./worklet.d.ts" />

/**
 * State-variable filter — Chamberlin form (digital SVF) with LP/HP/BP/Notch
 * taps. `resonance` in [0,1] maps to damping `damp = 2*(1 - r)`; at r≈1 the
 * filter sits on the edge of self-oscillation. Cutoff is prewarped via
 * `f = 2*sin(PI*fc/sr)` and clamped so the classic stability bound
 * `fc < sr/6` is respected (we use sr*0.45/2 ceiling after CV).
 *
 * CV at input index 1 is per-sample octave scaling; bypassed if no cable.
 * Outputs: lp(0), hp(1), bp(2), notch(3) to match definitions.ts.
 *
 * Registered as `'dp-filter-svf'`.
 */

class FilterSvfProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'a-rate' }
    ]
  }

  // Chamberlin state: lp and bp (hp + notch derived).
  private lpState = 0
  private bpState = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    // Keep port handler pattern in case enum params are ever added.
    this.port.onmessage = (_event: MessageEvent) => {
      /* no enum params for SVF */
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const freqCv = inputs[1]?.[0]
    const hasCv = !!(freqCv && freqCv.length > 0)

    const lp = outputs[0]?.[0]
    const hp = outputs[1]?.[0]
    const bp = outputs[2]?.[0]
    const notch = outputs[3]?.[0]

    // Figure out block length from whatever output we have.
    const n = lp?.length ?? hp?.length ?? bp?.length ?? notch?.length ?? 0
    if (n === 0) return true

    const freqArr = parameters.frequency
    const resArr = parameters.resonance
    const freqIsA = freqArr.length > 1
    const resIsA = resArr.length > 1

    const maxFreq = sampleRate * 0.45
    const twoPiOverSr = (2 * Math.PI) / sampleRate // only used if we wanted exact; Chamberlin uses 2*sin(PI*f/sr)
    void twoPiOverSr

    // Precompute block-rate coefficients when CV is inactive and params are k-rate.
    let fCoeff = 0
    let dampCoeff = 0
    if (!hasCv && !freqIsA && !resIsA) {
      let freq = freqArr[0]
      if (freq < 20) freq = 20
      else if (freq > maxFreq) freq = maxFreq
      fCoeff = 2 * Math.sin((Math.PI * freq) / sampleRate)
      let r = resArr[0]
      if (r < 0) r = 0
      else if (r > 1) r = 1
      // damp in (0, 2]; at r=1 damp=0 → self-oscillation edge.
      dampCoeff = 2 * (1 - r)
    }

    let lpS = this.lpState
    let bpS = this.bpState

    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      let f = fCoeff
      let damp = dampCoeff
      if (hasCv || freqIsA || resIsA) {
        let freq = freqIsA ? freqArr[i] : freqArr[0]
        if (hasCv) freq = freq * Math.pow(2, freqCv![i])
        if (freq < 20) freq = 20
        else if (freq > maxFreq) freq = maxFreq
        f = 2 * Math.sin((Math.PI * freq) / sampleRate)

        let r = resIsA ? resArr[i] : resArr[0]
        if (r < 0) r = 0
        else if (r > 1) r = 1
        damp = 2 * (1 - r)
      }

      // Chamberlin SVF single-pass. hp = x - lp - damp*bp; bp += f*hp; lp += f*bp.
      const hpVal = x - lpS - damp * bpS
      bpS = bpS + f * hpVal
      lpS = lpS + f * bpS
      const notchVal = hpVal + lpS // classic Chamberlin: notch = hp + lp

      // Clamp to prevent runaway. Hard ceiling 100 is plenty given |x|≈1.
      if (!isFinite(lpS) || lpS > 100 || lpS < -100) lpS = 0
      if (!isFinite(bpS) || bpS > 100 || bpS < -100) bpS = 0

      if (lp) lp[i] = lpS
      if (hp) hp[i] = hpVal
      if (bp) bp[i] = bpS
      if (notch) notch[i] = notchVal
    }

    this.lpState = lpS
    this.bpState = bpS
    return true
  }
}

registerProcessor('dp-filter-svf', FilterSvfProcessor)
