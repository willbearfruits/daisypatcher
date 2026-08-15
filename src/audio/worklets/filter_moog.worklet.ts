/// <reference path="./worklet.d.ts" />

/**
 * Moog 4-pole ladder lowpass — a port of DaisySP's `MoogLadder`
 * (Huovilainen's thermal-voltage model, via Csound).
 *
 * This used to be a Stilson/Smith ladder: four one-pole stages with
 * `tanh(s4) * res * 4` fed back. Same family, different filter — the
 * device runs the nonlinearity INSIDE each stage, scaled by a thermal
 * voltage of 25 uV, and oversamples 2x per sample. `npm run test:audio`
 * put the two 36.5% apart on level, and resonance behaviour diverged
 * faster than that: the whole point of a ladder is what it does near
 * self-oscillation, which is exactly where two ladders disagree most.
 *
 * The coefficient block is recomputed only when cutoff or resonance
 * changes, as in the original — `oldFreq`/`oldRes` are not an
 * optimisation carried over for its own sake, they change the output,
 * because `tune` and `acr` lag by a sample when the knob moves.
 *
 * Cutoff CV: `cv_cutoff` (index 2) replaces the sidebar value; the legacy
 * `freq_cv` (index 1) still applies octave scaling on top.
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

  /** `delay_[6]` and `tanhstg_[3]` from the original. */
  private readonly delay = new Float64Array(6)
  private readonly tanhstg = new Float64Array(3)
  private oldFreq = 0
  private oldRes = -1
  private oldAcr = 0
  private oldTune = 0

  /**
   * `MoogLadder::my_tanh` — piecewise, not `Math.tanh`.
   *
   * Below 0.5 it is the identity, above 4 it saturates to +/-1. Those
   * shortcuts are audible, not just fast: the linear region is what keeps
   * the ladder's small-signal gain exactly 1.
   */
  private myTanh(x: number): number {
    let sign = 1
    if (x < 0) {
      sign = -1
      x = -x
    }
    if (x >= 4) return sign
    if (x < 0.5) return x * sign
    return sign * Math.tanh(x)
  }

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
    const THERMAL = 0.000025

    const delay = this.delay
    const tanhstg = this.tanhstg
    const stg = [0, 0, 0, 0]

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      let x = inCh ? inCh[i] : 0

      // cv_cutoff replaces sidebar directly; freq_cv still applies as
      // octave-scaling on top (legacy behavior).
      let freq = cutoffCv ? cutoffCv[i] : freqIsA ? freqArr[i] : freqArr[0]
      if (hasCv) freq = freq * Math.pow(2, freqCv![i])
      if (freq < 20) freq = 20
      else if (freq > maxFreq) freq = maxFreq
      let res = resCv ? resCv[i] : resIsA ? resArr[i] : resArr[0]
      if (res < 0) res = 0

      let acr: number
      let tune: number
      if (this.oldFreq !== freq || this.oldRes !== res) {
        const fc = freq / sampleRate
        const f = 0.5 * fc
        const fc2 = fc * fc
        const fc3 = fc2 * fc2
        const fcr = 1.873 * fc3 + 0.4955 * fc2 - 0.649 * fc + 0.9988
        acr = -3.9364 * fc2 + 1.8409 * fc + 0.9968
        tune = (1 - Math.exp(-(2 * Math.PI * f * fcr))) / THERMAL
        this.oldFreq = freq
        this.oldRes = res
        this.oldAcr = acr
        this.oldTune = tune
      } else {
        res = this.oldRes
        acr = this.oldAcr
        tune = this.oldTune
      }

      const res4 = 4 * res * acr

      // 2x oversampled, as in the original.
      for (let j = 0; j < 2; j++) {
        x -= res4 * delay[5]
        delay[0] = stg[0] = delay[0] + tune * (this.myTanh(x * THERMAL) - tanhstg[0])
        for (let k = 1; k < 4; k++) {
          x = stg[k - 1]
          tanhstg[k - 1] = this.myTanh(x * THERMAL)
          stg[k] =
            delay[k] +
            tune * (tanhstg[k - 1] - (k !== 3 ? tanhstg[k] : this.myTanh(delay[k] * THERMAL)))
          delay[k] = stg[k]
        }
        delay[5] = (stg[3] + delay[4]) * 0.5
        delay[4] = stg[3]
      }

      let y = delay[5]
      if (!isFinite(y) || y > 100 || y < -100) {
        y = 0
        delay.fill(0)
        tanhstg.fill(0)
      }
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-filter-moog', FilterMoogProcessor)
