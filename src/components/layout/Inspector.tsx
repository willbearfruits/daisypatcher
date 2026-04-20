/**
 * Inspector — right rail. Renders parameter controls for the selected node.
 *
 * Controls are derived from NODE_DEFINITIONS[kind].params and wired
 * straight to store.setParam — no local buffering, the store is the
 * source of truth.
 */

import { useEditorStore } from '@/state/store'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { ParamDef } from '@/nodes/definitions'
import type { NodeInstance } from '@/types/graph'
import styles from './Inspector.module.css'

export function Inspector() {
  const selectedId = useEditorStore((s) => s.selectedNodeId)
  const selectionSize = useEditorStore((s) => s.selection.size)
  const node = useEditorStore((s) =>
    s.selectedNodeId ? s.graph.nodes.find((n) => n.id === s.selectedNodeId) ?? null : null
  )

  if (selectionSize > 1) {
    // Multi-select: showing per-param editors for a heterogeneous set is
    // its own design problem — skip for now and surface the count.
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

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>{def.label}</span>
        <span className={styles.headerId}>{node.id}</span>
      </div>
      <div className={styles.body}>
        {def.params.length === 0 ? (
          <span className={styles.emptyHint}>no parameters</span>
        ) : (
          def.params.map((p) => <ParamControl key={p.id} node={node} param={p} />)
        )}
      </div>
    </div>
  )
}

function ParamControl({ node, param }: { node: NodeInstance; param: ParamDef }) {
  const setParam = useEditorStore((s) => s.setParam)
  const raw = node.params[param.id] ?? param.default

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

function formatNumber(v: number, step: number): string {
  // pick decimals from step (e.g. 0.01 -> 2, 1 -> 0)
  if (step >= 1) return Math.round(v).toString()
  const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))))
  return v.toFixed(decimals)
}
