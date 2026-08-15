/**
 * Presets — capture, recall, morph.
 *
 * Lives in the Inspector rail in the Patch view and, in a compact form, on
 * the Perform surface: a preset you cannot recall while playing is a preset
 * you will not use.
 *
 * The morph slider is the reason presets are more than bookmarks. Dragging
 * it walks every numeric param between two snapshots at once, which is a
 * thing you cannot do by hand and which turns a pair of sounds into a
 * continuum. Enums snap at the midpoint — there is no value between `sine`
 * and `square`, and inventing one would misrepresent what is happening.
 *
 * The whole drag is ONE undo entry. Without the transaction bracket, a
 * two-second sweep would push a hundred-odd entries and bury everything
 * before it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@/state/store'
import styles from './PresetBar.module.css'

export function PresetBar({ compact = false }: { compact?: boolean }) {
  const presets = useEditorStore((s) => s.presets)
  const activeId = useEditorStore((s) => s.activePresetId)
  const capture = useEditorStore((s) => s.capturePreset)
  const recall = useEditorStore((s) => s.recallPreset)
  const update = useEditorStore((s) => s.updatePreset)
  const remove = useEditorStore((s) => s.deletePreset)
  const rename = useEditorStore((s) => s.renamePreset)
  const morph = useEditorStore((s) => s.morphPresets)
  const begin = useEditorStore((s) => s.beginTransaction)
  const end = useEditorStore((s) => s.endTransaction)

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [morphA, setMorphA] = useState<string | null>(null)
  const [morphB, setMorphB] = useState<string | null>(null)
  const [morphT, setMorphT] = useState(0)
  const morphOpen = useRef(false)

  // Keep the morph endpoints pointing at presets that still exist.
  useEffect(() => {
    const ids = new Set(presets.map((p) => p.id))
    if (morphA && !ids.has(morphA)) setMorphA(null)
    if (morphB && !ids.has(morphB)) setMorphB(null)
  }, [presets, morphA, morphB])

  const startMorph = useCallback(() => {
    if (morphOpen.current) return
    morphOpen.current = true
    begin()
  }, [begin])

  const endMorph = useCallback(() => {
    if (!morphOpen.current) return
    morphOpen.current = false
    end()
  }, [end])

  // A drag interrupted by unmount must still close its transaction, or the
  // next unrelated edit joins this undo step.
  useEffect(() => endMorph, [endMorph])

  const canMorph = presets.length >= 2 && morphA !== null && morphB !== null && morphA !== morphB

  /*
   * Presets compile into the firmware, but only a `preset_recall` node can
   * fire one on the device — there is no hidden runtime service, by design.
   * Codegen warns about this at build time, which is too late to be useful:
   * by then you have already decided the patch is finished. So say it here,
   * next to the presets, while there is still a canvas to drop the node on.
   */
  const hasDriver = useEditorStore((s) => s.graph.nodes.some((n) => n.kind === 'preset_recall'))

  return (
    <section className={`${styles.root} ${compact ? styles.compact : ''}`} aria-label="Presets">
      <header className={styles.head}>
        <span className={styles.title}>PRESETS</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.btn}
          onClick={() => capture()}
          title="Save the current parameter state as a new preset"
        >
          + Capture
        </button>
      </header>

      {presets.length === 0 ? (
        <p className={styles.empty}>
          No presets. Capture saves every knob and switch in the patch — not the
          wiring — so you can get back here.
        </p>
      ) : (
        <ul className={styles.list}>
          {presets.map((p, i) => (
            <li
              key={p.id}
              className={`${styles.row} ${activeId === p.id ? styles.rowActive : ''}`}
            >
              <button
                type="button"
                className={styles.slot}
                onClick={() => recall(p.id)}
                title="Recall"
              >
                {i + 1}
              </button>
              {editing === p.id ? (
                <input
                  className={styles.nameInput}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    rename(p.id, draft.trim() || p.name)
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditing(null)
                    e.stopPropagation()
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={styles.name}
                  onClick={() => recall(p.id)}
                  onDoubleClick={() => {
                    setEditing(p.id)
                    setDraft(p.name)
                  }}
                  title="Click to recall · double-click to rename"
                >
                  {p.name}
                </button>
              )}
              {!compact && (
                <>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => update(p.id)}
                    title="Overwrite with the current state"
                  >
                    ⤓
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.danger}`}
                    onClick={() => remove(p.id)}
                    title="Delete"
                  >
                    ✕
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {presets.length > 0 && !hasDriver && !compact ? (
        <p className={styles.empty}>
          These compile into the firmware, but nothing on the device can select
          one yet — add a <strong>Preset</strong> node and patch a trigger to it.
        </p>
      ) : null}

      {presets.length >= 2 && !compact ? (
        <div className={styles.morph}>
          <div className={styles.morphRow}>
            <select
              className={styles.select}
              value={morphA ?? ''}
              onChange={(e) => setMorphA(e.target.value || null)}
              aria-label="Morph from"
            >
              <option value="">from…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              value={morphB ?? ''}
              onChange={(e) => setMorphB(e.target.value || null)}
              aria-label="Morph to"
            >
              <option value="">to…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={morphT}
            disabled={!canMorph}
            aria-label="Morph amount"
            onPointerDown={startMorph}
            onPointerUp={endMorph}
            onPointerCancel={endMorph}
            onChange={(e) => {
              const t = Number(e.target.value)
              setMorphT(t)
              if (canMorph && morphA && morphB) morph(morphA, morphB, t)
            }}
          />
          <div className={styles.morphNote}>
            {canMorph
              ? `${Math.round(morphT * 100)}% — numbers interpolate, choices snap at 50%`
              : 'pick two presets to morph between'}
          </div>
        </div>
      ) : null}
    </section>
  )
}
