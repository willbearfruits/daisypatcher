/// <reference path="./worklet.d.ts" />

/**
 * Clock divider — counts rising edges on `in` (prev<0.5 && curr>=0.5) and
 * emits four square-wave outputs at /2, /4, /8, /16. Output d2 toggles on
 * every rising edge, d4 every 2 edges, d8 every 4, d16 every 8.
 * Registered as `'dp-clock-divider'`.
 */

class ClockDividerProcessor extends AudioWorkletProcessor {
  private prevHigh = false
  private edgeCount = 0 // monotonic count of rising edges observed

  // state[k] is the current high/low for output k (0:d2, 1:d4, 2:d8, 3:d16).
  private s0 = false
  private s1 = false
  private s2 = false
  private s3 = false

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const d2 = outputs[0]?.[0]
    const d4 = outputs[1]?.[0]
    const d8 = outputs[2]?.[0]
    const d16 = outputs[3]?.[0]
    const n = d2?.length ?? d4?.length ?? d8?.length ?? d16?.length ?? 0
    if (n === 0) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined

    for (let i = 0; i < n; i++) {
      const v = inCh ? inCh[i] : 0
      const nowHigh = v >= 0.5
      if (nowHigh && !this.prevHigh) {
        this.edgeCount++
        this.s0 = !this.s0
        if ((this.edgeCount & 1) === 0) this.s1 = !this.s1
        if ((this.edgeCount & 3) === 0) this.s2 = !this.s2
        if ((this.edgeCount & 7) === 0) this.s3 = !this.s3
      }
      this.prevHigh = nowHigh

      if (d2) d2[i] = this.s0 ? 1 : 0
      if (d4) d4[i] = this.s1 ? 1 : 0
      if (d8) d8[i] = this.s2 ? 1 : 0
      if (d16) d16[i] = this.s3 ? 1 : 0
    }

    return true
  }
}

registerProcessor('dp-clock-divider', ClockDividerProcessor)
