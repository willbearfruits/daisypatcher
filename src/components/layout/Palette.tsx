/**
 * Palette — draggable catalog of node kinds grouped by category.
 *
 * Drag payload uses the 'application/x-dp-node-kind' MIME so the canvas
 * can distinguish our drag from anything else the OS might hand it.
 *
 * A filter input at the top narrows the visible list as the user types.
 * Matching uses substring first, then a lightweight fuzzy scorer (see
 * palettefuzzy.ts). Categories with zero matches hide entirely.
 */

import { useMemo, useRef, useState } from 'react'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { NodeDefinition } from '@/nodes/definitions'
import type { NodeKind } from '@/types/graph'
import styles from './Palette.module.css'
import { matchScore } from './palettefuzzy'

const CATEGORY_ORDER: NodeDefinition['category'][] = ['source', 'process', 'io']

const CATEGORY_LABEL: Record<NodeDefinition['category'], string> = {
  source: 'Sources',
  process: 'Process',
  io: 'I/O'
}

export const NODE_DRAG_MIME = 'application/x-dp-node-kind'
export const PALETTE_SEARCH_INPUT_ID = 'dp-palette-search'

/** Best score across the fields we consider searchable. */
function scoreDef(def: NodeDefinition, query: string): number {
  if (!query) return 0
  const s1 = matchScore(def.label, query)
  const s2 = matchScore(def.kind, query)
  const s3 = matchScore(def.description, query)
  const s4 = matchScore(def.category, query)
  return Math.max(s1, s2, s3, s4)
}

export function Palette() {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<NodeDefinition['category'], NodeDefinition[]>()
    for (const def of Object.values(NODE_DEFINITIONS)) {
      const list = map.get(def.category) ?? []
      list.push(def)
      map.set(def.category, list)
    }
    return map
  }, [])

  const filtered = useMemo(() => {
    if (!query.trim()) return grouped
    const q = query.trim()
    const map = new Map<NodeDefinition['category'], NodeDefinition[]>()
    for (const [cat, defs] of grouped) {
      const scored: { def: NodeDefinition; score: number }[] = []
      for (const def of defs) {
        const score = scoreDef(def, q)
        if (score >= 0) scored.push({ def, score })
      }
      if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score)
        map.set(cat, scored.map((s) => s.def))
      }
    }
    return map
  }, [grouped, query])

  const onInputKey = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      if (query) {
        setQuery('')
      } else {
        inputRef.current?.blur()
      }
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>Nodes</div>
      <div className={styles.searchWrap}>
        <svg
          className={styles.searchIcon}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
        >
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <input
          id={PALETTE_SEARCH_INPUT_ID}
          ref={inputRef}
          type="text"
          className={styles.searchInput}
          placeholder="filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          spellCheck={false}
          autoComplete="off"
          aria-label="Filter nodes"
        />
        {query.length > 0 && (
          <button
            type="button"
            className={styles.searchClear}
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
            aria-label="Clear filter"
            title="Clear filter"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
              <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className={styles.scroll}>
        {CATEGORY_ORDER.map((cat) => {
          const items = filtered.get(cat)
          if (!items || items.length === 0) return null
          return (
            <div key={cat} className={styles.section}>
              <div className={styles.sectionTitle}>{CATEGORY_LABEL[cat]}</div>
              {items.map((def) => (
                <PaletteCard key={def.kind} def={def} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PaletteCard({ def }: { def: NodeDefinition }) {
  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(NODE_DRAG_MIME, def.kind)
    // also plain text fallback for robustness, harmless
    e.dataTransfer.setData('text/plain', def.kind)
  }

  return (
    <div
      className={styles.card}
      draggable
      onDragStart={onDragStart}
      data-dp-node-kind={def.kind satisfies NodeKind}
      title={def.description}
    >
      <span className={styles.cardLabel}>{def.label}</span>
      <span className={styles.cardDesc}>{def.description}</span>
    </div>
  )
}
