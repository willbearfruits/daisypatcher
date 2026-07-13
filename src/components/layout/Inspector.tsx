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

import { useState } from 'react'
import { useEditorStore, hardwareKindForNodeKind } from '@/state/store'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { ParamDef } from '@/nodes/definitions'
import type { NodeInstance, NodeKind } from '@/types/graph'
import { KIND_ROLES } from '@/types/hardware'
import type { BoardPin } from '@/types/hardware'
import { getBoardPinout } from '@/hardware/boardPinout'
import { hasTestTemplate, disabledReasonFor } from '@/state/testRig'
import { useVerificationStore, verificationKey } from '@/state/verificationStore'
import { TestRigModal } from './TestRigModal'
import styles from './Inspector.module.css'

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

  const [testKind, setTestKind] = useState<NodeKind | null>(null)

  if (selectionSize > 1) {
    return (
      <div className={styles.root}>
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
          def.params.map((p) => <ParamControl key={p.id} node={node} param={p} />)
        )}
      </div>
      <TestRigModal kind={testKind} onClose={() => setTestKind(null)} />
    </div>
  )
}

function ParamControl({ node, param }: { node: NodeInstance; param: ParamDef }) {
  const setParam = useEditorStore((s) => s.setParam)
  const raw = node.params[param.id] ?? param.default

  // Binding params are declared with a static "(unbound)" stub option; the
  // real choices only exist at runtime (the hardware layout). Render them
  // live — including per-role pin selectors — instead of the dead stub,
  // which used to display "(unbound)" even for a correctly auto-linked node.
  if (param.id === 'bindingId') {
    return <BindingControl node={node} param={param} />
  }

  if (param.kind === 'number') {
    const value = typeof raw === 'number' ? raw : Number(raw)
    const min = param.min ?? 0
    const max = param.max ?? 1
    const step = param.step ?? 0.01
    return (
      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel}>{param.label}</span>
          <span className={styles.fieldValue}>
            {formatNumber(value, step)}
            {param.unit ? <span className={styles.fieldUnit}>{' '}{param.unit}</span> : null}
          </span>
        </div>
        <input
          className={styles.slider}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setParam(node.id, param.id, Number(e.target.value))}
          // Coalesce a slider drag into one undo step. We open the
          // transaction on pointer-down and close it on pointer-up /
          // blur — intermediate `setParam` calls apply in-place.
          onPointerDown={() => useEditorStore.getState().beginTransaction()}
          onPointerUp={() => useEditorStore.getState().endTransaction()}
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

  const hwKind = hardwareKindForNodeKind(node.kind)
  const value = String(node.params[param.id] ?? '')
  const compatible = hwKind ? components.filter((c) => c.kind === hwKind) : []
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
