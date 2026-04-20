/**
 * App — top-level shell. Wires together the four independent pieces:
 *
 *   1. Layout shell (TopBar/Palette/CanvasShell/Inspector/StatusBar)
 *   2. Rete.js editor — mounted inside CanvasShell; palette drops route
 *      through its ref so client coords become canvas coords
 *   3. AudioEngine — subscribes to the store for graph/transport changes
 *      and writes its state back to the status line
 *   4. AudioEngineProvider — shares the engine with Visual nodes (scope /
 *      VU / spectrum) that need to `tap()` into its analyser infrastructure
 */

import { useEffect, useMemo, useRef } from 'react'
import { ThemeProvider } from '@/theme'
import {
  TopBar,
  Palette,
  CanvasShell,
  Inspector,
  StatusBar,
  ResizeHandle
} from '@/components/layout'
import { useEditorStore } from '@/state/store'
import { useCompileStore } from '@/state/compileState'
import { useSerialStore } from '@/state/serialState'
import { ReteEditor, type ReteEditorHandle } from '@/editor/ReteEditor'
import { createAudioEngine } from '@/audio'
import { AudioEngineProvider } from '@/audio/AudioEngineContext'
import { useGlobalKeybindings } from '@/hooks/useGlobalKeybindings'
import { BuildLogPanel } from '@/components/layout/BuildLogPanel'
import { SerialMonitorPanel } from '@/components/layout/SerialMonitorPanel'
import { SdkInstallModal } from '@/components/layout/SdkInstallModal'
import { HardwarePalette } from '@/hardware/HardwarePalette'
import { HardwareView } from '@/hardware/HardwareView'
import { HardwareInspector } from '@/hardware/HardwareInspector'

export default function App() {
  const reteRef = useRef<ReteEditorHandle>(null)
  useGlobalKeybindings()

  // Engine is constructed once, synchronously — the constructor is cheap
  // and does NOT create an AudioContext (that only happens on start()).
  // Creating it up front means VisualNode children can call engine.tap()
  // on first render instead of waiting for a useEffect tick.
  const engine = useMemo(() => createAudioEngine(), [])

  useEffect(() => {
    const store = useEditorStore

    const unsubEngine = engine.onStateChange((state, err) => {
      const s = store.getState()
      switch (state) {
        case 'starting':
          s.setStatus({ kind: 'info', message: 'starting engine' })
          break
        case 'running':
          s.setStatus({ kind: 'info', message: 'engine running' })
          break
        case 'stopped':
          s.setStatus({ kind: 'idle', message: 'ready' })
          break
        case 'error':
          s.setStatus({ kind: 'error', message: err?.message ?? 'engine error' })
          s.setPlaying(false)
          break
      }
    })

    // Seed engine with current graph; keep it synced on every graph change.
    engine.setGraph(store.getState().graph)
    const unsubGraph = store.subscribe((s, prev) => {
      if (s.graph !== prev.graph) engine.setGraph(s.graph)
    })

    // Transport.
    const unsubPlay = store.subscribe((s, prev) => {
      if (s.isPlaying === prev.isPlaying) return
      if (s.isPlaying) {
        engine.start().catch(() => { /* surfaced via onStateChange */ })
      } else {
        engine.stop().catch(() => { /* idem */ })
      }
    })

    return () => {
      unsubEngine()
      unsubGraph()
      unsubPlay()
      void engine.stop().catch(() => { /* mount teardown */ })
    }
  }, [engine])

  // One-shot SDK status probe on mount — drives the install-modal
  // visibility logic. The DFU poller fires every 3s on an interval bounded
  // to this effect's lifetime, so unmount cancels cleanly with no leaks.
  useEffect(() => {
    const c = useCompileStore.getState()
    const s = useSerialStore.getState()
    void c.refreshSdkStatus()
    void c.detectDevice()
    void s.refreshPorts()
    // Single 3s poller drives both DFU detect and port enumeration so
    // we don't double up on timers or interleave their cadences.
    const id = window.setInterval(() => {
      void useCompileStore.getState().detectDevice()
      void useSerialStore.getState().refreshPorts()
    }, 3000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <ThemeProvider>
      <AudioEngineProvider engine={engine}>
        <MainShell reteRef={reteRef} />
        <BuildLogPanel />
        <SerialMonitorPanel />
        <SdkInstallModal />
      </AudioEngineProvider>
    </ThemeProvider>
  )
}

/**
 * Main shell — swaps the left / center / right panels based on `store.view`.
 *
 * The Rete editor mount point stays present in the DOM at all times (just
 * hidden via display:none when the hardware view is active) so its internal
 * area state — pan/zoom/selection — survives round-trips between views.
 */
/** Store defaults as plain literals — keep in sync with `DEFAULT_LAYOUT`. */
const DEFAULT_PALETTE_W = 240
const DEFAULT_INSPECTOR_W = 280

function MainShell({ reteRef }: { reteRef: React.RefObject<ReteEditorHandle | null> }) {
  const view = useEditorStore((s) => s.view)
  const paletteW = useEditorStore((s) => s.layout.paletteW)
  const inspectorW = useEditorStore((s) => s.layout.inspectorW)
  const setPaletteW = useEditorStore((s) => s.setPaletteW)
  const setInspectorW = useEditorStore((s) => s.setInspectorW)
  const isPatch = view === 'patch'

  // Five tracks: [palette] [handle] [canvas] [handle] [inspector]. The
  // handles are fixed 4px so the main canvas absorbs all remaining space.
  // Composing the template inline means we never need to touch index.css
  // for a resize — the store owns the sizes.
  const gridTemplateColumns = `${paletteW}px 4px 1fr 4px ${inspectorW}px`

  return (
    <div className="dp-app">
      <TopBar />
      <div className="dp-main" style={{ gridTemplateColumns }}>
        <aside className="dp-panel">
          {isPatch ? <Palette /> : <HardwarePalette />}
        </aside>
        <ResizeHandle
          orientation="vertical"
          ariaLabel="Resize palette"
          onResize={(dx) => setPaletteW(paletteW + dx)}
          onReset={() => setPaletteW(DEFAULT_PALETTE_W)}
        />
        <main className="dp-canvas-shell">
          {/* Patch canvas — stays mounted so Rete.js state persists. */}
          <div style={{ position: 'absolute', inset: 0, display: isPatch ? 'block' : 'none' }}>
            <CanvasShell
              onDropNode={(kind, clientX, clientY) =>
                reteRef.current?.onDropNode(kind, clientX, clientY)
              }
            >
              <ReteEditor ref={reteRef} />
            </CanvasShell>
          </div>
          {/* Hardware canvas — fresh mount each time; its state lives in the store. */}
          {!isPatch ? <HardwareView /> : null}
        </main>
        <ResizeHandle
          orientation="vertical"
          ariaLabel="Resize inspector"
          // Drag right shrinks the inspector; drag left grows it. Negate dx.
          onResize={(dx) => setInspectorW(inspectorW - dx)}
          onReset={() => setInspectorW(DEFAULT_INSPECTOR_W)}
        />
        <aside className="dp-inspector">
          {isPatch ? <Inspector /> : <HardwareInspector />}
        </aside>
      </div>
      <StatusBar />
    </div>
  )
}
