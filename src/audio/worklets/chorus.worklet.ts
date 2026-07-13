/// <reference path="./worklet.d.ts" />

/**
 * Chorus — short delay line modulated by an internal sine LFO, blended
 * with the dry signal. Base delay 8ms, modulation ±6ms scaled by depth,
 * yielding a read tap in the 2..15ms range. 2048-sample circular buffer
 * is large enough for all supported sample rates at these tap lengths.
 * Fractional read via linear interpolation.
 * Registered as `'dp-chorus'`.
 */

const CHORUS_BUF_SIZE = 2048
const CHORUS_TWO_PI = Math.PI * 2
const BASE_DELAY_MS = 8
const MOD_RANGE_MS = 6

class ChorusProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 0.8, minValue: 0.05, maxValue: 8, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private buffer = new Float32Array(CHORUS_BUF_SIZE)
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
    const rateCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const depthCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const mixCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    const rateBase = parameters.rate[0] ?? 0.8
    const depthBase = parameters.depth[0] ?? 0.5
    const mixBase = parameters.mix[0] ?? 0.5

    const buf = this.buffer
    const bufLen = buf.length
    const sr = sampleRate
    const baseSamples = (BASE_DELAY_MS / 1000) * sr
    const modRange = (MOD_RANGE_MS / 1000) * sr

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      let rate = rateBase
      if (rateCv) {
        rate = rateCv[i]
        if (rate < 0.05) rate = 0.05
        else if (rate > 8) rate = 8
      }
      let depth = depthBase
      if (depthCv) {
        depth = depthCv[i]
        if (depth < 0) depth = 0
        else if (depth > 1) depth = 1
      }
      let mix = mixBase
      if (mixCv) {
        mix = mixCv[i]
        if (mix < 0) mix = 0
        else if (mix > 1) mix = 1
      }
      const modSamples = modRange * depth
      const phaseInc = (CHORUS_TWO_PI * rate) / sr

      // Write dry input into delay line.
      buf[this.writeIdx] = x

      // Read tap offset wobbles around base delay.
      let delaySamples = baseSamples + Math.sin(this.lfoPhase) * modSamples
      if (delaySamples < 1) delaySamples = 1
      const maxDelay = bufLen - 2
      if (delaySamples > maxDelay) delaySamples = maxDelay

      let readPos = this.writeIdx - delaySamples
      while (readPos < 0) readPos += bufLen
      const r0 = Math.floor(readPos)
      const frac = readPos - r0
      const r1 = (r0 + 1) % bufLen
      const delayed = buf[r0] * (1 - frac) + buf[r1] * frac

      outCh[i] = x * (1 - mix) + delayed * mix

      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0
      this.lfoPhase += phaseInc
      if (this.lfoPhase >= CHORUS_TWO_PI) this.lfoPhase -= CHORUS_TWO_PI
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-chorus', ChorusProcessor)
