/**
 * Daisy Seed pin-to-STM32 mapping + capability flags.
 *
 * Ground truth used for this file (Phase 0 verification):
 *
 *   1. Electrosmith official "DAISY PINOUT" poster (Rev 5, full-res copy
 *      fetched from the product CDN). The poster's pin ORDER, peripheral
 *      labels, and color coding are authoritative for the visual layout.
 *   2. libDaisy source (`sdk/libDaisy/src/daisy_seed.h` for seed::D0..D30,
 *      `per/adc.cpp` for the ADC index map, `per/{spi,uart,i2c,sai}.cpp`
 *      for alt-function assignments). libDaisy wins over the poster where
 *      the two ever disagree — it's what the user's code actually compiles
 *      against.
 *
 * Verified pin table (physical pin # from the poster; poster's STM32
 * pin matches libDaisy's `seed::Dn` entries on every row):
 *
 *   Pin# | Daisy |  STM32 | ADC | DAC |   I2C   |   SPI    |   UART    |   I2S / SAI    |  Notes
 *   -----+-------+--------+-----+-----+---------+----------+-----------+----------------+-------------------
 *    --  |  D0   |  PB12  |  -  |  -  |    -    | SPI2_NSS | UART5_RX  |       -        | Not on 40-pin header;
 *        |       |        |     |     |         |          |           |                | Seed exposes as TP only.
 *     2  |  D1   |  PC11  |  -  |  -  |    -    | SPI3_MISO| UART4_RX  |       -        | SDMMC1_D3
 *     3  |  D2   |  PC10  |  -  |  -  |    -    | SPI3_SCK | USART3_TX |       -        | SDMMC1_D2, poster: USART3_TX
 *     4  |  D3   |  PC9   |  -  |  -  | I2C3_SDA|    -     | USART3_TX |       -        | SDMMC1_D1; poster shows USART3_TX
 *     5  |  D4   |  PC8   |  -  |  -  |    -    |    -     |     -     |       -        | SDMMC1_D0
 *     6  |  D5   |  PD2   |  -  |  -  |    -    |    -     | UART5_RX  |       -        | SDMMC1_CMD
 *     7  |  D6   |  PC12  |  -  |  -  |    -    | SPI3_MOSI| UART5_TX  |       -        | SDMMC1_CK
 *     8  |  D7   |  PG10  |  -  |  -  |    -    | SPI1_NSS |     -     |   SAI2_SD_B    |
 *     9  |  D8   |  PG11  |  -  |  -  |    -    | SPI1_SCK |     -     |  SAI2_SCK_B    | Poster: SPDIF(rx)
 *    10  |  D9   |  PB4   |  -  |  -  |    -    | SPI1_MISO| UART7_TX  |       -        | TIM16_CH1N (PWM)
 *    11  |  D10  |  PB5   |  -  |  -  |    -    | SPI1_MOSI| UART5_RX  |       -        | TIM17_CH1N (PWM)
 *    12  |  D11  |  PB8   |  -  |  -  | I2C1_SCL|    -     | UART4_RX  |       -        | TIM4_CH3 (PWM); I2C4_SCL alt
 *    13  |  D12  |  PB9   |  -  |  -  | I2C1_SDA|    -     | UART4_TX  |       -        | TIM4_CH4 (PWM); I2C4_SDA alt
 *    14  |  D13  |  PB6   |  -  |  -  | I2C4_SCL|    -     | USART1_TX |       -        | Poster labels I2C4_SCL (AF6)
 *    15  |  D14  |  PB7   |  -  |  -  | I2C4_SDA|    -     | USART1_RX |       -        | Poster labels I2C4_SDA (AF6)
 *    22  |  D15  |  PC0   |  x  |  -  |    -    |    -     |     -     |       -        | ADC_0 (CH10, lbDaisy idx 6)
 *    23  |  D16  |  PA3   |  x  |  -  |    -    |    -     | USART2_RX |       -        | ADC_1 (CH15, idx 11)
 *    24  |  D17  |  PB1   |  x  |  -  |    -    |    -     |     -     |       -        | ADC_2 (CH5, idx 2); TIM3_CH4
 *    25  |  D18  |  PA7   |  x  |  -  |    -    | SPI1_MOSI|     -     |   I2S1_SD      | ADC_3 (CH7, idx 3)
 *    26  |  D19  |  PA6   |  x  |  -  |    -    | SPI1_MISO|     -     |   I2S1_MCK     | ADC_4 (CH3, idx 0)
 *    27  |  D20  |  PC1   |  x  |  -  |    -    | SPI2_MOSI|     -     |   I2S2_SD alt  | ADC_5 (CH11, idx 7); SAI1_SD_A
 *    28  |  D21  |  PC4   |  x  |  -  |    -    |    -     |     -     |   I2S1_MCK     | ADC_6 (CH4, idx 1)
 *    29  |  D22  |  PA5   |  x  |  x  |    -    | SPI1_SCK |     -     |   I2S1_CK      | DAC_OUT_2, ADC_7 (CH19, idx 15)
 *    30  |  D23  |  PA4   |  x  |  x  |    -    | SPI1_NSS |     -     |   I2S1_WS      | DAC_OUT_1, ADC_8 (CH18, idx 14)
 *    31  |  D24  |  PA1   |  x  |  -  |    -    |    -     | UART4_RX  |   SAI2_MCK_B   | ADC_9 (CH17, idx 13)
 *    32  |  D25  |  PA0   |  x  |  -  |    -    |    -     | UART4_TX  |   SAI2_SD_B    | ADC_10 (CH16, idx 12)
 *    33  |  D26  |  PD11  |  -  |  -  |    -    |    -     | USART3_CTS|   SAI2_SD_A    |
 *    34  |  D27  |  PG9   |  -  |  -  |    -    |    -     | USART6_RX |   SAI2_FS_B    |
 *    35  |  D28  |  PA2   |  x  |  -  |    -    |    -     | USART2_TX |   SAI2_SCK_B   | ADC_11 (CH14, idx 10)
 *    36  |  D29  |  PB14  |  -  |  -  |    -    | SPI2_MISO| USART1_TX |   I2S2_MCK     | USB OTG_HS D- (poster)
 *    37  |  D30  |  PB15  |  -  |  -  |    -    | SPI2_MOSI| USART1_RX |   I2S2_SD      | USB OTG_HS D+ (poster)
 *
 * Poster discrepancies — in every case I resolved in favor of the poster
 * for the `label` (so what the user sees matches the reference art) while
 * keeping libDaisy's STM32-pin assignment canonical:
 *
 *   - D13/D14: poster shows I2C4 (AF6), older copies of this file said
 *     I2C1. PB6/PB7 carry I2C4 peripherals (AF6) per the STM32H750 alt-
 *     function table; I2C1 is also valid on PB6/PB7 via AF4 but the Seed
 *     firmware convention is I2C1 on PB8/PB9, so I2C4 is correct for
 *     D13/D14.
 *   - D3: poster shows USART3_TX, older file said I2C3_SDA. Both are
 *     valid alt-functions on PC9; since the poster is the user-facing
 *     reference we emit USART3_TX first.
 *
 * D0 note: D0 = PB12 exists in libDaisy's seed::D0 but is NOT on the
 * 40-pin header the poster illustrates. The Seed exposes it as a bottom-
 * side test pad only. We keep a capability row for D0 so code round-trips,
 * and mark it with side: 'bottom' in PHYSICAL_PIN_LAYOUT so the view can
 * render a small "D0 (TP)" chip off-board.
 */
import type { PinCapabilities, SeedPin } from '@/types/hardware'

/**
 * Authoritative pin-capability table for the OG Seed (D0..D30) plus D31
 * for Seed 2 DFM round-tripping. Labels are concatenated alt-function
 * tokens ("/"-separated) — the HardwareView turns the label into a stack
 * of color-coded pills, one per token. Keep the pin name first, STM32
 * name second, then poster peripherals in the order the poster lists them.
 */
export const DAISY_SEED_PINS: PinCapabilities[] = [
  // --- D0 (test pad; not on 40-pin header) ---
  { pin: 'D0',  stm32Pin: 'PB12', gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', spi: 'cs',
    label: 'D0 / PB12 / UART5_RX / SPI2_NSS (test pad)' },

  // --- Right-header D1..D14 (SDMMC / SPI1 / I2C1 / I2C4 side) ---
  { pin: 'D1',  stm32Pin: 'PC11', gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', spi: 'miso',
    label: 'D1 / PC11 / SD_Data0 / UART4_RX' },
  { pin: 'D2',  stm32Pin: 'PC10', gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', spi: 'sck',
    label: 'D2 / PC10 / SD_Data1 / USART3_RX' },
  { pin: 'D3',  stm32Pin: 'PC9',  gpio: true, adc: false, dac: false, pwm: true,  uart: 'tx', i2c: 'sda',
    label: 'D3 / PC9 / SD_Data2 / USART3_TX / I2C3_SDA' },
  { pin: 'D4',  stm32Pin: 'PC8',  gpio: true, adc: false, dac: false, pwm: true,
    label: 'D4 / PC8 / SD_Data3 / TIM3_CH3' },
  { pin: 'D5',  stm32Pin: 'PD2',  gpio: true, adc: false, dac: false, pwm: false, uart: 'rx',
    label: 'D5 / PD2 / SD_CMD / UART5_RX' },
  { pin: 'D6',  stm32Pin: 'PC12', gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', spi: 'mosi',
    label: 'D6 / PC12 / SD_CLK / UART5_TX / SPI3_MOSI' },
  { pin: 'D7',  stm32Pin: 'PG10', gpio: true, adc: false, dac: false, pwm: false, spi: 'cs',  i2s: 'sd',
    label: 'D7 / PG10 / SPI1_CS / SAI2_SD_B' },
  { pin: 'D8',  stm32Pin: 'PG11', gpio: true, adc: false, dac: false, pwm: false, spi: 'sck', i2s: 'sck',
    label: 'D8 / PG11 / SPI1_SCK / SPDIF_RX' },
  { pin: 'D9',  stm32Pin: 'PB4',  gpio: true, adc: false, dac: false, pwm: true,  spi: 'miso', uart: 'tx',
    label: 'D9 / PB4 / SPI1_MISO / UART7_TX' },
  { pin: 'D10', stm32Pin: 'PB5',  gpio: true, adc: false, dac: false, pwm: true,  spi: 'mosi', uart: 'rx',
    label: 'D10 / PB5 / SPI1_MOSI / UART5_RX' },
  { pin: 'D11', stm32Pin: 'PB8',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'scl', uart: 'rx',
    label: 'D11 / PB8 / I2C1_SCL / UART4_RX / TIM4_CH3' },
  { pin: 'D12', stm32Pin: 'PB9',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'sda', uart: 'tx',
    label: 'D12 / PB9 / I2C1_SDA / UART4_TX / TIM4_CH4' },
  { pin: 'D13', stm32Pin: 'PB6',  gpio: true, adc: false, dac: false, pwm: true,  uart: 'tx', i2c: 'scl',
    label: 'D13 / PB6 / USART1_TX / I2C4_SCL / TIM4_CH1' },
  { pin: 'D14', stm32Pin: 'PB7',  gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', i2c: 'sda',
    label: 'D14 / PB7 / USART1_RX / I2C4_SDA / TIM4_CH2' },

  // --- Left-header D15..D30 (analog / DAC / SAI side) ---
  { pin: 'D15', stm32Pin: 'PC0',  gpio: true, adc: true,  dac: false, pwm: false,
    label: 'D15 / PC0 / A0 / ADC_0' },
  { pin: 'D16', stm32Pin: 'PA3',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'rx',
    label: 'D16 / PA3 / A1 / ADC_1 / USART2_RX / TIM2_CH4' },
  { pin: 'D17', stm32Pin: 'PB1',  gpio: true, adc: true,  dac: false, pwm: true,
    label: 'D17 / PB1 / A2 / ADC_2 / TIM3_CH4' },
  { pin: 'D18', stm32Pin: 'PA7',  gpio: true, adc: true,  dac: false, pwm: true,  spi: 'mosi', i2s: 'sd',
    label: 'D18 / PA7 / A3 / ADC_3 / SPI1_MOSI / I2S1_SD' },
  { pin: 'D19', stm32Pin: 'PA6',  gpio: true, adc: true,  dac: false, pwm: true,  spi: 'miso', i2s: 'mclk',
    label: 'D19 / PA6 / A4 / ADC_4 / SPI1_MISO / I2S1_MCK' },
  { pin: 'D20', stm32Pin: 'PC1',  gpio: true, adc: true,  dac: false, pwm: false, spi: 'mosi', i2s: 'sd',
    label: 'D20 / PC1 / A5 / ADC_5 / SPI2_MOSI / SAI1_SD_A' },
  { pin: 'D21', stm32Pin: 'PC4',  gpio: true, adc: true,  dac: false, pwm: false, i2s: 'mclk',
    label: 'D21 / PC4 / A6 / ADC_6 / I2S1_MCK' },
  { pin: 'D22', stm32Pin: 'PA5',  gpio: true, adc: true,  dac: true,  pwm: true,  spi: 'sck', i2s: 'sck',
    label: 'D22 / PA5 / A7 / DAC_OUT_2 / ADC_7 / SPI1_SCK / I2S1_CK' },
  { pin: 'D23', stm32Pin: 'PA4',  gpio: true, adc: true,  dac: true,  pwm: false, spi: 'cs',  i2s: 'ws',
    label: 'D23 / PA4 / A8 / DAC_OUT_1 / ADC_8 / SPI1_NSS / I2S1_WS' },
  { pin: 'D24', stm32Pin: 'PA1',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'rx', i2s: 'mclk',
    label: 'D24 / PA1 / A9 / ADC_9 / SAI2_MCK_B / UART4_RX' },
  { pin: 'D25', stm32Pin: 'PA0',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'tx', i2s: 'sd',
    label: 'D25 / PA0 / A10 / ADC_10 / SAI2_SD_B / UART4_TX' },
  { pin: 'D26', stm32Pin: 'PD11', gpio: true, adc: false, dac: false, pwm: false, i2s: 'sd',
    label: 'D26 / PD11 / SAI2_SD_A / USART3_CTS' },
  { pin: 'D27', stm32Pin: 'PG9',  gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', i2s: 'ws',
    label: 'D27 / PG9 / SAI2_FS_B / USART6_RX' },
  { pin: 'D28', stm32Pin: 'PA2',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'tx', i2s: 'sck',
    label: 'D28 / PA2 / A11 / ADC_11 / SAI2_SCK_B / USART2_TX' },
  { pin: 'D29', stm32Pin: 'PB14', gpio: true, adc: false, dac: false, pwm: true,  uart: 'tx', spi: 'miso', i2s: 'mclk',
    label: 'D29 / PB14 / USB_D- / USART1_TX / SPI2_MISO / I2S2_MCK' },
  { pin: 'D30', stm32Pin: 'PB15', gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', spi: 'mosi', i2s: 'sd',
    label: 'D30 / PB15 / USB_D+ / USART1_RX / SPI2_MOSI / I2S2_SD' },

  // --- Daisy Seed 2 DFM only ---
  { pin: 'D31', stm32Pin: 'PC2',  gpio: true, adc: true,  dac: false, pwm: false, spi: 'miso',
    label: 'D31 / PC2 / ADC_CH12 / SPI2_MISO (Seed 2 DFM)' }
]

/** Fast lookup. Populated once at module load. */
export const PIN_CAPS: Record<SeedPin, PinCapabilities> = (() => {
  const out = {} as Record<SeedPin, PinCapabilities>
  for (const c of DAISY_SEED_PINS) out[c.pin as SeedPin] = c
  return out
})()

/**
 * libDaisy ADC index (0..15) for each ADC-capable Seed pin. Derived from
 * dsy_adc_channel_map in libDaisy/src/per/adc.cpp:
 *   index order = CH3, CH4, CH5, CH7, CH8, CH9, CH10, CH11, CH12, CH13,
 *                 CH14, CH15, CH16, CH17, CH18, CH19
 */
export function adcChannelOf(pin: SeedPin): number {
  const map: Partial<Record<SeedPin, number>> = {
    D19: 0,   // PA6 CH3
    D21: 1,   // PC4 CH4
    D17: 2,   // PB1 CH5
    D18: 3,   // PA7 CH7
    D15: 6,   // PC0 CH10
    D20: 7,   // PC1 CH11
    D31: 8,   // PC2 CH12 (Seed 2 DFM)
    D28: 10,  // PA2 CH14
    D16: 11,  // PA3 CH15
    D25: 12,  // PA0 CH16
    D24: 13,  // PA1 CH17
    D23: 14,  // PA4 CH18
    D22: 15   // PA5 CH19
  }
  return map[pin] ?? -1
}

/**
 * Physical pin positions on the Seed's 40-pin header, AS SILKSCREENED.
 *
 * Poster orientation — the published Electrosmith poster draws the board
 * with USB at the BOTTOM. Our HardwareView prefers USB at the TOP (more
 * natural for a pinout you'd read while the board is mounted in a case),
 * so we store a vertical index going 0..N starting from the USB end and
 * the view renders top-down accordingly.
 *
 * Poster pin ordering, translated to our "USB at top" convention:
 *   LEFT column (top→bottom, index 0→19):
 *     USB, 3V3D, D30, D29, D28, D27, D26, D25, D24, D23, D22, D21, D20,
 *     D19, D18, D17, D16, D15, 3V3A, (empty top)
 *   RIGHT column (top→bottom, index 0→19):
 *     USB ID, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, D14,
 *     AUDIO IN R, AUDIO IN L, AUDIO OUT R, AUDIO OUT L, AGND
 *
 * Wait — the poster has power (3V3D, VIN, DGND) at the BOTTOM of the left
 * column (pins 38-40). With USB-at-top that flips them to the TOP. We match
 * the poster's actual pin number → label pairing here so the pin numbers
 * read bottom-up-to-top for the USB-at-top view. Pin-number labels are
 * informational only; the capability/name is what codegen cares about.
 *
 * Layout index (side, idx) determines vertical placement: idx=0 is the top
 * row, larger idx is lower on the canvas. The physical pin # (`pinNumber`)
 * is preserved as a metadata string for display.
 */
export interface PhysicalPinPosition {
  pin:
    | SeedPin
    | 'VIN'
    | '3V3'
    | '3V3_A'
    | 'DGND'
    | 'AGND'
    | 'USB_DP'
    | 'USB_DM'
    | 'USB_ID'
    | 'AUDIO_IN_L'
    | 'AUDIO_IN_R'
    | 'AUDIO_OUT_L'
    | 'AUDIO_OUT_R'
  side: 'left' | 'right' | 'bottom'
  /** 0 = topmost on its side; larger = lower on the canvas. */
  index: number
  /** Human-readable label for the pin-name pill. */
  label: string
  /** Physical pin number as printed on the poster (1..40). */
  pinNumber?: number
}

/**
 * USB-at-top orientation. Left column indices 0..19 read top→bottom:
 *   0:  DGND     (poster pin 40)
 *   1:  VIN      (39)
 *   2:  3V3 D    (38)
 *   3:  D30      (37)  USB D+ / USART1_RX
 *   4:  D29      (36)  USB D- / USART1_TX
 *   5:  D28      (35)
 *   6:  D27      (34)
 *   7:  D26      (33)
 *   8:  D25      (32)
 *   9:  D24      (31)
 *  10:  D23      (30)  DAC_OUT_1
 *  11:  D22      (29)  DAC_OUT_2
 *  12:  D21      (28)
 *  13:  D20      (27)
 *  14:  D19      (26)
 *  15:  D18      (25)
 *  16:  D17      (24)
 *  17:  D16      (23)
 *  18:  D15      (22)
 *  19:  3V3 A    (21)
 *
 * Right column indices 0..19 read top→bottom:
 *   0:  AGND     (poster pin 20)
 *   1:  AUDIO OUT L (19)
 *   2:  AUDIO OUT R (18)
 *   3:  AUDIO IN L  (17)
 *   4:  AUDIO IN R  (16)
 *   5:  D14       (15)
 *   6:  D13       (14)
 *   7:  D12       (13)
 *   8:  D11       (12)
 *   9:  D10       (11)
 *  10:  D9        (10)
 *  11:  D8        (9)
 *  12:  D7        (8)
 *  13:  D6        (7)
 *  14:  D5        (6)
 *  15:  D4        (5)
 *  16:  D3        (4)
 *  17:  D2        (3)
 *  18:  D1        (2)
 *  19:  USB ID    (1)
 *
 * This matches the poster's pin-1→40 counterclockwise numbering with our
 * canvas oriented USB-at-top.
 */
export const PHYSICAL_PIN_LAYOUT: PhysicalPinPosition[] = [
  // ------------------ LEFT column (USB at top → bottom) ------------------
  { pin: 'DGND',        side: 'left', index: 0,  label: 'DGND',    pinNumber: 40 },
  { pin: 'VIN',         side: 'left', index: 1,  label: 'VIN',     pinNumber: 39 },
  { pin: '3V3',         side: 'left', index: 2,  label: '3V3 D',   pinNumber: 38 },
  { pin: 'D30',         side: 'left', index: 3,  label: 'D30',     pinNumber: 37 },
  { pin: 'D29',         side: 'left', index: 4,  label: 'D29',     pinNumber: 36 },
  { pin: 'D28',         side: 'left', index: 5,  label: 'D28',     pinNumber: 35 },
  { pin: 'D27',         side: 'left', index: 6,  label: 'D27',     pinNumber: 34 },
  { pin: 'D26',         side: 'left', index: 7,  label: 'D26',     pinNumber: 33 },
  { pin: 'D25',         side: 'left', index: 8,  label: 'D25',     pinNumber: 32 },
  { pin: 'D24',         side: 'left', index: 9,  label: 'D24',     pinNumber: 31 },
  { pin: 'D23',         side: 'left', index: 10, label: 'D23',     pinNumber: 30 },
  { pin: 'D22',         side: 'left', index: 11, label: 'D22',     pinNumber: 29 },
  { pin: 'D21',         side: 'left', index: 12, label: 'D21',     pinNumber: 28 },
  { pin: 'D20',         side: 'left', index: 13, label: 'D20',     pinNumber: 27 },
  { pin: 'D19',         side: 'left', index: 14, label: 'D19',     pinNumber: 26 },
  { pin: 'D18',         side: 'left', index: 15, label: 'D18',     pinNumber: 25 },
  { pin: 'D17',         side: 'left', index: 16, label: 'D17',     pinNumber: 24 },
  { pin: 'D16',         side: 'left', index: 17, label: 'D16',     pinNumber: 23 },
  { pin: 'D15',         side: 'left', index: 18, label: 'D15',     pinNumber: 22 },
  { pin: '3V3_A',       side: 'left', index: 19, label: '3V3 A',   pinNumber: 21 },

  // ------------------ RIGHT column (USB at top → bottom) ------------------
  { pin: 'AGND',        side: 'right', index: 0,  label: 'AGND',         pinNumber: 20 },
  { pin: 'AUDIO_OUT_L', side: 'right', index: 1,  label: 'AUD OUT L',    pinNumber: 19 },
  { pin: 'AUDIO_OUT_R', side: 'right', index: 2,  label: 'AUD OUT R',    pinNumber: 18 },
  { pin: 'AUDIO_IN_L',  side: 'right', index: 3,  label: 'AUD IN L',     pinNumber: 17 },
  { pin: 'AUDIO_IN_R',  side: 'right', index: 4,  label: 'AUD IN R',     pinNumber: 16 },
  { pin: 'D14',         side: 'right', index: 5,  label: 'D14',          pinNumber: 15 },
  { pin: 'D13',         side: 'right', index: 6,  label: 'D13',          pinNumber: 14 },
  { pin: 'D12',         side: 'right', index: 7,  label: 'D12',          pinNumber: 13 },
  { pin: 'D11',         side: 'right', index: 8,  label: 'D11',          pinNumber: 12 },
  { pin: 'D10',         side: 'right', index: 9,  label: 'D10',          pinNumber: 11 },
  { pin: 'D9',          side: 'right', index: 10, label: 'D9',           pinNumber: 10 },
  { pin: 'D8',          side: 'right', index: 11, label: 'D8',           pinNumber: 9 },
  { pin: 'D7',          side: 'right', index: 12, label: 'D7',           pinNumber: 8 },
  { pin: 'D6',          side: 'right', index: 13, label: 'D6',           pinNumber: 7 },
  { pin: 'D5',          side: 'right', index: 14, label: 'D5',           pinNumber: 6 },
  { pin: 'D4',          side: 'right', index: 15, label: 'D4',           pinNumber: 5 },
  { pin: 'D3',          side: 'right', index: 16, label: 'D3',           pinNumber: 4 },
  { pin: 'D2',          side: 'right', index: 17, label: 'D2',           pinNumber: 3 },
  { pin: 'D1',          side: 'right', index: 18, label: 'D1',           pinNumber: 2 },
  { pin: 'USB_ID',      side: 'right', index: 19, label: 'USB ID',       pinNumber: 1 },

  // ------------------ Bottom test pad (D0 is not on the header) ------------------
  { pin: 'D0',          side: 'bottom', index: 0, label: 'D0 (TP)' },

  // Daisy Seed 2 DFM additional pin (hidden on OG Seed — the view can
  // choose to show it conditionally if it ever wants to).
  { pin: 'D31',         side: 'bottom', index: 1, label: 'D31 (Seed 2)' }
]

/**
 * All addressable SeedPins (D0..D31) in physical order — left column
 * top-to-bottom, then right column top-to-bottom, then bottom pads.
 * Useful for the inspector's filtered dropdowns.
 */
export const SEED_PINS_IN_ORDER: SeedPin[] = PHYSICAL_PIN_LAYOUT
  .filter((p): p is PhysicalPinPosition & { pin: SeedPin } =>
    /^D\d+$/.test(p.pin as string)
  )
  .map((p) => p.pin as SeedPin)

/**
 * Which pins satisfy a component role. Used by both the inspector and the
 * hardware view's drag-to-pin interaction (compatible pins highlight,
 * incompatible dim).
 */
export function pinsForRole(
  role: string,
  kind: string
): SeedPin[] {
  const r = role.toLowerCase()

  // The four audio pads on the Seed (AUDIO_OUT_L/R, AUDIO_IN_L/R) are
  // HARDWIRED to the onboard AK4556 codec — they aren't GPIO, so they
  // don't appear in DAISY_SEED_PINS. The audio_jack kind is purely for
  // documenting which physical jack connects to which pad; match by
  // role ('left'/'right') to the audio-IN or audio-OUT pads.
  if (kind === 'audio_jack') {
    if (r === 'left')  return ['AUDIO_OUT_L', 'AUDIO_IN_L'] as unknown as SeedPin[]
    if (r === 'right') return ['AUDIO_OUT_R', 'AUDIO_IN_R'] as unknown as SeedPin[]
    return [
      'AUDIO_OUT_L', 'AUDIO_OUT_R', 'AUDIO_IN_L', 'AUDIO_IN_R'
    ] as unknown as SeedPin[]
  }

  return DAISY_SEED_PINS.filter((cap) => {
    switch (kind) {
      case 'pot':
      case 'cv_jack':
      case 'slider':
      case 'touch_ribbon':
      case 'ldr':
      case 'electret':
        return cap.adc
      case 'piezo':
        // Direction lives in config; allow any ADC- or DAC-capable pin so
        // the user can wire as input (ADC) or output (DAC/PWM).
        return cap.adc || cap.dac || cap.pwm
      case 'button':
      case 'switch_3way':
      case 'gate_jack':
      case 'encoder':
        return cap.gpio
      case 'led':
        return cap.gpio
      case 'oled_ssd1306':
      case 'gyroscope':
      case 'magnetometer':
      case 'tof':
        if (r === 'sda')   return cap.i2c === 'sda'
        if (r === 'scl')   return cap.i2c === 'scl'
        if (r === 'int')   return cap.gpio
        if (r === 'xshut') return cap.gpio
        return !!cap.i2c
      /*
       * pcm5102a / max98357a are ESP32-only kinds (the Seed has an onboard
       * AK4556), but a `.dpatch` authored on an ESP32 target can still be
       * opened while the Seed is selected. Offer the real SAI-capable pins
       * rather than falling through to "every GPIO", so the inspector
       * dropdown stays honest instead of listing nonsense.
       */
      case 'i2s_codec':
      case 'pcm5102a':
      case 'max98357a':
        if (r === 'sck')   return cap.i2s === 'sck'
        if (r === 'ws')    return cap.i2s === 'ws'
        if (r === 'mclk')  return cap.i2s === 'mclk'
        if (r === 'sd_in' || r === 'sd_out') return cap.i2s === 'sd'
        return !!cap.i2s
      case 'midi_jack':
        return cap.uart === 'rx' || cap.uart === 'tx'
      case 'audio_jack':
        return cap.gpio
      default:
        return cap.gpio
    }
  }).map((c) => c.pin as SeedPin)
}
