/// <reference path="./worklet.d.ts" />

/**
 * Random CV stepper — picks a new random target in [-range, range] and
 * slews toward it. When the clock input is connected (at least one
 * channel of samples present), the target updates on each rising edge
 * (prev<0.5, curr>=0.5). Otherwise it free-runs at `rate` Hz. `smooth` in
 * [0,1] maps to a one-pole slew coefficient: 0 snaps instantly, 1 is a
 * very slow glide (~1s time constant at 48k).
 * Registered as `'dp-random'`.
 */

class RandomProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 2, minValue: 0.1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'smooth', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private target = 0
  private current = 0
  private freePhase = 0 // samples counted toward next free-run tick
  private clkHigh = false

  private pickTarget(range: number): void {
    // Uniform in [-1, 1] scaled by range.
    this.target = (Math.random() * 2 - 1) * range
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const rate = parameters.rate[0] ?? 2
    const range = parameters.range[0] ?? 1
    let smooth = parameters.smooth[0] ?? 0
    if (smooth < 0) smooth = 0
    else if (smooth > 1) smooth = 1

    // Slew coefficient: at smooth=0, coef=1 (snap). At smooth=1, ~1s time const.
    // One-pole: current += (target - current) * coef.
    let coef: number
    if (smooth <= 0) coef = 1
    else {
      // Map smooth to time constant 0.001s .. 1s.
      const tc = 0.001 + smooth * 1.0
      coef = 1 - Math.exp(-1 / (tc * sampleRate))
      if (coef > 1) coef = 1
      else if (coef < 0) coef = 0
    }

    const clkCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const hasClock = !!clkCh

    const samplesPerTick = sampleRate / Math.max(0.0001, rate)

    const n = out.length
    for (let i = 0; i < n; i++) {
      if (hasClock) {
        const v = clkCh![i]
        const nowHigh = v >= 0.5
        if (nowHigh && !this.clkHigh) this.pickTarget(range)
        this.clkHigh = nowHigh
      } else {
        this.freePhase++
        if (this.freePhase >= samplesPerTick) {
          this.freePhase -= samplesPerTick
          this.pickTarget(range)
        }
      }
      this.current += (this.target - this.current) * coef
      out[i] = this.current
    }

    return true
  }
}

registerProcessor('dp-random', RandomProcessor)
