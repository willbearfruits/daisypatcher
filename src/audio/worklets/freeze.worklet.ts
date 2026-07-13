/// <reference path="./worklet.d.ts" />

/**
 * Freeze — on gate rising edge, starts recording up to `buffer_ms` into a
 * buffer. While gate is high and the buffer is full, loops the buffer.
 * When gate goes low mid-record, stops recording and loops the partial.
 * When gate is low and no buffer has been captured, passes input through.
 * Registered as `'dp-freeze'`.
 */

const FREEZE_MAX_MS = 500

class FreezeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'buffer_ms', defaultValue: 120, minValue: 20, maxValue: FREEZE_MAX_MS, automationRate: 'k-rate' }
    ]
  }

  private buffer: Float32Array
  private writeIdx = 0
  private playIdx = 0
  private captured = 0
  private recording = false
  private prevGate = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const size = Math.ceil((FREEZE_MAX_MS / 1000) * sampleRate) + 2
    this.buffer = new Float32Array(size)
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

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const gateCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const lenCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    const bufBase = parameters.buffer_ms[0] ?? 120

    const buf = this.buffer
    const bufCapacity = this.buffer.length - 2
    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const g = gateCh ? gateCh[i] : 0
      const gateHigh = g > 0.5

      let bufMs = bufBase
      if (lenCv) {
        bufMs = lenCv[i]
      }
      if (bufMs < 20) bufMs = 20
      else if (bufMs > FREEZE_MAX_MS) bufMs = FREEZE_MAX_MS
      const targetSamples = Math.min(bufCapacity, Math.floor((bufMs / 1000) * sampleRate))

      // Rising edge: start a fresh record.
      if (gateHigh && this.prevGate <= 0.5) {
        this.recording = true
        this.writeIdx = 0
        this.captured = 0
      }
      // Falling edge: stop recording; keep whatever was captured.
      if (!gateHigh && this.prevGate > 0.5) {
        this.recording = false
      }
      this.prevGate = g

      if (this.recording) {
        if (this.writeIdx < targetSamples) {
          buf[this.writeIdx++] = x
          this.captured = this.writeIdx
        } else {
          // Hit target size, wrap to loop mode.
          this.recording = false
        }
      }

      let y: number
      if (this.captured > 0 && (gateHigh || !this.recording)) {
        // Loop through the captured buffer only when gate is high, OR when
        // gate is low but we previously captured something? Spec says: when
        // gate low and buffer empty, passthrough; when gate high and buffer
        // full, loop the buffer. Interpreting conservatively: only loop when
        // gate is high.
        if (gateHigh) {
          if (this.playIdx >= this.captured) this.playIdx = 0
          y = buf[this.playIdx++]
        } else {
          y = x
        }
      } else {
        y = x
        this.playIdx = 0
      }
      if (!isFinite(y)) y = 0
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-freeze', FreezeProcessor)
