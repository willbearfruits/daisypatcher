/// <reference path="./worklet.d.ts" />

/**
 * Chorus — a port of DaisySP's `Chorus`: two independently panned engines,
 * each a short modulated delay with feedback, summed and halved.
 *
 * This used to be one delay line swept by a sine LFO over a fixed 2–15 ms
 * range, which is a chorus and not the one the device plays. Three things
 * differ and all of them are audible:
 *
 *   - the LFO is a TRIANGLE that ping-pongs by flipping the sign of its
 *     own increment at the turnaround, not a sine;
 *   - `SetLfoFreq` scales by `4 * freq / sr` and clamps at +/-0.25, so the
 *     Rate knob does not mean Hz — it means roughly `rate / 2` Hz;
 *   - each engine returns `(in + wet) * .5` internally, and the wrapper
 *     sums two of them at 0.75/0.25 pan weights and halves again, so the
 *     dry signal arrives at a quarter of its input level before this
 *     node's own `mix` knob has done anything.
 *
 * `npm run test:audio` measured 11% on level; the character gap was wider.
 *
 * Both engines get identical settings here because the node exposes one
 * Rate and one Depth, which is what the emitter does too. Keeping the pair
 * rather than collapsing them to one engine preserves the pan-weighted sum
 * exactly, and leaves room for a stereo spread param later.
 *
 * Registered as `'dp-chorus'`.
 */

const CHORUS_BUF_SIZE = 2048

/** One `ChorusEngine`: a modulated delay with feedback and an equal mix. */
class ChorusEngine {
  private readonly line = new Float32Array(CHORUS_BUF_SIZE)
  private writePtr = 0
  private delaySamples = 0
  private frac = 0

  private sr = 48000
  private lfoPhase = 0
  private lfoFreq = 0
  private lfoAmp = 0
  private delay = 0
  private feedback = 0.2

  init(sampleRate: number): void {
    this.sr = sampleRate
    this.line.fill(0)
    this.writePtr = 0
    this.lfoAmp = 0
    this.feedback = 0.2
    this.setDelay(0.75)
    this.lfoPhase = 0
    this.lfoFreq = 0
    this.setLfoFreq(0.3)
    this.setLfoDepth(0.9)
  }

  /** `SetDelay`: the 0..1 knob maps to 0.1..8 ms. */
  setDelay(d: number): void {
    const ms = Math.max(0.1, 0.1 + d * 7.9)
    this.delay = ms * 0.001 * this.sr
    this.lfoAmp = Math.min(this.lfoAmp, this.delay)
  }

  setLfoDepth(depth: number): void {
    const d = depth < 0 ? 0 : depth > 0.93 ? 0.93 : depth
    this.lfoAmp = d * this.delay
  }

  /**
   * `SetLfoFreq`. The sign carry is not incidental — the LFO reverses by
   * negating its increment, so re-setting the rate mid-sweep must not
   * silently flip the direction of travel.
   */
  setLfoFreq(freq: number): void {
    let f = (4 * freq) / this.sr
    f *= this.lfoFreq < 0 ? -1 : 1
    this.lfoFreq = f < -0.25 ? -0.25 : f > 0.25 ? 0.25 : f
  }

  setFeedback(fb: number): void {
    this.feedback = fb < 0 ? 0 : fb > 1 ? 1 : fb
  }

  private setDelaySamples(d: number): void {
    const intDelay = Math.trunc(d)
    this.frac = d - intDelay
    this.delaySamples = intDelay < CHORUS_BUF_SIZE ? intDelay : CHORUS_BUF_SIZE - 1
    if (this.delaySamples < 0) this.delaySamples = 0
  }

  private read(): number {
    const a = this.line[(this.writePtr + this.delaySamples) % CHORUS_BUF_SIZE]
    const b = this.line[(this.writePtr + this.delaySamples + 1) % CHORUS_BUF_SIZE]
    return a + (b - a) * this.frac
  }

  private write(sample: number): void {
    this.line[this.writePtr] = sample
    this.writePtr = (this.writePtr - 1 + CHORUS_BUF_SIZE) % CHORUS_BUF_SIZE
  }

  /** Triangle LFO that ping-pongs by flipping its own increment. */
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

  process(input: number): number {
    const lfoSig = this.processLfo()
    this.setDelaySamples(lfoSig + this.delay)
    const out = this.read()
    this.write(input + out * this.feedback)
    return (input + out) * 0.5 // equal mix, as in the original
  }
}

class ChorusProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 0.8, minValue: 0.05, maxValue: 8, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly engines = [new ChorusEngine(), new ChorusEngine()]
  /** `SetPan(.25, .75)` from `Chorus::Init`. */
  private readonly pan = [0.25, 0.75]
  private readonly gainFrac = 0.5
  private ready = false

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
      for (const e of this.engines) e.init(sampleRate)
      // The emitter's init leaves feedback at DaisySP's 0.1 for this node.
      for (const e of this.engines) e.setFeedback(0.1)
      this.ready = true
    }

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const rateCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const depthCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const mixCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    let rate = parameters.rate[0] ?? 0.8
    if (rateCv) rate = rateCv[0]
    if (rate < 0.05) rate = 0.05
    else if (rate > 8) rate = 8
    let depth = parameters.depth[0] ?? 0.5
    if (depthCv) depth = depthCv[0]
    if (depth < 0) depth = 0
    else if (depth > 1) depth = 1
    let mix = parameters.mix[0] ?? 0.5
    if (mixCv) mix = mixCv[0]
    if (mix < 0) mix = 0
    else if (mix > 1) mix = 1

    // Block-rate, matching the emitter — it calls the setters once per
    // sample but from the same k-rate values.
    for (const e of this.engines) {
      e.setLfoFreq(rate)
      e.setLfoDepth(depth)
    }

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      let sigL = 0
      let sigR = 0
      for (let e = 0; e < 2; e++) {
        const sig = this.engines[e].process(x)
        sigL += (1 - this.pan[e]) * sig
        sigR += this.pan[e] * sig
      }
      sigL *= this.gainFrac
      sigR *= this.gainFrac

      // The emitter takes 0.5 * (GetLeft() + GetRight()) as its wet signal.
      let wet = 0.5 * (sigL + sigR)
      if (!isFinite(wet)) wet = 0
      outCh[i] = x * (1 - mix) + wet * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-chorus', ChorusProcessor)
