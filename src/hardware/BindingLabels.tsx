/**
 * BindingLabels — SVG overlay that draws small text tags next to each
 * bound pin, showing the patch node that pin drives. Purely presentational:
 * receives the already-computed pin coordinates and resolved labels.
 *
 * Why a separate component? Label resolution depends on the graph (which
 * changes independently from the hardware layout), and keeping this
 * overlay in its own subtree means selector churn here doesn't invalidate
 * the larger HardwareView tree.
 */

import * as React from 'react'
import { useEditorStore } from '@/state/store'
import { describeBinding } from './hardwareBindingLabels'
import type { PlacedComponent } from '@/types/hardware'
import type { AudioGraph } from '@/types/graph'

/** Shape of the minimal pin coordinate map we need. Matches PinCoord. */
interface PinCoordLike {
  pin: string
  side: 'left' | 'right' | 'bottom'
  x: number
  y: number
}

interface BindingLabelsProps {
  components: PlacedComponent[]
  pinCoordMap: Map<string, PinCoordLike>
  /** Board silhouette rect — labels are pushed outward from this. */
  boardX: number
  boardW: number
}

export function BindingLabels({
  components,
  pinCoordMap,
  boardX,
  boardW
}: BindingLabelsProps): React.JSX.Element | null {
  // Build an index of componentId -> label string. Select a stable string
  // off the store so the Zustand selector doesn't hand back a fresh object
  // per render (see CLAUDE.md "Zustand selectors must return cached
  // references"). We re-derive the index with useMemo from the string.
  const descIndex = useEditorStore((s) => {
    const graph: AudioGraph = s.graph
    const parts: string[] = []
    for (const c of components) {
      const d = describeBinding(graph, c)
      if (d) parts.push(`${c.id}=${d}`)
    }
    return parts.join('\n')
  })

  const descMap = React.useMemo(() => {
    const m = new Map<string, string>()
    if (!descIndex) return m
    for (const row of descIndex.split('\n')) {
      const i = row.indexOf('=')
      if (i > 0) m.set(row.slice(0, i), row.slice(i + 1))
    }
    return m
  }, [descIndex])

  // Emit one text per bound pin across all components.
  const entries: {
    key: string
    text: string
    x: number
    y: number
    anchor: 'start' | 'end'
  }[] = []
  for (const comp of components) {
    const desc = descMap.get(comp.id)
    if (!desc) continue
    for (const [role, pin] of Object.entries(comp.pins)) {
      if (!pin) continue
      const coord = pinCoordMap.get(pin as string)
      if (!coord || coord.side === 'bottom') continue
      const isLeft = coord.side === 'left'
      // Push the label further out past the name pill + alt pills. Rough
      // offset so we stay clear of the pill stack and read against the
      // background.
      const OUT_PX = 130
      const x = isLeft ? boardX - OUT_PX : boardX + boardW + OUT_PX
      const y = coord.y
      const display =
        Object.keys(comp.pins).length > 1
          ? `${pin} · ${role} → ${desc}`
          : `${pin} → ${desc}`
      entries.push({
        key: `${comp.id}-${role}`,
        text: display,
        x,
        y,
        anchor: isLeft ? 'end' : 'start'
      })
    }
  }

  if (entries.length === 0) return null
  return (
    <g pointerEvents="none">
      {entries.map((e) => (
        <g key={e.key}>
          {/* faint background plate so text stays legible over pills */}
          <rect
            x={e.anchor === 'end' ? e.x - 160 : e.x - 4}
            y={e.y - 8}
            width={164}
            height={16}
            rx={4}
            fill="color-mix(in srgb, var(--dp-bg) 85%, transparent)"
            stroke="color-mix(in srgb, var(--dp-border) 60%, transparent)"
            strokeWidth="0.5"
          />
          <text
            x={e.x}
            y={e.y + 3}
            textAnchor={e.anchor}
            fontFamily="var(--dp-font-mono)"
            fontSize="10"
            letterSpacing="0.04em"
            fill="var(--dp-text-muted)"
          >
            {e.text}
          </text>
        </g>
      ))}
    </g>
  )
}
