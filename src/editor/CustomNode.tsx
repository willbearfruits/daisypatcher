/**
 * Custom Rete node renderer. Styled to the Signal Lab aesthetic using only
 * `--dp-*` CSS variables — never hardcode a color here.
 *
 * Sockets themselves are drawn by `CustomSocket` (registered via the react
 * preset's `customize.socket` hook). This file only lays out the socket
 * row structure — no coloured wrapper around `RefSocket`; `RefSocket` passes
 * straight through to `CustomSocket`.
 *
 * Collapsing: the store tracks a per-node `collapsed` flag. When true, the
 * body rows hide and the sockets re-attach to the header strip so cables
 * (which read socket DOM rects via `getBoundingClientRect()`) keep rendering
 * to valid endpoints. A chevron button in the header toggles the flag;
 * double-clicking the header background does the same.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme, RenderEmit } from 'rete-react-plugin'
import { DaisyNode } from './nodes/base'
import type { SignalSocket } from './sockets'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { useEditorStore } from '@/state/store'
import styles from './CustomNode.module.css'

const { RefSocket } = Presets.classic

type Props<S extends ClassicScheme> = {
  data: S['Node']
  emit: RenderEmit<S>
}

type Category = 'source' | 'process' | 'io' | 'hardware'

function accentClassFor(cat: Category): string {
  switch (cat) {
    case 'source':
      return styles['accent-source']
    case 'process':
      return styles['accent-process']
    case 'io':
      return styles['accent-io']
    case 'hardware':
      return styles['accent-hardware']
  }
}

/**
 * Chevron: rotates 0° when expanded (pointing down), -90° when collapsed
 * (pointing right). Pure inline SVG so the icon picks up `currentColor`
 * from the header's text color — no per-theme tuning required.
 */
export function CollapseChevron({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  return (
    <svg
      className={styles.chevron}
      width={12}
      height={12}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
    >
      <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Shared chevron button. The click handler stops propagation so Rete's
 * nodepicked pipeline doesn't treat the toggle as a drag attempt.
 */
export function CollapseButton({
  nodeId,
  collapsed
}: {
  nodeId: string
  collapsed: boolean
}): React.JSX.Element {
  const onClick = React.useCallback(
    (ev: React.MouseEvent<HTMLButtonElement>) => {
      ev.stopPropagation()
      ev.preventDefault()
      useEditorStore.getState().toggleCollapsed(nodeId)
    },
    [nodeId]
  )
  const onPointerDown = React.useCallback(
    (ev: React.PointerEvent<HTMLButtonElement>) => {
      // Stop Rete from starting a drag on the chevron.
      ev.stopPropagation()
    },
    []
  )
  return (
    <button
      type="button"
      className={styles.collapseBtn}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label={collapsed ? 'Expand node' : 'Collapse node'}
      title={collapsed ? 'Expand' : 'Collapse'}
    >
      <CollapseChevron collapsed={collapsed} />
    </button>
  )
}

/**
 * Double-clicking the header toggles collapse. The handler ignores clicks
 * that bubbled up from the chevron button (which already handled them).
 */
export function useHeaderDoubleClick(nodeId: string): (ev: React.MouseEvent) => void {
  return React.useCallback(
    (ev: React.MouseEvent) => {
      // Ignore double-clicks that originated inside an interactive element.
      const target = ev.target as HTMLElement | null
      if (target && target.closest('button, input, select, textarea')) return
      ev.stopPropagation()
      useEditorStore.getState().toggleCollapsed(nodeId)
    },
    [nodeId]
  )
}

export function CustomNode<S extends ClassicScheme>(props: Props<S>): React.JSX.Element {
  const { data, emit } = props
  const selected = data.selected ?? false

  const isDaisy = data instanceof DaisyNode
  const def = isDaisy ? NODE_DEFINITIONS[data.kind] : undefined

  // Subscribe to the node's `collapsed` flag from the store. Keeping the
  // flag in the graph (not in React state) means sync-from-store events
  // (undo/redo, load from file, Cmd+. broadcast) all drive this renderer.
  const collapsed = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return n?.collapsed === true
  })

  const onHeaderDoubleClick = useHeaderDoubleClick(data.id)

  // Placeholder for unknown/missing definitions so a parallel agent's
  // in-flight NodeKind expansion can't crash the editor.
  if (isDaisy && !def) {
    return (
      <div className={`${styles.node} ${selected ? styles.selected : ''}`} data-testid="node">
        <div className={styles.header}>
          <span className={`${styles.accent} ${styles['accent-process']}`} aria-hidden />
          <span className={styles.headerLabel}>{data.label || data.kind}</span>
        </div>
        <div className={styles.body}>
          <div className={styles.placeholder}>definition missing</div>
        </div>
      </div>
    )
  }

  const category: Category = def?.category ?? 'process'

  const inputs = Object.entries(data.inputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]
  const outputs = Object.entries(data.outputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]

  const activeInputs = inputs.filter((entry): entry is [string, { socket: SignalSocket; label?: string }] => entry[1] !== undefined)
  const activeOutputs = outputs.filter((entry): entry is [string, { socket: SignalSocket; label?: string }] => entry[1] !== undefined)

  return (
    <div
      className={`${styles.node} ${selected ? styles.selected : ''} ${collapsed ? styles.collapsed : ''}`}
      data-testid="node"
    >
      <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
        <span className={`${styles.accent} ${accentClassFor(category)}`} aria-hidden />
        <span className={styles.headerLabel}>{data.label}</span>
        {collapsed ? (
          <span className={styles.headerSummary} aria-hidden>
            {activeInputs.length}&rarr;{activeOutputs.length}
          </span>
        ) : null}
        <CollapseButton nodeId={data.id} collapsed={collapsed} />
        {/*
          Edge-mounted sockets for the collapsed form. They MUST stay in the
          DOM whenever the node is collapsed so the cable renderer's
          getBoundingClientRect() lookups still resolve. When expanded, the
          per-row sockets below are authoritative; we render these only in
          collapsed mode to avoid duplicate socket elements (RefSocket uses
          a singleton registry keyed by nodeId+socketKey).
        */}
        {collapsed ? (
          <div className={styles.headerSocketsLeft} aria-hidden>
            {activeInputs.map(([key, input]) => (
              <div key={`chin-${key}`} className={styles.headerSocketCell}>
                <RefSocket
                  name="input-socket"
                  side="input"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={input.socket}
                />
              </div>
            ))}
          </div>
        ) : null}
        {collapsed ? (
          <div className={styles.headerSocketsRight} aria-hidden>
            {activeOutputs.map(([key, output]) => (
              <div key={`chout-${key}`} className={styles.headerSocketCell}>
                <RefSocket
                  name="output-socket"
                  side="output"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={output.socket}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {collapsed ? null : (
        <div className={styles.body}>
          {activeInputs.map(([key, input]) => (
            <div
              key={`in-${key}`}
              className={`${styles.row} ${styles['row-input']}`}
              data-testid={`input-${key}`}
            >
              <div className={styles.socketCell}>
                <RefSocket
                  name="input-socket"
                  side="input"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={input.socket}
                />
              </div>
              <span className={styles.socketLabel}>{input.label ?? key}</span>
            </div>
          ))}
          {activeOutputs.map(([key, output]) => (
            <div
              key={`out-${key}`}
              className={`${styles.row} ${styles['row-output']}`}
              data-testid={`output-${key}`}
            >
              <span className={styles.socketLabel}>{output.label ?? key}</span>
              <div className={styles.socketCell}>
                <RefSocket
                  name="output-socket"
                  side="output"
                  socketKey={key}
                  nodeId={data.id}
                  emit={emit}
                  payload={output.socket}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
