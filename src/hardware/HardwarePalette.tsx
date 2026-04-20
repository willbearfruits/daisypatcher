/**
 * HardwarePalette — left sidebar for the hardware view. Mirrors the DSP
 * Palette but dispenses PlacedComponents via drag-and-drop. Drag payload
 * uses the 'application/x-dp-hardware-kind' MIME so the hardware canvas
 * can distinguish from the patch palette's node-kind drops.
 */

import type { ReactElement } from 'react'
import type { HardwareKind } from '@/types/hardware'
import {
  IconPot,
  IconButton,
  IconSwitch,
  IconLED,
  IconGateJack,
  IconCVJack,
  IconAudioJack,
  IconMidiJack,
  IconOLED,
  IconI2S,
  IconEncoder
} from './hardwareIcons'
import styles from './HardwarePalette.module.css'

export const HARDWARE_DRAG_MIME = 'application/x-dp-hardware-kind'

interface HwKindCard {
  kind: HardwareKind
  label: string
  description: string
  icon: () => ReactElement
}

const HARDWARE_CARDS: HwKindCard[] = [
  { kind: 'pot',          label: 'Pot',          description: 'Potentiometer → ADC',      icon: IconPot },
  { kind: 'button',       label: 'Button',       description: 'Momentary → GPIO in',      icon: IconButton },
  { kind: 'switch_3way',  label: 'Switch',       description: 'SP3T toggle',              icon: IconSwitch },
  { kind: 'encoder',      label: 'Encoder',      description: 'Rotary with push',         icon: IconEncoder },
  { kind: 'led',          label: 'LED',          description: 'GPIO out, PWM-capable',    icon: IconLED },
  { kind: 'gate_jack',    label: 'Gate Jack',    description: '3.5mm gate I/O',           icon: IconGateJack },
  { kind: 'cv_jack',      label: 'CV Jack',      description: '3.5mm CV in/out',          icon: IconCVJack },
  { kind: 'audio_jack',   label: 'Audio Jack',   description: 'TRS stereo',               icon: IconAudioJack },
  { kind: 'midi_jack',    label: 'MIDI Jack',    description: 'DIN5 / TRS MIDI',          icon: IconMidiJack },
  { kind: 'oled_ssd1306', label: 'OLED 128x64',  description: 'I2C SSD1306 display',      icon: IconOLED },
  { kind: 'i2s_codec',    label: 'I2S Codec',    description: 'External I2S DAC/ADC',     icon: IconI2S }
]

export function HardwarePalette() {
  return (
    <div className={styles.root}>
      <div className={styles.header}>Hardware</div>
      <div className={styles.scroll}>
        {HARDWARE_CARDS.map((c) => (
          <HardwareCard key={c.kind} card={c} />
        ))}
      </div>
    </div>
  )
}

function HardwareCard({ card }: { card: HwKindCard }) {
  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(HARDWARE_DRAG_MIME, card.kind)
    e.dataTransfer.setData('text/plain', card.kind)
  }
  const Icon = card.icon
  return (
    <div
      className={styles.card}
      draggable
      onDragStart={onDragStart}
      data-dp-hardware-kind={card.kind}
      title={card.description}
    >
      <span className={styles.cardIcon}>
        <Icon />
      </span>
      <span className={styles.cardBody}>
        <span className={styles.cardLabel}>{card.label}</span>
        <span className={styles.cardDesc}>{card.description}</span>
      </span>
    </div>
  )
}
