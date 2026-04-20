/// <reference path="./worklet.d.ts" />

/**
 * Vibrato — pitch modulation via a short modulated delay line. The read
 * tap wobbles around a 5 ms centre between ~3 ms and ~7 ms at `rate` Hz
 * (±2 ms × depth). Linear-interpolated read for smooth pitch slewing.
 * 1024-sample circular buffer is plenty at any supported sample rate for
 * a max tap of ~10 ms.
 * Registered as `'dp-vibrato'`.
 */

class VibratoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 6, minValue: 0.1, maxValue: 15, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly bufSize = 1024
  private buffer = new Float32Array(1024)
  private writeIdx = 0
  private lfoPhase = 0 // 0..2π

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined

    let rate = parameters.rate[0] ?? 6
    if (rate < 0.01) rate = 0.01
    let depth = parameters.depth[0] ?? 0.3
    if (depth < 0) depth = 0
    else if (depth > 1) depth = 1

    const sr = sampleRate
    const centreSamples = 0.005 * sr // 5 ms
    const modSamples = 0.002 * sr * depth // ±2ms * depth
    const phaseInc = (Math.PI * 2 * rate) / sr
    const buf = this.buffer
    const bufLen = this.bufSize
    const maxDelay = bufLen - 2

    const n = out.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      buf[this.writeIdx] = x

      let delaySamples = centreSamples + Math.sin(this.lfoPhase) * modSamples
      if (delaySamples < 1) delaySamples = 1
      else if (delaySamples > maxDelay) delaySamples = maxDelay

      let readPos = this.writeIdx - delaySamples
      while (readPos < 0) readPos += bufLen
      const r0 = Math.floor(readPos)
      const frac = readPos - r0
      const r1 = (r0 + 1) % bufLen
      out[i] = buf[r0] * (1 - frac) + buf[r1] * frac

      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0
      this.lfoPhase += phaseInc
      if (this.lfoPhase >= Math.PI * 2) this.lfoPhase -= Math.PI * 2
    }

    for (let c = 1; c < (outputs[0]?.length ?? 1); c++) outputs[0][c].set(out)
    return true
  }
}

registerProcessor('dp-vibrato', VibratoProcessor)
