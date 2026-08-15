/**
 * Which node emitted which lines.
 *
 * The generated C++ is the thing that actually runs, and until now it was
 * write-only: a file the app produced, handed to a compiler, and never
 * shown. Reading it is how you learn what a node really does, and how you
 * find out why the device disagrees with the emulator — but a 700-line
 * `main.cpp` with no idea which node produced which line is a wall.
 *
 * So the backends hand back the per-node text blocks they assembled, in
 * order, and this locates each one in the finished file.
 *
 * WHY POST-HOC RATHER THAN COUNTED DURING ASSEMBLY: the file is built by
 * interpolating joined section strings into a template, so a line counter
 * would have to know the template's own line count and stay in step with
 * every future edit to it — a number that is wrong the moment someone adds
 * a comment. Searching for the block instead is self-correcting: the block
 * IS a substring of the file, the blocks appear in emission order, and each
 * search starts where the last one ended, so a repeated fragment can never
 * match backwards.
 */

import type { NodeKind } from '@/types/graph'

/** A section of the generated file, in the order the backends emit them. */
export type EmitSection = 'declare' | 'init' | 'process' | 'loop'

/** One node's contribution to one section, as handed over by a backend. */
export interface EmitBlock {
  nodeId: string
  kind: NodeKind
  section: EmitSection
  /** Exactly the text the backend placed in the file. */
  text: string
}

export interface ProvenanceRange {
  nodeId: string
  kind: NodeKind
  section: EmitSection
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
}

export interface Provenance {
  /** Project-relative path this map applies to. */
  file: string
  ranges: ProvenanceRange[]
}

/**
 * Locate each block in `text`.
 *
 * ONE CURSOR PER SECTION, not one overall. The blocks arrive grouped by
 * node — node A's declare, init and process, then node B's — but the file
 * is grouped the other way round: every declaration at the top, every
 * process line inside the audio callback, every init inside `main`/`setup`,
 * every loop hook inside the housekeeping loop. A single advancing cursor
 * therefore fails on the second block it sees, because that text lives
 * further back in the file than the first. Within a section the blocks DO
 * appear in emission order, so a per-section cursor is both correct and
 * still immune to matching a repeated fragment backwards.
 *
 * Blocks that cannot be found are skipped rather than guessed at. That
 * happens legitimately: a backend may post-process a section (trimming, or
 * the menu-runtime de-duplication) so the text in the file is no longer
 * byte-identical to what the emitter returned. A missing range costs a
 * highlight; a wrong one would point at the wrong node, which is worse.
 */
export function buildProvenance(file: string, text: string, blocks: EmitBlock[]): Provenance {
  const ranges: ProvenanceRange[] = []
  // Line number at each character offset, computed once — `split` per block
  // would be O(blocks x file).
  const lineAt = lineIndex(text)
  const cursors: Record<EmitSection, number> = { declare: 0, init: 0, process: 0, loop: 0 }

  for (const b of blocks) {
    const trimmed = b.text.replace(/\s+$/, '')
    if (!trimmed) continue
    const at = text.indexOf(trimmed, cursors[b.section])
    if (at < 0) continue
    cursors[b.section] = at + trimmed.length
    ranges.push({
      nodeId: b.nodeId,
      kind: b.kind,
      section: b.section,
      startLine: lineAt(at),
      endLine: lineAt(at + trimmed.length)
    })
  }

  ranges.sort((a, b) => a.startLine - b.startLine)
  return { file, ranges }
}

/** Offset -> 1-based line number, via binary search over line starts. */
function lineIndex(text: string): (offset: number) => number {
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** Every range touching `line`, innermost (shortest) first. */
export function nodesAtLine(p: Provenance | undefined, line: number): ProvenanceRange[] {
  if (!p) return []
  return p.ranges
    .filter((r) => line >= r.startLine && line <= r.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))
}

/** Every range a node owns, in file order. */
export function rangesForNode(p: Provenance | undefined, nodeId: string): ProvenanceRange[] {
  if (!p) return []
  return p.ranges.filter((r) => r.nodeId === nodeId).sort((a, b) => a.startLine - b.startLine)
}
