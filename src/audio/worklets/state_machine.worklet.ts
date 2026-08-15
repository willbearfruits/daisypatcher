/// <reference path="./worklet.d.ts" />

/**
 * State machine.
 *
 * `cv_goto` jumps directly when connected, and it is level-triggered rather
 * than edge-triggered: patching a knob to it should let you scrub through
 * states, not require a separate trigger. The `changed` output still only
 * fires when the state actually differs, so a held knob does not machine-gun.
 *
 * `state` is normalised by `states - 1` for the same reason the counter's
 * is — the last state must read exactly 1.0.
 *
 * Registered as `'dp-state-machine'`.
 */

class StateMachineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'states', defaultValue: 4, minValue: 2, maxValue: 16, automationRate: 'k-rate' }
    ]
  }

  private index = 0
  private mode = 'wrap'
  private nextHigh = false
  private prevHigh = false
  private resetHigh = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; paramId?: string; value?: unknown }
      if (d?.type === 'param' && d.paramId === 'mode') this.mode = String(d.value)
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const stateOut = outputs[0]?.[0]
    const indexOut = outputs[1]?.[0]
    const changedOut = outputs[2]?.[0]
    const n = stateOut?.length ?? indexOut?.length ?? changedOut?.length ?? 0
    if (n === 0) return true

    const nxt = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const prv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const rst = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const goto_ = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    let states = Math.round(parameters.states[0] ?? 4)
    if (states < 2) states = 2
    else if (states > 16) states = 16
    if (this.index >= states) this.index = states - 1
    const wrap = this.mode !== 'clamp'

    for (let i = 0; i < n; i++) {
      const before = this.index

      const rv = (rst ? rst[i] : 0) >= 0.5
      if (rv && !this.resetHigh) this.index = 0
      this.resetHigh = rv

      const nv = (nxt ? nxt[i] : 0) >= 0.5
      if (nv && !this.nextHigh) {
        this.index++
        if (this.index >= states) this.index = wrap ? 0 : states - 1
      }
      this.nextHigh = nv

      const pv = (prv ? prv[i] : 0) >= 0.5
      if (pv && !this.prevHigh) {
        this.index--
        if (this.index < 0) this.index = wrap ? states - 1 : 0
      }
      this.prevHigh = pv

      if (goto_) {
        // Level-triggered: scrub with a knob. 0..1 maps across all states.
        let g = goto_[i]
        if (g < 0) g = 0
        else if (g > 1) g = 1
        this.index = Math.min(states - 1, Math.floor(g * states))
      }

      if (stateOut) stateOut[i] = states > 1 ? this.index / (states - 1) : 0
      if (indexOut) indexOut[i] = this.index
      if (changedOut) changedOut[i] = this.index !== before ? 1 : 0
    }
    return true
  }
}

registerProcessor('dp-state-machine', StateMachineProcessor)
