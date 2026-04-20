/// <reference path="./worklet.d.ts" />

/**
 * Oscillator worklet — four standard waveforms, k-rate frequency + amplitude,
 * enum waveform toggled via port message. Registered as `'dp-oscillator'`.
 */

type Waveform = 'sine' | 'sawtooth' | 'square' | 'triangle'

const TWO_PI = Math.PI * 2

class OscillatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'frequency',
        defaultValue: 220,
        minValue: 20,
        maxValue: 20000,
        automationRate: 'k-rate'
      },
      {
        name: 'amplitude',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      }
    ]
  }

  private phase = 0
  private waveform: Waveform = 'sine'

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'waveform') {
        const v = data.value as string
        if (v === 'sine' || v === 'sawtooth' || v === 'square' || v === 'triangle') {
          this.waveform = v
        }
      }
    }
  }

  private sample(phase: number): number {
    switch (this.waveform) {
      case 'sine':
        return Math.sin(phase)
      case 'sawtooth':
        // phase in [0, 2π) → saw in [-1, 1)
        return (phase / Math.PI) - 1
      case 'square':
        return phase < Math.PI ? 1 : -1
      case 'triangle': {
        const t = phase / TWO_PI // 0..1
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
    const channel = output[0]
    if (!channel) return true

    const freqParam = parameters.frequency
    const ampParam = parameters.amplitude
    const baseFreq = freqParam.length > 0 ? freqParam[0] : 220
    const baseAmp = ampParam.length > 0 ? ampParam[0] : 0.5

    // CV inputs: pitch_cv at 0, amp_cv at 1. Both a-rate per sample.
    // Treat no-cable as zero by checking channel length; in that case skip the math.
    const pitchCv = inputs[0]?.[0]
    const ampCv = inputs[1]?.[0]
    const hasPitchCv = !!(pitchCv && pitchCv.length > 0)
    const hasAmpCv = !!(ampCv && ampCv.length > 0)

    for (let i = 0; i < channel.length; i++) {
      // pitch_cv: effective freq = base * 2^cv, clamped to [20, 20000].
      let freq = baseFreq
      if (hasPitchCv) {
        const cv = pitchCv![i]
        freq = baseFreq * Math.pow(2, cv)
        if (freq < 20) freq = 20
        else if (freq > 20000) freq = 20000
      }
      // amp_cv: VCA-style, effective amp = base * max(0, cv).
      let amp = baseAmp
      if (hasAmpCv) {
        const cv = ampCv![i]
        amp = baseAmp * (cv > 0 ? cv : 0)
      }
      const phaseInc = (TWO_PI * freq) / sampleRate
      channel[i] = this.sample(this.phase) * amp
      this.phase += phaseInc
      if (this.phase >= TWO_PI) this.phase -= TWO_PI
      else if (this.phase < 0) this.phase += TWO_PI
    }

    // Fan out to all remaining channels if any requested (usually mono).
    for (let c = 1; c < output.length; c++) {
      output[c].set(channel)
    }

    return true
  }
}

registerProcessor('dp-oscillator', OscillatorProcessor)
