/**
 * Inspector — right rail. Renders parameter controls for the selected node.
 *
 * Controls are derived from NODE_DEFINITIONS[kind].params and wired
 * straight to store.setParam — no local buffering, the store is the
 * source of truth.
 *
 * Also owns the entry point to the per-node Test-Rig modal: a "TEST"
 * button next to the header that generates a one-node verification patch,
 * compiles it, flashes it, and asks the user to vote pass/fail. Disabled
 * for kinds that have no test template (UI-only, hardware-bound).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore, hardwareKindsForNodeKind } from '@/state/store'
import { SamplePicker } from './SamplePicker'
import { InputDevicePicker } from './InputDevicePicker'
import { PresetBar } from './PresetBar'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { ParamDef } from '@/nodes/definitions'
import type { NodeInstance, NodeKind } from '@/types/graph'
import { KIND_ROLES } from '@/types/hardware'
import type { BoardPin } from '@/types/hardware'
import { getBoardPinout } from '@/hardware/boardPinout'
import { hasTestTemplate, disabledReasonFor } from '@/state/testRig'
import { useVerificationStore, verificationKey } from '@/state/verificationStore'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import { TestRigModal } from './TestRigModal'
import styles from './Inspector.module.css'

/**
 * Replace-semantics CV sockets are named `cv_<paramId>` by convention, but a
 * handful predate strict naming and use a shorthand that doesn't equal the
 * param id. This maps those shorthands to the param they replace (verified
 * against the worklets/emitters: e.g. filter `cv_cutoff` clamps into
 * `frequency`, karplus `cv_decay` clamps into `feedback`). An exact
 * `cv_<paramId>` match always wins — the alias is only consulted when the
 * stripped socket name is not itself a param id on the node.
 */
const CV_SOCKET_ALIASES: Record<string, string> = {
  cutoff: 'frequency', // filter_svf / filter_moog
  rate: 'frequency', // lfo (param id is `frequency`, labeled Rate)
  pitch: 'frequency', // oscillator / karplus
  res: 'resonance', // filters
  damp: 'damping', // karplus
  decay: 'feedback', // karplus (string decay = loop feedback)
  dens: 'density', // dust
  amp: 'amplitude', // fm_op
  level1: 'gain1', // mixer4
  level2: 'gain2',
  level3: 'gain3',
  level4: 'gain4'
}

/** Slider position ∈ [0,1] for fine (shift) drags: full track = ¼ range. */
const FINE_DRAG_SENSITIVITY = 0.25

export function Inspector() {
  const selectedId = useEditorStore((s) => s.selectedNodeId)
  const selectionSize = useEditorStore((s) => s.selection.size)
  const node = useEditorStore((s) =>
    s.selectedNodeId ? s.graph.nodes.find((n) => n.id === s.selectedNodeId) ?? null : null
  )
  const target = useEditorStore((s) => s.target)
  const entry = useVerificationStore((s) =>
    node ? s.table[verificationKey(node.kind, target)] ?? null : null
  )
  // Stable store field — deriving happens in useMemo below, never in the
  // selector (a fresh Map per snapshot would loop useSyncExternalStore).
  const connections = useEditorStore((s) => s.graph.connections)

  const [testKind, setTestKind] = useState<NodeKind | null>(null)

  // paramId → source nodeId for every connected replace-semantics CV input
  // on the selected node. Drives the "CV" override state on param rows.
  const cvSources = useMemo(() => {
    const map = new Map<string, string>()
    if (!node) return map
    const paramIds = new Set(NODE_DEFINITIONS[node.kind].params.map((p) => p.id))
    for (const c of connections) {
      if (c.to.nodeId !== node.id || !c.to.socketId.startsWith('cv_')) continue
      const stripped = c.to.socketId.slice(3)
      const paramId = paramIds.has(stripped) ? stripped : CV_SOCKET_ALIASES[stripped]
      if (paramId && paramIds.has(paramId)) map.set(paramId, c.from.nodeId)
    }
    return map
  }, [connections, node])

  if (selectionSize > 1) {
    return (
      <div className={styles.root}>
        <PresetBar />
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>{selectionSize} nodes selected</span>
          <span className={styles.emptyHint}>(params hidden in multi-select)</span>
        </div>
      </div>
    )
  }

  if (!selectedId || !node) {
    return (
      <div className={styles.root}>
        <PresetBar />
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>no selection</span>
          <span className={styles.emptyHint}>(select a node)</span>
        </div>
      </div>
    )
  }

  const def = NODE_DEFINITIONS[node.kind]
  const testable = hasTestTemplate(node.kind)
  const testTooltip = testable
    ? `Run the hardware test rig for ${def.label}`
    : disabledReasonFor(node.kind)

  const statusDotClass =
    entry?.result === 'pass'
      ? styles.testStatusPass
      : entry?.result === 'fail'
        ? styles.testStatusFail
        : styles.testStatusUnknown

  return (
    <div className={styles.root}>
      <PresetBar />
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <span className={styles.headerLabel}>{def.label}</span>
          <button
            type="button"
            className={styles.testBtn}
            onClick={() => setTestKind(node.kind)}
            disabled={!testable}
            aria-label={testTooltip}
            title={testTooltip}
          >
            <span className={`${styles.testStatusDot} ${statusDotClass}`} aria-hidden />
            <span>Test</span>
          </button>
        </div>
        <span className={styles.headerId}>{node.id}</span>
      </div>
      <div className={styles.body}>
        {def.params.length === 0 ? (
          <span className={styles.emptyHint}>no parameters</span>
        ) : (
          def.params.map((p) => (
            <ParamControl
              key={p.id}
              node={node}
              param={p}
              cvSource={cvSources.get(p.id) ?? null}
            />
          ))
        )}
      </div>
      <TestRigModal kind={testKind} onClose={() => setTestKind(null)} />
    </div>
  )
}

function ParamControl({
  node,
  param,
  cvSource
}: {
  node: NodeInstance
  param: ParamDef
  cvSource: string | null
}) {
  const setParam = useEditorStore((s) => s.setParam)
  const raw = node.params[param.id] ?? param.default

  // Binding params are declared with a static "(unbound)" stub option; the
  // real choices only exist at runtime (the hardware layout). Render them
  // live — including per-role pin selectors — instead of the dead stub,
  // which used to display "(unbound)" even for a correctly auto-linked node.
  if (param.id === 'bindingId') {
    return <BindingControl node={node} param={param} />
  }

  // Same escape hatch, same reason: the sample library is runtime state, so
  // the declared enum carries one placeholder option and the real picker
  // lives in its own component.
  if (param.id === 'sampleId') {
    return <SamplePicker node={node} />
  }

  // Third one: the capture device for `audio_in` is whatever the OS has
  // plugged in right now.
  if (node.kind === 'audio_in' && param.id === 'device') {
    return <InputDevicePicker node={node} />
  }

  if (param.kind === 'number') {
    return <NumberParam node={node} param={param} cvSource={cvSource} drivenTag="CV" />
  }

  // enum
  const value = String(raw)
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{param.label}</span>
      </div>
      <select
        className={styles.select}
        value={value}
        onChange={(e) => setParam(node.id, param.id, e.target.value)}
        aria-label={param.label}
      >
        {(param.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Number param row: slider + editable value readout.
 *
 * - `taper: 'log'` params run the slider in position space t ∈ [0,1] with
 *   value = min·(max/min)^t (guarded: falls back to linear when min ≤ 0).
 *   Pure position mapping — the stored value is untouched.
 * - Click the readout → inline exact-value entry ("1.2k" → 1200; Enter/blur
 *   commits clamped to min/max, Esc cancels).
 * - Double-click the slider → reset to default. Shift-drag → fine (¼).
 * - When a replace-semantics CV connection drives this param (`cvSource`),
 *   the row renders the driven state: tint, tag pill, disabled slider, and
 *   a live readout tapped from the CV source node.
 */
function NumberParam({
  node,
  param,
  cvSource,
  drivenTag
}: {
  node: NodeInstance
  param: ParamDef
  cvSource: string | null
  drivenTag: string
}) {
  const setParam = useEditorStore((s) => s.setParam)
  const engine = useAudioEngine()
  const raw = node.params[param.id] ?? param.default
  const value = typeof raw === 'number' ? raw : Number(raw)
  const min = param.min ?? 0
  const max = param.max ?? 1
  const step = param.step ?? 0.01
  const driven = cvSource !== null

  const isLog = param.taper === 'log' && min > 0 && max > min
  const toT = (v: number) =>
    isLog
      ? clamp01(Math.log(clamp(v, min, max) / min) / Math.log(max / min))
      : clamp01((v - min) / (max - min))
  const fromT = (t: number) =>
    isLog ? min * Math.pow(max / min, clamp01(t)) : min + clamp01(t) * (max - min)

  const commit = (v: number) => setParam(node.id, param.id, snapToStep(v, step, min, max))

  // ---- inline value entry ----
  const [draft, setDraft] = useState<string | null>(null)
  const commitDraft = () => {
    if (draft === null) return
    const parsed = parseValueEntry(draft)
    if (parsed !== null) {
      // Exact-entry contract: clamp to range but do NOT snap to step.
      setParam(node.id, param.id, clamp(parsed, min, max))
    }
    setDraft(null)
  }

  // ---- shift-drag fine adjust (¼ sensitivity, position space) ----
  const fineDrag = useRef<{ pointerId: number; startX: number; startT: number; width: number } | null>(null)

  // ---- live CV readout: tap the source node driving this param ----
  const [liveValue, setLiveValue] = useState<number | null>(null)
  useEffect(() => {
    if (!cvSource || !engine) {
      setLiveValue(null)
      return
    }
    const tap = engine.tap(cvSource, (f) => {
      const s = f.timeDomain[f.timeDomain.length - 1] ?? 0
      // Replace-semantics convention: incoming CV is clamped to the param range.
      const v = clamp(s, min, max)
      // Only re-render when the *displayed* value actually changes.
      setLiveValue((prev) =>
        prev !== null && formatNumber(prev, step) === formatNumber(v, step) ? prev : v
      )
    })
    return () => {
      tap.stop()
      setLiveValue(null)
    }
  }, [cvSource, engine, min, max, step])

  const shown = driven && liveValue !== null ? liveValue : value

  return (
    <div className={`${styles.field} ${driven ? styles.paramDriven : ''}`}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabelGroup}>
          <span className={styles.fieldLabel}>{param.label}</span>
          {driven ? <span className={styles.drivenTag}>{drivenTag}</span> : null}
        </span>
        {draft !== null ? (
          <input
            className={styles.valueInput}
            type="text"
            value={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft()
              else if (e.key === 'Escape') setDraft(null)
            }}
            onBlur={commitDraft}
            aria-label={`${param.label} value`}
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            className={styles.fieldValue}
            onClick={() => setDraft(formatNumber(value, step))}
            disabled={driven}
            title={driven ? `Driven by ${drivenTag}` : 'Click to type an exact value'}
          >
            {formatNumber(shown, step)}
            {param.unit ? <span className={styles.fieldUnit}>{' '}{param.unit}</span> : null}
          </button>
        )}
      </div>
      <input
        className={styles.slider}
        type="range"
        min={isLog ? 0 : min}
        max={isLog ? 1 : max}
        step={isLog ? 0.001 : step}
        value={isLog ? toT(value) : value}
        disabled={driven}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (isLog) commit(fromT(n))
          else setParam(node.id, param.id, n)
        }}
        onDoubleClick={() => {
          const dv = typeof param.default === 'number' ? param.default : Number(param.default)
          if (Number.isFinite(dv)) setParam(node.id, param.id, clamp(dv, min, max))
        }}
        // Coalesce a slider drag into one undo step. We open the
        // transaction on pointer-down and close it on pointer-up /
        // blur — intermediate `setParam` calls apply in-place.
        onPointerDown={(e) => {
          useEditorStore.getState().beginTransaction()
          if (e.shiftKey) {
            // Fine drag: suppress the native jump-to-click and drive the
            // value ourselves from pointer deltas at reduced sensitivity.
            const el = e.currentTarget
            fineDrag.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startT: toT(value),
              width: Math.max(1, el.getBoundingClientRect().width)
            }
            el.setPointerCapture(e.pointerId)
            e.preventDefault()
          }
        }}
        onPointerMove={(e) => {
          const d = fineDrag.current
          if (!d || e.pointerId !== d.pointerId) return
          const dt = ((e.clientX - d.startX) / d.width) * FINE_DRAG_SENSITIVITY
          commit(fromT(d.startT + dt))
        }}
        onPointerUp={() => {
          fineDrag.current = null
          useEditorStore.getState().endTransaction()
        }}
        onLostPointerCapture={() => {
          fineDrag.current = null
        }}
        onBlur={() => {
          // Guard against a dangling transaction if pointer-up never
          // fired (keyboard input, stolen capture, etc.). Safe no-op
          // when no transaction is open.
          useEditorStore.getState().endTransaction()
        }}
        aria-label={param.label}
      />
    </div>
  )
}

/**
 * Live binding editor for hardware-bound nodes (`button`, `led`, `knob_in`,
 * `oled`, …). Top select re-points the node at any compatible placed
 * component; below it, one pin selector per role of the bound component
 * writes straight through `setHardwarePin` — same store action the
 * hardware view uses, so both editors stay in sync.
 */
function BindingControl({ node, param }: { node: NodeInstance; param: ParamDef }) {
  const setParam = useEditorStore((s) => s.setParam)
  const setHardwarePin = useEditorStore((s) => s.setHardwarePin)
  const components = useEditorStore((s) => s.hardware.components)
  const board = useEditorStore((s) => s.hardware.board)

  const value = String(node.params[param.id] ?? '')
  // Every kind this node can read, not just its canonical one — a knob_in
  // binds equally to a pot, fader, ribbon, LDR, mic, piezo or CV jack.
  const compatibleKinds = hardwareKindsForNodeKind(node.kind)
  const compatible = components.filter((c) => compatibleKinds.includes(c.kind))
  const bound = compatible.find((c) => c.id === value) ?? null
  const pinout = getBoardPinout(board)

  return (
    <>
      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel}>{param.label}</span>
        </div>
        <select
          className={styles.select}
          value={bound ? value : ''}
          onChange={(e) => setParam(node.id, param.id, e.target.value)}
          aria-label={param.label}
        >
          <option value="">(unbound)</option>
          {compatible.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {bound &&
        KIND_ROLES[bound.kind].map((role) => {
          const candidates = pinout.pinsForRole(role, bound.kind)
          const current = (bound.pins[role] as string | undefined) ?? ''
          const single = KIND_ROLES[bound.kind].length === 1
          return (
            <div className={styles.field} key={role}>
              <div className={styles.fieldHead}>
                <span className={styles.fieldLabel}>
                  {single ? 'Pin' : `Pin · ${role}`}
                </span>
              </div>
              <select
                className={styles.select}
                value={current}
                onChange={(e) =>
                  setHardwarePin(
                    bound.id,
                    role,
                    e.target.value === '' ? null : (e.target.value as BoardPin)
                  )
                }
                aria-label={`${bound.label} ${role} pin`}
              >
                <option value="">(none)</option>
                {candidates.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
    </>
  )
}

function formatNumber(v: number, step: number): string {
  // pick decimals from step (e.g. 0.01 -> 2, 1 -> 0)
  if (step >= 1) return Math.round(v).toString()
  const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))))
  return v.toFixed(decimals)
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Quantize a slider-produced value onto the param's step grid, clean up
 * float noise (0.020999999… → 0.021), and clamp into range. Only used for
 * slider/drag paths — typed entry commits the exact value.
 */
function snapToStep(v: number, step: number, min: number, max: number): number {
  const snapped = Math.round(v / step) * step
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(step))))
  return clamp(Number(snapped.toFixed(decimals)), min, max)
}

/**
 * Parse inline value entry. Accepts plain numbers plus a `k` multiplier
 * ("1.2k" → 1200); a trailing unit ("440 Hz", "250ms") is tolerated and
 * ignored. Returns null when the text isn't a number.
 */
function parseValueEntry(raw: string): number | null {
  const m = raw.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([kK])?\s*[a-zA-Z%]*$/)
  if (!m) return null
  const v = Number(m[1])
  if (!Number.isFinite(v)) return null
  return m[2] ? v * 1000 : v
}
