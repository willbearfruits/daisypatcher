/**
 * TestRigModal — one-click "build a tiny patch around this node kind,
 * flash it, listen, vote pass/fail". Opened from the Inspector's Test
 * button OR the VerificationPanel's re-test button.
 *
 * State machine:
 *   idle → compiling → compiled → flashing → flashed → (done)
 *   Any stage can transition to idle by closing the modal.
 *
 * The modal doesn't own its own graph store — it holds a `TestGraph`
 * locally and calls `useCompileStore.buildTestPatch(graph, hardware,
 * target)` to route through the same pipeline as the main Compile button.
 * Flash re-uses the normal flash() action because once a build succeeds
 * the binary path is written into the compile store and that's all
 * flash() needs.
 */

import { useEffect, useMemo, useState } from 'react'
import type { NodeKind } from '@/types/graph'
import { useCompileStore } from '@/state/compileState'
import { useSerialStore, DEFAULT_BAUD } from '@/state/serialState'
import { useEditorStore } from '@/state/store'
import { useVerificationStore, type VerificationResult } from '@/state/verificationStore'
import { buildTestGraph, type TestGraph } from '@/state/testRig'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import styles from './TestRigModal.module.css'

interface TestRigModalProps {
  kind: NodeKind | null
  onClose: () => void
}

function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconCompile() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="4" y="7" width="8" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M2.5 9.5H4M2.5 11.5H4M12 9.5h1.5M12 11.5h1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 1.5v4.5M6 4l2 2 2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconFlash() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M9 1.5L3 9h4l-1 5.5L13 7H9l1-5.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function IconSerial() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="8" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="7" r="0.8" fill="currentColor" />
      <circle cx="8" cy="7" r="0.8" fill="currentColor" />
      <circle cx="11" cy="7" r="0.8" fill="currentColor" />
      <path d="M5 13h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function timeAgo(ms: number | null): string {
  if (ms === null) return 'never'
  const delta = Date.now() - ms
  if (delta < 0) return 'just now'
  const min = Math.floor(delta / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

export function TestRigModal({ kind, onClose }: TestRigModalProps) {
  const target = useEditorStore((s) => s.target)
  const building = useCompileStore((s) => s.building)
  const flashing = useCompileStore((s) => s.flashing)
  const lastBuildSuccess = useCompileStore((s) => s.lastBuildSuccess)
  const lastFlashSuccess = useCompileStore((s) => s.lastFlashSuccess)
  const deviceAvailable = useCompileStore((s) => s.deviceAvailable)
  const buildTestPatch = useCompileStore((s) => s.buildTestPatch)
  const flash = useCompileStore((s) => s.flash)
  const logPanelOpen = useCompileStore((s) => s.logPanelOpen)
  const openLogPanel = useCompileStore((s) => s.openLogPanel)

  const openMonitor = useSerialStore((s) => s.openMonitor)
  const connectSerial = useSerialStore((s) => s.connect)
  const serialPorts = useSerialStore((s) => s.ports)

  const setResult = useVerificationStore((s) => s.setResult)
  const entry = useVerificationStore((s) =>
    kind ? s.table[`${kind}:${target}`] ?? null : null
  )

  // Build a fresh test graph whenever the kind changes. Captured once so
  // subsequent compiles re-use the exact same patch layout.
  const testGraph: TestGraph | null = useMemo(() => {
    if (!kind) return null
    return buildTestGraph(kind)
  }, [kind])

  // Track whether THIS modal session has triggered a build/flash — the
  // compile store is global so its `lastBuildSuccess` may reflect a
  // prior main-button invocation. We gate the Flash button on a local
  // "built during this session" flag.
  const [sessionBuilt, setSessionBuilt] = useState(false)
  const [sessionFlashed, setSessionFlashed] = useState(false)
  const [showFailNotes, setShowFailNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')

  // Reset session flags when the target kind changes (reopens the modal).
  useEffect(() => {
    setSessionBuilt(false)
    setSessionFlashed(false)
    setShowFailNotes(false)
    setNotesDraft('')
  }, [kind])

  // Esc closes. Disabled while a build/flash is active to prevent
  // orphaning the pipeline halfway.
  useEffect(() => {
    if (!kind) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !building && !flashing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [kind, onClose, building, flashing])

  if (!kind) return null
  const def = NODE_DEFINITIONS[kind]

  const canCompile = !!testGraph && !building && !flashing
  const canFlash =
    sessionBuilt && !building && !flashing && deviceAvailable && lastBuildSuccess === true

  const onCompile = async (): Promise<void> => {
    if (!testGraph) return
    if (!logPanelOpen) openLogPanel()
    await buildTestPatch(testGraph.graph, testGraph.hardware, target)
    // Pull the current store state after the call — lastBuildSuccess is
    // flipped before `building` goes false, so this reads cleanly here.
    if (useCompileStore.getState().lastBuildSuccess === true) {
      setSessionBuilt(true)
    }
  }

  const onFlash = async (): Promise<void> => {
    await flash()
    if (useCompileStore.getState().lastFlashSuccess === true) {
      setSessionFlashed(true)
      // Auto-open the serial monitor and try to connect to the first
      // available port at 115200 — matches libDaisy's StartLog default.
      openMonitor()
      const path = serialPorts[0]?.path
      if (path) {
        // Swallow errors; the monitor UI surfaces them.
        void connectSerial(path, DEFAULT_BAUD)
      }
    }
  }

  const recordResult = (result: VerificationResult, notes?: string): void => {
    setResult(kind, target, result, notes)
    onClose()
  }

  const onPass = (): void => recordResult('pass')
  const onSkip = (): void => onClose()
  const onFail = (): void => {
    if (!showFailNotes) {
      setShowFailNotes(true)
      return
    }
    recordResult('fail', notesDraft.trim())
  }

  const stimulusLabel = testGraph ? testGraph.stimulus : 'none'

  const prevStatusText = (() => {
    if (!entry) return 'Not yet tested on this target.'
    const ago = timeAgo(entry.lastTestedMs)
    const label =
      entry.result === 'pass' ? 'PASS' : entry.result === 'fail' ? 'FAIL' : 'unknown'
    return `Last tested ${ago} · ${label}${entry.notes ? ` — ${entry.notes}` : ''}`
  })()

  const statusLine = (() => {
    if (building) return 'compiling…'
    if (flashing) return 'flashing…'
    if (sessionFlashed && lastFlashSuccess) return 'flashed — listen and vote.'
    if (sessionBuilt && lastBuildSuccess) return 'compiled — ready to flash.'
    if (lastBuildSuccess === false && sessionBuilt) return 'compile failed — check build log.'
    if (lastFlashSuccess === false && sessionFlashed) return 'flash failed — check build log.'
    return testGraph
      ? 'ready — press Compile.'
      : 'no test template for this node kind.'
  })()

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={`Test ${def.label}`}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.title}>
            <span className={styles.titleKicker}>TEST</span>
            <span className={styles.titleLabel}>{def.label}</span>
            <span className={styles.titleKind}>{kind}</span>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            disabled={building || flashing}
            aria-label="Close"
            title="Close"
          >
            <IconClose />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.prevStatus}>{prevStatusText}</div>

          <div className={styles.description}>
            {testGraph ? testGraph.description : 'No test template exists for this node. Build a patch by hand and verify.'}
            {testGraph ? (
              <span className={styles.stimulusTag}>stimulus: {stimulusLabel}</span>
            ) : null}
          </div>

          <div className={styles.statusLine}>{statusLine}</div>

          <div className={styles.stepRow}>
            <button
              type="button"
              className={`${styles.stepBtn} ${styles.stepCompile}`}
              onClick={() => void onCompile()}
              disabled={!canCompile}
              title={canCompile ? 'Generate and compile the test patch' : 'Cannot compile'}
            >
              <IconCompile />
              <span>{building ? 'Compiling…' : 'Compile'}</span>
            </button>
            <button
              type="button"
              className={`${styles.stepBtn} ${styles.stepFlash}`}
              onClick={() => void onFlash()}
              disabled={!canFlash}
              title={
                !sessionBuilt
                  ? 'Compile first'
                  : !deviceAvailable
                    ? 'No device detected'
                    : 'Flash the binary to hardware'
              }
            >
              <IconFlash />
              <span>{flashing ? 'Flashing…' : 'Flash'}</span>
            </button>
            <button
              type="button"
              className={styles.stepBtn}
              onClick={() => {
                openMonitor()
                const path = serialPorts[0]?.path
                if (path) void connectSerial(path, DEFAULT_BAUD)
              }}
              disabled={serialPorts.length === 0}
              title={serialPorts.length === 0 ? 'No serial ports available' : 'Open the serial monitor'}
            >
              <IconSerial />
              <span>Serial Monitor</span>
            </button>
          </div>

          {showFailNotes ? (
            <div className={styles.notesRow}>
              <label className={styles.notesLabel} htmlFor="dp-testrig-notes">
                Why did it fail?
              </label>
              <input
                id="dp-testrig-notes"
                className={styles.notesInput}
                type="text"
                autoFocus
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder="one-line note…"
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={`${styles.voteBtn} ${styles.votePass}`}
            onClick={onPass}
            disabled={building || flashing}
            title="Record PASS and close"
          >
            Pass
          </button>
          <button
            type="button"
            className={`${styles.voteBtn} ${styles.voteFail}`}
            onClick={onFail}
            disabled={building || flashing}
            title={showFailNotes ? 'Save note and close' : 'Record FAIL (with one-line note)'}
          >
            {showFailNotes ? 'Save Fail' : 'Fail'}
          </button>
          <button
            type="button"
            className={styles.voteBtn}
            onClick={onSkip}
            disabled={building || flashing}
            title="Close without recording"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
