/**
 * Menu node body — in-node menu designer + live screen preview.
 *
 * Same shape as `OledNode`: the tree lives in the node's `tree` param as
 * JSON, this designer is the only UI that edits it, and the preview shows
 * exactly what the device will show. The screen is built from
 * `buildMenuScreen()` — shared with the firmware emitters — so what you
 * design here is what renders on the hardware, rather than two layouts
 * that drift.
 *
 * Three stacked sections:
 *   - PREVIEW  the screen, plus drive buttons so a menu can be navigated
 *              and tested before any encoder is wired.
 *   - TREE     the entries at the level being edited, with add / remove /
 *              reorder and a breadcrumb to descend.
 *   - DETAIL   the selected entry: label, range, target param, CV slot.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme, RenderEmit } from 'rete-react-plugin'

import { DaisyNode } from './nodes/base'
import type { SignalSocket } from './sockets'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { useEditorStore } from '@/state/store'
import { driveMenu, menuStateFor } from '@/state/menuRuntime'
import {
  clampTo,
  entriesAt,
  parseMenuTree,
  serializeMenuTree,
  type MenuAction,
  type MenuNode as MenuTreeNode,
  type MenuOutSlot,
  type MenuTree,
  type MenuValue
} from './menu/tree'
import { buildMenuScreen, MENU_VISIBLE_ROWS } from './menu/render'
import { CollapseButton, useHeaderDoubleClick } from './CustomNode'
import styles from './MenuNode.module.css'

const { RefSocket } = Presets.classic

type Props<S extends ClassicScheme> = {
  data: S['Node']
  emit: RenderEmit<S>
}

const ACTIONS: { value: MenuAction; label: string }[] = [
  { value: 'back', label: 'Back' },
  { value: 'home', label: 'Home' },
  { value: 'reset', label: 'Reset value' },
  { value: 'toggle', label: 'Toggle value' },
  { value: 'none', label: '(nothing)' }
]

const OUT_SLOTS: { value: MenuOutSlot; label: string }[] = [
  { value: 'none', label: '—' },
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
  { value: 'd', label: 'D' }
]

/*
 * Separators for the flattened target list. The Zustand selector must
 * return a primitive (building an array inside it re-renders forever — see
 * CLAUDE.md), so the options are packed into one string. ASCII unit/record
 * separators cannot appear in a node id or a param label.
 */
const UNIT_SEP = '\u001f'
const REC_SEP = '\u001e'

/**
 * Swallow pointerdown inside interactive chrome.
 *
 * Rete's area plugin binds node dragging to pointerdown on the node
 * element, so without this every button/select/input in the body starts a
 * drag instead of receiving the click — the control looks completely dead.
 * `OledNode` does the same on each of its interactive regions.
 */
const stopDrag = (e: React.PointerEvent): void => e.stopPropagation()

let uid = 0
function newId(prefix: string): string {
  uid += 1
  return `${prefix}${Date.now().toString(36)}${uid.toString(36)}`
}

/** Replace the entry list at `path`, returning a new tree. */
function withEntriesAt(tree: MenuTree, path: number[], next: MenuTreeNode[]): MenuTree {
  if (path.length === 0) return { ...tree, root: next }
  const [head, ...rest] = path
  const root = tree.root.map((n, i) => {
    if (i !== head || n.kind !== 'submenu') return n
    const sub = withEntriesAt({ ...tree, root: n.children }, rest, next)
    return { ...n, children: sub.root }
  })
  return { ...tree, root }
}

export function MenuNode<S extends ClassicScheme>(props: Props<S>): React.JSX.Element {
  const { data, emit } = props
  const selected = data.selected ?? false
  const isDaisy = data instanceof DaisyNode
  const kind = isDaisy ? data.kind : undefined
  const def = kind ? NODE_DEFINITIONS[kind] : undefined

  const inputs = Object.entries(data.inputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]
  const outputs = Object.entries(data.outputs) as [
    string,
    { socket: SignalSocket; label?: string } | undefined
  ][]

  const collapsed = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return n?.collapsed === true
  })
  const onHeaderDoubleClick = useHeaderDoubleClick(data.id)

  // Subscribe to the tree param alone so unrelated graph edits don't
  // re-render the designer.
  const treeJson = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    const raw = n?.params.tree
    return typeof raw === 'string' ? raw : ''
  })
  const tree = React.useMemo(() => parseMenuTree(treeJson), [treeJson])

  const setParam = useEditorStore((s) => s.setParam)
  const commit = React.useCallback(
    (next: MenuTree) => setParam(data.id, 'tree', serializeMenuTree(next)),
    [data.id, setParam]
  )

  /* ---- editing cursor (design-time, separate from the runtime cursor) ---- */
  const [editPath, setEditPath] = React.useState<number[]>([])
  const [editIndex, setEditIndex] = React.useState(0)

  const levelEntries = React.useMemo(() => entriesAt(tree, editPath), [tree, editPath])
  const selectedEntry: MenuTreeNode | undefined = levelEntries[editIndex]

  /* ---- live preview ---- */
  // The runtime owns navigation state; re-read it each render and nudge a
  // repaint after driving so the preview tracks the machine rather than
  // keeping a second copy that could disagree.
  const [, forceRepaint] = React.useReducer((n: number) => n + 1, 0)
  const runState = menuStateFor(data.id)
  const screen = React.useMemo(
    () => buildMenuScreen(tree, runState, MENU_VISIBLE_ROWS),
    [tree, runState]
  )
  const drive = React.useCallback(
    (g: 'cw' | 'ccw' | 'click' | 'long' | 'double') => {
      driveMenu(data.id, g)
      forceRepaint()
    },
    [data.id]
  )

  /* ---- mutations ---- */
  const replaceLevel = React.useCallback(
    (next: MenuTreeNode[]) => commit(withEntriesAt(tree, editPath, next)),
    [commit, tree, editPath]
  )

  const addSubmenu = (): void => {
    const next = [
      ...levelEntries,
      { id: newId('s'), kind: 'submenu' as const, label: 'Submenu', children: [] }
    ]
    replaceLevel(next)
    setEditIndex(next.length - 1)
  }

  const addValue = (): void => {
    const next: MenuTreeNode[] = [
      ...levelEntries,
      {
        id: newId('v'),
        kind: 'value',
        label: 'Value',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.01,
        value: 0,
        defaultValue: 0,
        out: 'none'
      }
    ]
    replaceLevel(next)
    setEditIndex(next.length - 1)
  }

  const removeEntry = (): void => {
    if (!selectedEntry) return
    const next = levelEntries.filter((_, i) => i !== editIndex)
    replaceLevel(next)
    setEditIndex(Math.max(0, Math.min(editIndex, next.length - 1)))
  }

  const moveEntry = (dir: -1 | 1): void => {
    const to = editIndex + dir
    if (!selectedEntry || to < 0 || to >= levelEntries.length) return
    const next = levelEntries.slice()
    const [it] = next.splice(editIndex, 1)
    next.splice(to, 0, it)
    replaceLevel(next)
    setEditIndex(to)
  }

  const patchEntry = (patch: Partial<MenuTreeNode>): void => {
    if (!selectedEntry) return
    const next = levelEntries.map((n, i) =>
      i === editIndex ? ({ ...n, ...patch } as MenuTreeNode) : n
    )
    replaceLevel(next)
  }

  const patchValue = (patch: Partial<MenuValue>): void => {
    if (!selectedEntry || selectedEntry.kind !== 'value') return
    patchEntry(patch as Partial<MenuTreeNode>)
  }

  /* ---- target picker options ---- */
  // Only numeric and enum params are offered: those are the two shapes the
  // encoder can step through.
  const targetOptions = useEditorStore((s) => {
    const parts: string[] = []
    for (const n of s.graph.nodes) {
      if (n.id === data.id) continue
      const d = NODE_DEFINITIONS[n.kind]
      if (!d) continue
      for (const p of d.params) {
        if (p.kind !== 'number' && p.kind !== 'enum') continue
        if (p.id === 'bindingId' || p.id === 'tree' || p.id === 'elements') continue
        parts.push([n.id, p.id, d.label, p.label].join(UNIT_SEP))
      }
    }
    // Selector must return a primitive — see the Zustand note in CLAUDE.md.
    return parts.join(REC_SEP)
  })
  const targets = React.useMemo(
    () =>
      targetOptions
        .split(REC_SEP)
        .filter(Boolean)
        .map((rec) => {
          const [nodeId, paramId, nodeLabel, paramLabel] = rec.split(UNIT_SEP)
          return { nodeId, paramId, nodeLabel, paramLabel }
        }),
    [targetOptions]
  )

  if (collapsed) {
    return (
      <div
        className={`${styles.node} ${selected ? styles.selected : ''} ${styles.collapsed}`}
        data-testid="node"
      >
        <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
          <CollapseButton nodeId={data.id} collapsed />
          <span className={styles.title}>{def?.label ?? 'Menu'}</span>
        </div>
        <div className={styles.collapsedSockets}>
          {inputs.map(([key, input]) =>
            input ? (
              <div className={styles.collapsedIn} key={key}>
                <RefSocket
                  name="input-socket"
                  side="input"
                  emit={emit}
                  socketKey={key}
                  nodeId={data.id}
                  payload={input.socket}
                />
              </div>
            ) : null
          )}
          {outputs.map(([key, output]) =>
            output ? (
              <div className={styles.collapsedOut} key={key}>
                <RefSocket
                  name="output-socket"
                  side="output"
                  emit={emit}
                  socketKey={key}
                  nodeId={data.id}
                  payload={output.socket}
                />
              </div>
            ) : null
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`${styles.node} ${selected ? styles.selected : ''}`}
      data-testid="node"
    >
      <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
        <CollapseButton nodeId={data.id} collapsed={false} />
        <span className={styles.title}>{def?.label ?? 'Menu'}</span>
      </div>

      <div className={styles.body}>
        {/* ---------- preview ---------- */}
        <div className={styles.screen}>
          <div className={styles.screenTitle}>
            {screen.title}
            {screen.moreAbove ? <span className={styles.more}>▲</span> : null}
            {screen.moreBelow ? <span className={styles.more}>▼</span> : null}
          </div>
          {screen.rows.length === 0 ? (
            <div className={styles.screenEmpty}>(empty — add an entry below)</div>
          ) : (
            screen.rows.map((r, i) => (
              <div
                key={i}
                className={`${styles.screenRow} ${r.selected ? styles.screenRowSel : ''}`}
              >
                <span className={styles.screenCursor}>{r.selected ? '>' : ' '}</span>
                <span className={styles.screenLabel}>{r.label}</span>
                <span className={styles.screenValue}>
                  {r.submenu ? '>' : r.editing ? `[${r.value}]` : r.value}
                </span>
              </div>
            ))
          )}
        </div>

        <div className={styles.driveRow} onPointerDown={stopDrag}>
          <button type="button" className={styles.drive} onClick={() => drive('ccw')} title="Anticlockwise">↺</button>
          <button type="button" className={styles.drive} onClick={() => drive('cw')} title="Clockwise">↻</button>
          <button type="button" className={styles.drive} onClick={() => drive('click')} title="Click">click</button>
          <button type="button" className={styles.drive} onClick={() => drive('long')} title={`Long press → ${tree.longPress}`}>long</button>
          <button type="button" className={styles.drive} onClick={() => drive('double')} title={`Double click → ${tree.doubleClick}`}>×2</button>
        </div>

        {/* ---------- tree ---------- */}
        <div className={styles.crumbs} onPointerDown={stopDrag}>
          <button
            type="button"
            className={styles.crumb}
            onClick={() => {
              setEditPath([])
              setEditIndex(0)
            }}
          >
            root
          </button>
          {editPath.map((idx, depth) => {
            const list = entriesAt(tree, editPath.slice(0, depth))
            const n = list[idx]
            return (
              <button
                key={depth}
                type="button"
                className={styles.crumb}
                onClick={() => {
                  setEditPath(editPath.slice(0, depth + 1))
                  setEditIndex(0)
                }}
              >
                {n?.label ?? '?'}
              </button>
            )
          })}
        </div>

        <div className={styles.list} onPointerDown={stopDrag}>
          {levelEntries.length === 0 ? (
            <div className={styles.listEmpty}>no entries at this level</div>
          ) : (
            levelEntries.map((n, i) => (
              <div
                key={n.id}
                className={`${styles.item} ${i === editIndex ? styles.itemSel : ''}`}
                onClick={() => setEditIndex(i)}
              >
                <span className={styles.itemKind}>{n.kind === 'submenu' ? '▸' : '·'}</span>
                <span className={styles.itemLabel}>{n.label}</span>
                {n.kind === 'submenu' ? (
                  <button
                    type="button"
                    className={styles.itemEnter}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditPath([...editPath, i])
                      setEditIndex(0)
                    }}
                    title="Edit this submenu"
                  >
                    open
                  </button>
                ) : (
                  <span className={styles.itemTarget}>
                    {n.target ? `→ ${n.target.paramId}` : n.out !== 'none' ? `→ ${n.out.toUpperCase()}` : '—'}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        <div className={styles.toolbar} onPointerDown={stopDrag}>
          <button type="button" className={styles.tool} onClick={addSubmenu}>+ submenu</button>
          <button type="button" className={styles.tool} onClick={addValue}>+ value</button>
          <button type="button" className={styles.tool} onClick={() => moveEntry(-1)} disabled={editIndex <= 0}>↑</button>
          <button type="button" className={styles.tool} onClick={() => moveEntry(1)} disabled={editIndex >= levelEntries.length - 1}>↓</button>
          <button type="button" className={styles.toolDanger} onClick={removeEntry} disabled={!selectedEntry}>remove</button>
        </div>

        {/* ---------- detail ---------- */}
        {selectedEntry ? (
          <div className={styles.detail} onPointerDown={stopDrag}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Label</span>
              <input
                className={styles.input}
                value={selectedEntry.label}
                onChange={(e) => patchEntry({ label: e.target.value } as Partial<MenuTreeNode>)}
              />
            </label>

            {selectedEntry.kind === 'value' ? (
              <>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Type</span>
                  <select
                    className={styles.select}
                    value={selectedEntry.type}
                    onChange={(e) => {
                      const type = e.target.value === 'enum' ? 'enum' : 'number'
                      patchValue(
                        type === 'enum'
                          ? { type, options: selectedEntry.options ?? ['A', 'B'], min: 0, max: Math.max(0, (selectedEntry.options?.length ?? 2) - 1), step: 1, value: 0, defaultValue: 0 }
                          : { type, min: 0, max: 1, step: 0.01, value: 0, defaultValue: 0 }
                      )
                    }}
                  >
                    <option value="number">Number</option>
                    <option value="enum">Pick list</option>
                  </select>
                </label>

                {selectedEntry.type === 'enum' ? (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Options</span>
                    <input
                      className={styles.input}
                      value={(selectedEntry.options ?? []).join(', ')}
                      placeholder="Sine, Saw, Square, Tri"
                      onChange={(e) => {
                        const options = e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                        patchValue({
                          options,
                          min: 0,
                          max: Math.max(0, options.length - 1),
                          step: 1,
                          value: clampTo(selectedEntry.value, 0, Math.max(0, options.length - 1))
                        })
                      }}
                    />
                  </label>
                ) : (
                  <div className={styles.row3}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Min</span>
                      <input className={styles.input} type="number" value={selectedEntry.min}
                        onChange={(e) => patchValue({ min: Number(e.target.value) })} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Max</span>
                      <input className={styles.input} type="number" value={selectedEntry.max}
                        onChange={(e) => patchValue({ max: Number(e.target.value) })} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Step</span>
                      <input className={styles.input} type="number" step="0.001" value={selectedEntry.step}
                        onChange={(e) => patchValue({ step: Number(e.target.value) })} />
                    </label>
                  </div>
                )}

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Target param</span>
                  <select
                    className={styles.select}
                    value={selectedEntry.target ? `${selectedEntry.target.nodeId}${UNIT_SEP}${selectedEntry.target.paramId}` : ''}
                    onChange={(e) => {
                      if (!e.target.value) {
                        patchValue({ target: undefined })
                        return
                      }
                      const [nodeId, paramId] = e.target.value.split(UNIT_SEP)
                      patchValue({ target: { nodeId, paramId } })
                    }}
                  >
                    <option value="">(none — use CV out)</option>
                    {targets.map((t) => (
                      <option key={`${t.nodeId}:${t.paramId}`} value={`${t.nodeId}${UNIT_SEP}${t.paramId}`}>
                        {t.nodeLabel} · {t.paramLabel}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>CV out</span>
                  <select
                    className={styles.select}
                    value={selectedEntry.out}
                    onChange={(e) => patchValue({ out: e.target.value as MenuOutSlot })}
                  >
                    {OUT_SLOTS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {/* ---------- menu-level settings ---------- */}
        <div className={styles.detail} onPointerDown={stopDrag}>
          <div className={styles.row2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Long press</span>
              <select className={styles.select} value={tree.longPress}
                onChange={(e) => commit({ ...tree, longPress: e.target.value as MenuAction })}>
                {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Double click</span>
              <select className={styles.select} value={tree.doubleClick}
                onChange={(e) => commit({ ...tree, doubleClick: e.target.value as MenuAction })}>
                {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.row2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Long ms</span>
              <input className={styles.input} type="number" value={tree.longMs}
                onChange={(e) => commit({ ...tree, longMs: Number(e.target.value) })} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Double ms</span>
              <input className={styles.input} type="number" value={tree.doubleMs}
                onChange={(e) => commit({ ...tree, doubleMs: Number(e.target.value) })} />
            </label>
          </div>
        </div>

        {/* ---------- sockets ---------- */}
        <div className={styles.sockets}>
          <div className={styles.socketCol}>
            {inputs.map(([key, input]) =>
              input ? (
                <div className={styles.socketRow} key={key}>
                  <RefSocket
                    name="input-socket"
                    side="input"
                    emit={emit}
                    socketKey={key}
                    nodeId={data.id}
                    payload={input.socket}
                  />
                  <span className={styles.socketLabel}>{input.label ?? key}</span>
                </div>
              ) : null
            )}
          </div>
          <div className={styles.socketColRight}>
            {outputs.map(([key, output]) =>
              output ? (
                <div className={styles.socketRowRight} key={key}>
                  <span className={styles.socketLabel}>{output.label ?? key}</span>
                  <RefSocket
                    name="output-socket"
                    side="output"
                    emit={emit}
                    socketKey={key}
                    nodeId={data.id}
                    payload={output.socket}
                  />
                </div>
              ) : null
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
