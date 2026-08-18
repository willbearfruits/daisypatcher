/**
 * ESP32-S3 SuperMini pinout — the ESP32-S3-Zero form factor.
 *
 * "ESP32-S3 SuperMini" as sold is the Waveshare ESP32-S3-Zero layout (or a
 * clone of it): 18 x 23.5 mm, USB-C, ESP32-S3FH4R2 (4 MB flash, 2 MB
 * QSPI PSRAM), a WS2812 RGB LED on GPIO21, and 2 x 9 castellated header
 * pins at 2.54 mm plus a set of SMD pads that are not on the header rows.
 * Transcribed 2026-08-17 from the vendor pin card of a board in hand
 * (docs/ had the photo); this replaces a provisional 11-per-side guess.
 *
 * Board viewed from the top, USB-C UP:
 *
 *   LEFT  (top→bottom):  5V  GND  3V3   1   2   3   4   5   6
 *   RIGHT (top→bottom):  TX(43) RX(44) 13  12  11  10   9   8   7
 *
 * Pads (bindable in the inspector, not drawn on the header rows):
 *   bottom-right castellations  GPIO14 GPIO15 GPIO16
 *   back-side pads              GPIO17 GPIO18 GPIO38 GPIO39 GPIO40 GPIO41 GPIO42 GPIO45
 *
 * Constraints:
 *   - ADC1 = GPIO1–10 (usable with WiFi), ADC2 = GPIO11–18 (not with WiFi;
 *     the generated firmware runs no WiFi, so both work as knobs).
 *   - Strapping: GPIO0 (BOOT button, not on the header), GPIO3, GPIO45.
 *   - GPIO19/20 are USB D-/D+ — not exposed. GPIO21 drives the RGB LED —
 *     not exposed either, so it is not in this table.
 *   - Arduino-core defaults on the S3: I2C SDA=8 SCL=9, SPI SS=10 MOSI=11
 *     SCK=12 MISO=13, UART0 TX=43 RX=44. I2S has no fixed pins (GPIO
 *     matrix), so any header pin carries BCLK/WS/DATA.
 *   - The 2 MB PSRAM is quad-SPI on a 4 MB-flash part; the target profile
 *     declares `psram: { bus: 'qspi', flash: '4MB' }` and codegen emits the
 *     matching platformio.ini block, so the granulator gets its full
 *     buffer here.
 */
import type { PinCapabilities } from '@/types/hardware'
import type { BoardGeometry } from './boardPinout'
import { preferDedicated } from './pinPreference'

export const ESP32_S3_SM_PINS: PinCapabilities[] = [
  // ---- LEFT header (top→bottom after 5V/GND/3V3): ADC1 block ----
  { pin: 'GPIO1',  gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO1 / ADC1_0' },
  { pin: 'GPIO2',  gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO2 / ADC1_1' },
  { pin: 'GPIO3',  gpio: true, adc: true,  dac: false, pwm: true, strapping: true, label: 'GPIO3 (strap) / ADC1_2' },
  { pin: 'GPIO4',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'sck',  label: 'GPIO4 / ADC1_3' },
  { pin: 'GPIO5',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'ws',   label: 'GPIO5 / ADC1_4' },
  { pin: 'GPIO6',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'sd',   label: 'GPIO6 / ADC1_5' },
  // ---- RIGHT header (bottom→top): ADC1 7–10, ADC2 11–13, UART ----
  { pin: 'GPIO7',  gpio: true, adc: true,  dac: false, pwm: true, i2s: 'sd',   label: 'GPIO7 / ADC1_6' },
  { pin: 'GPIO8',  gpio: true, adc: true,  dac: false, pwm: true, i2c: 'sda',  label: 'GPIO8 / ADC1_7 / I2C_SDA' },
  { pin: 'GPIO9',  gpio: true, adc: true,  dac: false, pwm: true, i2c: 'scl',  label: 'GPIO9 / ADC1_8 / I2C_SCL' },
  { pin: 'GPIO10', gpio: true, adc: true,  dac: false, pwm: true, spi: 'cs',   label: 'GPIO10 / ADC1_9 / SPI_CS' },
  { pin: 'GPIO11', gpio: true, adc: true,  dac: false, pwm: true, spi: 'mosi', label: 'GPIO11 / ADC2_0 / SPI_MOSI' },
  { pin: 'GPIO12', gpio: true, adc: true,  dac: false, pwm: true, spi: 'sck',  label: 'GPIO12 / ADC2_1 / SPI_SCK' },
  { pin: 'GPIO13', gpio: true, adc: true,  dac: false, pwm: true, spi: 'miso', i2s: 'mclk', label: 'GPIO13 / ADC2_2 / SPI_MISO' },
  { pin: 'GPIO43', gpio: true, adc: false, dac: false, pwm: true, uart: 'tx', label: 'GPIO43 / UART_TX' },
  { pin: 'GPIO44', gpio: true, adc: false, dac: false, pwm: true, uart: 'rx', label: 'GPIO44 / UART_RX' },
  // ---- Pads, not on the header rows. Listed LAST so first-free auto-
  //      assignment reaches for a header pin before a solder pad. ----
  { pin: 'GPIO14', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO14 / ADC2_3 (pad)' },
  { pin: 'GPIO15', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO15 / ADC2_4 (pad)' },
  { pin: 'GPIO16', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO16 / ADC2_5 (pad)' },
  { pin: 'GPIO17', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO17 / ADC2_6 (back pad)' },
  { pin: 'GPIO18', gpio: true, adc: true,  dac: false, pwm: true, label: 'GPIO18 / ADC2_7 (back pad)' },
  { pin: 'GPIO38', gpio: true, adc: false, dac: false, pwm: true, label: 'GPIO38 (back pad)' },
  { pin: 'GPIO39', gpio: true, adc: false, dac: false, pwm: true, label: 'GPIO39 (back pad)' },
  { pin: 'GPIO40', gpio: true, adc: false, dac: false, pwm: true, label: 'GPIO40 (back pad)' },
  { pin: 'GPIO41', gpio: true, adc: false, dac: false, pwm: true, label: 'GPIO41 (back pad)' },
  { pin: 'GPIO42', gpio: true, adc: false, dac: false, pwm: true, label: 'GPIO42 (back pad)' },
  { pin: 'GPIO45', gpio: true, adc: false, dac: false, pwm: true, strapping: true, label: 'GPIO45 (strap, back pad)' }
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

/**
 * Physical layout, index 0 at the USB-C end, top view, USB up. 9 per side.
 * `side: 'bottom'` = a pad that is not on the header rows: it stays
 * bindable from the inspector but the view does not draw it or wire to it,
 * the same treatment the Seed gives its D0 test pad.
 */
export const ESP32_S3_SM_PHYSICAL_LAYOUT: Esp32S3SmPhysicalPinPosition[] = [
  // LEFT header, USB-C end first
  { pin: '5V',     side: 'left', index: 0, label: '5V',  pinNumber: 1 },
  { pin: 'GND',    side: 'left', index: 1, label: 'GND', pinNumber: 2 },
  { pin: '3V3',    side: 'left', index: 2, label: '3V3', pinNumber: 3 },
  { pin: 'GPIO1',  side: 'left', index: 3, label: 'GPIO1 / ADC1_0', pinNumber: 4 },
  { pin: 'GPIO2',  side: 'left', index: 4, label: 'GPIO2 / ADC1_1', pinNumber: 5 },
  { pin: 'GPIO3',  side: 'left', index: 5, label: 'GPIO3 / ADC1_2', pinNumber: 6 },
  { pin: 'GPIO4',  side: 'left', index: 6, label: 'GPIO4 / ADC1_3', pinNumber: 7 },
  { pin: 'GPIO5',  side: 'left', index: 7, label: 'GPIO5 / ADC1_4', pinNumber: 8 },
  { pin: 'GPIO6',  side: 'left', index: 8, label: 'GPIO6 / ADC1_5', pinNumber: 9 },

  // RIGHT header, USB-C end first
  { pin: 'GPIO43', side: 'right', index: 0, label: 'GPIO43 / UART_TX', pinNumber: 10 },
  { pin: 'GPIO44', side: 'right', index: 1, label: 'GPIO44 / UART_RX', pinNumber: 11 },
  { pin: 'GPIO13', side: 'right', index: 2, label: 'GPIO13 / SPI_MISO', pinNumber: 12 },
  { pin: 'GPIO12', side: 'right', index: 3, label: 'GPIO12 / SPI_SCK',  pinNumber: 13 },
  { pin: 'GPIO11', side: 'right', index: 4, label: 'GPIO11 / SPI_MOSI', pinNumber: 14 },
  { pin: 'GPIO10', side: 'right', index: 5, label: 'GPIO10 / SPI_CS',   pinNumber: 15 },
  { pin: 'GPIO9',  side: 'right', index: 6, label: 'GPIO9 / I2C_SCL',   pinNumber: 16 },
  { pin: 'GPIO8',  side: 'right', index: 7, label: 'GPIO8 / I2C_SDA',   pinNumber: 17 },
  { pin: 'GPIO7',  side: 'right', index: 8, label: 'GPIO7 / ADC1_6',    pinNumber: 18 },

  // Pads — bottom-right castellations, then the back side
  { pin: 'GPIO14', side: 'bottom', index: 0,  label: 'GPIO14 (pad)' },
  { pin: 'GPIO15', side: 'bottom', index: 1,  label: 'GPIO15 (pad)' },
  { pin: 'GPIO16', side: 'bottom', index: 2,  label: 'GPIO16 (pad)' },
  { pin: 'GPIO17', side: 'bottom', index: 3,  label: 'GPIO17 (back pad)' },
  { pin: 'GPIO18', side: 'bottom', index: 4,  label: 'GPIO18 (back pad)' },
  { pin: 'GPIO38', side: 'bottom', index: 5,  label: 'GPIO38 (back pad)' },
  { pin: 'GPIO39', side: 'bottom', index: 6,  label: 'GPIO39 (back pad)' },
  { pin: 'GPIO40', side: 'bottom', index: 7,  label: 'GPIO40 (back pad)' },
  { pin: 'GPIO41', side: 'bottom', index: 8,  label: 'GPIO41 (back pad)' },
  { pin: 'GPIO42', side: 'bottom', index: 9,  label: 'GPIO42 (back pad)' },
  { pin: 'GPIO45', side: 'bottom', index: 10, label: 'GPIO45 (strap, back pad)' }
]

export const ESP32_S3_SM_PINS_IN_ORDER: string[] = ESP32_S3_SM_PHYSICAL_LAYOUT
  .filter((p) => p.pin.startsWith('GPIO'))
  .map((p) => p.pin)

export function esp32S3SmPinsForRole(role: string, kind: string): string[] {
  const r = role.toLowerCase()
  return preferDedicated(ESP32_S3_SM_PINS.filter((cap) => {
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
  }), r).map((c) => c.pin)
}

/**
 * 9 rows/side. Same 50-unit pitch as the C3 SuperMini (that board is 8 rows
 * in 410), so the two SuperMinis draw at the same scale; boardY keeps the
 * silhouette centred where the C3's was.
 */
export const ESP32_S3_SM_GEOMETRY: BoardGeometry = {
  boardW: 150,
  boardH: 460,
  boardY: 520,
  pinEdgeInset: 14,
  rowTopMargin: 30,
  rowBottomMargin: 30,
  leftColumnBottomUp: false,
  silhouette: 'esp32_supermini'
}
