/**
 * Lightweight fuzzy scorer for the palette filter. Query characters must
 * appear in `text` in order (anywhere), and consecutive matches rank
 * higher — so "osc" matches "oscillator" well and "orllt" matches it
 * poorly but still matches.
 *
 * Returns a non-negative score (higher is better), or -1 if the query
 * does not fit at all. An empty query always scores 0 (a trivial match).
 */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let score = 0
  let ti = 0
  let streak = 0
  let prevMatched = false
  for (let qi = 0; qi < q.length; qi++) {
    const qc = q[qi]
    let found = -1
    while (ti < t.length) {
      if (t[ti] === qc) { found = ti; break }
      ti++
    }
    if (found === -1) return -1
    // Reward consecutive hits (streak) and start-of-string hits.
    if (prevMatched) { streak++; score += 3 + streak } else { streak = 0; score += 1 }
    if (found === 0) score += 4
    prevMatched = true
    ti++
  }
  return score
}

/**
 * Full match test: substring first (cheap, high score), then fuzzy.
 * `-1` means no match. Score is comparable across fields.
 */
export function matchScore(text: string, query: string): number {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const idx = t.indexOf(q)
  if (idx !== -1) return 100 + (idx === 0 ? 20 : 0) + Math.max(0, 10 - idx)
  return fuzzyScore(text, query)
}
