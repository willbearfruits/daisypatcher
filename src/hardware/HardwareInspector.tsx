/**
 * HardwareInspector — right rail for the hardware view.
 *
 * Shows:
 *   - editable label
 *   - pin dropdown per role (filtered to compatible pins)
 *   - kind-specific config (taper for pots, color for LEDs, etc.)
 *   - delete button
 *
 * All mutations route through `useEditorStore` so they participate in the
 * unified history stack. No local buffering.
 */

import { useEditorStore } from '@/state/store'
import { KIND_ROLES } from '@/types/hardware'
import type { BoardPin, HardwareKind, PlacedComponent } from '@/types/hardware'
import { getBoardPinout } from './boardPinout'
import styles from './HardwareInspector.module.css'

export function HardwareInspector() {
  const id = useEditorStore((s) => s.selectedHardwareId)
  const comp = useEditorStore((s) =>
    s.selectedHardwareId
      ? s.hardware.components.find((c) => c.id === s.selectedHardwareId) ?? null
      : null
  )

  if (!id || !comp) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>no selection</span>
          <span className={styles.emptyHint}>(select a component)</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <LabelEditor comp={comp} />
        <span className={styles.headerId}>{comp.kind}</span>
      </div>
      <div className={styles.body}>
        <Section title="Pins">
          {KIND_ROLES[comp.kind].map((role) => (
            <PinRow key={role} comp={comp} role={role} />
          ))}
        </Section>
        <ConfigSection comp={comp} />
        <button
          type="button"
          className={styles.deleteBtn}
          onClick={() => useEditorStore.getState().removeHardware(comp.id)}
        >
          Remove component
        </button>
      </div>
    </div>
  )
}

function LabelEditor({ comp }: { comp: PlacedComponent }) {
  const rename = useEditorStore((s) => s.renameHardware)
  return (
    <input
      className={styles.labelInput}
      value={comp.label}
      onChange={(e) => rename(comp.id, e.target.value)}
      aria-label="Component label"
    />
  )
}

function PinRow({ comp, role }: { comp: PlacedComponent; role: string }) {
  const setPin = useEditorStore((s) => s.setHardwarePin)
  const board = useEditorStore((s) => s.hardware.board)
  const pinout = getBoardPinout(board)
  const current = (comp.pins[role] ?? '') as string
  const allowed = new Set(pinout.pinsForRole(role, comp.kind))
  // If the currently-bound pin isn't valid on this board, flag it.
  const invalid = current && !allowed.has(current)
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{role}</span>
        {current ? (
          <span className={styles.pinBadge}>
            {current}{invalid ? ' \u26A0' : ''}
          </span>
        ) : (
          <span className={styles.pinMissing}>unassigned</span>
        )}
      </div>
      <select
        className={styles.select}
        value={current}
        onChange={(e) => {
          const v = e.target.value
          setPin(comp.id, role, v === '' ? null : (v as BoardPin))
        }}
      >
        <option value="">(none)</option>
        {pinout.pinsInOrder.filter((p) => allowed.has(p)).map((p) => (
          <option key={p} value={p}>
            {pinout.pinCaps[p]?.label ?? p}
          </option>
        ))}
      </select>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  )
}

/** Kind-specific config controls. Simple, declarative — add rows per kind. */
function ConfigSection({ comp }: { comp: PlacedComponent }) {
  const rows = CONFIG_ROWS[comp.kind]
  if (!rows || rows.length === 0) return null
  return (
    <Section title="Config">
      {rows.map((row) => (
        <ConfigRow key={row.key} comp={comp} row={row} />
      ))}
    </Section>
  )
}

type ConfigRowDef =
  | { key: string; label: string; kind: 'text' }
  | { key: string; label: string; kind: 'enum'; options: { value: string; label: string }[] }
  | { key: string; label: string; kind: 'bool' }
  | { key: string; label: string; kind: 'number'; min?: number; max?: number; step?: number }

const CONFIG_ROWS: Partial<Record<HardwareKind, ConfigRowDef[]>> = {
  pot: [
    {
      key: 'taper',
      label: 'Taper',
      kind: 'enum',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'audio', label: 'Audio (log)' },
        { value: 'reverse', label: 'Reverse log' }
      ]
    }
  ],
  led: [
    {
      key: 'color',
      label: 'Color',
      kind: 'enum',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'amber', label: 'Amber' },
        { value: 'green', label: 'Green' },
        { value: 'blue', label: 'Blue' },
        { value: 'white', label: 'White' }
      ]
    },
    { key: 'pwm', label: 'PWM', kind: 'bool' }
  ],
  switch_3way: [
    {
      key: 'positions',
      label: 'Positions',
      kind: 'enum',
      options: [
        { value: '2', label: '2-position' },
        { value: '3', label: '3-position' }
      ]
    }
  ],
  encoder: [
    { key: 'detents', label: 'Detents', kind: 'number', min: 1, max: 64, step: 1 },
    { key: 'withSwitch', label: 'Push-to-select', kind: 'bool' }
  ],
  oled_ssd1306: [
    { key: 'address', label: 'I2C addr', kind: 'text' },
    { key: 'width',  label: 'Width',  kind: 'number', min: 64, max: 256, step: 1 },
    { key: 'height', label: 'Height', kind: 'number', min: 16, max: 128, step: 1 }
  ],
  i2s_codec: [
    {
      key: 'model',
      label: 'Model',
      kind: 'enum',
      options: [
        { value: 'pcm3060', label: 'PCM3060' },
        { value: 'pcm5102', label: 'PCM5102' },
        { value: 'wm8731', label: 'WM8731' }
      ]
    }
  ]
}

function ConfigRow({ comp, row }: { comp: PlacedComponent; row: ConfigRowDef }) {
  const setConfig = useEditorStore((s) => s.setHardwareConfig)
  const raw = comp.config[row.key]
  if (row.kind === 'bool') {
    const checked = !!raw
    return (
      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel}>{row.label}</span>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setConfig(comp.id, row.key, e.target.checked)}
          />
        </div>
      </div>
    )
  }
  if (row.kind === 'enum') {
    return (
      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel}>{row.label}</span>
        </div>
        <select
          className={styles.select}
          value={String(raw ?? row.options[0]?.value ?? '')}
          onChange={(e) => setConfig(comp.id, row.key, e.target.value)}
        >
          {row.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    )
  }
  if (row.kind === 'number') {
    const value = typeof raw === 'number' ? raw : Number(raw ?? 0)
    return (
      <div className={styles.field}>
        <div className={styles.fieldHead}>
          <span className={styles.fieldLabel}>{row.label}</span>
          <span className={styles.fieldValue}>{value}</span>
        </div>
        <input
          type="range"
          className={styles.slider}
          min={row.min ?? 0}
          max={row.max ?? 1}
          step={row.step ?? 1}
          value={value}
          onChange={(e) => setConfig(comp.id, row.key, Number(e.target.value))}
          onPointerDown={() => useEditorStore.getState().beginTransaction()}
          onPointerUp={() => useEditorStore.getState().endTransaction()}
          onBlur={() => useEditorStore.getState().endTransaction()}
        />
      </div>
    )
  }
  // text
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{row.label}</span>
      </div>
      <input
        className={styles.textInput}
        value={String(raw ?? '')}
        onChange={(e) => setConfig(comp.id, row.key, e.target.value)}
      />
    </div>
  )
}
