/// <reference path="./worklet.d.ts" />

/**
 * Hi-hat. Six square waves at inharmonic ratios (after the TR-808 circuit:
 * 2, 3, 4.16, 5.43, 6.79, 8.21 times a 40 Hz base) summed and passed
 * through a bandpass centered around 8 kHz * tone. Amp env is exp decay.
 *
 * Registered as `'dp-drum-hat'`.
 */

class DrumHatProcessor extends AudioWorkletProcessor {
  private readonly TWO_PI = Math.PI * 2
  private readonly BASE_HZ = 40
  private readonly RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21]

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'decay', defaultValue: 0.08, minValue: 0.01, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.7, minValue: 0.3, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private phases: Float32Array = new Float32Array(6)
  private trigHigh = false
  private ampEnv = 0
  // State-variable bandpass state.
  private bpLow = 0
  private bpBand = 0

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined

    const decay = Math.max(0.01, parameters.decay[0] ?? 0.08)
    const tone = parameters.tone[0] ?? 0.7

    const ampCoef = Math.exp(-1 / (decay * sampleRate))
    const twoPi = this.TWO_PI
    const ratios = this.RATIOS
    const base = this.BASE_HZ

    // Pre-compute increments.
    const inc0 = (twoPi * base * ratios[0]) / sampleRate
    const inc1 = (twoPi * base * ratios[1]) / sampleRate
    const inc2 = (twoPi * base * ratios[2]) / sampleRate
    const inc3 = (twoPi * base * ratios[3]) / sampleRate
    const inc4 = (twoPi * base * ratios[4]) / sampleRate
    const inc5 = (twoPi * base * ratios[5]) / sampleRate

    // Bandpass center ~ 8 kHz * tone, clamped under Nyquist.
    let bpFreq = 8000 * tone
    const nyquist = sampleRate * 0.5
    if (bpFreq > nyquist * 0.9) bpFreq = nyquist * 0.9
    const f = 2 * Math.sin(Math.PI * bpFreq / sampleRate)
    const q = 0.5 // 1/Q for a resonant band

    const n = outCh.length
    const ph = this.phases
    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) {
        this.ampEnv = 1
        ph[0] = 0; ph[1] = 0; ph[2] = 0; ph[3] = 0; ph[4] = 0; ph[5] = 0
        this.bpLow = 0
        this.bpBand = 0
      }
      this.trigHigh = nowHigh

      // Sum six square waves.
      const sq = (p: number) => (p < Math.PI ? 1 : -1)
      const mix =
        (sq(ph[0]) + sq(ph[1]) + sq(ph[2]) + sq(ph[3]) + sq(ph[4]) + sq(ph[5])) / 6

      // Advance phases.
      ph[0] += inc0; if (ph[0] >= twoPi) ph[0] -= twoPi
      ph[1] += inc1; if (ph[1] >= twoPi) ph[1] -= twoPi
      ph[2] += inc2; if (ph[2] >= twoPi) ph[2] -= twoPi
      ph[3] += inc3; if (ph[3] >= twoPi) ph[3] -= twoPi
      ph[4] += inc4; if (ph[4] >= twoPi) ph[4] -= twoPi
      ph[5] += inc5; if (ph[5] >= twoPi) ph[5] -= twoPi

      // SVF bandpass step.
      const high = mix - this.bpLow - q * this.bpBand
      this.bpBand += f * high
      this.bpLow += f * this.bpBand
      const bp = this.bpBand

      let y = bp * this.ampEnv
      this.ampEnv *= ampCoef

      if (!isFinite(y)) {
        y = 0
        this.ampEnv = 0
        this.bpLow = 0
        this.bpBand = 0
      }
      if (y > 1) y = 1
      else if (y < -1) y = -1
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-drum-hat', DrumHatProcessor)
