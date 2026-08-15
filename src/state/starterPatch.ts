/**
 * Starter patch — the small, musical demo graph behind the canvas empty
 * state's "load a starter patch" action. A classic subtractive voice:
 *
 *   oscillator (saw) ──▶ SVF ──lp──▶ audio output (L+R)
 *                         ▲
 *          LFO (sine) ──freq_cv (±1 octave sweep around the cutoff)
 *
 * The LFO drives the SVF's legacy `freq_cv` socket on purpose: it scales
 * the sidebar cutoff by octaves (`freq * 2^cv`), so a -1..1 LFO sweeps
 * 450–1800 Hz around the 900 Hz base. The replace-semantics `cv_cutoff`
 * socket would clamp a bipolar LFO to the param floor (20 Hz) instead.
 *
 * All four kinds are 'native' on every target (see nodes/targetSupport.ts),
 * so the starter compiles for Daisy Seed and ESP32-S3 alike.
 *
 * Loading mirrors the `.dpatch` open path (`store.loadGraph` — see
 * patchFile.ts): the graph is swapped atomically so Rete and the audio
 * engine resync exactly like a real file load. Two deliberate differences:
 *
 *   - ONE history snapshot is pushed first, so undo removes the starter
 *     in a single step (loadGraph wipes history — wrong here, the user
 *     may want their empty canvas back);
 *   - the result stays untitled + dirty with no filePath — it was never
 *     saved to disk.
 *
 * Transport is NOT auto-started: audio needs a user gesture, and surprise
 * sound is hostile. The TopBar play button / Space bar remain the way in.
 */

import { nanoid } from 'nanoid'
import type { AudioGraph } from '@/types/graph'
import type { HistorySnapshot } from '@/types/store'
import { useEditorStore } from './store'

type Store = typeof useEditorStore

/** Mirror of `HISTORY_LIMIT` in store.ts (private there). */
const HISTORY_LIMIT = 50

/**
 * Build a fresh starter graph. Ids are generated per call (same `nanoid(8)`
 * shape the store's `addNode` uses) so loading twice never collides with
 * nodes the user kept from a previous load.
 */
export function buildStarterGraph(): AudioGraph {
  const osc = nanoid(8)
  const lfo = nanoid(8)
  const svf = nanoid(8)
  const out = nanoid(8)
  return {
    nodes: [
      {
        id: osc,
        kind: 'oscillator',
        position: { x: 60, y: 60 },
        params: { frequency: 110, amplitude: 0.5, waveform: 'sawtooth' }
      },
      {
        id: lfo,
        kind: 'lfo',
        position: { x: 60, y: 320 },
        params: { frequency: 0.3, depth: 1, offset: 0, waveform: 'sine' }
      },
      {
        id: svf,
        kind: 'filter_svf',
        position: { x: 380, y: 120 },
        params: { frequency: 900, resonance: 0.55 }
      },
      {
        id: out,
        kind: 'audio_output',
        position: { x: 700, y: 160 },
        params: {}
      }
    ],
    connections: [
      { id: nanoid(8), from: { nodeId: osc, socketId: 'out' }, to: { nodeId: svf, socketId: 'in' } },
      { id: nanoid(8), from: { nodeId: lfo, socketId: 'out' }, to: { nodeId: svf, socketId: 'freq_cv' } },
      { id: nanoid(8), from: { nodeId: svf, socketId: 'lp' }, to: { nodeId: out, socketId: 'left' } },
      { id: nanoid(8), from: { nodeId: svf, socketId: 'lp' }, to: { nodeId: out, socketId: 'right' } }
    ],
    meta: { name: 'untitled', sampleRate: 48000, blockSize: 48 }
  }
}

/**
 * Load the starter into the store. Direct `setState` follows the same
 * pattern patchFile.ts uses for save/open; setting `graph` is what drives
 * the ReteEditor + AudioEngine subscriptions, identical to a file load.
 * The hardware layout is left untouched — the starter is patch-only, and
 * the snapshot captures both halves so undo stays consistent regardless.
 */
export function loadStarterPatch(store: Store = useEditorStore): void {
  const s = store.getState()
  const snapshot: HistorySnapshot = { graph: s.graph, hardware: s.hardware, presets: s.presets }
  const past = [...s.history.past, snapshot]
  store.setState({
    graph: buildStarterGraph(),
    selection: new Set<string>(),
    selectedNodeId: null,
    history: {
      past: past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past,
      future: []
    },
    filePath: null,
    isDirty: true
  })
  s.setStatus({ kind: 'info', message: 'starter patch loaded — press play' })
}
