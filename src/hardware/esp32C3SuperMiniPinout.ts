/**
 * ESP32-C3 SuperMini pinout.
 *
 * Board: 22.5 x 18 mm, USB-C, two 8-pin headers at 2.54 mm pitch.
 * MCU: ESP32-C3 (single-core RISC-V, 4 MB flash, NO PSRAM).
 *
 * Sources cross-checked (all agree on the 16-pin layout below):
 *   - lastminuteengineers.com/esp32-c3-super-mini-pinout-reference
 *   - mischianti.org/esp32-c3-super-mini-high-resolution-pinout-...
 *   - espboards.dev/esp32/esp32-c3-super-mini
 * The layout is also geometrically consistent: 8 pins x 2.54 mm = 20.3 mm
 * along a 22.5 mm edge.
 *
 * Only GPIO0-10 plus GPIO20/21 are bonded out. Notable constraints:
 *   - ADC is GPIO0-5 ONLY (ADC1 ch0-4 on GPIO0-4, ADC2 ch0 on GPIO5).
 *     Everything above GPIO5 is digital-only — much tighter than an S3.
 *   - Strapping pins: GPIO2, GPIO8, GPIO9. Do not pull low at boot.
 *     GPIO8 and GPIO9 are still the board's documented I2C pair; their
 *     bus pull-ups hold them high, which is why that works.
 *   - GPIO8 drives the on-board blue LED (active low).
 *   - GPIO9 is the BOOT button.
 *   - GPIO20/21 are UART0 RX/TX.
 *   - I2S has no fixed pins: the C3 routes it through the GPIO matrix, so
 *     any free GPIO can carry BCLK/WS/DATA. Marked broadly below.
 */
import type { PinCapabilities } from '@/types/hardware'
import type { BoardGeometry } from './boardPinout'

export const ESP32_C3_SM_PINS: PinCapabilities[] = [
  // --- ADC-capable block, GPIO0..5 ---
  { pin: 'GPIO0',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'sck', label: 'GPIO0 / ADC1_0' },
  { pin: 'GPIO1',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'ws',  label: 'GPIO1 / ADC1_1' },
  { pin: 'GPIO2',  gpio: true, adc: true,  dac: false, pwm: true, strapping: true, i2s: 'sd', label: 'GPIO2 (strap) / ADC1_2' },
  { pin: 'GPIO3',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'mclk', label: 'GPIO3 / ADC1_3' },
  { pin: 'GPIO4',  gpio: true, adc: true,  dac: false, pwm: true, spi: 'sck',  i2s: 'sck', label: 'GPIO4 / ADC1_4 / SPI_SCK' },
  { pin: 'GPIO5',  gpio: true, adc: true,  dac: false, pwm: true, spi: 'miso', i2s: 'ws',  label: 'GPIO5 / ADC2_0 / SPI_MISO' },

  // --- Digital-only block, GPIO6..10 ---
  { pin: 'GPIO6',  gpio: true, adc: false, dac: false, pwm: true, spi: 'mosi', i2s: 'sd', label: 'GPIO6 / SPI_MOSI' },
  { pin: 'GPIO7',  gpio: true, adc: false, dac: false, pwm: true, spi: 'cs',   i2s: 'sd', label: 'GPIO7 / SPI_CS' },
  { pin: 'GPIO8',  gpio: true, adc: false, dac: false, pwm: true, strapping: true, i2c: 'sda', label: 'GPIO8 (strap/LED) / I2C_SDA' },
  { pin: 'GPIO9',  gpio: true, adc: false, dac: false, pwm: true, strapping: true, i2c: 'scl', label: 'GPIO9 (strap/BOOT) / I2C_SCL' },
  { pin: 'GPIO10', gpio: true, adc: false, dac: false, pwm: true, i2s: 'mclk', label: 'GPIO10' },

  // --- UART0, GPIO20/21 ---
  { pin: 'GPIO20', gpio: true, adc: false, dac: false, pwm: true, uart: 'rx', label: 'GPIO20 / UART_RX' },
  { pin: 'GPIO21', gpio: true, adc: false, dac: false, pwm: true, uart: 'tx', label: 'GPIO21 / UART_TX' }
]

export const ESP32_C3_SM_PIN_CAPS: Record<string, PinCapabilities> = (() => {
  const m: Record<string, PinCapabilities> = {}
  for (const p of ESP32_C3_SM_PINS) m[p.pin] = p
  return m
})()

/**
 * ADC channel index. Same convention as the S3 table: 0..9 means ADC1
 * channel N, 100+ means ADC2 channel N-100, -1 means not ADC-capable.
 *
 * On the C3, ADC1 covers GPIO0-4 and ADC2 has a single channel on GPIO5.
 * ADC2 is unusable while WiFi is active — a real constraint, not a
 * formality, so GPIO5 is a poor choice for a knob.
 */
export function esp32C3SmAdcChannelOf(pin: string): number {
  switch (pin) {
    case 'GPIO0': return 0
    case 'GPIO1': return 1
    case 'GPIO2': return 2
    case 'GPIO3': return 3
    case 'GPIO4': return 4
    case 'GPIO5': return 100
    default: return -1
  }
}

export interface Esp32C3SmPhysicalPinPosition {
  pin: string
  side: 'left' | 'right' | 'bottom'
  index: number
  label: string
  pinNumber?: number
}

/**
 * Physical layout: 8 pins per side, index 0 at the USB-C end.
 * Silkscreen order verified against the published pinout diagrams.
 */
export const ESP32_C3_SM_PHYSICAL_LAYOUT: Esp32C3SmPhysicalPinPosition[] = [
  // LEFT header, USB-C end first
  { pin: '5V',     side: 'left', index: 0, label: '5V',    pinNumber: 1 },
  { pin: 'GND',    side: 'left', index: 1, label: 'GND',   pinNumber: 2 },
  { pin: '3V3',    side: 'left', index: 2, label: '3V3',   pinNumber: 3 },
  { pin: 'GPIO0',  side: 'left', index: 3, label: 'GPIO0 / ADC1_0', pinNumber: 4 },
  { pin: 'GPIO1',  side: 'left', index: 4, label: 'GPIO1 / ADC1_1', pinNumber: 5 },
  { pin: 'GPIO2',  side: 'left', index: 5, label: 'GPIO2 / ADC1_2', pinNumber: 6 },
  { pin: 'GPIO3',  side: 'left', index: 6, label: 'GPIO3 / ADC1_3', pinNumber: 7 },
  { pin: 'GPIO4',  side: 'left', index: 7, label: 'GPIO4 / ADC1_4 / SPI_SCK', pinNumber: 8 },

  // RIGHT header, USB-C end first
  { pin: 'GPIO5',  side: 'right', index: 0, label: 'GPIO5 / ADC2_0 / SPI_MISO', pinNumber: 9 },
  { pin: 'GPIO6',  side: 'right', index: 1, label: 'GPIO6 / SPI_MOSI', pinNumber: 10 },
  { pin: 'GPIO7',  side: 'right', index: 2, label: 'GPIO7 / SPI_CS',   pinNumber: 11 },
  { pin: 'GPIO8',  side: 'right', index: 3, label: 'GPIO8 / I2C_SDA',  pinNumber: 12 },
  { pin: 'GPIO9',  side: 'right', index: 4, label: 'GPIO9 / I2C_SCL',  pinNumber: 13 },
  { pin: 'GPIO10', side: 'right', index: 5, label: 'GPIO10',           pinNumber: 14 },
  { pin: 'GPIO21', side: 'right', index: 6, label: 'GPIO21 / UART_TX', pinNumber: 15 },
  { pin: 'GPIO20', side: 'right', index: 7, label: 'GPIO20 / UART_RX', pinNumber: 16 }
]

export const ESP32_C3_SM_PINS_IN_ORDER: string[] = ESP32_C3_SM_PHYSICAL_LAYOUT
  .filter((p) => p.pin.startsWith('GPIO'))
  .map((p) => p.pin)

/**
 * Role filter. Mirrors the S3 table's shape, but the ADC branch actually
 * bites here: with only six ADC pins, offering a knob every GPIO would
 * hand the user a binding that silently reads nothing.
 */
export function esp32C3SmPinsForRole(role: string, kind: string): string[] {
  const r = role.toLowerCase()
  return ESP32_C3_SM_PINS.filter((cap) => {
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
        // The C3 routes I2S through the GPIO matrix — any free pin works.
        if (r === 'sck' || r === 'ws' || r === 'mclk') return cap.gpio
        if (r === 'sd_in' || r === 'sd_out') return cap.gpio
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

/**
 * Silhouette proportions. 8 rows/side instead of 20, so the board is drawn
 * shorter and narrower — `pitch` is derived from the row count, giving
 * ~50 units between pins, close enough to the big boards' ~49.5 that the
 * pin pills keep the same visual density.
 */
export const ESP32_C3_SM_GEOMETRY: BoardGeometry = {
  boardW: 150,
  boardH: 410,
  boardY: 545,
  pinEdgeInset: 14,
  rowTopMargin: 30,
  rowBottomMargin: 30,
  // This board's data really is listed top-to-bottom from the USB end, so
  // it renders in declaration order — unlike the two older tables, which
  // are reversed to preserve their long-standing appearance.
  leftColumnBottomUp: false,
  silhouette: 'esp32_supermini'
}
