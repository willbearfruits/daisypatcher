/**
 * Daisy Seed pin-to-STM32 mapping + capability flags. Matches the
 * Electrosmith "DAISY PINOUT" poster (Rev 2, color-coded per-peripheral)
 * and is cross-checked against libDaisy's pin/peripheral source.
 *
 * Authoritative sources used:
 *   1. Electrosmith poster — the color-coded pill layout shipped with the
 *      dev kit, also on electro-smith.com. This drives which alt-functions
 *      we surface to the user (we show everything the poster labels).
 *   2. libDaisy — `sdk/libDaisy/src/daisy_seed.h` (seed::D0..D30 on the OG
 *      Seed; D31/D32 on Seed 2 DFM). ADC ordering from
 *      `sdk/libDaisy/src/per/adc.cpp` (dsy_adc_channel_map).
 *   3. STM32H750 datasheet alt-function table for all SPI/I2C/UART/SAI/
 *      I2S/TIM assignments. The poster abbreviates most of these; where
 *      the poster and the datasheet disagreed I followed the poster and
 *      noted the alternate.
 *
 * Note on I2S/SAI (important — a previous pass wrongly stripped these):
 *   The onboard WM8731/AK4556 codec is hard-wired to SAI1 on PORTE pins
 *   (not broken out). BUT several broken-out pins carry I2S/SAI alt
 *   functions and the poster labels them as such:
 *     PA4/D23  — I2S1_WS
 *     PA5/D22  — I2S1_CK  (SCK)
 *     PA6/D19  — I2S1_MCK (alt)
 *     PA7/D18  — I2S1_SD
 *     PC4/D21  — I2S1_MCK
 *     PC1/D20  — I2S2_SD (alt)
 *     PB14/D29 — I2S2_MCK  / SPI2_MISO
 *     PB15/D30 — I2S2_SD   / SPI2_MOSI
 *     PG9/D27  — SAI2_FS_B
 *     PG10/D7  — SAI2_SD_B
 *     PA2/D28  — SAI2_SCK_B (AF3)
 *   We surface I2S via the `i2s` capability so the role→pin filter in
 *   `pinsForRole` can gate an external I2S codec to the correct pins
 *   instead of falling back to "any GPIO".
 *
 * Note on D22/D23:
 *   Both are DAC + ADC + I2S + SPI1. Codegen picks DAC when bound to an
 *   `audio_jack` / `cv_jack` out; `pot`/`cv_jack` in uses ADC; `i2s_codec`
 *   uses I2S. Users can bind explicitly via the inspector.
 *
 * Note on D31/D32 (Seed 2 DFM only):
 *   OG Seed Rev 1..5 stops at D30. D31/D32 exist only on the Daisy Seed 2
 *   DFM. We keep D31 in `SeedPin` so Seed 2 DFM projects round-trip, but
 *   the physical layout marks it as a Seed-2-only slot.
 */
import type { PinCapabilities, SeedPin } from '@/types/hardware'

/**
 * Authoritative pin-capability table for the OG Seed (D0..D30) plus D31
 * for Seed 2 DFM round-tripping. Labels are concatenated alt-function
 * tokens — the HardwareView turns the label into a stack of color-coded
 * pills, one per token, so keep them space-separated and peripheral-
 * prefixed (`USART1_TX`, `TIM2_CH4`, `I2C1_SDA`, etc.).
 */
export const DAISY_SEED_PINS: PinCapabilities[] = [
  // --- Left header (D0..D14) ---
  // D0 = PB12. UART5_RX, SPI2_NSS, CAN2_RX, USB_HS ID, TIM1_BKIN.
  { pin: 'D0',  stm32Pin: 'PB12', gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', spi: 'cs',
    label: 'D0 / PB12 / UART5_RX / SPI2_NSS' },
  // D1 = PC11. USART3_RX, UART4_RX, SPI3_MISO, SDMMC1_D3.
  { pin: 'D1',  stm32Pin: 'PC11', gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', spi: 'miso',
    label: 'D1 / PC11 / USART3_RX / UART4_RX / SPI3_MISO' },
  // D2 = PC10. USART3_TX, UART4_TX, SPI3_SCK, SDMMC1_D2.
  { pin: 'D2',  stm32Pin: 'PC10', gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', spi: 'sck',
    label: 'D2 / PC10 / USART3_TX / UART4_TX / SPI3_SCK' },
  // D3 = PC9. I2C3_SDA, TIM3_CH4, TIM8_CH4, SDMMC1_D1.
  { pin: 'D3',  stm32Pin: 'PC9',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'sda',
    label: 'D3 / PC9 / I2C3_SDA / TIM3_CH4' },
  // D4 = PC8. TIM3_CH3, TIM8_CH3, SDMMC1_D0, USART6_CK.
  { pin: 'D4',  stm32Pin: 'PC8',  gpio: true, adc: false, dac: false, pwm: true,
    label: 'D4 / PC8 / TIM3_CH3 / TIM8_CH3' },
  // D5 = PD2. UART5_RX, TIM3_ETR, SDMMC1_CMD.
  { pin: 'D5',  stm32Pin: 'PD2',  gpio: true, adc: false, dac: false, pwm: false, uart: 'rx',
    label: 'D5 / PD2 / UART5_RX / TIM3_ETR' },
  // D6 = PC12. UART5_TX, USART3_CK, SPI3_MOSI, SDMMC1_CK.
  { pin: 'D6',  stm32Pin: 'PC12', gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', spi: 'mosi',
    label: 'D6 / PC12 / UART5_TX / SPI3_MOSI' },
  // D7 = PG10. SPI1_NSS (CS), I2S1_WS (alt), SAI2_SD_B, LCD_R2.
  { pin: 'D7',  stm32Pin: 'PG10', gpio: true, adc: false, dac: false, pwm: false, spi: 'cs',  i2s: 'sd',
    label: 'D7 / PG10 / SPI1_NSS / SAI2_SD_B' },
  // D8 = PG11. SPI1_SCK (alt), SAI2_SCK_B (alt), ETH.
  { pin: 'D8',  stm32Pin: 'PG11', gpio: true, adc: false, dac: false, pwm: false, spi: 'sck', i2s: 'sck',
    label: 'D8 / PG11 / SPI1_SCK / SAI2_SCK_B' },
  // D9 = PB4. SPI1_MISO, SPI3_MISO, UART7_TX, TIM16_CH1N, NJTRST.
  { pin: 'D9',  stm32Pin: 'PB4',  gpio: true, adc: false, dac: false, pwm: true,  spi: 'miso', uart: 'tx',
    label: 'D9 / PB4 / SPI1_MISO / UART7_TX / TIM16_CH1N' },
  // D10 = PB5. SPI1_MOSI, SPI3_MOSI, UART5_RX, I2C1_SMBA, TIM17_CH1N.
  { pin: 'D10', stm32Pin: 'PB5',  gpio: true, adc: false, dac: false, pwm: true,  spi: 'mosi', uart: 'rx',
    label: 'D10 / PB5 / SPI1_MOSI / UART5_RX / TIM17_CH1N' },
  // D11 = PB8. I2C1_SCL, I2C4_SCL, UART4_RX, TIM16_CH1, TIM4_CH3.
  { pin: 'D11', stm32Pin: 'PB8',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'scl', uart: 'rx',
    label: 'D11 / PB8 / I2C1_SCL / UART4_RX / TIM4_CH3' },
  // D12 = PB9. I2C1_SDA, I2C4_SDA, UART4_TX, TIM17_CH1, TIM4_CH4.
  { pin: 'D12', stm32Pin: 'PB9',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'sda', uart: 'tx',
    label: 'D12 / PB9 / I2C1_SDA / UART4_TX / TIM4_CH4' },
  // D13 = PB6. USART1_TX, LPUART1_TX, UART5_TX, I2C1_SCL (alt), I2C4_SCL,
  // TIM4_CH1, TIM16_CH1N.
  { pin: 'D13', stm32Pin: 'PB6',  gpio: true, adc: false, dac: false, pwm: true,  uart: 'tx', i2c: 'scl',
    label: 'D13 / PB6 / USART1_TX / I2C1_SCL / TIM4_CH1' },
  // D14 = PB7. USART1_RX, LPUART1_RX, I2C1_SDA (alt), I2C4_SDA, TIM4_CH2,
  // TIM17_CH1N.
  { pin: 'D14', stm32Pin: 'PB7',  gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', i2c: 'sda',
    label: 'D14 / PB7 / USART1_RX / I2C1_SDA / TIM4_CH2' },

  // --- Right header (D15..D30) — the analog-rich side ---
  // libDaisy ADC indices come from dsy_adc_channel_map position, not raw
  // STM32 ADC channel number. We expose both (index and CHxx) in the label.

  // D15 = PC0. ADC123_INP10 (libDaisy index 6).
  { pin: 'D15', stm32Pin: 'PC0',  gpio: true, adc: true,  dac: false, pwm: false,
    label: 'D15 / PC0 / ADC_0 / CH10' },
  // D16 = PA3. ADC12_INP15 (idx 11), USART2_RX, TIM2_CH4, TIM5_CH4.
  { pin: 'D16', stm32Pin: 'PA3',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'rx',
    label: 'D16 / PA3 / ADC_1 / CH15 / USART2_RX / TIM2_CH4' },
  // D17 = PB1. ADC12_INP5 (idx 2), TIM1_CH3N, TIM3_CH4, TIM8_CH3N.
  { pin: 'D17', stm32Pin: 'PB1',  gpio: true, adc: true,  dac: false, pwm: true,
    label: 'D17 / PB1 / ADC_2 / CH5 / TIM1_CH3N / TIM3_CH4' },
  // D18 = PA7. ADC12_INP7 (idx 3), SPI1_MOSI / I2S1_SD, SPI6_MOSI,
  // TIM1_CH1N, TIM3_CH2, TIM8_CH1N.
  { pin: 'D18', stm32Pin: 'PA7',  gpio: true, adc: true,  dac: false, pwm: true,  spi: 'mosi', i2s: 'sd',
    label: 'D18 / PA7 / ADC_3 / CH7 / SPI1_MOSI / I2S1_SD / TIM1_CH1N' },
  // D19 = PA6. ADC12_INP3 (idx 0), SPI1_MISO / I2S1_MCK, SPI6_MISO,
  // TIM3_CH1, TIM13_CH1.
  { pin: 'D19', stm32Pin: 'PA6',  gpio: true, adc: true,  dac: false, pwm: true,  spi: 'miso', i2s: 'mclk',
    label: 'D19 / PA6 / ADC_4 / CH3 / SPI1_MISO / I2S1_MCK / TIM3_CH1' },
  // D20 = PC1. ADC123_INP11 (idx 7), SPI2_MOSI (alt) / I2S2_SD (alt),
  // SAI1_SD_A.
  { pin: 'D20', stm32Pin: 'PC1',  gpio: true, adc: true,  dac: false, pwm: false, spi: 'mosi', i2s: 'sd',
    label: 'D20 / PC1 / ADC_5 / CH11 / SPI2_MOSI / SAI1_SD_A' },
  // D21 = PC4. ADC12_INP4 (idx 1), SPI1_MCK / I2S1_MCK.
  { pin: 'D21', stm32Pin: 'PC4',  gpio: true, adc: true,  dac: false, pwm: false, i2s: 'mclk',
    label: 'D21 / PC4 / ADC_6 / CH4 / I2S1_MCK' },
  // D22 = PA5. DAC1_OUT2, ADC12_INP19 (idx 15), SPI1_SCK / I2S1_CK,
  // SPI6_SCK, TIM2_CH1, TIM8_CH1N.
  { pin: 'D22', stm32Pin: 'PA5',  gpio: true, adc: true,  dac: true,  pwm: true,  spi: 'sck', i2s: 'sck',
    label: 'D22 / PA5 / DAC_OUT_2 / ADC_11 / CH19 / SPI1_SCK / I2S1_CK' },
  // D23 = PA4. DAC1_OUT1, ADC12_INP18 (idx 14), SPI1_NSS / I2S1_WS,
  // SPI3_NSS, SPI6_NSS, USART2_CK.
  { pin: 'D23', stm32Pin: 'PA4',  gpio: true, adc: true,  dac: true,  pwm: false, spi: 'cs',  i2s: 'ws',
    label: 'D23 / PA4 / DAC_OUT_1 / ADC_10 / CH18 / SPI1_NSS / I2S1_WS' },
  // D24 = PA1. ADC12_INP17 (idx 13), USART2_RTS, UART4_RX, TIM2_CH2,
  // TIM5_CH2, TIM15_CH1N.
  { pin: 'D24', stm32Pin: 'PA1',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'rx',
    label: 'D24 / PA1 / ADC_9 / CH17 / UART4_RX / TIM2_CH2' },
  // D25 = PA0. ADC12_INP16 (idx 12), USART2_CTS, UART4_TX, TIM2_CH1,
  // TIM5_CH1, TIM8_ETR, TIM15_CH1N.
  { pin: 'D25', stm32Pin: 'PA0',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'tx',
    label: 'D25 / PA0 / ADC_8 / CH16 / UART4_TX / TIM2_CH1' },
  // D26 = PD11. USART3_CTS, I2C4_SMBA, SAI2_SD_A, QSPI_BK1_IO0. Not ADC-
  // capable on STM32H750.
  { pin: 'D26', stm32Pin: 'PD11', gpio: true, adc: false, dac: false, pwm: false, i2s: 'sd',
    label: 'D26 / PD11 / USART3_CTS / SAI2_SD_A' },
  // D27 = PG9. USART6_RX, SPI1_MISO (alt), SAI2_FS_B, QSPI_BK2_IO2,
  // SDMMC2_D0. Not ADC-capable on STM32H750.
  { pin: 'D27', stm32Pin: 'PG9',  gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', i2s: 'ws',
    label: 'D27 / PG9 / USART6_RX / SAI2_FS_B' },
  // D28 = PA2. ADC12_INP14 (idx 10, aliased A11 by libDaisy), USART2_TX,
  // SAI2_SCK_B (AF3), TIM2_CH3, TIM5_CH3, TIM15_CH1.
  { pin: 'D28', stm32Pin: 'PA2',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'tx', i2s: 'sck',
    label: 'D28 / PA2 / ADC_7 / CH14 / USART2_TX / SAI2_SCK_B' },
  // D29 = PB14. USART1_TX, SPI2_MISO / I2S2_MCK, TIM1_CH2N, TIM12_CH1,
  // TIM8_CH2N, SDMMC2_D0. No ADC.
  { pin: 'D29', stm32Pin: 'PB14', gpio: true, adc: false, dac: false, pwm: true,  uart: 'tx', spi: 'miso', i2s: 'mclk',
    label: 'D29 / PB14 / USART1_TX / SPI2_MISO / I2S2_MCK / TIM1_CH2N' },
  // D30 = PB15. USART1_RX, SPI2_MOSI / I2S2_SD, TIM1_CH3N, TIM12_CH2,
  // TIM8_CH3N, SDMMC2_D1. No ADC.
  { pin: 'D30', stm32Pin: 'PB15', gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', spi: 'mosi', i2s: 'sd',
    label: 'D30 / PB15 / USART1_RX / SPI2_MOSI / I2S2_SD / TIM1_CH3N' },

  // --- Daisy Seed 2 DFM only ---
  // D31 = PC2. ADC123_INP12 (idx 8), SPI2_MISO. Present only on Seed 2 DFM.
  // (Seed 2 DFM also exposes D32 = PC3 = ADC CH13 / SPI2_MOSI; we leave
  // it out of SeedPin for now since the union only goes to D31 — revisit
  // if Seed 2 DFM codegen needs it.)
  { pin: 'D31', stm32Pin: 'PC2',  gpio: true, adc: true,  dac: false, pwm: false, spi: 'miso',
    label: 'D31 / PC2 / ADC_CH12 / SPI2_MISO (Seed 2 DFM only)' }
]

/** Fast lookup. Populated once at module load. */
export const PIN_CAPS: Record<SeedPin, PinCapabilities> = (() => {
  const out = {} as Record<SeedPin, PinCapabilities>
  for (const c of DAISY_SEED_PINS) out[c.pin as SeedPin] = c
  return out
})()

/**
 * Map a SeedPin to its libDaisy ADC channel index (0..15), for codegen.
 * Returns -1 if the pin is not ADC-capable.
 *
 * Derived from dsy_adc_channel_map in libDaisy/src/per/adc.cpp:
 *   index order = CH3, CH4, CH5, CH7, CH8, CH9, CH10, CH11, CH12, CH13,
 *                 CH14, CH15, CH16, CH17, CH18, CH19
 *
 * ADC pin → libDaisy index (12 pins on OG Seed, 13 counting Seed 2 DFM):
 *   D19=PA6 (CH3)  → 0     D22=PA5 (CH19) → 15
 *   D21=PC4 (CH4)  → 1     D23=PA4 (CH18) → 14
 *   D17=PB1 (CH5)  → 2     D24=PA1 (CH17) → 13
 *   D18=PA7 (CH7)  → 3     D25=PA0 (CH16) → 12
 *   D15=PC0 (CH10) → 6     D28=PA2 (CH14) → 10
 *   D20=PC1 (CH11) → 7     D31=PC2 (CH12) → 8  (Seed 2 DFM)
 *   D16=PA3 (CH15) → 11
 */
export function adcChannelOf(pin: SeedPin): number {
  const map: Partial<Record<SeedPin, number>> = {
    D19: 0,
    D21: 1,
    D17: 2,
    D18: 3,
    D15: 6,
    D20: 7,
    D31: 8,
    D28: 10,
    D16: 11,
    D25: 12,
    D24: 13,
    D23: 14,
    D22: 15
  }
  return map[pin] ?? -1
}

/**
 * Physical pin positions on the Seed's 40-pin header, as silkscreened.
 *
 * Orientation: looking at the TOP face of the Seed with the USB connector
 * at the TOP. The left header (D0..D14 + power/USB) runs top-to-bottom;
 * the right header (D30..D15 + audio-out + 3V3A) runs top-to-bottom (so
 * D30 is physically next to D0 and D15 is physically next to USB_DP at
 * the bottom).
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
    | 'AUDIO_IN_L'
    | 'AUDIO_IN_R'
    | 'AUDIO_OUT_L'
    | 'AUDIO_OUT_R'
  side: 'left' | 'right'
  index: number
  label: string
}

/**
 * Physical layout of the 40-pin Seed. Left column = D0..D14 + power/USB;
 * right column = D30..D15 + audio-out + analog 3V3 (mirrored so the
 * highest-numbered GPIO sits physically next to D0).
 */
export const PHYSICAL_PIN_LAYOUT: PhysicalPinPosition[] = [
  // ------------- LEFT SIDE (silkscreen top-to-bottom) -------------
  { pin: 'D0',        side: 'left', index: 0,  label: 'D0'  },
  { pin: 'D1',        side: 'left', index: 1,  label: 'D1'  },
  { pin: 'D2',        side: 'left', index: 2,  label: 'D2'  },
  { pin: 'D3',        side: 'left', index: 3,  label: 'D3'  },
  { pin: 'D4',        side: 'left', index: 4,  label: 'D4'  },
  { pin: 'D5',        side: 'left', index: 5,  label: 'D5'  },
  { pin: 'D6',        side: 'left', index: 6,  label: 'D6'  },
  { pin: 'D7',        side: 'left', index: 7,  label: 'D7'  },
  { pin: 'D8',        side: 'left', index: 8,  label: 'D8'  },
  { pin: 'D9',        side: 'left', index: 9,  label: 'D9'  },
  { pin: 'D10',       side: 'left', index: 10, label: 'D10' },
  { pin: 'D11',       side: 'left', index: 11, label: 'D11' },
  { pin: 'D12',       side: 'left', index: 12, label: 'D12' },
  { pin: 'D13',       side: 'left', index: 13, label: 'D13' },
  { pin: 'D14',       side: 'left', index: 14, label: 'D14' },
  { pin: 'AGND',      side: 'left', index: 15, label: 'AGND' },
  { pin: 'DGND',      side: 'left', index: 16, label: 'DGND' },
  { pin: 'VIN',       side: 'left', index: 17, label: 'VIN'  },
  { pin: '3V3',       side: 'left', index: 18, label: '3V3 D' },
  { pin: 'USB_DP',    side: 'left', index: 19, label: 'USB'  },

  // ------------- RIGHT SIDE -------------
  { pin: 'D30',         side: 'right', index: 0,  label: 'D30' },
  { pin: 'D29',         side: 'right', index: 1,  label: 'D29' },
  { pin: 'D28',         side: 'right', index: 2,  label: 'D28' },
  { pin: 'D27',         side: 'right', index: 3,  label: 'D27' },
  { pin: 'D26',         side: 'right', index: 4,  label: 'D26' },
  { pin: 'D25',         side: 'right', index: 5,  label: 'D25' },
  { pin: 'D24',         side: 'right', index: 6,  label: 'D24' },
  { pin: 'D23',         side: 'right', index: 7,  label: 'D23' },
  { pin: 'D22',         side: 'right', index: 8,  label: 'D22' },
  { pin: 'D21',         side: 'right', index: 9,  label: 'D21' },
  { pin: 'D20',         side: 'right', index: 10, label: 'D20' },
  { pin: 'D19',         side: 'right', index: 11, label: 'D19' },
  { pin: 'D18',         side: 'right', index: 12, label: 'D18' },
  { pin: 'D17',         side: 'right', index: 13, label: 'D17' },
  { pin: 'D16',         side: 'right', index: 14, label: 'D16' },
  { pin: 'D15',         side: 'right', index: 15, label: 'D15' },
  { pin: 'D31',         side: 'right', index: 16, label: 'D31 (Seed 2 DFM)' },
  { pin: 'AUDIO_OUT_L', side: 'right', index: 17, label: 'AUD_OUT_L' },
  { pin: 'AUDIO_OUT_R', side: 'right', index: 18, label: 'AUD_OUT_R' },
  { pin: '3V3_A',       side: 'right', index: 19, label: '3V3 A' }
  // Audio IN is routed to underside test pads, not broken out to the
  // 2.54mm header; intentionally not listed here.
]

/**
 * Convenience: all strictly-addressable SeedPins (D0..D31), sorted by
 * physical order on the left header then right header. Useful for the
 * inspector's pin dropdown so options appear in a consistent order.
 */
export const SEED_PINS_IN_ORDER: SeedPin[] = PHYSICAL_PIN_LAYOUT
  .filter((p): p is PhysicalPinPosition & { pin: SeedPin } =>
    /^D\d+$/.test(p.pin as string)
  )
  .map((p) => p.pin as SeedPin)

/**
 * Which pins satisfy a component role. Used by both the inspector's
 * filtered dropdown and the hardware view's drag-to-pin interaction
 * (compatible pins light up, incompatible ones dim).
 */
export function pinsForRole(
  role: string,
  kind: string
): SeedPin[] {
  const r = role.toLowerCase()
  return DAISY_SEED_PINS.filter((cap) => {
    switch (kind) {
      case 'pot':
      case 'cv_jack':
        return cap.adc
      case 'button':
      case 'switch_3way':
      case 'gate_jack':
      case 'encoder':
        return cap.gpio
      case 'led':
        return cap.gpio // PWM is optional, not required
      case 'oled_ssd1306':
        if (r === 'sda') return cap.i2c === 'sda'
        if (r === 'scl') return cap.i2c === 'scl'
        return !!cap.i2c
      case 'i2s_codec':
        // Poster confirms I2S on D18..D23 (SAI1) and D29/D30 (SAI2).
        // We gate strictly on the i2s flag now.
        if (r === 'sck')   return cap.i2s === 'sck'
        if (r === 'ws')    return cap.i2s === 'ws'
        if (r === 'mclk')  return cap.i2s === 'mclk'
        if (r === 'sd_in' || r === 'sd_out') return cap.i2s === 'sd'
        return !!cap.i2s
      case 'midi_jack':
        return cap.uart === 'rx' || cap.uart === 'tx'
      case 'audio_jack':
        // Audio jacks bind to the hard-wired codec channels; any GPIO works.
        return cap.gpio
      default:
        return cap.gpio
    }
  }).map((c) => c.pin as SeedPin)
}
