/// <reference path="./worklet.d.ts" />

/**
 * Delay with feedback. Fixed 2s circular buffer; fractional read via linear
 * interpolation. Wet/dry mixed by `mix`. Registered as `'dp-delay'`.
 */

const MAX_DELAY_SECONDS = 2

class DelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'time', defaultValue: 0.25, minValue: 0.001, maxValue: MAX_DELAY_SECONDS, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.4, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private buffer: Float32Array
  private writeIdx = 0
  // 1-pole smoothing on the effective delay length in samples to dodge clicks
  // when `time_cv` moves. Coef chosen for ~5ms time constant at common SR.
  private smoothedDelaySamples = 0
  private static readonly SMOOTH_COEF = 0.002

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const size = Math.ceil(MAX_DELAY_SECONDS * sampleRate) + 2
    this.buffer = new Float32Array(size)
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
    // time_cv at input index 1: effective_time = time * 2^cv, clamped [0.001, 2].
    const timeCv = inputs[1]?.[0]
    const hasTimeCv = !!(timeCv && timeCv.length > 0)

    const baseTime = parameters.time[0] ?? 0.25
    const fb = parameters.feedback[0] ?? 0.4
    const mix = parameters.mix[0] ?? 0.5

    const buf = this.buffer
    const bufLen = buf.length
    const maxSamples = bufLen - 2
    const coef = DelayProcessor.SMOOTH_COEF

    if (this.smoothedDelaySamples === 0) {
      this.smoothedDelaySamples = Math.max(1, Math.min(maxSamples, baseTime * sampleRate))
    }

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      let effTime = baseTime
      if (hasTimeCv) {
        effTime = baseTime * Math.pow(2, timeCv![i])
        if (effTime < 0.001) effTime = 0.001
        else if (effTime > MAX_DELAY_SECONDS) effTime = MAX_DELAY_SECONDS
      }
      const targetSamples = Math.max(1, Math.min(maxSamples, effTime * sampleRate))
      this.smoothedDelaySamples += (targetSamples - this.smoothedDelaySamples) * coef
      const delaySamples = this.smoothedDelaySamples

      let readPos = this.writeIdx - delaySamples
      while (readPos < 0) readPos += bufLen
      const r0 = Math.floor(readPos)
      const frac = readPos - r0
      const r1 = (r0 + 1) % bufLen
      const delayed = buf[r0] * (1 - frac) + buf[r1] * frac

      // Write x + feedback*delayed into the buffer.
      buf[this.writeIdx] = x + delayed * fb
      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0

      outCh[i] = x * (1 - mix) + delayed * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-delay', DelayProcessor)
