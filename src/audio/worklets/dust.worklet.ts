/// <reference path="./worklet.d.ts" />

/**
 * Dust — Poisson impulse generator. Each sample has probability
 * `density / sampleRate` of triggering. When triggered, the gate output
 * goes high for `width` seconds. Only one active pulse at a time; new
 * triggers during an active pulse refresh the remaining-time counter.
 * Registered as `'dp-dust'`.
 */

class DustProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'density', defaultValue: 5, minValue: 0.1, maxValue: 50, automationRate: 'k-rate' },
      { name: 'width', defaultValue: 0.005, minValue: 0.001, maxValue: 0.05, automationRate: 'k-rate' }
    ]
  }

  private samplesRemaining = 0 // samples of gate still to emit as 1

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    let density = parameters.density[0] ?? 5
    if (density < 0.1) density = 0.1
    else if (density > 50) density = 50
    let width = parameters.width[0] ?? 0.005
    if (width < 0.001) width = 0.001
    else if (width > 0.05) width = 0.05

    const probPerSample = density / sampleRate
    const widthSamples = Math.max(1, Math.round(width * sampleRate))

    const n = out.length
    for (let i = 0; i < n; i++) {
      if (Math.random() < probPerSample) {
        this.samplesRemaining = widthSamples
      }
      if (this.samplesRemaining > 0) {
        out[i] = 1
        this.samplesRemaining--
      } else {
        out[i] = 0
      }
    }

    return true
  }
}

registerProcessor('dp-dust', DustProcessor)
