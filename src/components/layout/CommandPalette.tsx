/**
 * CommandPalette — floating fuzzy picker for node kinds.
 *
 * Invoked with Cmd/Ctrl+K. Centered modal on top of the canvas. Mirrors
 * the palette's active target filter (so "Available" hides unsupported
 * kinds here too). Keyboard-only model: arrow keys to navigate, Enter
 * to drop, Shift+Enter to drop and close, Esc to close.
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
import styles from './CommandPalette.module.css'

const MAX_RESULTS = 12
export const OPEN_COMMAND_PALETTE_EVENT = 'dp-open-command-palette'

interface Result {
  def: NodeDefinition
  support: ReturnType<typeof supportLevel>
  score: number
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const target = useEditorStore((s) => s.target)
  const filter = useEditorStore((s) => s.layout.paletteFilter)
  const recent = useEditorStore((s) => s.layout.recentKinds)

  // External open trigger from the global keybindings hook.
  useEffect(() => {
    const onOpen = () => {
      setOpen(true)
      setQuery('')
      setIndex(0)
    }
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
  }, [])

  // Focus-on-open, pinned after mount so autoFocus doesn't fight the
  // click-outside logic.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  const results = useMemo<Result[]>(() => {
    const q = query.trim()
    const defs = Object.values(NODE_DEFINITIONS)
    const scored: Result[] = []
    for (const def of defs) {
      const support = supportLevel(def.kind, target)
      // Target filter: same rules as the side palette.
      if (filter === 'native' && support !== 'native') continue
      if (filter === 'available' && support === 'unsupported') continue

      if (q) {
        const s1 = matchScore(def.label, q)
        const s2 = matchScore(def.kind, q)
        const s3 = matchScore(def.description, q)
        const s4 = matchScore(def.category, q)
        const score = Math.max(s1, s2, s3, s4)
        if (score < 0) continue
        scored.push({ def, support, score })
      } else {
        scored.push({ def, support, score: 0 })
      }
    }
    if (q) {
      scored.sort((a, b) => b.score - a.score)
    } else {
      // No query: lead with recent kinds so the user can re-drop quickly.
      const recentRank = new Map<NodeKind, number>()
      recent.forEach((k, i) => recentRank.set(k, recent.length - i))
      scored.sort((a, b) => {
        const ra = recentRank.get(a.def.kind) ?? 0
        const rb = recentRank.get(b.def.kind) ?? 0
        if (ra !== rb) return rb - ra
        return a.def.label.localeCompare(b.def.label)
      })
    }
    return scored.slice(0, MAX_RESULTS)
  }, [query, target, filter, recent])

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
            placeholder="search nodes…"
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
            <kbd>↑↓</kbd> <kbd>Enter</kbd> drops ·
            <kbd>Shift+Enter</kbd> closes · <kbd>Esc</kbd>
          </span>
        </div>
        {results.length === 0 ? (
          <div className={styles.empty}>no matches</div>
        ) : (
          <ul ref={listRef} className={styles.list} role="listbox">
            {results.map((r, i) => (
              <CommandRow
                key={r.def.kind}
                def={r.def}
                support={r.support}
                active={i === index}
                onClick={() => commit({ keepOpen: false }, i)}
                onHover={() => setIndex(i)}
              />
            ))}
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
