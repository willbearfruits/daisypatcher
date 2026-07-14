/**
 * tapInput — tap the UPSTREAM source of a node's input socket.
 *
 * `AudioEngine.tap(nodeId)` forks a node's OUTPUT. When a consumer wants
 * the signal ARRIVING at an input socket (OLED display elements bound to
 * sockets a..f, the Perform view's live OLED window), it must walk the
 * graph's connection list to the connection's source node and tap THAT.
 *
 * Extracted from `OledNode.tsx` so the Perform view can reuse the exact
 * same walk instead of reimplementing it.
 */

import { useEditorStore } from '@/state/store'
import type { AudioEngine, Tap } from '@/types/store'

/**
 * Tap the source of a connected input socket. Returns the engine `Tap` or
 * null if the socket is unconnected. Callers keep a zero-filled buffer as
 * the default for unconnected inputs so render code uses zero state.
 */
export function tapInput(
  engine: AudioEngine,
  nodeId: string,
  socketId: string,
  onFrame: (values: Float32Array) => void
): Tap | null {
  const graph = useEditorStore.getState().graph
  const conn = graph.connections.find(
    (c) => c.to.nodeId === nodeId && c.to.socketId === socketId
  )
  if (!conn) return null
  return engine.tap(
    conn.from.nodeId,
    (frame) => {
      onFrame(frame.timeDomain)
    },
    { wantFrequency: false }
  )
}
