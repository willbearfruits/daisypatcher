/**
 * ESP32-S3 SuperMini pinout — PROVISIONAL.
 *
 * ============================ READ THIS =============================
 * Unlike the C3 SuperMini, "ESP32-S3 SuperMini" is NOT a standardised
 * board. There is no authoritative published pinout:
 *   - mischianti.org has pages for the C3 SuperMini, C6 SuperMini and
 *     Waveshare S3 Zero, but none for an S3 SuperMini.
 *   - espboards.dev claims 37 pins on a 22.5 x 18 mm board, which cannot
 *     be true: 18 pins per row at 2.54 mm needs 45 mm of edge.
 *   - The community Arduino pin-definition library derived from that page
 *     lists GPIO26-32 as "safe", but those are the SPI flash pins on
 *     every ESP32-S3 module and are not bonded out on any SuperMini.
 *
 * So the table below is a CONSERVATIVE INTERSECTION rather than a
 * transcription: GPIOs that exist and are free on any ESP32-S3-WROOM-1,
 * laid out in the SuperMini form factor. It is deliberately missing pins
 * your board may well expose, and its silkscreen order is a best guess.
 *
 * TO CORRECT IT: read the labels off the physical board and edit
 * `ESP32_S3_SM_PHYSICAL_LAYOUT` (order + which pins exist) and
 * `ESP32_S3_SM_PINS` (capabilities). Nothing else needs to change —
 * `pitch` and the silhouette derive from the row counts automatically.
 * Also revisit `hasPsram` in `codegen/targets/esp32Profiles.ts`, which is
 * currently false because many of these clones ship without it.
 * ====================================================================
 */
import type { PinCapabilities } from '@/types/hardware'
import type { BoardGeometry } from './boardPinout'

export const ESP32_S3_SM_PINS: PinCapabilities[] = [
  // ADC1 block — safe on every S3, ADC1 works with WiFi active.
  { pin: 'GPIO1',  gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO1 / ADC1_0' },
  { pin: 'GPIO2',  gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO2 / ADC1_1' },
  { pin: 'GPIO3',  gpio: true, adc: true,  dac: false, pwm: true, strapping: true, label: 'GPIO3 (strap) / ADC1_2' },
  { pin: 'GPIO4',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'sck',  label: 'GPIO4 / ADC1_3' },
  { pin: 'GPIO5',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'ws',   label: 'GPIO5 / ADC1_4' },
  { pin: 'GPIO6',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'sd',   label: 'GPIO6 / ADC1_5' },
  { pin: 'GPIO7',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'sd',   label: 'GPIO7 / ADC1_6' },
  { pin: 'GPIO8',  gpio: true, adc: true,  dac: false, pwm: true, i2c: 'sda',  label: 'GPIO8 / ADC1_7 / I2C_SDA' },
  { pin: 'GPIO9',  gpio: true, adc: true,  dac: false, pwm: true, i2c: 'scl',  label: 'GPIO9 / ADC1_8 / I2C_SCL' },
  { pin: 'GPIO10', gpio: true, adc: true,  dac: false, pwm: true, spi: 'cs',   label: 'GPIO10 / ADC1_9 / SPI_CS' },
  // ADC2 block — unusable while WiFi is on.
  { pin: 'GPIO11', gpio: true, adc: true,  dac: false, pwm: true, spi: 'mosi', label: 'GPIO11 / ADC2_0 / SPI_MOSI' },
  { pin: 'GPIO12', gpio: true, adc: true,  dac: false, pwm: true, spi: 'sck',  label: 'GPIO12 / ADC2_1 / SPI_SCK' },
  { pin: 'GPIO13', gpio: true, adc: true,  dac: false, pwm: true, spi: 'miso', label: 'GPIO13 / ADC2_2 / SPI_MISO' },
  { pin: 'GPIO14', gpio: true, adc: true,  dac: false, pwm: true, i2s: 'mclk', label: 'GPIO14 / ADC2_3' },
  { pin: 'GPIO15', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO15 / ADC2_4' },
  { pin: 'GPIO16', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO16 / ADC2_5' },
  { pin: 'GPIO17', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO17 / ADC2_6' },
  { pin: 'GPIO18', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO18 / ADC2_7' },
  { pin: 'GPIO21', gpio: true, adc: false, dac: false, pwm: true, label: 'GPIO21' },
  { pin: 'GPIO43', gpio: true, adc: false, dac: false, pwm: true, uart: 'tx', label: 'GPIO43 / UART_TX' },
  { pin: 'GPIO44', gpio: true, adc: false, dac: false, pwm: true, uart: 'rx', label: 'GPIO44 / UART_RX' },
  { pin: 'GPIO48', gpio: true, adc: false, dac: false, pwm: true, label: 'GPIO48 / RGB_LED' }
]

export const ESP32_S3_SM_PIN_CAPS: Record<string, PinCapabilities> = (() => {
  const m: Record<string, PinCapabilities> = {}
  for (const p of ESP32_S3_SM_PINS) m[p.pin] = p
  return m
})()

/** Same convention as the other ESP32 tables: 0..9 = ADC1, 100+ = ADC2. */
export function esp32S3SmAdcChannelOf(pin: string): number {
  const m = /^GPIO(\d+)$/.exec(pin)
  if (!m) return -1
  const n = Number(m[1])
  if (n >= 1 && n <= 10) return n - 1
  if (n >= 11 && n <= 18) return 100 + (n - 11)
  return -1
}

export interface Esp32S3SmPhysicalPinPosition {
  pin: string
  side: 'left' | 'right' | 'bottom'
  index: number
  label: string
  pinNumber?: number
}

/** PROVISIONAL layout — 11 per side. Verify against the board. */
export const ESP32_S3_SM_PHYSICAL_LAYOUT: Esp32S3SmPhysicalPinPosition[] = [
  { pin: '5V',     side: 'left', index: 0,  label: '5V'  },
  { pin: 'GND',    side: 'left', index: 1,  label: 'GND' },
  { pin: '3V3',    side: 'left', index: 2,  label: '3V3' },
  { pin: 'GPIO1',  side: 'left', index: 3,  label: 'GPIO1 / ADC1_0' },
  { pin: 'GPIO2',  side: 'left', index: 4,  label: 'GPIO2 / ADC1_1' },
  { pin: 'GPIO3',  side: 'left', index: 5,  label: 'GPIO3 / ADC1_2' },
  { pin: 'GPIO4',  side: 'left', index: 6,  label: 'GPIO4 / ADC1_3' },
  { pin: 'GPIO5',  side: 'left', index: 7,  label: 'GPIO5 / ADC1_4' },
  { pin: 'GPIO6',  side: 'left', index: 8,  label: 'GPIO6 / ADC1_5' },
  { pin: 'GPIO7',  side: 'left', index: 9,  label: 'GPIO7 / ADC1_6' },
  { pin: 'GPIO8',  side: 'left', index: 10, label: 'GPIO8 / I2C_SDA' },

  { pin: 'GPIO9',  side: 'right', index: 0,  label: 'GPIO9 / I2C_SCL' },
  { pin: 'GPIO10', side: 'right', index: 1,  label: 'GPIO10 / SPI_CS' },
  { pin: 'GPIO11', side: 'right', index: 2,  label: 'GPIO11 / SPI_MOSI' },
  { pin: 'GPIO12', side: 'right', index: 3,  label: 'GPIO12 / SPI_SCK' },
  { pin: 'GPIO13', side: 'right', index: 4,  label: 'GPIO13 / SPI_MISO' },
  { pin: 'GPIO14', side: 'right', index: 5,  label: 'GPIO14 / ADC2_3' },
  { pin: 'GPIO15', side: 'right', index: 6,  label: 'GPIO15 / ADC2_4' },
  { pin: 'GPIO16', side: 'right', index: 7,  label: 'GPIO16 / ADC2_5' },
  { pin: 'GPIO21', side: 'right', index: 8,  label: 'GPIO21' },
  { pin: 'GPIO43', side: 'right', index: 9,  label: 'GPIO43 / UART_TX' },
  { pin: 'GPIO44', side: 'right', index: 10, label: 'GPIO44 / UART_RX' }
]

export const ESP32_S3_SM_PINS_IN_ORDER: string[] = ESP32_S3_SM_PHYSICAL_LAYOUT
  .filter((p) => p.pin.startsWith('GPIO'))
  .map((p) => p.pin)

export function esp32S3SmPinsForRole(role: string, kind: string): string[] {
  const r = role.toLowerCase()
  return ESP32_S3_SM_PINS.filter((cap) => {
    switch (kind) {
      case 'pot':
      case 'cv_jack':
      case 'slider':
      case 'touch_ribbon':
      case 'ldr':
      case 'electret':
        return cap.adc
      case 'piezo':
        return cap.adc || cap.pwm
      case 'button':
      case 'switch_3way':
      case 'gate_jack':
      case 'encoder':
      case 'led':
        return cap.gpio
      case 'oled_ssd1306':
      case 'gyroscope':
      case 'magnetometer':
      case 'tof':
        if (r === 'sda')   return cap.i2c === 'sda' || cap.gpio
        if (r === 'scl')   return cap.i2c === 'scl' || cap.gpio
        if (r === 'int')   return cap.gpio
        if (r === 'xshut') return cap.gpio
        return !!cap.i2c
      case 'i2s_codec':
      case 'pcm5102a':
      case 'max98357a':
        // S3 routes I2S through the GPIO matrix too.
        return cap.gpio
      case 'midi_jack':
        return cap.uart === 'rx' || cap.uart === 'tx' || cap.gpio
      case 'audio_jack':
        return cap.gpio
      default:
        return cap.gpio
    }
  }).map((c) => c.pin)
}

/** 11 rows/side — taller than the C3, still far shorter than a DevKitC. */
export const ESP32_S3_SM_GEOMETRY: BoardGeometry = {
  boardW: 160,
  boardH: 560,
  boardY: 470,
  pinEdgeInset: 14,
  rowTopMargin: 30,
  rowBottomMargin: 30,
  leftColumnBottomUp: false,
  silhouette: 'esp32_supermini'
}
