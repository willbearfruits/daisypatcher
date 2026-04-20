/// <reference path="./worklet.d.ts" />

/**
 * Flanger — short modulated delay line with signed feedback. Base tap around
 * 1.5ms, modulation up to ±4ms scaled by depth → tap range ~0.5..10ms.
 * Negative feedback gives the classic hollow tonal character.
 * Registered as `'dp-flanger'`.
 */

class FlangerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 0.3, minValue: 0.05, maxValue: 5, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: -0.95, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly TWO_PI = Math.PI * 2
  private readonly BUF_SIZE = 2048
  private readonly BASE_MS = 1.5
  private readonly MOD_MS = 4
  private buffer = new Float32Array(this.BUF_SIZE)
  private writeIdx = 0
  private lfoPhase = 0

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
    const rate = parameters.rate[0] ?? 0.3
    const depth = parameters.depth[0] ?? 0.6
    let fb = parameters.feedback[0] ?? 0.5
    if (fb > 0.95) fb = 0.95
    else if (fb < -0.95) fb = -0.95
    const mix = parameters.mix[0] ?? 0.5

    const sr = sampleRate
    const buf = this.buffer
    const bufLen = buf.length
    const baseSamples = (this.BASE_MS / 1000) * sr
    const modSamples = (this.MOD_MS / 1000) * sr * depth
    const phaseInc = (this.TWO_PI * rate) / sr

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      // LFO 0..1 gives a one-sided sweep so the tap never goes below base.
      const lfo = (Math.sin(this.lfoPhase) + 1) * 0.5
      let delaySamples = baseSamples + lfo * modSamples
      if (delaySamples < 1) delaySamples = 1
      const maxDelay = bufLen - 2
      if (delaySamples > maxDelay) delaySamples = maxDelay

      let readPos = this.writeIdx - delaySamples
      while (readPos < 0) readPos += bufLen
      const r0 = Math.floor(readPos)
      const frac = readPos - r0
      const r1 = (r0 + 1) % bufLen
      const delayed = buf[r0] * (1 - frac) + buf[r1] * frac

      let w = x + delayed * fb
      if (!isFinite(w)) w = 0
      buf[this.writeIdx] = w
      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0

      outCh[i] = x * (1 - mix) + delayed * mix

      this.lfoPhase += phaseInc
      if (this.lfoPhase >= this.TWO_PI) this.lfoPhase -= this.TWO_PI
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-flanger', FlangerProcessor)
