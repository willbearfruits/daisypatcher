/// <reference path="./worklet.d.ts" />

/**
 * Stereo widener — Haas (interchannel delay) plus mid/side width boost.
 * L = in, R = in delayed by `haas_ms`. For `width` > 1 the side channel
 * (L-R) is scaled up and the mid (L+R)/2 scaled down; for `width` < 1
 * the stereo collapses toward mono. Output L/R on sockets 0/1.
 * Registered as `'dp-stereo-widener'`.
 */

const SW_MAX_HAAS_SECONDS = 0.035

class StereoWidenerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'width', defaultValue: 1.2, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'haas_ms', defaultValue: 8, minValue: 0, maxValue: 30, automationRate: 'k-rate' }
    ]
  }

  private buffer: Float32Array
  private writeIdx = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const size = Math.ceil(SW_MAX_HAAS_SECONDS * sampleRate) + 2
    this.buffer = new Float32Array(size)
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
    const width = parameters.width[0] ?? 1.2
    let haasMs = parameters.haas_ms[0] ?? 8
    if (haasMs < 0) haasMs = 0
    else if (haasMs > 30) haasMs = 30

    const buf = this.buffer
    const bufLen = buf.length

    let delaySamples = (haasMs / 1000) * sampleRate
    if (delaySamples < 0) delaySamples = 0
    const maxDelay = bufLen - 2
    if (delaySamples > maxDelay) delaySamples = maxDelay

    const n = outL.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      buf[this.writeIdx] = x

      let readPos = this.writeIdx - delaySamples
      while (readPos < 0) readPos += bufLen
      const r0 = Math.floor(readPos)
      const frac = readPos - r0
      const r1 = (r0 + 1) % bufLen
      const delayed = buf[r0] * (1 - frac) + buf[r1] * frac

      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0

      // Haas stage: L is dry, R is delayed.
      const l0 = x
      const r0v = delayed
      // Mid/side: mid = (L+R)/2, side = (L-R)/2. width > 1 boosts side.
      const mid = (l0 + r0v) * 0.5
      const side = (l0 - r0v) * 0.5 * width
      let lOut = mid + side
      let rOut = mid - side
      if (!isFinite(lOut)) lOut = 0
      if (!isFinite(rOut)) rOut = 0
      outL[i] = lOut
      outR[i] = rOut
    }

    return true
  }
}

registerProcessor('dp-stereo-widener', StereoWidenerProcessor)
