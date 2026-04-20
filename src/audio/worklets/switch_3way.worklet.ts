/// <reference path="./worklet.d.ts" />

/**
 * 3-way toggle — discrete CV source. Position parameter maps to
 * -1 / 0 / +1 and drives the output directly.
 *
 * On hardware this reads two GPIO lines (or a single ADC divider) bound
 * to the placed SPDT/SP3T switch. In the emulator the inspector's `position`
 * enum is the source of truth. `bindingId` is stashed for hardware export.
 *
 * Registered as `'dp-switch-3way'`.
 */

class Switch3WayProcessor extends AudioWorkletProcessor {
  private position = 0
  private bindingId = ''

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param') {
        if (data.paramId === 'position') {
          const n = Number(data.value)
          this.position = Number.isFinite(n) ? (n < 0 ? -1 : n > 0 ? 1 : 0) : 0
        } else if (data.paramId === 'bindingId') {
          this.bindingId = String(data.value)
        }
      }
      void this.bindingId
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const ch = output[0]
    if (!ch) return true

    ch.fill(this.position)
    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-switch-3way', Switch3WayProcessor)
