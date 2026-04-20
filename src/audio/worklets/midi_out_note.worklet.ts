/// <reference path="./worklet.d.ts" />

/**
 * CV/gate/velocity → Web MIDI note-on/off.
 *
 * On a rising gate edge, posts `{ type: 'midi', data: [0x90 | ch, note, vel] }`
 * to the main thread. On a falling edge, posts the corresponding note-off.
 * The main thread is responsible for relaying these to the selected Web
 * MIDI output. No audio is produced.
 *
 * Pitch is interpreted as (note - 60) / 12 volts-per-octave, the same
 * scale `midi_in_note` emits, so the round-trip is lossless within the
 * 0..127 MIDI range.
 *
 * Registered as `'dp-midi-out-note'`.
 */

class MidiOutNoteProcessor extends AudioWorkletProcessor {
  private channel = 1
  private prevGate = 0
  private activeNote = -1

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'channel') {
        const n = parseInt(String(data.value), 10)
        if (Number.isFinite(n) && n >= 1 && n <= 16) this.channel = n
      }
    }
  }

  private pitchToMidi(pitch: number): number {
    const note = Math.round(60 + pitch * 12)
    return note < 0 ? 0 : note > 127 ? 127 : note
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const pitchCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const gateCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const velCh = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    // Scan the block for gate edges; emit at most one event per edge.
    const n = gateCh ? gateCh.length : 0
    for (let i = 0; i < n; i++) {
      const gv = gateCh ? gateCh[i] : 0
      const nowHigh = gv >= 0.5 ? 1 : 0
      if (this.prevGate < 0.5 && nowHigh >= 0.5) {
        const note = this.pitchToMidi(pitchCh ? pitchCh[i] : 0)
        const velRaw = velCh ? velCh[i] : 1
        const velClamped = velRaw < 0 ? 0 : velRaw > 1 ? 1 : velRaw
        const vel = Math.round(velClamped * 127)
        this.activeNote = note
        this.port.postMessage({
          type: 'midi',
          data: [0x90 | ((this.channel - 1) & 0x0f), note, vel]
        })
      } else if (this.prevGate >= 0.5 && nowHigh < 0.5) {
        if (this.activeNote >= 0) {
          this.port.postMessage({
            type: 'midi',
            data: [0x80 | ((this.channel - 1) & 0x0f), this.activeNote, 0]
          })
          this.activeNote = -1
        }
      }
      this.prevGate = nowHigh
    }
    return true
  }
}

registerProcessor('dp-midi-out-note', MidiOutNoteProcessor)
