/// <reference path="./worklet.d.ts" />

/**
 * Flanger — a port of DaisySP's `Flanger`.
 *
 * Structurally the same as the chorus port next door (one modulated delay
 * line with feedback, returning `(in + wet) * .5`), with three differences
 * that belong to this effect rather than that one:
 *
 *   - the base delay knob maps to 0.1–7 ms, not 0.1–8 ms;
 *   - `SetFeedback` multiplies by 0.97 on the way in, which is what keeps
 *     the resonance from running away at knob-max;
 *   - `SetDelay(1 + lfo + delay)` — the extra sample of offset matters at
 *     short flange times, where the read tap would otherwise reach the
 *     write pointer.
 *
 * The old implementation swept a sine over a fixed range and applied
 * feedback without the 0.97 trim, which `npm run test:audio` measured 10%
 * off on level and further off as feedback rose.
 *
 * See the chorus worklet for why the LFO is a sign-flipping triangle and
 * why the Rate knob does not mean Hz.
 *
 * Registered as `'dp-flanger'`.
 */

const FLANGER_BUF_SIZE = 2048

class FlangerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 0.3, minValue: 0.05, maxValue: 8, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly line = new Float32Array(FLANGER_BUF_SIZE)
  private writePtr = 0
  private delaySamples = 0
  private frac = 0

  private lfoPhase = 0
  private lfoFreq = 0
  private lfoAmp = 0
  private delay = 0
  private feedback = 0.2
  private ready = false

  /** `SetDelay`: the 0..1 knob maps to 0.1..7 ms. */
  private setDelay(d: number): void {
    const ms = Math.max(0.1, 0.1 + d * 6.9)
    this.delay = ms * 0.001 * sampleRate
    this.lfoAmp = Math.min(this.lfoAmp, this.delay)
  }

  private setLfoDepth(depth: number): void {
    const d = depth < 0 ? 0 : depth > 0.93 ? 0.93 : depth
    this.lfoAmp = d * this.delay
  }

  private setLfoFreq(freq: number): void {
    let f = (4 * freq) / sampleRate
    f *= this.lfoFreq < 0 ? -1 : 1
    this.lfoFreq = f < -0.25 ? -0.25 : f > 0.25 ? 0.25 : f
  }

  /** Note the 0.97 trim — DaisySP applies it inside the setter. */
  private setFeedback(fb: number): void {
    const f = fb < 0 ? 0 : fb > 1 ? 1 : fb
    this.feedback = f * 0.97
  }

  private setDelaySamples(d: number): void {
    const intDelay = Math.trunc(d)
    this.frac = d - intDelay
    this.delaySamples = intDelay < FLANGER_BUF_SIZE ? intDelay : FLANGER_BUF_SIZE - 1
    if (this.delaySamples < 0) this.delaySamples = 0
  }

  private read(): number {
    const a = this.line[(this.writePtr + this.delaySamples) % FLANGER_BUF_SIZE]
    const b = this.line[(this.writePtr + this.delaySamples + 1) % FLANGER_BUF_SIZE]
    return a + (b - a) * this.frac
  }

  private write(sample: number): void {
    this.line[this.writePtr] = sample
    this.writePtr = (this.writePtr - 1 + FLANGER_BUF_SIZE) % FLANGER_BUF_SIZE
  }

  private processLfo(): number {
    this.lfoPhase += this.lfoFreq
    if (this.lfoPhase > 1) {
      this.lfoPhase = 1 - (this.lfoPhase - 1)
      this.lfoFreq *= -1
    } else if (this.lfoPhase < -1) {
      this.lfoPhase = -1 - (this.lfoPhase + 1)
      this.lfoFreq *= -1
    }
    return this.lfoPhase * this.lfoAmp
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

    if (!this.ready) {
      // Mirrors `Flanger::Init`.
      this.setFeedback(0.2)
      this.lfoAmp = 0
      this.setDelay(0.75)
      this.lfoPhase = 0
      this.setLfoFreq(0.3)
      this.setLfoDepth(0.9)
      this.ready = true
    }

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const rateCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const depthCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const fbCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined
    const mixCv = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined

    let rate = parameters.rate[0] ?? 0.3
    if (rateCv) rate = rateCv[0]
    if (rate < 0.05) rate = 0.05
    else if (rate > 8) rate = 8
    let depth = parameters.depth[0] ?? 0.6
    if (depthCv) depth = depthCv[0]
    if (depth < 0) depth = 0
    else if (depth > 1) depth = 1
    let fb = parameters.feedback[0] ?? 0.5
    if (fbCv) fb = fbCv[0]
    if (fb < 0) fb = 0
    else if (fb > 0.9) fb = 0.9
    let mix = parameters.mix[0] ?? 0.5
    if (mixCv) mix = mixCv[0]
    if (mix < 0) mix = 0
    else if (mix > 1) mix = 1

    this.setLfoFreq(rate)
    this.setLfoDepth(depth)
    this.setFeedback(fb)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const lfoSig = this.processLfo()
      this.setDelaySamples(1 + lfoSig + this.delay)
      const wetTap = this.read()
      this.write(x + wetTap * this.feedback)
      let wet = (x + wetTap) * 0.5 // equal mix, as in the original
      if (!isFinite(wet)) {
        wet = 0
        this.line.fill(0)
      }
      outCh[i] = x * (1 - mix) + wet * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-flanger', FlangerProcessor)
