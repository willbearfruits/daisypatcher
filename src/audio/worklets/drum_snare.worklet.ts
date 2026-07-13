/// <reference path="./worklet.d.ts" />

/**
 * Snare. Two detuned triangle bodies at `tune` and tune*1.59 plus white
 * noise highpassed at ~1 kHz. `tone` blends body↔noise. Amp envelope is a
 * short attack and exponential decay.
 *
 * Inputs:
 *   0  trigger  — gate
 *   1  cv_tune  — replaces sidebar `tune` (Hz, clamped 100..400)
 *   2  cv_decay — replaces sidebar `decay` (s, clamped 0.05..1)
 *   3  cv_noise — replaces sidebar `tone` (0..1, noise mix)
 *
 * Registered as `'dp-drum-snare'`.
 */

class DrumSnareProcessor extends AudioWorkletProcessor {
  private readonly TWO_PI = Math.PI * 2

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'tune', defaultValue: 200, minValue: 100, maxValue: 400, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.2, minValue: 0.05, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private phase1 = 0
  private phase2 = 0
  private trigHigh = false
  private ampEnv = 0
  // Single-pole highpass state for noise: y = x - prev_x_lp; use a 1-pole LP
  // and subtract.
  private hpPrev = 0

  private tri(phase: number, twoPi: number): number {
    const t = phase / twoPi
    return 4 * Math.abs(t - 0.5) - 1
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

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const tuneCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const decayCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const noiseCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    let tune = parameters.tune[0] ?? 200
    if (tuneCv) {
      tune = tuneCv[0]
      if (tune < 100) tune = 100
      else if (tune > 400) tune = 400
    }
    let decay = parameters.decay[0] ?? 0.2
    if (decayCv) {
      decay = decayCv[0]
    }
    if (decay < 0.05) decay = 0.05
    else if (decay > 1) decay = 1
    let tone = parameters.tone[0] ?? 0.5
    if (noiseCv) {
      tone = noiseCv[0]
      if (tone < 0) tone = 0
      else if (tone > 1) tone = 1
    }

    const ampCoef = Math.exp(-1 / (decay * sampleRate))
    // HP cutoff ~ 1 kHz. Simple 1-pole LP coef for the "lowband" we subtract.
    // coef = exp(-2π fc / SR)
    const twoPi = this.TWO_PI
    const lpCoef = Math.exp(-twoPi * 1000 / sampleRate)

    const inc1 = (twoPi * tune) / sampleRate
    const inc2 = (twoPi * (tune * 1.59)) / sampleRate
    const n = outCh.length

    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) {
        this.ampEnv = 1
        this.phase1 = 0
        this.phase2 = 0
      }
      this.trigHigh = nowHigh

      // Body: two detuned triangles, sum and scale.
      const b = (this.tri(this.phase1, twoPi) + this.tri(this.phase2, twoPi)) * 0.5

      // Noise with highpass.
      const w = Math.random() * 2 - 1
      this.hpPrev = this.hpPrev * lpCoef + w * (1 - lpCoef)
      const noiseHp = w - this.hpPrev

      // Blend.
      let y = (b * (1 - tone) + noiseHp * tone) * this.ampEnv
      this.ampEnv *= ampCoef

      if (!isFinite(y)) { y = 0; this.ampEnv = 0; this.hpPrev = 0 }
      if (y > 1) y = 1
      else if (y < -1) y = -1
      outCh[i] = y

      this.phase1 += inc1
      if (this.phase1 >= twoPi) this.phase1 -= twoPi
      this.phase2 += inc2
      if (this.phase2 >= twoPi) this.phase2 -= twoPi
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-drum-snare', DrumSnareProcessor)
