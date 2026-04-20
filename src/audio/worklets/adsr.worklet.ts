/// <reference path="./worklet.d.ts" />

/**
 * ADSR envelope — gate >= 0.5 is high. Stages: idle → attack → decay → sustain
 * (while gate high) → release → idle. Output in [0,1]. Uses linear segments
 * for simplicity — swap for exp curves later if desired.
 *
 * Registered as `'dp-adsr'`.
 */

type Stage = 'idle' | 'attack' | 'decay' | 'sustain' | 'release'

class AdsrProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'attack', defaultValue: 0.01, minValue: 0.001, maxValue: 4, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.1, minValue: 0.001, maxValue: 4, automationRate: 'k-rate' },
      { name: 'sustain', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.3, minValue: 0.001, maxValue: 8, automationRate: 'k-rate' }
    ]
  }

  private stage: Stage = 'idle'
  private value = 0
  private gateHigh = false
  // Level the release stage starts from, so a key-off mid-attack sounds right.
  private releaseFrom = 0

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const gateIn = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined

    const a = Math.max(0.001, parameters.attack[0] ?? 0.01)
    const d = Math.max(0.001, parameters.decay[0] ?? 0.1)
    const s = parameters.sustain[0] ?? 0.7
    const r = Math.max(0.001, parameters.release[0] ?? 0.3)

    const attackInc = 1 / (a * sampleRate)
    const decayDec = (1 - s) / (d * sampleRate)
    // Release per-sample decrement depends on level at note-off.
    const releaseDecPerUnit = 1 / (r * sampleRate)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const gv = gateIn ? gateIn[i] : 0
      const nowHigh = gv >= 0.5
      if (nowHigh !== this.gateHigh) {
        if (nowHigh) {
          this.stage = 'attack'
        } else {
          this.stage = 'release'
          this.releaseFrom = this.value
        }
        this.gateHigh = nowHigh
      }

      switch (this.stage) {
        case 'attack':
          this.value += attackInc
          if (this.value >= 1) {
            this.value = 1
            this.stage = 'decay'
          }
          break
        case 'decay':
          this.value -= decayDec
          if (this.value <= s) {
            this.value = s
            this.stage = 'sustain'
          }
          break
        case 'sustain':
          this.value = s
          break
        case 'release':
          // Linear decay to 0 over `r` seconds scaled by the level at key-off.
          this.value -= releaseDecPerUnit * this.releaseFrom
          if (this.value <= 0) {
            this.value = 0
            this.stage = 'idle'
          }
          break
        case 'idle':
          this.value = 0
          break
      }

      outCh[i] = this.value
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-adsr', AdsrProcessor)
