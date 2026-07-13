/// <reference path="./worklet.d.ts" />

/**
 * Euclidean rhythm generator — distributes `pulses` across `steps` as
 * evenly as possible (Bresenham-style bucketing, equivalent to Bjorklund
 * for this purpose), then rotates by `rotate`. Pattern is recomputed on
 * every port message so it stays stable across process() calls — no
 * allocations in the audio loop. On each rising edge of `clock`, advances
 * the step index and emits the pattern bit. Optional `reset` input
 * restarts the step at 0.
 * Registered as `'dp-euclidean'`.
 */

class EuclideanProcessor extends AudioWorkletProcessor {
  private readonly maxSteps = 32
  private stepsCount = 16
  private pulsesCount = 4
  private rotate = 0
  private pattern = new Uint8Array(32)
  private step = 0
  private clkHigh = false
  private rstHigh = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && typeof data.paramId === 'string') {
        const id = data.paramId as string
        const v = Number(data.value)
        if (!Number.isFinite(v)) return
        if (id === 'steps') {
          let s = Math.round(v)
          if (s < 2) s = 2
          else if (s > this.maxSteps) s = this.maxSteps
          this.stepsCount = s
        } else if (id === 'pulses') {
          let p = Math.round(v)
          if (p < 0) p = 0
          else if (p > this.maxSteps) p = this.maxSteps
          this.pulsesCount = p
        } else if (id === 'rotate') {
          let r = Math.round(v)
          if (r < 0) r = 0
          this.rotate = r
        }
        this.recompute()
      }
    }
    this.recompute()
  }

  private recompute(): void {
    const steps = this.stepsCount
    let pulses = this.pulsesCount
    if (pulses > steps) pulses = steps
    const rot = this.rotate % steps
    // Zero out all of the pattern buffer we care about.
    for (let i = 0; i < this.maxSteps; i++) this.pattern[i] = 0
    if (pulses === 0 || steps === 0) return
    // Bresenham distribution: mark bucket boundaries.
    let prev = -1
    for (let i = 0; i < steps; i++) {
      const bucket = Math.floor((i * pulses) / steps)
      if (bucket !== prev) {
        const idx = ((i - rot) % steps + steps) % steps
        this.pattern[idx] = 1
        prev = bucket
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const n = out.length

    const clkCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const rstCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    // Wave 4 CVs: 2=pulses, 3=rotate. Replace semantics, block-rate sampling
    // since changing the pattern is integer-valued and recomputes the bitmap.
    const pulsesCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const rotateCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    if (pulsesCv || rotateCv) {
      const prevPulses = this.pulsesCount
      const prevRotate = this.rotate
      if (pulsesCv) {
        let p = Math.round(pulsesCv[0])
        if (p < 0) p = 0
        else if (p > this.maxSteps) p = this.maxSteps
        this.pulsesCount = p
      }
      if (rotateCv) {
        let r = Math.round(rotateCv[0])
        if (r < 0) r = 0
        else if (r > 31) r = 31
        this.rotate = r
      }
      if (this.pulsesCount !== prevPulses || this.rotate !== prevRotate) {
        this.recompute()
      }
    }

    const steps = this.stepsCount
    for (let i = 0; i < n; i++) {
      const clkV = clkCh ? clkCh[i] : 0
      const rstV = rstCh ? rstCh[i] : 0
      const clkNow = clkV >= 0.5
      const rstNow = rstV >= 0.5

      if (rstNow && !this.rstHigh) {
        this.step = 0
      } else if (clkNow && !this.clkHigh) {
        this.step++
        if (this.step >= steps) this.step = 0
      }
      this.clkHigh = clkNow
      this.rstHigh = rstNow

      // Emit pattern bit masked by the clock, so gate width matches the clock.
      const bit = this.pattern[this.step] === 1 ? 1 : 0
      out[i] = bit === 1 ? clkV : 0
    }

    return true
  }
}

registerProcessor('dp-euclidean', EuclideanProcessor)
