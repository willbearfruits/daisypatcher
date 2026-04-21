/**
 * React context plumbing for the `AudioEngine`. Visual nodes
 * (`src/editor/VisualNode.tsx`) reach for the engine through
 * `useAudioEngine()` so they can call `engine.tap()` from inside the Rete
 * scene — we can't forward refs through the Rete preset, so context is the
 * natural channel.
 *
 * The provider is wired once at the top of `App.tsx`, wrapping the rest of
 * the tree after the engine is created.
 */

import * as React from 'react'
import type { AudioEngine } from '@/types/store'

const AudioEngineCtx = React.createContext<AudioEngine | null>(null)

/*
 * Module-level fallback singleton.
 *
 * Rete mounts each node / connection / socket in its own `createRoot` —
 * React Context from the main app tree does NOT cross that boundary, so
 * `useContext(AudioEngineCtx)` returns null inside anything Rete renders
 * (VisualNode, CustomConnection, OledNode, ...). We stash the engine here
 * on every provider render and fall back to it in `useAudioEngine` so those
 * components get a live engine regardless of Context scope.
 *
 * There's only ever one engine per app (see `App.tsx`'s `useMemo`), so a
 * singleton is correct, not a compromise.
 */
let engineSingleton: AudioEngine | null = null

export interface AudioEngineProviderProps {
  engine: AudioEngine
  children: React.ReactNode
}

export function AudioEngineProvider(props: AudioEngineProviderProps): React.JSX.Element {
  engineSingleton = props.engine
  return (
    <AudioEngineCtx.Provider value={props.engine}>
      {props.children}
    </AudioEngineCtx.Provider>
  )
}

/**
 * Read the engine. Tries React Context first, falls back to the module
 * singleton — the latter is what Rete-rendered components use. Returns
 * null only if no provider has ever mounted, in which case visual
 * consumers degrade gracefully (flat line / empty meter).
 */
export function useAudioEngine(): AudioEngine | null {
  const fromCtx = React.useContext(AudioEngineCtx)
  return fromCtx ?? engineSingleton
}
