/// <reference path="./worklet.d.ts" />

/**
 * State-variable filter — a port of DaisySP's `Svf`, which is a Chamberlin
 * SVF but not the plain one this used to be.
 *
 * Three differences, all audible:
 *   - it runs the difference equation TWICE per input sample and averages
 *     the two passes, which is why `SetFreq` divides by `sr * 2`;
 *   - `damp` is `min(2*(1 - res^0.25), min(2, 2/freq - freq*0.5))`, not
 *     `2*(1 - res)` — the quarter-power makes the resonance knob far less
 *     linear, and the second term is a stability bound that matters near
 *     Nyquist;
 *   - there is a cubic `drive` term subtracted from the band state, fed
 *     by `pre_drive_ * res_` with `pre_drive_` sitting at 0.5 from `Init`.
 *
 * Together those put the emulator 11.3% off the firmware on level and
 * further off in resonance character.
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

  // `Svf` internal state. All four taps come out of one pass pair.
  private low = 0
  private high = 0
  private band = 0
  private notchS = 0
  /** `pre_drive_` from `Init`; `SetDrive` is never called by the emitter. */
  private readonly preDrive = 0.5

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
    // Replace-semantics CV (Wave 2): when connected, overrides sidebar.
    const cutoffCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const resCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

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

    // `fc_max_` in the original is sr/3, not sr*0.45.
    const fcMax = sampleRate / 3

    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      // cv_cutoff overrides sidebar directly; freq_cv still applies as
      // octave-scaling on top (legacy behavior per Wave 2 policy).
      let freq = cutoffCv ? cutoffCv[i] : freqIsA ? freqArr[i] : freqArr[0]
      if (hasCv) freq = freq * Math.pow(2, freqCv![i])
      if (freq < 1e-6) freq = 1e-6
      else if (freq > fcMax) freq = fcMax

      let r = resCv ? resCv[i] : resIsA ? resArr[i] : resArr[0]
      if (r < 0) r = 0
      else if (r > 1) r = 1

      // `SetFreq`: the /2 is because the filter is double-sampled below.
      const arg = freq / (sampleRate * 2)
      const f = 2 * Math.sin(Math.PI * (arg < 0.25 ? arg : 0.25))
      // `SetRes`: quarter-power, bounded by the stability term.
      const a = 2 * (1 - Math.pow(r, 0.25))
      const b = 2 / f - f * 0.5
      const inner = 2 < b ? 2 : b
      const damp = a < inner ? a : inner
      const drive = this.preDrive * r

      // First pass.
      this.notchS = x - damp * this.band
      this.low = this.low + f * this.band
      this.high = this.notchS - this.low
      this.band = f * this.high + this.band - drive * this.band * this.band * this.band
      let outLow = 0.5 * this.low
      let outHigh = 0.5 * this.high
      let outBand = 0.5 * this.band
      let outNotch = 0.5 * this.notchS
      // Second pass, averaged in.
      this.notchS = x - damp * this.band
      this.low = this.low + f * this.band
      this.high = this.notchS - this.low
      this.band = f * this.high + this.band - drive * this.band * this.band * this.band
      outLow += 0.5 * this.low
      outHigh += 0.5 * this.high
      outBand += 0.5 * this.band
      outNotch += 0.5 * this.notchS

      if (!isFinite(this.low) || this.low > 100 || this.low < -100) {
        this.low = 0
        this.high = 0
        this.band = 0
        this.notchS = 0
        outLow = 0
        outHigh = 0
        outBand = 0
        outNotch = 0
      }

      if (lp) lp[i] = outLow
      if (hp) hp[i] = outHigh
      if (bp) bp[i] = outBand
      if (notch) notch[i] = outNotch
    }

    return true
  }
}

registerProcessor('dp-filter-svf', FilterSvfProcessor)
