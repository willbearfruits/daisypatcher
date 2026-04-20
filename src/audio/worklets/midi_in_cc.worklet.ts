/// <reference path="./worklet.d.ts" />

/**
 * MIDI CC → normalized CV (0..1).
 *
 * Web MIDI events are forwarded from the main thread as
 * `{ type: 'midi', data: [status, d1, d2] }`. This worklet tracks the
 * last matching CC value for the configured channel + CC number.
 *
 * When no MIDI device is connected the inspector's `test_value` param
 * (0..1) drives the output directly for manual testing.
 *
 * Registered as `'dp-midi-in-cc'`.
 */

class MidiInCcProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'cc', defaultValue: 1, minValue: 0, maxValue: 127, automationRate: 'k-rate' },
      { name: 'test_value', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private channel = '1'
  private ccReceived = false
  // Table covering the 128 possible CC numbers. Allocated once in the
  // field initialiser (i.e. at construction time) — no runtime allocs.
  private ccTable = new Float32Array(128)

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'channel') {
        this.channel = String(data.value)
      } else if (data.type === 'midi' && Array.isArray(data.data)) {
        this.handleMidi(data.data as number[])
      }
    }
  }

  private channelMatches(status: number): boolean {
    if (this.channel === 'all') return true
    const ch = (status & 0x0f) + 1
    return String(ch) === this.channel
  }

  private handleMidi(bytes: number[]): void {
    if (bytes.length < 3) return
    const status = bytes[0] & 0xf0
    if (status !== 0xb0) return
    if (!this.channelMatches(bytes[0])) return
    // We don't have the `cc` param value here (k-rate param block only
    // arrives in process()). Stash raw CC number + value; compare in
    // process(). Cheaper: just latch latest matching CC per-process().
    // Keep it simple: store per-CC table.
    const ccNum = bytes[1] & 0x7f
    const ccVal = (bytes[2] & 0x7f) / 127
    this.ccTable[ccNum] = ccVal
    this.ccReceived = true
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const ch = output[0]
    if (!ch) return true

    const cc = (parameters.cc[0] ?? 1) | 0
    const testValue = parameters.test_value[0] ?? 0
    const ccIdx = cc < 0 ? 0 : cc > 127 ? 127 : cc
    const value = this.ccReceived ? this.ccTable[ccIdx] : testValue
    ch.fill(value)
    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-midi-in-cc', MidiInCcProcessor)
