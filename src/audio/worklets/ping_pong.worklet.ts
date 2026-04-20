/// <reference path="./worklet.d.ts" />

/**
 * Ping-pong delay — two delay lines whose outputs cross-feed each other.
 * L's delayed output feeds into R's input (weighted by `width`) and vice
 * versa; mono input hits both at equal time. Left/right written to
 * outputs[0]/outputs[1] per engine multi-output conventions.
 * Registered as `'dp-ping-pong'`.
 */

const PP_MAX_DELAY_SECONDS = 2

class PingPongProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'time', defaultValue: 0.3, minValue: 0.02, maxValue: PP_MAX_DELAY_SECONDS, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.45, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'width', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private bufL: Float32Array
  private bufR: Float32Array
  private writeIdx = 0
  private smoothedDelay = 0
  private readonly SMOOTH_COEF = 0.002

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const size = Math.ceil(PP_MAX_DELAY_SECONDS * sampleRate) + 2
    this.bufL = new Float32Array(size)
    this.bufR = new Float32Array(size)
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0]
    const outR = outputs[1]?.[0]
    if (!outL || !outR) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const time = parameters.time[0] ?? 0.3
    const fb = parameters.feedback[0] ?? 0.45
    const mix = parameters.mix[0] ?? 0.4
    const width = parameters.width[0] ?? 1

    const bufL = this.bufL
    const bufR = this.bufR
    const bufLen = bufL.length
    const maxSamples = bufLen - 2
    const coef = this.SMOOTH_COEF

    if (this.smoothedDelay === 0) {
      this.smoothedDelay = Math.max(1, Math.min(maxSamples, time * sampleRate))
    }

    const targetSamples = Math.max(1, Math.min(maxSamples, time * sampleRate))

    const n = outL.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      this.smoothedDelay += (targetSamples - this.smoothedDelay) * coef
      const delaySamples = this.smoothedDelay

      let readPos = this.writeIdx - delaySamples
      while (readPos < 0) readPos += bufLen
      const r0 = Math.floor(readPos)
      const frac = readPos - r0
      const r1 = (r0 + 1) % bufLen
      const delL = bufL[r0] * (1 - frac) + bufL[r1] * frac
      const delR = bufR[r0] * (1 - frac) + bufR[r1] * frac

      // Cross-feed: L line receives x + R's delayed output (scaled by width),
      // R line receives x + L's delayed output. Feedback scales the cross.
      let wL = x + delR * fb * width + delL * fb * (1 - width)
      let wR = x + delL * fb * width + delR * fb * (1 - width)
      if (!isFinite(wL)) wL = 0
      if (!isFinite(wR)) wR = 0
      bufL[this.writeIdx] = wL
      bufR[this.writeIdx] = wR
      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0

      outL[i] = x * (1 - mix) + delL * mix
      outR[i] = x * (1 - mix) + delR * mix
    }

    return true
  }
}

registerProcessor('dp-ping-pong', PingPongProcessor)
