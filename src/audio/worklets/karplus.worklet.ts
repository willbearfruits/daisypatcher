/// <reference path="./worklet.d.ts" />

/**
 * Karplus-Strong plucked string. A delay line of length sampleRate/frequency
 * feeds a one-pole lowpass, and the LP output is summed back into the input
 * with `feedback`. A pluck fills the buffer with white noise; a rising edge
 * on the trigger input also plucks. The `retrigger` enum schedules periodic
 * auto-plucks so the node is audible with no gate wired.
 *
 * Registered as `'dp-karplus'`.
 */

type Retrigger = 'manual' | '1s' | '500ms' | '250ms'

class KarplusProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'damping', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.99, minValue: 0.9, maxValue: 0.999, automationRate: 'k-rate' }
    ]
  }

  // Max buffer sized for 20 Hz fundamental (SR/20 samples). Computed once.
  private readonly buffer: Float32Array
  private writeIdx = 0
  // Active delay length in samples (integer — KS sounds fine with integer).
  private lineLen = 1
  private lpState = 0
  private trigHigh = false
  private retrigger: Retrigger = 'manual'
  private autoCounter = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const maxLen = Math.ceil(sampleRate / 20) + 4
    this.buffer = new Float32Array(maxLen)
    this.lineLen = Math.max(2, Math.floor(sampleRate / 220))
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'retrigger') {
        const v = data.value as string
        if (v === 'manual' || v === '1s' || v === '500ms' || v === '250ms') {
          this.retrigger = v
        }
      }
    }
  }

  private pluck(length: number): void {
    const buf = this.buffer
    const n = Math.min(length, buf.length)
    for (let i = 0; i < n; i++) {
      buf[i] = Math.random() * 2 - 1
    }
    // Zero the rest of the active region so stale samples don't leak.
    for (let i = n; i < buf.length; i++) buf[i] = 0
    this.writeIdx = 0
    this.lpState = 0
  }

  private autoPeriodSamples(): number {
    switch (this.retrigger) {
      case '1s':    return Math.floor(sampleRate)
      case '500ms': return Math.floor(sampleRate * 0.5)
      case '250ms': return Math.floor(sampleRate * 0.25)
      default:      return 0
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

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined

    const freq = parameters.frequency[0] ?? 220
    const damping = parameters.damping[0] ?? 0.5
    const feedback = parameters.feedback[0] ?? 0.99

    const targetLen = Math.max(2, Math.min(this.buffer.length - 1, Math.floor(sampleRate / freq)))
    this.lineLen = targetLen

    // One-pole LP coef: damping 0 → no LP (coef 0), damping 1 → very dark.
    const lpCoef = damping * 0.95
    const autoPeriod = this.autoPeriodSamples()

    const buf = this.buffer
    const len = this.lineLen
    const n = outCh.length

    for (let i = 0; i < n; i++) {
      // Trigger handling.
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) this.pluck(len)
      this.trigHigh = nowHigh

      // Auto retrigger when no manual pluck connected.
      if (autoPeriod > 0) {
        this.autoCounter++
        if (this.autoCounter >= autoPeriod) {
          this.autoCounter = 0
          this.pluck(len)
        }
      } else {
        this.autoCounter = 0
      }

      // Read current sample from the delay line.
      const readIdx = this.writeIdx % len
      const sample = buf[readIdx]

      // One-pole LP across the loop.
      this.lpState = sample * (1 - lpCoef) + this.lpState * lpCoef
      let next = this.lpState * feedback
      if (!isFinite(next)) next = 0
      if (next > 1) next = 1
      else if (next < -1) next = -1

      buf[readIdx] = next
      this.writeIdx++
      if (this.writeIdx >= len) this.writeIdx -= len

      outCh[i] = sample
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-karplus', KarplusProcessor)
