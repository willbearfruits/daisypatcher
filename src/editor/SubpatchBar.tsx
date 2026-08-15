/**
 * Breadcrumb for the subpatch you are inside.
 *
 * Hidden at the root, which is where you spend most of your time — chrome
 * that is always visible to say "you are in the normal place" is chrome
 * that earns nothing.
 *
 * It exists because being inside a box is otherwise invisible: the canvas
 * looks like a canvas, and the difference between "my patch is empty" and
 * "I am two levels down in a subpatch" is the single most disorienting
 * thing a nested editor can get wrong. The bar also states the one
 * non-obvious fact — the whole instrument keeps playing while you are in
 * here, because the engine renders the root, not the level on screen.
 */

import { useEditorStore } from '@/state/store'
import styles from './SubpatchBar.module.css'

export function SubpatchBar() {
  const stack = useEditorStore((s) => s.subpatchStack)
  const exit = useEditorStore((s) => s.exitSubpatch)
  const nodeCount = useEditorStore((s) => s.graph.nodes.length)

  if (stack.length === 0) return null

  /*
   * Inside a poly the note changes, because the fact that matters is
   * different: every edit here happens N times over. Someone who thinks
   * they are editing one oscillator and is actually editing eight will
   * misread the CPU cost of everything they do.
   */
  const top = stack[stack.length - 1]
  const host = top.graph.nodes.find((n) => n.id === top.nodeId)
  const voices =
    host?.kind === 'poly' ? Math.max(1, Math.round(Number(host.params.voices) || 1)) : null

  return (
    <div className={styles.bar} role="navigation" aria-label="Subpatch path">
      <button
        type="button"
        className={styles.up}
        onClick={() => exit()}
        title="Back up one level (Esc)"
      >
        ↑
      </button>
      <span className={styles.crumbs}>
        <span className={styles.root}>patch</span>
        {stack.map((level, i) => (
          <span key={level.nodeId} className={styles.crumb}>
            <span className={styles.sep}>/</span>
            <span className={i === stack.length - 1 ? styles.here : undefined}>{level.label}</span>
          </span>
        ))}
      </span>
      <span className={styles.spacer} />
      <span className={styles.note}>
        {voices !== null
          ? `one voice · ${nodeCount} node${nodeCount === 1 ? '' : 's'} × ${voices} = ${nodeCount * voices} compiled`
          : `${nodeCount} node${nodeCount === 1 ? '' : 's'} · the whole patch is still playing`}
      </span>
    </div>
  )
}
