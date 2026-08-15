/**
 * CommandPalette — floating fuzzy picker for commands AND node kinds.
 *
 * Invoked with Cmd/Ctrl+K. Centered modal on top of the canvas. Mirrors
 * the palette's active target filter (so "Available" hides unsupported
 * kinds here too). Keyboard-only model: arrow keys to navigate, Enter
 * to run/drop, Shift+Enter to run and close, Esc to close.
 *
 * It used to list only node kinds, which made it a second node palette
 * rather than a command palette: every actual *action* in the app was a
 * toolbar icon or an unlisted keyboard shortcut, with nowhere to look it
 * up. Commands now come first — that is what people press Cmd+K expecting —
 * and prefixing the query with `>` narrows to commands only, the same
 * convention as every other editor.
 *
 * Dropping uses the shared `dropKindAtCanvasCenter()` helper so the new
 * node lands at the middle of the visible canvas regardless of shell
 * panel sizes.
 *
 * Ownership: the overlay manages its own open/close state locally —
 * there's no store field for it. The open/close is driven by a DOM
 * CustomEvent ('dp-toggle-command-palette') dispatched from the global
 * keybindings hook, which keeps the keybinding wiring free of the
 * React tree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '@/state/store'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { NodeDefinition } from '@/nodes/definitions'
import type { NodeKind } from '@/types/graph'
import { iconForKind } from '@/nodes/nodeIcons'
import { supportLevel } from '@/nodes/targetSupport'
import { matchScore } from './palettefuzzy'
import { dropKindAtCanvasCenter } from './Palette'
import { buildCommands, type Command } from './commands'
import { useTheme } from '@/theme/ThemeProvider'
import styles from './CommandPalette.module.css'

const MAX_RESULTS = 14
export const OPEN_COMMAND_PALETTE_EVENT = 'dp-open-command-palette'

type Result =
  | { type: 'node'; key: string; def: NodeDefinition; support: ReturnType<typeof supportLevel>; score: number }
  | { type: 'command'; key: string; cmd: Command; score: number }

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const target = useEditorStore((s) => s.target)
  const filter = useEditorStore((s) => s.layout.paletteFilter)
  const recent = useEditorStore((s) => s.layout.recentKinds)
  const { skinId, setSkinId } = useTheme()

  /*
   * Commands are snapshotted when the palette opens, not recomputed per
   * keystroke: half of them read live state for their label ("Show grid" vs
   * "Hide grid") and rebuilding mid-search would make rows rename under the
   * cursor as the state they describe changes.
   */
  const [commands, setCommands] = useState<Command[]>([])

  // External open trigger from the global keybindings hook.
  useEffect(() => {
    const onOpen = () => {
      setOpen(true)
      setQuery('')
      setIndex(0)
      setCommands(buildCommands({ setSkinId, currentSkinId: skinId }))
    }
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
  }, [setSkinId, skinId])

  // Focus-on-open, pinned after mount so autoFocus doesn't fight the
  // click-outside logic.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  const results = useMemo<Result[]>(() => {
    const raw = query.trim()
    // `>` is the standard "commands only" prefix; strip it before matching.
    const commandsOnly = raw.startsWith('>')
    const q = commandsOnly ? raw.slice(1).trim() : raw

    const scored: Result[] = []

    for (const cmd of commands) {
      if (q) {
        const score = Math.max(
          matchScore(cmd.label, q),
          matchScore(cmd.group, q),
          cmd.keywords ? matchScore(cmd.keywords, q) : -1
        )
        if (score < 0) continue
        // Commands outrank nodes at equal relevance: Cmd+K is reached for to
        // do something far more often than to place something.
        scored.push({ type: 'command', key: cmd.id, cmd, score: score + 1 })
      } else {
        scored.push({ type: 'command', key: cmd.id, cmd, score: 1 })
      }
    }

    if (!commandsOnly) {
      for (const def of Object.values(NODE_DEFINITIONS)) {
        const support = supportLevel(def.kind, target)
        // Target filter: same rules as the side palette.
        if (filter === 'native' && support !== 'native') continue
        if (filter === 'available' && support === 'unsupported') continue

        if (q) {
          const score = Math.max(
            matchScore(def.label, q),
            matchScore(def.kind, q),
            matchScore(def.description, q),
            matchScore(def.category, q)
          )
          if (score < 0) continue
          scored.push({ type: 'node', key: `node:${def.kind}`, def, support, score })
        } else {
          scored.push({ type: 'node', key: `node:${def.kind}`, def, support, score: 0 })
        }
      }
    }

    if (q) {
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, MAX_RESULTS)
    }

    /*
     * Empty query: lead with the most-used commands, then recently dropped
     * kinds. A cold palette that opens on an alphabetical wall of every node
     * kind is a worse first impression than one that opens on what you were
     * just doing.
     */
    const recentRank = new Map<NodeKind, number>()
    recent.forEach((k, i) => recentRank.set(k, recent.length - i))
    const cmds = scored.filter((r): r is Extract<Result, { type: 'command' }> => r.type === 'command')
    const nodes = scored
      .filter((r): r is Extract<Result, { type: 'node' }> => r.type === 'node')
      .sort((a, b) => {
        const ra = recentRank.get(a.def.kind) ?? 0
        const rb = recentRank.get(b.def.kind) ?? 0
        if (ra !== rb) return rb - ra
        return a.def.label.localeCompare(b.def.label)
      })
    return [...cmds.slice(0, 6), ...nodes].slice(0, MAX_RESULTS)
  }, [query, target, filter, recent, commands])

  // Clamp selected index whenever the result list changes.
  useEffect(() => {
    setIndex((i) => (results.length === 0 ? 0 : Math.min(i, results.length - 1)))
  }, [results.length])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setIndex(0)
  }, [])

  const commit = useCallback(
    (opts: { keepOpen: boolean }, overrideIdx?: number) => {
      const i = overrideIdx ?? index
      const chosen = results[i]
      if (!chosen) return
      if (chosen.type === 'command') {
        if (chosen.cmd.disabled) return
        // Commands always close: unlike dropping nodes there is no batch
        // case, and leaving the modal up hides the thing that just happened.
        close()
        chosen.cmd.run()
        return
      }
      dropKindAtCanvasCenter(chosen.def.kind)
      if (opts.keepOpen) {
        // Power-user batch-drop: keep modal open, clear query so the
        // next keystrokes target a fresh search.
        setQuery('')
        setIndex(0)
        inputRef.current?.focus()
      } else {
        close()
      }
    },
    [index, results, close]
  )

  // Keyboard model.
  const onKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      close()
      return
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      setIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length))
      return
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      setIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length))
      return
    }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      // Shift+Enter: drop AND close.
      // Plain Enter:   drop and keep open (power-user batch drop).
      commit({ keepOpen: !ev.shiftKey })
      return
    }
  }

  // Scroll the active row into view when the index moves.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[index] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        // Click-outside closes.
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className={styles.dialog} role="dialog" aria-label="Command palette">
        <div className={styles.searchRow}>
          <svg
            className={styles.searchIcon}
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder="search commands and nodes… (&gt; for commands only)"
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
            aria-label="Search nodes"
          />
          <span className={styles.hint}>
            <kbd>↑↓</kbd> <kbd>Enter</kbd> run/drop · <kbd>Esc</kbd>
          </span>
        </div>
        {results.length === 0 ? (
          <div className={styles.empty}>no matches</div>
        ) : (
          <ul ref={listRef} className={styles.list} role="listbox">
            {results.map((r, i) =>
              r.type === 'command' ? (
                <ActionRow
                  key={r.key}
                  cmd={r.cmd}
                  active={i === index}
                  onClick={() => commit({ keepOpen: false }, i)}
                  onHover={() => setIndex(i)}
                />
              ) : (
                <CommandRow
                  key={r.key}
                  def={r.def}
                  support={r.support}
                  active={i === index}
                  onClick={() => commit({ keepOpen: false }, i)}
                  onHover={() => setIndex(i)}
                />
              )
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

function CommandRow({
  def,
  support,
  active,
  onClick,
  onHover
}: {
  def: NodeDefinition
  support: ReturnType<typeof supportLevel>
  active: boolean
  onClick: () => void
  onHover: () => void
}) {
  const Icon = useMemo(() => iconForKind(def.kind), [def.kind])
  return (
    <li
      role="option"
      aria-selected={active}
      className={`${styles.row} ${active ? styles.rowActive : ''}`}
      onMouseDown={(e) => {
        e.preventDefault() // prevent input blur
        onClick()
      }}
      onMouseMove={onHover}
    >
      <span className={styles.rowIcon} aria-hidden>
        <Icon />
      </span>
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{def.label}</span>
        <span className={styles.rowDesc}>{def.description}</span>
      </span>
      <span className={styles.rowMeta}>
        <span className={styles.rowCategory}>{def.category}</span>
        {support !== 'native' && (
          <span
            className={`${styles.supportDot} ${
              support === 'stub' ? styles.supportDotStub : styles.supportDotUnsup
            }`}
            aria-label={support}
          />
        )}
      </span>
    </li>
  )
}

function ActionRow({
  cmd,
  active,
  onClick,
  onHover
}: {
  cmd: Command
  active: boolean
  onClick: () => void
  onHover: () => void
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      aria-disabled={cmd.disabled}
      className={`${styles.row} ${active ? styles.rowActive : ''} ${cmd.disabled ? styles.rowDisabled : ''}`}
      onMouseDown={(e) => {
        e.preventDefault() // prevent input blur
        onClick()
      }}
      onMouseMove={onHover}
    >
      <span className={styles.rowIcon} aria-hidden>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M4 5.5L7 8L4 10.5M8.5 10.5H12"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{cmd.label}</span>
      </span>
      <span className={styles.rowMeta}>
        {cmd.shortcut ? <kbd className={styles.rowKey}>{cmd.shortcut}</kbd> : null}
        <span className={styles.rowCategory}>{cmd.group}</span>
      </span>
    </li>
  )
}
