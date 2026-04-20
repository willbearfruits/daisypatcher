/// <reference path="./worklet.d.ts" />

/**
 * Limiter — lookahead-free brickwall. Envelope follows |in| with a very
 * fast (1 ms) attack and user-controlled release. Soft-knee tapers the
 * gain curve a couple dB below the ceiling so transients aren't clipped
 * abruptly. Output is guaranteed to not exceed the linear ceiling.
 * Registered as `'dp-limiter'`.
 */

const LIMITER_ATTACK = 0.001 // 1 ms
const LIMITER_KNEE_DB = 2

class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'ceiling', defaultValue: -0.3, minValue: -12, maxValue: 0, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.05, minValue: 0.01, maxValue: 2, automationRate: 'k-rate' }
    ]
  }

  private env = 0

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
    const ceilDb = parameters.ceiling[0] ?? -0.3
    const release = parameters.release[0] ?? 0.05

    const ceilLin = Math.pow(10, ceilDb / 20)
    const sr = sampleRate
    const atkCoef = 1 - Math.exp(-1 / (LIMITER_ATTACK * sr))
    const relCoef = 1 - Math.exp(-1 / (release * sr))
    // Soft-knee onset: start easing gain starting knee dB below ceiling.
    const kneeStartLin = Math.pow(10, (ceilDb - LIMITER_KNEE_DB) / 20)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const absX = x < 0 ? -x : x
      if (absX > this.env) this.env += (absX - this.env) * atkCoef
      else this.env += (absX - this.env) * relCoef
      if (!isFinite(this.env) || this.env < 0) this.env = 0

      // Gain computer with soft knee from kneeStartLin to ceilLin.
      let gain = 1
      if (this.env > kneeStartLin) {
        if (this.env >= ceilLin) {
          gain = ceilLin / this.env
        } else {
          // Soft knee: smooth interp of gain from 1 to ceilLin/env as env
          // travels from kneeStartLin to ceilLin.
          const t = (this.env - kneeStartLin) / (ceilLin - kneeStartLin)
          const hardGain = ceilLin / this.env
          // Smoothstep for a gentle shoulder.
          const s = t * t * (3 - 2 * t)
          gain = 1 * (1 - s) + hardGain * s
        }
      }
      let y = x * gain
      // Hard guard — in the pathological case where env lags, still clamp.
      if (y > ceilLin) y = ceilLin
      else if (y < -ceilLin) y = -ceilLin
      if (!isFinite(y)) y = 0
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-limiter', LimiterProcessor)
