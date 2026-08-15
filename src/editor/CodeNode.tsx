/**
 * Code node body — write the DSP in the node.
 *
 * A plain textarea, deliberately. The project ships no UI libraries and a
 * code editor is not a reason to start: this is a dozen lines of DSP, not a
 * file, and CodeMirror would be more bytes than the rest of the renderer.
 * What it does have is the thing that actually matters — the error, with a
 * line number, live as you type.
 *
 * Parsing happens on every keystroke because it is cheap (a few hundred
 * tokens) and because a body that does not parse is silent: without live
 * feedback you would be listening to nothing and wondering why. The store
 * write is debounced separately so a burst of typing is one undo entry, not
 * one per character.
 */

import * as React from 'react'
import { Presets } from 'rete-react-plugin'
import type { ClassicScheme, RenderEmit } from 'rete-react-plugin'

import { DaisyNode } from './nodes/base'
import type { SignalSocket } from './sockets'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { useEditorStore } from '@/state/store'
import { tryParseCode, writtenOutputs, CODE_FUNCS } from '@/codegen/codeNode/lang'
import { CollapseButton, useHeaderDoubleClick } from './CustomNode'
import styles from './CodeNode.module.css'

const { RefSocket } = Presets.classic

type Props<S extends ClassicScheme> = {
  data: S['Node']
  emit: RenderEmit<S>
}

const stopDrag = (e: React.PointerEvent): void => e.stopPropagation()

/** Coalesce a burst of typing into one undo entry. */
const COMMIT_MS = 400

export function CodeNode<S extends ClassicScheme>(props: Props<S>): React.JSX.Element {
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
  const stored = useEditorStore((s) => {
    const n = s.graph.nodes.find((x) => x.id === data.id)
    return String(n?.params.source ?? '')
  })
  const setParam = useEditorStore((s) => s.setParam)
  const begin = useEditorStore((s) => s.beginTransaction)
  const end = useEditorStore((s) => s.endTransaction)
  const onHeaderDoubleClick = useHeaderDoubleClick(data.id)

  // Local draft so typing stays responsive and the store sees whole edits.
  const [draft, setDraft] = React.useState(stored)
  const draftRef = React.useRef(draft)
  const timerRef = React.useRef<number | null>(null)
  const openRef = React.useRef(false)

  // Adopt external changes (undo, file load) unless the user is mid-edit.
  React.useEffect(() => {
    if (timerRef.current === null) {
      setDraft(stored)
      draftRef.current = stored
    }
  }, [stored])

  const commit = React.useCallback(() => {
    timerRef.current = null
    if (draftRef.current === stored) {
      if (openRef.current) {
        openRef.current = false
        end()
      }
      return
    }
    if (!openRef.current) {
      openRef.current = true
      begin()
    }
    setParam(data.id, 'source', draftRef.current)
    openRef.current = false
    end()
  }, [data.id, setParam, begin, end, stored])

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const v = e.target.value
    setDraft(v)
    draftRef.current = v
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(commit, COMMIT_MS)
  }

  // Flush on unmount so an edit is never lost by clicking away.
  React.useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        commit()
      }
    },
    [commit]
  )

  const parsed = React.useMemo(() => tryParseCode(draft), [draft])
  const err = 'error' in parsed ? parsed.error : null
  const written = 'program' in parsed ? writtenOutputs(parsed.program) : new Set<string>()
  const stateCount = 'program' in parsed ? parsed.program.state.length : 0

  if (collapsed) {
    return (
      <div className={`${styles.node} ${selected ? styles.selected : ''} ${styles.collapsed}`} data-testid="node">
        <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
          <CollapseButton nodeId={data.id} collapsed />
          <span className={styles.title}>{def?.label ?? 'Code'}</span>
          {err ? <span className={styles.errDot} title={err.message} /> : null}
        </div>
        <div className={styles.collapsedSockets}>
          {inputs.map(([key, input]) =>
            input ? (
              <div className={styles.collapsedIn} key={key}>
                <RefSocket name="input-socket" side="input" emit={emit} socketKey={key} nodeId={data.id} payload={input.socket} />
              </div>
            ) : null
          )}
          {outputs.map(([key, output]) =>
            output ? (
              <div className={styles.collapsedOut} key={key}>
                <RefSocket name="output-socket" side="output" emit={emit} socketKey={key} nodeId={data.id} payload={output.socket} />
              </div>
            ) : null
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`${styles.node} ${selected ? styles.selected : ''}`} data-testid="node">
      <div className={styles.header} onDoubleClick={onHeaderDoubleClick}>
        <CollapseButton nodeId={data.id} collapsed={false} />
        <span className={styles.title}>{def?.label ?? 'Code'}</span>
        <span className={styles.spacer} />
        <span className={styles.stat}>
          {stateCount > 0 ? `${stateCount} state` : ''}
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.editorRow} onPointerDown={stopDrag}>
          <textarea
            className={`${styles.editor} ${err ? styles.editorErr : ''}`}
            value={draft}
            onChange={onChange}
            onBlur={commit}
            spellCheck={false}
            wrap="off"
            rows={12}
            aria-label="Node source"
            // Rete's canvas listens for these; without stopping them a
            // spacebar in the editor toggles the transport and Delete
            // removes the node you are typing into.
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>

        <div className={`${styles.status} ${err ? styles.statusErr : ''}`}>
          {err ? (
            <span title={err.message}>✕ {err.message}</span>
          ) : (
            <span>
              ✓ ok
              {written.size > 0 ? ` · writes ${[...written].join(', ')}` : ' · writes nothing'}
            </span>
          )}
        </div>

        <details className={styles.help} onPointerDown={stopDrag}>
          <summary className={styles.helpHead}>reference</summary>
          <div className={styles.helpBody}>
            <p>
              <b>a b c d</b> inputs · <b>p1..p4</b> params · <b>out out2</b> outputs ·{' '}
              <b>sr</b> sample rate · <b>PI E</b>
            </p>
            <p>
              <b>state float x = 0;</b> persists between samples (initialiser must be
              constant). <b>float y = …;</b> is per sample.
            </p>
            <p>
              <b>if (…) {'{'} … {'}'} else {'{'} … {'}'}</b> · <b>? :</b> ·{' '}
              comparisons yield 1 or 0.
            </p>
            <p className={styles.fnList}>{Object.keys(CODE_FUNCS).join(' · ')}</p>
            <p className={styles.helpNote}>
              No loops, arrays or pointers — this runs once per sample and has to
              finish in a bounded time. Divide by zero yields 0 on both targets
              rather than an inf that would poison everything downstream.
            </p>
          </div>
        </details>

        <div className={styles.sockets}>
          <div className={styles.socketCol}>
            {inputs.map(([key, input]) =>
              input ? (
                <div className={styles.socketRow} key={key}>
                  <RefSocket name="input-socket" side="input" emit={emit} socketKey={key} nodeId={data.id} payload={input.socket} />
                  <span className={styles.socketLabel}>{input.label ?? key}</span>
                </div>
              ) : null
            )}
          </div>
          <div className={styles.socketColRight}>
            {outputs.map(([key, output]) =>
              output ? (
                <div className={styles.socketRow} key={key}>
                  <span
                    className={`${styles.socketLabel} ${
                      written.has(key) ? '' : styles.socketUnused
                    }`}
                  >
                    {output.label ?? key}
                  </span>
                  <RefSocket name="output-socket" side="output" emit={emit} socketKey={key} nodeId={data.id} payload={output.socket} />
                </div>
              ) : null
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
