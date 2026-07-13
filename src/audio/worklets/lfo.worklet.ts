/// <reference path="./worklet.d.ts" />

/**
 * LFO worklet — CV output (audio-rate channel carrying a low-frequency
 * signal). Output = (waveform(t) * depth) + offset, clamped to [-1, 1].
 * Registered as `'dp-lfo'`.
 */

type LfoWaveform = 'sine' | 'tri' | 'saw' | 'square'

const LFO_TWO_PI = Math.PI * 2

class LfoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 1, minValue: 0.01, maxValue: 20, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'offset', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private phase = 0
  private waveform: LfoWaveform = 'sine'

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'waveform') {
        const v = data.value as string
        if (v === 'sine' || v === 'tri' || v === 'saw' || v === 'square') {
          this.waveform = v
        }
      }
    }
  }

  private sample(phase: number): number {
    switch (this.waveform) {
      case 'sine':
        return Math.sin(phase)
      case 'saw':
        return (phase / Math.PI) - 1
      case 'square':
        return phase < Math.PI ? 1 : -1
      case 'tri': {
        const t = phase / LFO_TWO_PI
        return 4 * Math.abs(t - 0.5) - 1
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const ch = output[0]
    if (!ch) return true

    // Wave 4 CVs: 0=rate, 1=depth, 2=offset. Replace semantics with clamp.
    const rateCv = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const depthCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const offsetCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    const freqBase = parameters.frequency[0] ?? 1
    const depthBase = parameters.depth[0] ?? 1
    const offsetBase = parameters.offset[0] ?? 0

    const n = ch.length
    const sr = sampleRate
    for (let i = 0; i < n; i++) {
      let freq = freqBase
      if (rateCv) {
        freq = rateCv[i]
        if (freq < 0.01) freq = 0.01
        else if (freq > 20) freq = 20
      }
      let depth = depthBase
      if (depthCv) {
        depth = depthCv[i]
        if (depth < 0) depth = 0
        else if (depth > 1) depth = 1
      }
      let offset = offsetBase
      if (offsetCv) {
        offset = offsetCv[i]
        if (offset < -1) offset = -1
        else if (offset > 1) offset = 1
      }

      let v = this.sample(this.phase) * depth + offset
      if (v > 1) v = 1
      else if (v < -1) v = -1
      ch[i] = v
      this.phase += (LFO_TWO_PI * freq) / sr
      if (this.phase >= LFO_TWO_PI) this.phase -= LFO_TWO_PI
    }

    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-lfo', LfoProcessor)
