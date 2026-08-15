/**
 * CodePanel — the generated firmware, visible.
 *
 * Until now the C++ was write-only: produced, handed to a compiler, never
 * shown. That makes the patcher a closed box — you cannot learn what a node
 * really does, you cannot tell why the device disagrees with the emulator,
 * and a compile error is a line number in a file you have never seen.
 *
 * Read-only, deliberately. Editing here would have to round-trip C++ back
 * into a node graph, which is not a hard problem so much as an unsolved
 * one; every environment that promised it either died or quietly became
 * read-only. The escape hatch is Eject: write the project to disk and open
 * the folder, from where it is ordinary C++ and the graph stops claiming
 * ownership. The two are different promises and the UI says which is which.
 *
 * Provenance is what makes it more than a text dump. `generateProject`
 * reports which node emitted which lines, so:
 *   - selecting a node highlights and scrolls to its code,
 *   - clicking a line selects the node that produced it.
 * The graph stays visible above the panel, which is why this docks to the
 * bottom rather than opening as a modal.
 *
 * Regeneration is debounced and only runs while the panel is open — the
 * whole point of a live view is that it tracks the patch, but nobody should
 * pay for codegen on every keystroke of a slider drag when it is closed.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '@/state/store'
import { generateProject, type GeneratedProject } from '@/codegen/generateProject'
import { nodesAtLine, rangesForNode } from '@/codegen/provenance'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { scanFile } from './cppHighlight'
import { ResizeHandle } from './ResizeHandle'
import styles from './CodePanel.module.css'

export const TOGGLE_CODE_PANEL_EVENT = 'dp-toggle-code-panel'

/** Debounce for regeneration while the patch is being edited. */
const REGEN_MS = 180

export function CodePanel() {
  const [open, setOpen] = useState(false)
  const [proj, setProj] = useState<GeneratedProject | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [ejecting, setEjecting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const graph = useEditorStore((s) => s.graph)
  const hardware = useEditorStore((s) => s.hardware)
  const target = useEditorStore((s) => s.target)
  const flashMode = useEditorStore((s) => s.daisyFlashMode)
  const selection = useEditorStore((s) => s.selection)
  const select = useEditorStore((s) => s.select)
  const presets = useEditorStore((s) => s.presets)
  const height = useEditorStore((s) => s.layout.codePanelH)
  const setHeight = useEditorStore((s) => s.setCodePanelH)

  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const toggle = () => setOpen((v) => !v)
    window.addEventListener(TOGGLE_CODE_PANEL_EVENT, toggle)
    return () => window.removeEventListener(TOGGLE_CODE_PANEL_EVENT, toggle)
  }, [])

  /* ---- regenerate, debounced, only while open ---- */
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      try {
        setProj(
          generateProject(graph, hardware, graph.meta.name, target, {
            daisyFlashMode: flashMode,
            presets
          })
        )
      } catch (err) {
        // A throwing generator is a real bug, but the panel showing the
        // message beats the panel going blank with no explanation.
        setProj({
          projectName: graph.meta.name,
          files: { 'error.txt': `codegen threw:\n\n${(err as Error).stack ?? String(err)}` },
          warnings: []
        })
      }
    }, REGEN_MS)
    return () => window.clearTimeout(t)
  }, [open, graph, hardware, target, flashMode, presets])

  /* ---- which file ---- */
  const fileNames = useMemo(() => {
    if (!proj) return []
    // Main source first — it is what anyone opening this wants.
    const names = Object.keys(proj.files)
    const main = proj.provenance?.file
    return names.sort((a, b) => {
      if (a === main) return -1
      if (b === main) return 1
      return a.localeCompare(b)
    })
  }, [proj])

  const activeFile = file && proj?.files[file] !== undefined ? file : (fileNames[0] ?? null)
  const source = activeFile && proj ? proj.files[activeFile] : ''
  const lines = useMemo(() => scanFile(source), [source])
  const isMain = !!proj?.provenance && activeFile === proj.provenance.file

  /* ---- provenance: which lines belong to the selection ---- */
  const highlighted = useMemo(() => {
    if (!isMain || !proj?.provenance) return null
    const set = new Set<number>()
    for (const id of selection) {
      for (const r of rangesForNode(proj.provenance, id)) {
        for (let l = r.startLine; l <= r.endLine; l++) set.add(l)
      }
    }
    return set.size ? set : null
  }, [isMain, proj, selection])

  /* Scroll the first highlighted line into view when the selection moves. */
  const firstHighlighted = useMemo(() => {
    if (!highlighted) return null
    let min = Infinity
    for (const l of highlighted) min = Math.min(min, l)
    return Number.isFinite(min) ? min : null
  }, [highlighted])

  useEffect(() => {
    if (!open || firstHighlighted === null) return
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-line="${firstHighlighted}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [open, firstHighlighted, activeFile])

  const onLineClick = (line: number): void => {
    if (!isMain || !proj?.provenance) return
    const hits = nodesAtLine(proj.provenance, line)
    if (hits.length > 0) select(hits[0].nodeId, 'replace')
  }

  const eject = async (): Promise<void> => {
    if (!proj) return
    setEjecting(true)
    setNotice(null)
    try {
      const r = await window.daisy.project.eject({
        projectName: proj.projectName,
        files: proj.files,
        target
      })
      setNotice(r.opened ? `Opened ${r.path}` : `Written to ${r.path}`)
    } catch (err) {
      setNotice(`Eject failed: ${(err as Error).message}`)
    } finally {
      setEjecting(false)
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(source)
      setNotice(`Copied ${activeFile}`)
    } catch {
      setNotice('Clipboard unavailable')
    }
  }

  // Clear a notice after a beat so it does not become permanent chrome.
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(t)
  }, [notice])

  if (!open) return null

  const lineCount = lines.length
  const nodeCount = proj?.provenance?.ranges.length ?? 0

  return (
    <section
      className={styles.panel}
      style={{ height: `${height}px` }}
      aria-label="Generated code"
    >
      <ResizeHandle
        orientation="horizontal"
        ariaLabel="Resize code panel"
        onResize={(d) => setHeight(height - d)}
        onReset={() => setHeight(360)}
      />
      <header className={styles.head}>
        <span className={styles.title}>CODE</span>
        <div className={styles.tabs} role="tablist">
          {fileNames.map((n) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={n === activeFile}
              className={`${styles.tab} ${n === activeFile ? styles.tabActive : ''}`}
              onClick={() => setFile(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <span className={styles.meta}>
          {lineCount} lines
          {isMain && nodeCount > 0 ? ` · ${nodeCount} node blocks` : ''}
        </span>
        <span className={styles.spacer} />
        {notice ? <span className={styles.notice}>{notice}</span> : null}
        <button type="button" className={styles.btn} onClick={() => void copy()}>
          Copy
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => void eject()}
          disabled={ejecting || !proj}
          title="Write this project to disk and open the folder. From there it is ordinary C++ — the patch will not see your edits."
        >
          {ejecting ? 'Ejecting…' : 'Eject ▸'}
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => setOpen(false)}
          aria-label="Close code panel"
        >
          ✕
        </button>
      </header>

      <div className={styles.body} ref={bodyRef}>
        <pre className={styles.pre}>
          <code>
            {lines.map((tokens, i) => {
              const line = i + 1
              const lit = highlighted?.has(line) ?? false
              return (
                <span
                  key={line}
                  data-line={line}
                  className={`${styles.line} ${lit ? styles.lineHit : ''}`}
                  onClick={() => onLineClick(line)}
                >
                  <span className={styles.gutter}>{line}</span>
                  <span className={styles.code}>
                    {tokens.map((t, j) => (
                      <span key={j} className={styles[t.kind]}>
                        {t.text}
                      </span>
                    ))}
                    {tokens.length === 0 ? ' ' : null}
                  </span>
                </span>
              )
            })}
          </code>
        </pre>
      </div>

      {isMain ? (
        <footer className={styles.foot}>
          {selection.size > 0
            ? `Highlighting ${describeSelection(selection)} · click any line to select its node`
            : 'Select a node to highlight its code · click any line to select its node'}
        </footer>
      ) : null}
    </section>
  )
}

function describeSelection(selection: Set<string>): string {
  const graph = useEditorStore.getState().graph
  const kinds = [...selection]
    .map((id) => graph.nodes.find((n) => n.id === id)?.kind)
    .filter((k): k is NonNullable<typeof k> => !!k)
    .map((k) => NODE_DEFINITIONS[k]?.label ?? k)
  if (kinds.length === 0) return 'nothing'
  if (kinds.length === 1) return kinds[0]
  return `${kinds.length} nodes`
}
