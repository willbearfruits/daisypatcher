/// <reference path="./worklet.d.ts" />

/**
 * Timer, in three modes that are genuinely different behaviours:
 *
 *   - `delay`   — a rising edge starts a countdown; `out` fires for one
 *                 sample when it reaches zero.
 *   - `pulse`   — a rising edge takes `out` high immediately and holds it
 *                 for the set time.
 *   - `gateoff` — `out` follows the input high, and stays high until the
 *                 input has been LOW continuously for the set time. This is
 *                 a debounce, and it is why the node exists at all: a
 *                 mechanical button on a GPIO chatters, and every patch that
 *                 counts button presses needs this or it counts three.
 *
 * `running` is high whenever the timer is counting, which is what you patch
 * to an LED to see it work.
 *
 * Registered as `'dp-timer'`.
 */

class TimerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'time', defaultValue: 250, minValue: 1, maxValue: 10000, automationRate: 'k-rate' }
    ]
  }

  private mode = 'delay'
  private retrigger = 'restart'
  private remaining = 0
  private trigHigh = false
  private held = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; paramId?: string; value?: unknown }
      if (d?.type !== 'param') return
      if (d.paramId === 'mode') this.mode = String(d.value)
      else if (d.paramId === 'retrigger') this.retrigger = String(d.value)
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0]
    const running = outputs[1]?.[0]
    const n = out?.length ?? running?.length ?? 0
    if (n === 0) return true

    const trig = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const timeCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    let ms = parameters.time[0] ?? 250
    if (timeCv) ms = timeCv[0]
    if (ms < 1) ms = 1
    else if (ms > 10000) ms = 10000
    const samples = Math.max(1, Math.round((ms / 1000) * sampleRate))
    const mode = this.mode

    for (let i = 0; i < n; i++) {
      const tv = (trig ? trig[i] : 0) >= 0.5
      const rising = tv && !this.trigHigh
      const falling = !tv && this.trigHigh
      this.trigHigh = tv
      let o = 0

      if (mode === 'gateoff') {
        if (tv) {
          this.held = true
          this.remaining = 0
        } else if (falling) {
          this.remaining = samples
        } else if (this.remaining > 0) {
          this.remaining--
          if (this.remaining === 0) this.held = false
        }
        o = this.held ? 1 : 0
      } else if (mode === 'pulse') {
        if (rising && (this.remaining === 0 || this.retrigger === 'restart')) {
          this.remaining = samples
        }
        if (this.remaining > 0) {
          o = 1
          this.remaining--
        }
      } else {
        // delay
        if (rising && (this.remaining === 0 || this.retrigger === 'restart')) {
          this.remaining = samples
        }
        if (this.remaining > 0) {
          this.remaining--
          if (this.remaining === 0) o = 1
        }
      }

      if (out) out[i] = o
      if (running) running[i] = this.remaining > 0 ? 1 : 0
    }
    return true
  }
}

registerProcessor('dp-timer', TimerProcessor)
