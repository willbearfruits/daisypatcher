/**
 * Palette — draggable catalog of node kinds grouped by category.
 *
 * Drag payload uses the 'application/x-dp-node-kind' MIME so the canvas
 * can distinguish our drag from anything else the OS might hand it.
 *
 * Layered UI (top to bottom):
 *   - Header        — title, compact toggle, collapse chevron
 *   - Search input  — fuzzy scorer (palettefuzzy.ts), Esc to clear
 *   - Target filter — segmented All / Available / Native
 *   - Recent strip  — last N kinds dropped; click drops at canvas center
 *   - Category list — collapsible sections with optional card compaction
 *
 * Whole-panel collapse: when `layout.paletteCollapsed` is true, the entire
 * tree is replaced with a vertical "PALETTE" label + a chevron to expand.
 * The grid track still consumes `paletteW`; the App shell overrides the
 * width to 44px externally, we just render the compact chrome.
 */

import { useMemo, useRef, useState } from 'react'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { NodeDefinition } from '@/nodes/definitions'
import type { NodeKind } from '@/types/graph'
import type { PaletteFilterMode } from '@/types/store'
import { useEditorStore } from '@/state/store'
import { iconForKind } from '@/nodes/nodeIcons'
import { supportLevel, type SupportLevel } from '@/nodes/targetSupport'
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

/** Best score across the fields we consider searchable. Label + kind + description + category. */
function scoreDef(def: NodeDefinition, query: string): number {
  if (!query) return 0
  const s1 = matchScore(def.label, query)
  const s2 = matchScore(def.kind, query)
  const s3 = matchScore(def.description, query)
  const s4 = matchScore(def.category, query)
  return Math.max(s1, s2, s3, s4)
}

/**
 * Apply the active target-support filter to a definition. Returns a
 * `{ visible, support }` tuple so callers can also render the support
 * dot without re-computing the support level.
 */
function filterBySupport(
  def: NodeDefinition,
  target: ReturnType<typeof useEditorStore.getState>['target'],
  mode: PaletteFilterMode
): { visible: boolean; support: SupportLevel } {
  const support = supportLevel(def.kind, target)
  if (mode === 'all') return { visible: true, support }
  if (mode === 'native') return { visible: support === 'native', support }
  // 'available' — hide unsupported only
  return { visible: support !== 'unsupported', support }
}

export function Palette() {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const collapsed = useEditorStore((s) => s.layout.paletteCollapsed)
  const compact = useEditorStore((s) => s.layout.paletteCompact)
  const categoriesCollapsed = useEditorStore((s) => s.layout.categoriesCollapsed)
  const filter = useEditorStore((s) => s.layout.paletteFilter)
  const recent = useEditorStore((s) => s.layout.recentKinds)
  const target = useEditorStore((s) => s.target)
  const togglePaletteCollapsed = useEditorStore((s) => s.togglePaletteCollapsed)
  const togglePaletteCompact = useEditorStore((s) => s.togglePaletteCompact)
  const toggleCategoryCollapsed = useEditorStore((s) => s.toggleCategoryCollapsed)
  const setPaletteFilter = useEditorStore((s) => s.setPaletteFilter)

  // Group defs by category once; this is stable across renders.
  const grouped = useMemo(() => {
    const map = new Map<NodeDefinition['category'], NodeDefinition[]>()
    for (const def of Object.values(NODE_DEFINITIONS)) {
      const list = map.get(def.category) ?? []
      list.push(def)
      map.set(def.category, list)
    }
    return map
  }, [])

  /**
   * Filter pipeline — target filter first (cheap), then fuzzy score (ordering).
   * We keep the grouping because the UI lays out by category.
   */
  const filtered = useMemo(() => {
    const q = query.trim()
    const map = new Map<NodeDefinition['category'], { def: NodeDefinition; support: SupportLevel }[]>()
    for (const [cat, defs] of grouped) {
      const scored: { def: NodeDefinition; support: SupportLevel; score: number }[] = []
      for (const def of defs) {
        const { visible, support } = filterBySupport(def, target, filter)
        if (!visible) continue
        if (q) {
          const score = scoreDef(def, q)
          if (score < 0) continue
          scored.push({ def, support, score })
        } else {
          scored.push({ def, support, score: 0 })
        }
      }
      if (scored.length > 0) {
        if (q) scored.sort((a, b) => b.score - a.score)
        map.set(cat, scored.map(({ def, support }) => ({ def, support })))
      }
    }
    return map
  }, [grouped, query, target, filter])

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

  // Collapsed rail — just a vertical label + expand chevron.
  if (collapsed) {
    return (
      <div className={`${styles.root} ${styles.rootCollapsed}`}>
        <button
          type="button"
          className={styles.collapseRailBtn}
          onClick={togglePaletteCollapsed}
          title="Expand palette (Cmd/Ctrl+B)"
          aria-label="Expand palette"
        >
          <ChevronIcon direction="right" />
        </button>
        <div className={styles.railLabel} aria-hidden>
          PALETTE
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Nodes</span>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={`${styles.iconBtn} ${compact ? styles.iconBtnActive : ''}`}
            onClick={togglePaletteCompact}
            title={compact ? 'Show descriptions' : 'Icons only'}
            aria-label={compact ? 'Show descriptions' : 'Icons only'}
            aria-pressed={compact}
          >
            <CompactIcon />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={togglePaletteCollapsed}
            title="Collapse palette (Cmd/Ctrl+B)"
            aria-label="Collapse palette"
          >
            <ChevronIcon direction="left" />
          </button>
        </div>
      </div>
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
      <TargetFilter mode={filter} onChange={setPaletteFilter} />
      <div className={styles.scroll}>
        {recent.length > 0 && <RecentStrip recent={recent} target={target} filter={filter} />}
        {CATEGORY_ORDER.map((cat) => {
          const items = filtered.get(cat)
          if (!items || items.length === 0) return null
          const catLabel = CATEGORY_LABEL[cat]
          const isCollapsed = categoriesCollapsed.includes(catLabel)
          return (
            <div key={cat} className={styles.section}>
              <button
                type="button"
                className={styles.sectionTitle}
                onClick={() => toggleCategoryCollapsed(catLabel)}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? `Expand ${catLabel}` : `Collapse ${catLabel}`}
              >
                <span className={styles.sectionChevron} aria-hidden>
                  <ChevronIcon direction={isCollapsed ? 'right' : 'down'} small />
                </span>
                <span>{catLabel}</span>
                {isCollapsed && (
                  <span className={styles.sectionCount}>{items.length}</span>
                )}
              </button>
              <div
                className={`${styles.sectionBody} ${isCollapsed ? styles.sectionBodyCollapsed : ''}`}
                aria-hidden={isCollapsed}
              >
                {items.map(({ def, support }) => (
                  <PaletteCard
                    key={def.kind}
                    def={def}
                    support={support}
                    filterMode={filter}
                    compact={compact}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- Target filter ---------- */

function TargetFilter({
  mode,
  onChange
}: {
  mode: PaletteFilterMode
  onChange: (mode: PaletteFilterMode) => void
}) {
  const opts: { value: PaletteFilterMode; label: string; title: string }[] = [
    { value: 'all', label: 'All', title: 'Show every kind (dimmed when unsupported)' },
    { value: 'available', label: 'Avail', title: 'Native + stub on the active target' },
    { value: 'native', label: 'Native', title: 'Only fully-supported kinds' }
  ]
  return (
    <div className={styles.filterWrap} role="group" aria-label="Target support filter">
      {opts.map((o) => (
        <button
          type="button"
          key={o.value}
          className={`${styles.filterBtn} ${mode === o.value ? styles.filterBtnActive : ''}`}
          onClick={() => onChange(o.value)}
          title={o.title}
          aria-pressed={mode === o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Recent strip ---------- */

function RecentStrip({
  recent,
  target,
  filter
}: {
  recent: NodeKind[]
  target: ReturnType<typeof useEditorStore.getState>['target']
  filter: PaletteFilterMode
}) {
  // Filter recents by the same rules so the strip doesn't show things the
  // user can't actually drop on the current target.
  const kinds = useMemo(() => {
    return recent.filter((k) => {
      const def = NODE_DEFINITIONS[k]
      if (!def) return false
      return filterBySupport(def, target, filter).visible
    })
  }, [recent, target, filter])
  if (kinds.length === 0) return null
  return (
    <div className={styles.recentWrap}>
      <div className={styles.recentLabel}>Recent</div>
      <div className={styles.recentRow}>
        {kinds.map((k) => (
          <RecentChip key={k} kind={k} />
        ))}
      </div>
    </div>
  )
}

function RecentChip({ kind }: { kind: NodeKind }) {
  const def = NODE_DEFINITIONS[kind]
  const Icon = useMemo(() => iconForKind(kind), [kind])
  const onClick = () => dropKindAtCanvasCenter(kind)
  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(NODE_DRAG_MIME, kind)
    e.dataTransfer.setData('text/plain', kind)
  }
  return (
    <button
      type="button"
      className={styles.recentChip}
      onClick={onClick}
      draggable
      onDragStart={onDragStart}
      title={def?.label ?? kind}
      aria-label={`Drop ${def?.label ?? kind} at canvas center`}
      data-dp-node-kind={kind}
    >
      <Icon />
    </button>
  )
}

/* ---------- Card ---------- */

function PaletteCard({
  def,
  support,
  filterMode,
  compact
}: {
  def: NodeDefinition
  support: SupportLevel
  filterMode: PaletteFilterMode
  compact: boolean
}) {
  const Icon = useMemo(() => iconForKind(def.kind), [def.kind])
  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (support === 'unsupported') {
      // Still allow the drag for "All" mode — the user saw the dimmed
      // state so they're opting in to a kind that won't actually build.
      // No special path; fall through.
    }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(NODE_DRAG_MIME, def.kind)
    e.dataTransfer.setData('text/plain', def.kind)
  }

  // In "all" mode we render a red dot for unsupported and amber for stubs;
  // in "available" we still render the amber dot (stubs are visible).
  // In "native" mode, by definition only native kinds show — no dot.
  const showDot =
    (filterMode === 'all' && support !== 'native') ||
    (filterMode === 'available' && support === 'stub')

  const title =
    support === 'unsupported'
      ? `${def.description} — not supported on current target`
      : support === 'stub'
        ? `${def.description} — stubbed on current target`
        : def.description

  return (
    <div
      className={[
        styles.card,
        compact ? styles.cardCompact : '',
        support === 'unsupported' ? styles.cardUnsupported : ''
      ].filter(Boolean).join(' ')}
      draggable
      onDragStart={onDragStart}
      data-dp-node-kind={def.kind satisfies NodeKind}
      title={title}
    >
      <span className={styles.cardIcon} aria-hidden>
        <Icon />
      </span>
      <span className={styles.cardText}>
        <span className={styles.cardLabel}>{def.label}</span>
        {!compact && <span className={styles.cardDesc}>{def.description}</span>}
      </span>
      {showDot && (
        <span
          className={`${styles.supportDot} ${
            support === 'stub' ? styles.supportDotStub : styles.supportDotUnsup
          }`}
          aria-label={support === 'stub' ? 'stubbed' : 'unsupported'}
        />
      )}
    </div>
  )
}

/* ---------- icons ---------- */

function ChevronIcon({
  direction,
  small
}: {
  direction: 'left' | 'right' | 'down' | 'up'
  small?: boolean
}) {
  const size = small ? 10 : 12
  const rot = {
    left: 180,
    right: 0,
    down: 90,
    up: -90
  }[direction]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      style={{ transform: `rotate(${rot}deg)` }}
      aria-hidden
    >
      <path
        d="M4 2 L8 6 L4 10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CompactIcon() {
  // Three short horizontal bars = "condense rows". 12x12.
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 3 L10 3 M2 6 L10 6 M2 9 L10 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/* ---------- drop helper shared with command palette ---------- */

/**
 * Drop a new node of `kind` at the center of the canvas viewport. Uses
 * the canvas element's bounding rect (not window center) so the drop
 * lands on the actual Rete surface regardless of shell panel sizes.
 *
 * Exported so the command palette can reuse it.
 */
export function dropKindAtCanvasCenter(kind: NodeKind): void {
  const canvas = document.querySelector('[data-dp-canvas="true"]') as HTMLElement | null
  const rect = canvas?.getBoundingClientRect()
  const clientX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
  const clientY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
  // Route through the synthetic drop event via the globally-shared handler.
  // We post to a DOM event so we don't have to thread a ref through three
  // layers of components. The editor subscribes in `App.tsx`.
  const ev = new CustomEvent<{ kind: NodeKind; clientX: number; clientY: number }>(
    'dp-drop-kind',
    { detail: { kind, clientX, clientY } }
  )
  window.dispatchEvent(ev)
}

