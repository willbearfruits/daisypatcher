/// <reference path="./worklet.d.ts" />

/**
 * Arpeggiator — when `gate_in` is high, steps through a scale on each
 * rising edge of `clock` (prev<0.5, curr>=0.5). Output CV is
 * `root + (scale[step % len] + octave * 12) / 12`, so the pitch tracks a
 * 1V/oct-style encoding at 1/12 per semitone. `octaves` multiplies the
 * range, `pattern` picks the step order (up, down, up_down, random).
 * Gate output mirrors the clock while gate_in is high, else 0.
 * Registered as `'dp-arp'`.
 */

type ArpPattern = 'up' | 'down' | 'up_down' | 'random'
type ArpScale = 'major' | 'minor' | 'pentatonic' | 'chromatic'

class ArpProcessor extends AudioWorkletProcessor {
  // Pre-declared scale tables — constructed once per instance, not per
  // process() call. Lookup by scale name at runtime.
  private readonly scaleMajor = [0, 2, 4, 5, 7, 9, 11]
  private readonly scaleMinor = [0, 2, 3, 5, 7, 8, 10]
  private readonly scalePent = [0, 2, 4, 7, 9]
  private readonly scaleChrom = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'octaves', defaultValue: 1, minValue: 1, maxValue: 4, automationRate: 'k-rate' },
      { name: 'root', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private pattern: ArpPattern = 'up'
  private scaleKind: ArpScale = 'major'

  private step = 0 // index within the expanded scale (base * octaves)
  private dir = 1 // for up_down
  private clkHigh = false
  private gateHigh = false
  private lastCv = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && typeof data.paramId === 'string') {
        const v = data.value
        if (data.paramId === 'pattern' && (v === 'up' || v === 'down' || v === 'up_down' || v === 'random')) {
          this.pattern = v
        } else if (data.paramId === 'scale' && (v === 'major' || v === 'minor' || v === 'pentatonic' || v === 'chromatic')) {
          this.scaleKind = v
        }
      }
    }
  }

  private scaleArray(): number[] {
    switch (this.scaleKind) {
      case 'major': return this.scaleMajor
      case 'minor': return this.scaleMinor
      case 'pentatonic': return this.scalePent
      case 'chromatic': return this.scaleChrom
    }
  }

  private advance(totalLen: number): void {
    switch (this.pattern) {
      case 'up':
        this.step++
        if (this.step >= totalLen) this.step = 0
        break
      case 'down':
        this.step--
        if (this.step < 0) this.step = totalLen - 1
        break
      case 'up_down':
        this.step += this.dir
        if (this.step >= totalLen) {
          this.step = totalLen > 1 ? totalLen - 2 : 0
          this.dir = -1
        } else if (this.step < 0) {
          this.step = totalLen > 1 ? 1 : 0
          this.dir = 1
        }
        break
      case 'random':
        if (totalLen > 0) this.step = Math.floor(Math.random() * totalLen)
        break
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const cvOut = outputs[0]?.[0]
    const gateOut = outputs[1]?.[0]
    const n = cvOut?.length ?? gateOut?.length ?? 0
    if (n === 0) return true

    const clkCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const gateCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    let octaves = Math.round(parameters.octaves[0] ?? 1)
    if (octaves < 1) octaves = 1
    else if (octaves > 4) octaves = 4
    const root = parameters.root[0] ?? 0

    const scale = this.scaleArray()
    const baseLen = scale.length
    const totalLen = baseLen * octaves

    for (let i = 0; i < n; i++) {
      const clkV = clkCh ? clkCh[i] : 0
      const gateV = gateCh ? gateCh[i] : 0
      const clkNow = clkV >= 0.5
      const gateNow = gateV >= 0.5

      // Reset step when gate rises.
      if (gateNow && !this.gateHigh) {
        this.step = 0
        this.dir = 1
      }

      if (gateNow && clkNow && !this.clkHigh) {
        this.advance(totalLen)
      }

      this.clkHigh = clkNow
      this.gateHigh = gateNow

      if (gateNow && totalLen > 0) {
        const idx = ((this.step % totalLen) + totalLen) % totalLen
        const oct = Math.floor(idx / baseLen)
        const deg = idx - oct * baseLen
        const semis = scale[deg] + oct * 12
        let cv = root + semis / 12
        if (cv > 1) cv = 1
        else if (cv < -1) cv = -1
        this.lastCv = cv
      }

      if (cvOut) cvOut[i] = this.lastCv
      if (gateOut) gateOut[i] = gateNow ? clkV : 0
    }

    return true
  }
}

registerProcessor('dp-arp', ArpProcessor)
