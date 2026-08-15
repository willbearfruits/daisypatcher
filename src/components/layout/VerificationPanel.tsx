/**
 * VerificationPanel — global checklist of which node kinds are known-good
 * on which target. Opened from the TopBar's check-in-circle icon. Rows:
 * one per NodeKind × target pair (Seed AND ESP32 currently). Rows for
 * kinds that lack a test template (UI-only, hardware-bound) are still
 * listed but their re-test button is disabled.
 *
 * Filters:
 *   - free-text fuzzy name match
 *   - status (all / pass / fail / unknown)
 * Sort: status (pass > fail > unknown), then alpha by kind.
 *
 * Clicking "Re-test" on a row launches the TestRigModal scoped to that
 * kind. TopBar owns the modal's `kind` state so the open/close lifecycle
 * stays simple.
 */

import { useMemo, useState } from 'react'
import type { NodeKind } from '@/types/graph'
import type { BoardTarget } from '@/types/store'
import { NODE_DEFINITIONS, NODE_KINDS } from '@/nodes/definitions'
import {
  useVerificationStore,
  verificationKey,
  type VerificationResult
} from '@/state/verificationStore'
import { hasTestTemplate, disabledReasonFor } from '@/state/testRig'
import { useEditorStore } from '@/state/store'
import styles from './VerificationPanel.module.css'

interface VerificationPanelProps {
  open: boolean
  onClose: () => void
  onRetest: (kind: NodeKind) => void
}

type StatusFilter = 'all' | 'pass' | 'fail' | 'unknown'

function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function timeAgo(ms: number | null): string {
  if (ms === null) return '—'
  const delta = Date.now() - ms
  if (delta < 60000) return 'just now'
  const min = Math.floor(delta / 60000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

function statusBadgeClass(r: VerificationResult): string {
  if (r === 'pass') return styles.badgePass
  if (r === 'fail') return styles.badgeFail
  return styles.badgeUnknown
}

function statusLabel(r: VerificationResult): string {
  if (r === 'pass') return 'PASS'
  if (r === 'fail') return 'FAIL'
  return 'unknown'
}

export function VerificationPanel({ open, onClose, onRetest }: VerificationPanelProps) {
  const target = useEditorStore((s) => s.target)
  const table = useVerificationStore((s) => s.table)

  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  // Compute rows — one per kind for the CURRENT target. Multi-target
  // view would explode the row count; users switch target at the TopBar.
  const rows = useMemo(() => {
    const list = NODE_KINDS.map<{
      kind: NodeKind
      target: BoardTarget
      result: VerificationResult
      lastTestedMs: number | null
      notes: string
      label: string
    }>((kind) => {
      const entry = table[verificationKey(kind, target)] ?? null
      return {
        kind,
        target,
        result: entry ? entry.result : ('unknown' as VerificationResult),
        lastTestedMs: entry?.lastTestedMs ?? null,
        notes: entry?.notes ?? '',
        label: NODE_DEFINITIONS[kind]?.label ?? kind
      }
    })

    const needle = filter.trim().toLowerCase()
    const filtered = list.filter((r) => {
      if (statusFilter !== 'all' && r.result !== statusFilter) return false
      if (!needle) return true
      return (
        r.kind.toLowerCase().includes(needle) ||
        r.label.toLowerCase().includes(needle)
      )
    })

    // Sort: pass → fail → unknown, then alpha by kind.
    const rank: Record<VerificationResult, number> = {
      pass: 0,
      fail: 1,
      unknown: 2
    }
    filtered.sort((a, b) => {
      const d = rank[a.result] - rank[b.result]
      if (d !== 0) return d
      return a.kind.localeCompare(b.kind)
    })
    return filtered
  }, [table, target, filter, statusFilter])

  // Summary counts — for the header.
  const summary = useMemo(() => {
    let pass = 0
    let fail = 0
    let unknown = 0
    for (const k of NODE_KINDS) {
      const entry = table[verificationKey(k, target)]
      if (!entry) {
        unknown++
        continue
      }
      if (entry.result === 'pass') pass++
      else if (entry.result === 'fail') fail++
      else unknown++
    }
    return { pass, fail, unknown, total: NODE_KINDS.length }
  }, [table, target])

  if (!open) return null

  return (
    <div className={styles.backdrop} role="dialog" aria-label="Verification checklist" aria-modal="false">
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.title}>
            <span className={styles.titleKicker}>VERIFIED</span>
            <span className={styles.titleCounts}>
              {summary.pass} / {summary.total} tested on {target}
              {' · '}
              <span className={styles.countFail}>{summary.fail} failing</span>
              {' · '}
              <span className={styles.countUnknown}>{summary.unknown} unknown</span>
            </span>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <IconClose />
          </button>
        </div>

        <div className={styles.toolbar}>
          <input
            className={styles.filterInput}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter kinds…"
            spellCheck={false}
            aria-label="Filter by kind"
          />
          <div className={styles.statusFilter} role="tablist" aria-label="Status filter">
            {(['all', 'pass', 'fail', 'unknown'] as StatusFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={statusFilter === s}
                className={`${styles.statusBtn} ${statusFilter === s ? styles.statusBtnActive : ''}`}
                onClick={() => setStatusFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Last Tested</th>
                <th>Notes</th>
                <th className={styles.actionsHeader}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.empty}>
                    no rows match these filters
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const testable = hasTestTemplate(r.kind)
                  const disabledReason = testable ? '' : disabledReasonFor(r.kind)
                  return (
                    <tr key={`${r.kind}:${r.target}`}>
                      <td className={styles.cellKind}>
                        <span className={styles.kindLabel}>{r.label}</span>
                        <span className={styles.kindId}>{r.kind}</span>
                      </td>
                      <td>
                        <span className={`${styles.badge} ${statusBadgeClass(r.result)}`}>
                          {statusLabel(r.result)}
                        </span>
                      </td>
                      <td className={styles.cellTime}>{timeAgo(r.lastTestedMs)}</td>
                      <td className={styles.cellNotes} title={r.notes}>
                        {r.notes || '—'}
                      </td>
                      <td className={styles.cellAction}>
                        <button
                          type="button"
                          className={styles.retestBtn}
                          onClick={() => onRetest(r.kind)}
                          disabled={!testable}
                          title={
                            testable
                              ? 'Open the test rig for this kind'
                              : disabledReason
                          }
                        >
                          {testable ? 'Test' : '—'}
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
