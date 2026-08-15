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
  IconLineOut,
  IconAmp,
  IconEncoder,
  IconSlider,
  IconTouchRibbon,
  IconLDR,
  IconGyroscope,
  IconMagnetometer,
  IconTof,
  IconElectret,
  IconPiezo
} from './hardwareIcons'
import { useEditorStore } from '@/state/store'
import { isEsp32Target } from '@/codegen/targets'
import styles from './HardwarePalette.module.css'

export const HARDWARE_DRAG_MIME = 'application/x-dp-hardware-kind'

interface HwKindCard {
  kind: HardwareKind
  label: string
  description: string
  icon: () => ReactElement
  /**
   * Kinds that only make sense on an ESP32 target. The Daisy Seed has an
   * onboard AK4556 codec, so an external I2S DAC or amp is never wired to
   * it — and the Seed's SAI1 path is still a codegen stub, so offering
   * these there would produce firmware that silently does nothing.
   */
  esp32Only?: boolean
}

const HARDWARE_CARDS: HwKindCard[] = [
  { kind: 'pot',          label: 'Pot',          description: 'Potentiometer → ADC',      icon: IconPot },
  { kind: 'slider',       label: 'Slider',       description: 'Linear fader → ADC',       icon: IconSlider },
  { kind: 'touch_ribbon', label: 'Ribbon',       description: 'SoftPot / touch strip',    icon: IconTouchRibbon },
  { kind: 'button',       label: 'Button',       description: 'Momentary → GPIO in',      icon: IconButton },
  { kind: 'switch_3way',  label: 'Switch',       description: 'SP3T toggle',              icon: IconSwitch },
  { kind: 'encoder',      label: 'Encoder',      description: 'Rotary with push',         icon: IconEncoder },
  { kind: 'led',          label: 'LED',          description: 'GPIO out, PWM-capable',    icon: IconLED },
  { kind: 'ldr',          label: 'LDR',          description: 'Photoresistor → ADC',      icon: IconLDR },
  { kind: 'electret',     label: 'Mic',          description: 'Electret capsule → ADC',   icon: IconElectret },
  { kind: 'piezo',        label: 'Piezo',        description: 'Knock sensor / buzzer',    icon: IconPiezo },
  { kind: 'gyroscope',    label: 'Gyro / IMU',   description: 'I2C MPU-6050 / ICM',       icon: IconGyroscope },
  { kind: 'magnetometer', label: 'Compass',      description: 'I2C HMC5883L / QMC',       icon: IconMagnetometer },
  { kind: 'tof',          label: 'ToF',          description: 'I2C distance (VL53L0X)',   icon: IconTof },
  { kind: 'gate_jack',    label: 'Gate Jack',    description: '3.5mm gate I/O',           icon: IconGateJack },
  { kind: 'cv_jack',      label: 'CV Jack',      description: '3.5mm CV in/out',          icon: IconCVJack },
  { kind: 'audio_jack',   label: 'Audio Jack',   description: 'TRS stereo',               icon: IconAudioJack },
  { kind: 'midi_jack',    label: 'MIDI Jack',    description: 'DIN5 / TRS MIDI',          icon: IconMidiJack },
  { kind: 'oled_ssd1306', label: 'OLED 128x64',  description: 'I2C SSD1306 display',      icon: IconOLED },
  { kind: 'i2s_codec',    label: 'I2S Codec',    description: 'External I2S DAC/ADC',     icon: IconI2S },
  { kind: 'pcm5102a',     label: 'PCM5102A',     description: 'I2S line-out DAC + jack',  icon: IconLineOut, esp32Only: true },
  { kind: 'max98357a',    label: 'MAX98357A',    description: 'I2S class-D amp → speaker', icon: IconAmp,     esp32Only: true }
]

export function HardwarePalette() {
  const target = useEditorStore((s) => s.target)
  const isEsp32 = isEsp32Target(target)
  return (
    <div className={styles.root}>
      <div className={styles.header}>Hardware</div>
      <div className={styles.scroll}>
        {HARDWARE_CARDS.map((c) => (
          <HardwareCard
            key={c.kind}
            card={c}
            unsupported={c.esp32Only === true && !isEsp32}
          />
        ))}
      </div>
    </div>
  )
}

function HardwareCard({
  card,
  unsupported
}: {
  card: HwKindCard
  unsupported: boolean
}) {
  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (unsupported) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(HARDWARE_DRAG_MIME, card.kind)
    e.dataTransfer.setData('text/plain', card.kind)
  }
  const Icon = card.icon
  return (
    <div
      className={`${styles.card} ${unsupported ? styles.cardUnsupported : ''}`}
      draggable={!unsupported}
      onDragStart={onDragStart}
      data-dp-hardware-kind={card.kind}
      aria-disabled={unsupported || undefined}
      title={
        unsupported
          ? `${card.label} — ESP32 targets only. The Daisy Seed has an onboard audio codec.`
          : card.description
      }
    >
      <span className={styles.cardIcon}>
        <Icon />
      </span>
      <span className={styles.cardBody}>
        <span className={styles.cardLabel}>{card.label}</span>
        <span className={styles.cardDesc}>
          {unsupported ? 'ESP32 targets only' : card.description}
        </span>
      </span>
    </div>
  )
}
