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
import { useVerificationStore } from '@/state/verificationStore'
// Imported for its side effect: the updateState store registers its IPC
// listeners at construction time so update events that fire during
// first-paint work are captured even before any UI subscribes.
import '@/state/updateState'
import { ReteEditor, type ReteEditorHandle } from '@/editor/ReteEditor'
import { SignalLegend } from '@/editor/SignalLegend'
import { Minimap } from '@/editor/Minimap'
import { createAudioEngine } from '@/audio'
import { AudioEngineProvider } from '@/audio/AudioEngineContext'
import { useGlobalKeybindings } from '@/hooks/useGlobalKeybindings'
import { BuildLogPanel } from '@/components/layout/BuildLogPanel'
import { SerialMonitorPanel } from '@/components/layout/SerialMonitorPanel'
import { SdkInstallModal } from '@/components/layout/SdkInstallModal'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { ConfirmHost } from '@/components/layout/ConfirmDialog'
import type { NodeKind } from '@/types/graph'
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

  // The Palette's "Recent" strip and the command palette both drop nodes
  // without a drag — they dispatch a `dp-drop-kind` CustomEvent and we
  // route it through the Rete ref here. Keeps those components ignorant
  // of the editor instance.
  useEffect(() => {
    const onDrop = (ev: Event) => {
      const ce = ev as CustomEvent<{ kind: NodeKind; clientX: number; clientY: number }>
      const d = ce.detail
      if (!d) return
      reteRef.current?.onDropNode(d.kind, d.clientX, d.clientY)
    }
    window.addEventListener('dp-drop-kind', onDrop)
    return () => window.removeEventListener('dp-drop-kind', onDrop)
  }, [])

  // One-shot SDK status probe on mount — drives the install-modal
  // visibility logic. The DFU poller fires every 3s on an interval bounded
  // to this effect's lifetime, so unmount cancels cleanly with no leaks.
  useEffect(() => {
    const c = useCompileStore.getState()
    const s = useSerialStore.getState()
    void c.refreshSdkStatus()
    void c.detectDevice()
    // Fire an initial cross-target probe so startup doesn't wait 3s for
    // the first autodetect guess.
    void c.detectBoards()
    void s.refreshPorts()
    // Load the persisted verification table once so the Inspector's
    // Test-status dot + the VerificationPanel render a non-empty table
    // on first paint.
    void useVerificationStore.getState().loadFromDisk()
    // Single 1s poller drives target-scoped DFU detection, cross-target
    // autodetect, and port enumeration. Tight cadence because entering DFU
    // mode (boot+reset) is interactive — a 3s gap made the app feel slow
    // to notice the board had come up. 1s keeps the CPU cost bounded
    // (dfu-util -l is ~50–200 ms on Linux/macOS) and the feedback tight.
    const id = window.setInterval(() => {
      void useCompileStore.getState().detectDevice()
      void useCompileStore.getState().detectBoards()
      void useSerialStore.getState().refreshPorts()
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <ThemeProvider>
      <AudioEngineProvider engine={engine}>
        <MainShell reteRef={reteRef} />
        <BuildLogPanel />
        <SerialMonitorPanel />
        <SdkInstallModal />
        <CommandPalette />
        <ConfirmHost />
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

/** Width of the collapsed palette rail — matches `Palette.module.css .rootCollapsed`. */
const COLLAPSED_PALETTE_W = 44

function MainShell({ reteRef }: { reteRef: React.RefObject<ReteEditorHandle | null> }) {
  const view = useEditorStore((s) => s.view)
  const paletteW = useEditorStore((s) => s.layout.paletteW)
  const paletteCollapsed = useEditorStore((s) => s.layout.paletteCollapsed)
  const inspectorW = useEditorStore((s) => s.layout.inspectorW)
  const setPaletteW = useEditorStore((s) => s.setPaletteW)
  const setInspectorW = useEditorStore((s) => s.setInspectorW)
  const isPatch = view === 'patch'

  // Five tracks: [palette] [handle] [canvas] [handle] [inspector]. The
  // handles are fixed 4px so the main canvas absorbs all remaining space.
  // When the palette is collapsed we override its track width to a thin
  // rail — the resize handle is also disabled in that mode (there's
  // nothing to drag against).
  const effectivePaletteW = paletteCollapsed ? COLLAPSED_PALETTE_W : paletteW
  const gridTemplateColumns = `${effectivePaletteW}px 4px 1fr 4px ${inspectorW}px`

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
          onResize={(dx) => {
            // No-op while collapsed — dragging a thin rail would just
            // auto-expand it unexpectedly. User should uncollapse first.
            if (paletteCollapsed) return
            setPaletteW(paletteW + dx)
          }}
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
              <Minimap reteRef={reteRef} />
              <SignalLegend />
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
