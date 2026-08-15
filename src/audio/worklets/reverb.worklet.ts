/// <reference path="./worklet.d.ts" />

/**
 * Reverb — a port of DaisySP's `ReverbSc` (Sean Costello's 8-line FDN, via
 * Csound's `reverbsc`).
 *
 * This used to be Freeverb — eight lowpass-feedback combs into four series
 * allpasses — which is a different reverb by a different author with a
 * different tail. `npm run test:audio` measured 21% on level, but level was
 * the least of it: Freeverb's decay is dense and static where Costello's is
 * sparse and modulated, so the app's reverb and the board's reverb did not
 * sound like the same room at any setting.
 *
 * The modulation is the part that cannot be approximated away. Each of the
 * eight delay lines walks its read pointer along a random line segment —
 * pick a new target delay, interpolate to it over `sr / freq` samples,
 * repeat — using a 16-bit LCG seeded per line from a fixed table. That slow
 * random detuning is what stops the tail from ringing on fixed modes, and
 * it is why the read position is kept as a 28-bit fixed-point fraction and
 * read with a 4-point cubic rather than the linear interpolation every
 * other delay in this catalog uses.
 *
 * Buffer sizes come from the same table and so are prime-ish and unequal;
 * they are allocated once at the real sample rate, since `Init` in the
 * original sizes them from `sample_rate_` too.
 *
 * Params:
 *   size → feedback, mapped `0.5 + size * 0.45` as the emitter does
 *   damp → tone-filter cutoff, `1000 + (1 - damp) * 15000` Hz
 *   mix  → dry/wet blend
 *
 * Registered as `'dp-reverb'`.
 */

/* kReverbParams[n] = [delay time (s), random variation (s),
                       variation frequency (1/s), random seed (0-32767)] */
const REVERB_PARAMS: [number, number, number, number][] = [
  [2473 / 48000, 0.001, 3.1, 1966],
  [2767 / 48000, 0.0011, 3.5, 29491],
  [3217 / 48000, 0.0017, 1.11, 22937],
  [3557 / 48000, 0.0006, 3.973, 9830],
  [3907 / 48000, 0.001, 2.341, 20643],
  [4127 / 48000, 0.0011, 1.897, 22937],
  [2143 / 48000, 0.0017, 0.891, 29491],
  [1933 / 48000, 0.0006, 3.221, 14417]
]

const DELAYPOS_SHIFT = 28
const DELAYPOS_SCALE = 0x10000000
const DELAYPOS_MASK = 0x0fffffff
const REVERB_OUTPUT_GAIN = 0.35
const REVERB_JP_SCALE = 0.25

/** One of the eight modulated delay lines. */
interface ReverbLine {
  buf: Float32Array
  bufferSize: number
  writePos: number
  readPos: number
  readPosFrac: number
  readPosFracInc: number
  seedVal: number
  randLineCnt: number
  filterState: number
}

class ReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'size', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'damp', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private lines: ReverbLine[] = []
  private ready = false
  private feedback = 0.97
  private lpfreq = 10000
  private prvLpfreq = 0
  private dampFact = 1

  /** `DelayLineMaxSamples` — the +16.5 headroom is the original's. */
  private maxSamples(n: number): number {
    let maxDel = REVERB_PARAMS[n][0]
    maxDel += REVERB_PARAMS[n][1] * 1.125
    return Math.trunc(maxDel * sampleRate + 16.5)
  }

  /**
   * `NextRandomLineseg` — pick the next target delay and the per-sample
   * fixed-point increment that walks there.
   *
   * The LCG is 16-bit with a signed wrap, reproduced exactly: the seed's
   * sign is what makes the delay wander either side of nominal, and a
   * naive unsigned version detunes in one direction only.
   */
  private nextRandomLineseg(lp: ReverbLine, n: number): void {
    if (lp.seedVal < 0) lp.seedVal += 0x10000
    lp.seedVal = (lp.seedVal * 15625 + 1) & 0xffff
    if (lp.seedVal >= 0x8000) lp.seedVal -= 0x10000

    lp.randLineCnt = Math.trunc(sampleRate / REVERB_PARAMS[n][2] + 0.5)

    let prvDel = lp.writePos
    prvDel -= lp.readPos + lp.readPosFrac / DELAYPOS_SCALE
    while (prvDel < 0) prvDel += lp.bufferSize
    prvDel = prvDel / sampleRate

    let nxtDel = (lp.seedVal * REVERB_PARAMS[n][1]) / 32768
    nxtDel = REVERB_PARAMS[n][0] + nxtDel

    let phsIncVal = (prvDel - nxtDel) / lp.randLineCnt
    phsIncVal = phsIncVal * sampleRate + 1
    lp.readPosFracInc = Math.trunc(phsIncVal * DELAYPOS_SCALE + 0.5)
  }

  private initLines(): void {
    this.lines = []
    for (let n = 0; n < 8; n++) {
      const bufferSize = this.maxSamples(n)
      const lp: ReverbLine = {
        buf: new Float32Array(bufferSize),
        bufferSize,
        writePos: 0,
        readPos: 0,
        readPosFrac: 0,
        readPosFracInc: 0,
        seedVal: Math.trunc(REVERB_PARAMS[n][3] + 0.5),
        randLineCnt: 0,
        filterState: 0
      }
      let readPos = (lp.seedVal * REVERB_PARAMS[n][1]) / 32768
      readPos = REVERB_PARAMS[n][0] + readPos
      readPos = lp.bufferSize - readPos * sampleRate
      lp.readPos = Math.trunc(readPos)
      lp.readPosFrac = Math.trunc((readPos - lp.readPos) * DELAYPOS_SCALE + 0.5)
      this.lines.push(lp)
      this.nextRandomLineseg(lp, n)
    }
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
      this.initLines()
      this.ready = true
    }

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const sizeCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const dampCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const mixCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    let size = parameters.size[0] ?? 0.5
    if (sizeCv) size = sizeCv[0]
    if (size < 0) size = 0
    else if (size > 1) size = 1
    let damp = parameters.damp[0] ?? 0.5
    if (dampCv) damp = dampCv[0]
    if (damp < 0) damp = 0
    else if (damp > 1) damp = 1
    let mix = parameters.mix[0] ?? 0.3
    if (mixCv) mix = mixCv[0]
    if (mix < 0) mix = 0
    else if (mix > 1) mix = 1

    // Same mappings the emitter uses, so the knobs mean the same thing.
    this.feedback = 0.5 + size * 0.45
    this.lpfreq = 1000 + (1 - damp) * 15000

    if (this.lpfreq !== this.prvLpfreq) {
      this.prvLpfreq = this.lpfreq
      let d = 2 - Math.cos((this.prvLpfreq * (2 * Math.PI)) / sampleRate)
      this.dampFact = d - Math.sqrt(d * d - 1)
      d = 0
    }
    const dampFact = this.dampFact
    const lines = this.lines

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      // "Resultant junction pressure" — the shared feedback bus.
      let aInL = 0
      for (let k = 0; k < 8; k++) aInL += lines[k].filterState
      aInL *= REVERB_JP_SCALE
      const aInR = aInL + x
      aInL = aInL + x

      let aOutL = 0
      let aOutR = 0

      for (let k = 0; k < 8; k++) {
        const lp = lines[k]
        const bufferSize = lp.bufferSize

        lp.buf[lp.writePos] = (k & 1 ? aInR : aInL) - lp.filterState
        if (++lp.writePos >= bufferSize) lp.writePos -= bufferSize

        if (lp.readPosFrac >= DELAYPOS_SCALE) {
          lp.readPos += lp.readPosFrac >> DELAYPOS_SHIFT
          lp.readPosFrac &= DELAYPOS_MASK
        }
        if (lp.readPos >= bufferSize) lp.readPos -= bufferSize
        let readPos = lp.readPos
        const frac = lp.readPosFrac * (1 / DELAYPOS_SCALE)

        // 4-point cubic interpolation coefficients.
        let a2 = frac * frac
        a2 -= 1
        a2 *= 1 / 6
        let a1 = frac
        a1 += 1
        a1 *= 0.5
        let am1 = a1 - 1
        let a0 = 3 * a2
        a1 -= a0
        am1 -= a2
        a0 -= frac

        let vm1: number
        let v0: number
        let v1: number
        let v2: number
        if (readPos > 0 && readPos < bufferSize - 2) {
          vm1 = lp.buf[readPos - 1]
          v0 = lp.buf[readPos]
          v1 = lp.buf[readPos + 1]
          v2 = lp.buf[readPos + 2]
        } else {
          // At the wrap-around every index has to be checked.
          if (--readPos < 0) readPos += bufferSize
          vm1 = lp.buf[readPos]
          if (++readPos >= bufferSize) readPos -= bufferSize
          v0 = lp.buf[readPos]
          if (++readPos >= bufferSize) readPos -= bufferSize
          v1 = lp.buf[readPos]
          if (++readPos >= bufferSize) readPos -= bufferSize
          v2 = lp.buf[readPos]
        }
        v0 = (am1 * vm1 + a0 * v0 + a1 * v1 + a2 * v2) * frac + v0

        lp.readPosFrac += lp.readPosFracInc

        // Feedback gain, then the shared one-pole tone filter.
        v0 *= this.feedback
        v0 = (lp.filterState - v0) * dampFact + v0
        lp.filterState = v0

        if (k & 1) aOutR += v0
        else aOutL += v0

        if (--lp.randLineCnt <= 0) this.nextRandomLineseg(lp, k)
      }

      // The emitter takes 0.5 * (left + right) as its wet signal.
      let wet = 0.5 * (aOutL * REVERB_OUTPUT_GAIN + aOutR * REVERB_OUTPUT_GAIN)
      if (!isFinite(wet)) {
        wet = 0
        for (const lp of lines) {
          lp.buf.fill(0)
          lp.filterState = 0
        }
      }
      outCh[i] = x * (1 - mix) + wet * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-reverb', ReverbProcessor)
