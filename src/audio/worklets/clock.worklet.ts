/// <reference path="./worklet.d.ts" />

/**
 * Clock — tempo-based gate pulse generator. Outputs 1 while the current
 * phase is within `pulse_width * period`, else 0. Phase is maintained in
 * seconds and wrapped against the current period so tempo changes stay
 * continuous without clicks.
 * Registered as `'dp-clock'`.
 */

class ClockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'bpm', defaultValue: 120, minValue: 20, maxValue: 300, automationRate: 'k-rate' },
      { name: 'pulse_width', defaultValue: 0.1, minValue: 0.05, maxValue: 0.5, automationRate: 'k-rate' }
    ]
  }

  private phase = 0 // seconds into current period

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    let bpm = parameters.bpm[0] ?? 120
    if (bpm < 20) bpm = 20
    else if (bpm > 300) bpm = 300
    let pw = parameters.pulse_width[0] ?? 0.1
    if (pw < 0.05) pw = 0.05
    else if (pw > 0.5) pw = 0.5

    const period = 60 / bpm
    const highUntil = pw * period
    const dt = 1 / sampleRate
    const n = outCh.length

    for (let i = 0; i < n; i++) {
      outCh[i] = this.phase < highUntil ? 1 : 0
      this.phase += dt
      if (this.phase >= period) this.phase -= period
      if (this.phase >= period) this.phase = 0 // safety in case period shrank mid-block
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-clock', ClockProcessor)
