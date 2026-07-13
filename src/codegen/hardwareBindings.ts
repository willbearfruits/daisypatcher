/**
 * Codegen helpers for resolving hardware bindings on nodes, and for
 * emitting peripheral init that matches the placed-component layout.
 *
 * Resolve flow
 * ------------
 * A node (e.g. `knob_in`, `gate_in`, `button`, `led`, `oled`) may carry
 * a `bindingId` param pointing at a `PlacedComponent.id`. This helper
 * resolves the component + the specific SeedPin bound to the requested
 * role (e.g. "wiper", "io", "sda"). If anything is missing, returns
 * `null` — callers should fall back to their legacy behaviour.
 *
 * Emit flow
 * ---------
 * `emitHardwareInit` walks the layout and produces peripheral-init C++
 * that runs right after `hw.Init()` in the generated `main.cpp`.
 *
 *   - pots (+ CV jacks in-mode)  -> single ADC block with one
 *     AdcChannelConfig per placed pot, Init + Start.
 *   - OLED                       -> nothing here; the `oled` node emitter
 *     owns the full OledDisplay init (which brings up I2C1 itself via
 *     driver_config.transport_config). See nodeEmitters.ts.
 *   - I2S codec                  -> sai1 config sketch (comment only;
 *     full I2S init is too board-specific to auto-generate, we leave
 *     a TODO stub).
 *   - buttons, switches, LEDs    -> GpioInit blocks per component.
 */

import type { BoardPin, HardwareLayout, PlacedComponent, SeedPin } from '@/types/hardware'
import { adcChannelOf, PIN_CAPS } from '@/hardware/daisySeedPinout'

/** Lookup a bound (component, pin) pair for a given node's role. */
export function resolveBinding(
  _nodeId: string,
  bindingId: string | undefined,
  role: string,
  hardware: HardwareLayout
): { component: PlacedComponent; pin: BoardPin } | null {
  if (!bindingId) return null
  const comp = hardware.components.find((c) => c.id === bindingId)
  if (!comp) return null
  const pin = comp.pins[role]
  if (!pin) return null
  return { component: comp, pin }
}

/** Sanitize a placed-component id into a valid C identifier fragment. */
export function hwVar(comp: PlacedComponent): string {
  const safe = comp.id.replace(/[^A-Za-z0-9_]/g, '_')
  return `hw_${comp.kind}_${safe}`
}

/**
 * Walk the hardware layout and produce the file-scope declarations AND
 * the body-of-main init block. The returned `initCode` is inserted right
 * after `hw.Init()` (before audio start), so peripherals come up before
 * the audio callback fires.
 *
 * Only emits for components with at least one bound pin — a placed
 * component that isn't wired is visible in the UI but generates no code.
 */
export function emitHardwareInit(layout: HardwareLayout): {
  decls: string
  initCode: string
} {
  const declLines: string[] = []
  const initLines: string[] = []

  // Pots + CV jacks share a single ADC bank. Collect them up front so we
  // emit one AdcChannelConfig array (libDaisy requires all channels
  // registered in a single Init call).
  const adcTargets: { comp: PlacedComponent; pin: SeedPin; role: string }[] = []
  for (const c of layout.components) {
    if (c.kind === 'pot') {
      const pin = c.pins['wiper']
      if (pin && isSeedPin(pin) && PIN_CAPS[pin]?.adc) {
        adcTargets.push({ comp: c, pin, role: 'wiper' })
      }
    } else if (c.kind === 'cv_jack') {
      const pin = c.pins['signal']
      if (pin && isSeedPin(pin) && PIN_CAPS[pin]?.adc) {
        adcTargets.push({ comp: c, pin, role: 'signal' })
      }
    }
  }

  if (adcTargets.length > 0) {
    declLines.push('// Hardware: ADC channel values (0..1), one per placed pot / CV jack.')
    for (const t of adcTargets) {
      declLines.push(`float ${hwVar(t.comp)}_val = 0.f;`)
    }
    const n = adcTargets.length
    const initBlock: string[] = []
    initBlock.push(`    // --- ADC: ${n} channel${n === 1 ? '' : 's'} ---`)
    initBlock.push(`    AdcChannelConfig hw_adc_cfg[${n}];`)
    adcTargets.forEach((t, i) => {
      const chan = adcChannelOf(t.pin)
      if (chan >= 0) {
        initBlock.push(
          `    hw_adc_cfg[${i}].InitSingle(hw.GetPin(15 + ${chan})); // ${t.comp.label} (${t.pin})`
        )
      } else {
        initBlock.push(
          `    // TODO: ${t.pin} is not ADC-capable; skipping ${t.comp.label}`
        )
      }
    })
    initBlock.push(`    hw.adc.Init(hw_adc_cfg, ${n});`)
    initBlock.push(`    hw.adc.Start();`)
    initLines.push(initBlock.join('\n'))
  }

  // Buttons / gate jacks / switches — GPIO inputs with pull-up.
  for (const c of layout.components) {
    if (c.kind === 'button' || c.kind === 'gate_jack') {
      const pin = c.pins['io']
      if (!pin || !isSeedPin(pin)) continue
      declLines.push(`GPIO ${hwVar(c)}_gpio;`)
      initLines.push(
        `    // --- ${c.kind}: ${c.label} ---\n` +
        `    ${hwVar(c)}_gpio.Init(hw.GetPin(${seedPinToDPin(pin)}), GPIO::Mode::INPUT, GPIO::Pull::PULLUP);`
      )
    } else if (c.kind === 'switch_3way') {
      const p1 = c.pins['pos1']
      const p2 = c.pins['pos2']
      if (p1 && isSeedPin(p1)) {
        declLines.push(`GPIO ${hwVar(c)}_pos1_gpio;`)
        initLines.push(
          `    ${hwVar(c)}_pos1_gpio.Init(hw.GetPin(${seedPinToDPin(p1)}), GPIO::Mode::INPUT, GPIO::Pull::PULLUP);`
        )
      }
      if (p2 && isSeedPin(p2)) {
        declLines.push(`GPIO ${hwVar(c)}_pos2_gpio;`)
        initLines.push(
          `    ${hwVar(c)}_pos2_gpio.Init(hw.GetPin(${seedPinToDPin(p2)}), GPIO::Mode::INPUT, GPIO::Pull::PULLUP);`
        )
      }
    }
  }

  // LEDs — GPIO outputs.
  for (const c of layout.components) {
    if (c.kind !== 'led') continue
    const pin = c.pins['anode']
    if (!pin || !isSeedPin(pin)) continue
    declLines.push(`GPIO ${hwVar(c)}_gpio;`)
    initLines.push(
      `    // --- led: ${c.label} ---\n` +
      `    ${hwVar(c)}_gpio.Init(hw.GetPin(${seedPinToDPin(pin)}), GPIO::Mode::OUTPUT);`
    )
  }

  // OLED (I2C) — intentionally nothing here. The `oled` node emitter owns
  // the full OledDisplay<SSD130xI2c128x64Driver> init, and its Init()
  // brings up I2C1 itself via driver_config.transport_config; a second
  // I2C1 config emitted here would just be dead, confusing code.

  // I2S codec — only a stub; full SAI config is board-specific.
  const hasI2s = layout.components.some((c) => c.kind === 'i2s_codec')
  if (hasI2s) {
    initLines.push(
      '    // --- I2S codec: stub ---\n' +
      '    // TODO: configure SAI1 for external I2S DAC/ADC using bound pins.'
    )
  }

  return {
    decls: declLines.join('\n'),
    initCode: initLines.join('\n\n')
  }
}

/** Type guard: narrow a BoardPin string down to SeedPin. */
function isSeedPin(pin: BoardPin | undefined): pin is SeedPin {
  return typeof pin === 'string' && /^D\d{1,2}$/.test(pin)
}

/**
 * Convert a SeedPin string ("D15") into the integer hw.GetPin() expects.
 * libDaisy's GetPin takes the broken-out D-number directly.
 */
function seedPinToDPin(pin: SeedPin): number {
  return parseInt(pin.slice(1), 10)
}

/**
 * For `knob_in` / `gate_in` emitters: if the node's `params.bindingId`
 * resolves to a placed pot/gate with a bound ADC or GPIO pin, return
 * the identifier that already holds its current sample value. Callers
 * use this to synthesise `float out = <identifier>;` in their process()
 * block without duplicating ADC setup.
 *
 * Returns `null` when no binding is resolvable — caller then falls back
 * to its legacy behaviour (channel param + `_val` stub).
 */
export function valueExprForBinding(
  bindingId: string | undefined,
  role: string,
  hardware: HardwareLayout
): string | null {
  const r = resolveBinding('', bindingId, role, hardware)
  if (!r) return null
  // The Daisy binding emitter is SeedPin-only; if the layout was saved on
  // another board, the caller's emitter should pick a target-specific path.
  if (!isSeedPin(r.pin)) return null
  const cap = PIN_CAPS[r.pin]
  if (cap?.adc) {
    // ADC values are read via a poll loop in main(). The per-component
    // float is the shared name emitted by `emitHardwareInit`.
    return `${hwVar(r.component)}_val`
  }
  if (cap?.gpio) {
    // GPIO inputs are active-low on buttons/gates; we return 1.f when
    // pressed/high for uniformity with the legacy _val semantics.
    return `(${hwVar(r.component)}_gpio.Read() ? 0.f : 1.f)`
  }
  return null
}

/**
 * Poll lines for ADC reads — emitted inside main()'s `while(1)` so the
 * ADC values stay fresh. Returns one assignment per placed pot/CV.
 */
export function emitHardwarePoll(layout: HardwareLayout): string {
  const lines: string[] = []
  let idx = 0
  for (const c of layout.components) {
    let pin: BoardPin | undefined
    if (c.kind === 'pot') pin = c.pins['wiper']
    else if (c.kind === 'cv_jack') pin = c.pins['signal']
    if (!pin || !isSeedPin(pin)) continue
    const chan = adcChannelOf(pin)
    if (chan < 0) continue
    lines.push(`        ${hwVar(c)}_val = hw.adc.GetFloat(${idx});`)
    idx++
  }
  return lines.join('\n')
}
