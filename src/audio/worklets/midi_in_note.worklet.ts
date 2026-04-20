/// <reference path="./worklet.d.ts" />

/**
 * MIDI note → pitch (v/oct) + gate + velocity CV.
 *
 * Web MIDI lives on the main thread — not in AudioWorkletGlobalScope — so
 * the engine is expected to forward MIDI events in via `port.postMessage`
 * with `{ type: 'midi', data: [status, d1, d2] }`. This worklet tracks
 * the most recent note, its velocity, and the gate state for the
 * configured channel.
 *
 * Pitch mapping: (midi_note - 60) / 12 — so C4 → 0, A4 → 0.25, C5 → 1.0.
 * Velocity is normalised to 0..1.
 *
 * For manual testing without a MIDI device the inspector's `test_note`
 * enum (value = midi note number, or `'none'`) drives a held note when
 * non-`none`, so a user can audition the patch.
 *
 * Registered as `'dp-midi-in-note'`.
 */

class MidiInNoteProcessor extends AudioWorkletProcessor {
  // '1'..'16' | 'all'
  private channel = '1'
  private testNote = 'none'
  private heldNote = -1
  private heldVelocity = 0
  private gateOn = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param') {
        if (data.paramId === 'channel') this.channel = String(data.value)
        else if (data.paramId === 'test_note') {
          this.testNote = String(data.value)
          this.applyTestNote()
        }
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
    if (!this.channelMatches(bytes[0])) return
    const d1 = bytes[1] & 0x7f
    const d2 = bytes[2] & 0x7f
    if (status === 0x90 && d2 > 0) {
      this.heldNote = d1
      this.heldVelocity = d2 / 127
      this.gateOn = 1
    } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
      if (d1 === this.heldNote) {
        this.gateOn = 0
      }
    }
  }

  private applyTestNote(): void {
    if (this.testNote === 'none') {
      this.gateOn = 0
      return
    }
    const n = parseInt(this.testNote, 10)
    if (!Number.isFinite(n)) return
    this.heldNote = n
    this.heldVelocity = 100 / 127
    this.gateOn = 1
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const pitchOut = outputs[0]?.[0]
    const gateOut = outputs[1]?.[0]
    const velOut = outputs[2]?.[0]

    const pitch = this.heldNote >= 0 ? (this.heldNote - 60) / 12 : 0
    if (pitchOut) pitchOut.fill(pitch)
    if (gateOut) gateOut.fill(this.gateOn)
    if (velOut) velOut.fill(this.heldVelocity)

    // Mirror to any extra channels in each output for host flexibility.
    for (let o = 0; o < outputs.length; o++) {
      const out = outputs[o]
      if (!out || out.length <= 1) continue
      for (let c = 1; c < out.length; c++) out[c].set(out[0])
    }
    return true
  }
}

registerProcessor('dp-midi-in-note', MidiInNoteProcessor)
