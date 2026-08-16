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
import { stepMenus, setMenuEngine } from '@/state/menuRuntime'
import { ThemeProvider } from '@/theme'
import {
  TopBar,
  Palette,
  CanvasShell,
  Inspector,
  StatusBar,
  ResizeHandle
} from '@/components/layout'
import { useEditorStore, rootGraphOf } from '@/state/store'
import { useSampleStore } from '@/state/sampleStore'
import { flattenGraph } from '@/state/subpatch'
import { useCompileStore } from '@/state/compileState'
import { useSerialStore } from '@/state/serialState'
import { useVerificationStore } from '@/state/verificationStore'
// Imported for its side effect: the updateState store registers its IPC
// listeners at construction time so update events that fire during
// first-paint work are captured even before any UI subscribes.
import '@/state/updateState'
import { ReteEditor, type ReteEditorHandle } from '@/editor/ReteEditor'
import { SignalLegend } from '@/editor/SignalLegend'
import { SubpatchBar } from '@/editor/SubpatchBar'
import { Minimap } from '@/editor/Minimap'
import { createAudioEngine } from '@/audio'
import { AudioEngineProvider } from '@/audio/AudioEngineContext'
import { useGlobalKeybindings } from '@/hooks/useGlobalKeybindings'
import { BuildLogPanel } from '@/components/layout/BuildLogPanel'
import { SerialMonitorPanel } from '@/components/layout/SerialMonitorPanel'
import { SdkInstallModal } from '@/components/layout/SdkInstallModal'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { CanvasContextMenu } from '@/editor/CanvasContextMenu'
import { AssistantPanel } from '@/components/layout/AssistantPanel'
import { AppModals } from '@/components/layout/AppModals'
import { useMenuCommands } from '@/hooks/useMenuCommands'
import { CodePanel } from '@/components/layout/CodePanel'
import { ConfirmHost } from '@/components/layout/ConfirmDialog'
import type { NodeKind } from '@/types/graph'
import { HardwarePalette } from '@/hardware/HardwarePalette'
import { HardwareView } from '@/hardware/HardwareView'
import { HardwareInspector } from '@/hardware/HardwareInspector'
import { PerformView } from '@/perform/PerformView'
import { usePerformMode } from '@/perform/performMode'

export default function App() {
  const reteRef = useRef<ReteEditorHandle>(null)
  useGlobalKeybindings()
  useMenuCommands()

  /*
   * The last net under every fire-and-forget promise.
   *
   * Dozens of UI handlers call `void savePatch()` and the like — correct,
   * because a click handler cannot await — but a rejection from any of them
   * used to vanish into the devtools console the user does not have open.
   * A save that failed for lack of permission looked exactly like a save
   * that worked. Surface it on the status line, where every other error
   * already goes, and keep the console entry for anyone debugging.
   */
  useEffect(() => {
    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'unknown error')
      // Rete's own internal cancellations are not user-facing.
      if (/aborted|cancel/i.test(msg)) return
      useEditorStore.getState().setStatus({ kind: 'error', message: msg.slice(0, 200) })
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  // Engine is constructed once, synchronously — the constructor is cheap
  // and does NOT create an AudioContext (that only happens on start()).
  // Creating it up front means VisualNode children can call engine.tap()
  // on first render instead of waiting for a useEffect tick.
  const engine = useMemo(() => createAudioEngine(), [])

  /*
   * Dev-only handle for poking the store from a devtools console. Stripped
   * from production by the DEV guard; a released build exposes nothing on
   * `window` beyond the preload bridge.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __dp?: unknown }
    w.__dp = { store: useEditorStore, engine }
    return () => {
      delete w.__dp
    }
  }, [engine])

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

    /*
     * The engine plays the ROOT patch, flattened — not whichever level you
     * happen to be editing. Editing inside a subpatch must not silence the
     * rest of the instrument, and the engine has no concept of nesting by
     * design (see state/subpatch.ts).
     */
    const publish = (): void => engine.setGraph(flattenGraph(rootGraphOf(store.getState())))
    publish()
    const unsubGraph = store.subscribe((s, prev) => {
      if (s.graph !== prev.graph || s.subpatchStack !== prev.subpatchStack) publish()
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
    /*
     * Menu tick. Encoder gestures are control-rate, and the machine runs on
     * the main thread (worklets cannot import — see menu.worklet.ts), so it
     * needs a steady pulse to sample the encoder and settle long-press /
     * double-click timing. 30 ms is well inside a human double-click window
     * and costs nothing when no menu node exists — `stepMenus` returns
     * immediately on an empty list.
     */
    const menuId = window.setInterval(() => {
      stepMenus(null, performance.now())
    }, 30)

    const id = window.setInterval(() => {
      void useCompileStore.getState().detectDevice()
      void useCompileStore.getState().detectBoards()
      void useSerialStore.getState().refreshPorts()
    }, 1000)
    return () => {
      window.clearInterval(id)
      window.clearInterval(menuId)
    }
  }, [])

  // Hand the engine to the menu runtime so leaf edits reach the CV outs
  // even when driven from a button handler that has no engine reference.
  useEffect(() => {
    setMenuEngine(engine)
    return () => setMenuEngine(null)
  }, [engine])

  /*
   * A `preset_recall` node fires from inside the audio graph, where there
   * is no store. The engine forwards its requests here, and here is where
   * they become store transactions — so a preset triggered by a patched
   * gate behaves exactly like one clicked in the Preset bar, undo entry
   * and all.
   *
   * Slots are indices into the preset list, because that is what a CV can
   * address. A slot past the end is ignored rather than clamped: silently
   * loading the last preset when you asked for the ninth of eight is worse
   * than doing nothing.
   */
  // Where the engine reads sample PCM from. Same wiring reason as the
  // preset handler: the engine cannot import a store that imports it back.
  useEffect(() => {
    engine.setSampleReader((id) => useSampleStore.getState().getPcm(id))
    void useSampleStore.getState().refresh()
    return () => engine.setSampleReader(null)
  }, [engine])

  useEffect(() => {
    engine.setPresetHandler((req) => {
      const st = useEditorStore.getState()
      const presets = st.presets
      if (req.action === 'apply') {
        const p = presets[req.slot]
        // Silent: a recall the patch fired is not a user edit and must not
        // fill the undo stack — see `endTransaction`.
        if (p) st.recallPreset(p.id, { silent: true })
        return
      }
      const a = presets[req.a]
      const b = presets[req.b]
      if (a && b && a.id !== b.id) {
        // `morphPresets` leaves the transaction to its caller (the slider
        // brackets a whole drag). From a CV there is no drag — each tick
        // stands alone — so bracket it here, silently, for the same reason
        // as the recall above.
        st.beginTransactionSilent()
        st.morphPresets(a.id, b.id, req.t)
        st.endTransaction()
      }
    })
    return () => engine.setPresetHandler(null)
  }, [engine])

  return (
    <ThemeProvider>
      <AudioEngineProvider engine={engine}>
        <MainShell reteRef={reteRef} />
        <CodePanel />
        <AssistantPanel />
        <AppModals />
        <BuildLogPanel />
        <SerialMonitorPanel />
        <SdkInstallModal />
        <CommandPalette />
        <CanvasContextMenu />
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
  const isPerform = view === 'perform'
  // Perform's ARRANGE mode brings the right panel back (HardwareInspector
  // for the selected component); PLAY stays full-bleed.
  const performMode = usePerformMode((s) => s.mode)
  const performArrange = isPerform && performMode === 'arrange'
  const performFullBleed = isPerform && !performArrange

  // Five tracks: [palette] [handle] [canvas] [handle] [inspector]. The
  // handles are fixed 4px so the main canvas absorbs all remaining space.
  // When the palette is collapsed we override its track width to a thin
  // rail — the resize handle is also disabled in that mode (there's
  // nothing to drag against).
  //
  // Perform view is the stage: in PLAY both side panels collapse to zero
  // so the pedal gets the full width; ARRANGE re-opens the inspector
  // track. The panels stay in the grid (5 children, fixed track order)
  // so the Rete canvas never remounts.
  const effectivePaletteW = paletteCollapsed ? COLLAPSED_PALETTE_W : paletteW
  const gridTemplateColumns = isPerform
    ? performArrange
      ? `0px 0px 1fr 4px ${inspectorW}px`
      : '0px 0px 1fr 0px 0px'
    : `${effectivePaletteW}px 4px 1fr 4px ${inspectorW}px`

  return (
    <div className="dp-app">
      <TopBar />
      <div className="dp-main" style={{ gridTemplateColumns }}>
        <aside className="dp-panel" style={isPerform ? { border: 'none', overflow: 'hidden' } : undefined}>
          {isPatch ? <Palette /> : isPerform ? null : <HardwarePalette />}
        </aside>
        {isPerform ? (
          <div aria-hidden />
        ) : (
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
        )}
        <main className="dp-canvas-shell">
          {/*
            Patch canvas — stays mounted so Rete.js state persists.

            Hidden with `visibility`, NOT `display: none`, and that is
            load-bearing. Rete computes a socket's position by walking
            `offsetParent` up to the node element, and it waits for that
            chain to exist by spinning on `setTimeout(0)` until
            `offsetParent` is non-null. `display: none` makes it null
            forever, so any node whose sockets first render while the
            Hardware or Perform tab is open never gets a socket position at
            all — and its cables draw once at a stale endpoint and then sit
            there, unmoved by dragging the node. `visibility: hidden` keeps
            the element laid out and `offsetParent` populated, which costs
            nothing here (the canvas is already absolutely positioned) and
            removes the failure entirely.
          */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              visibility: isPatch ? 'visible' : 'hidden',
              pointerEvents: isPatch ? 'auto' : 'none'
            }}
            aria-hidden={!isPatch}
          >
            <CanvasShell
              onDropNode={(kind, clientX, clientY) =>
                reteRef.current?.onDropNode(kind, clientX, clientY)
              }
            >
              <ReteEditor ref={reteRef} />
              <SubpatchBar />
              <Minimap reteRef={reteRef} />
              <SignalLegend />
            </CanvasShell>
          </div>
          {/* Hardware / Perform canvases — fresh mount each time; their
              state lives in the store. */}
          {view === 'hardware' ? <HardwareView /> : null}
          {isPerform ? <PerformView /> : null}
        </main>
        {performFullBleed ? (
          <div aria-hidden />
        ) : (
          <ResizeHandle
            orientation="vertical"
            ariaLabel="Resize inspector"
            // Drag right shrinks the inspector; drag left grows it. Negate dx.
            onResize={(dx) => setInspectorW(inspectorW - dx)}
            onReset={() => setInspectorW(DEFAULT_INSPECTOR_W)}
          />
        )}
        <aside
          className="dp-inspector"
          style={performFullBleed ? { border: 'none', overflow: 'hidden' } : undefined}
        >
          {isPatch ? <Inspector /> : isPerform && !performArrange ? null : <HardwareInspector />}
        </aside>
      </div>
      <StatusBar />
    </div>
  )
}
