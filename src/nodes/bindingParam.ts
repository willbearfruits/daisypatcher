/**
 * The `bindingId` ParamDef, shared by every hardware-bound node kind.
 *
 * Its own leaf module on purpose. It is needed by both `definitions.ts`
 * (for `knob_in` / `gate_in`) and `defs.hardware.ts` (for the button /
 * LED / switch / I2S / MIDI kinds), and `definitions.ts` already imports
 * `defs.hardware.ts` to assemble the catalog. Putting it in either of
 * those files would make the other import it back — a real cycle, and one
 * that would bite at module-init time rather than lazily, because the
 * definition arrays call `bindingParam()` while they are being built.
 */

import type { ParamDef } from './definitions'

/**
 * "(unbound)" placeholder enum. The Inspector's `BindingControl` replaces
 * these options at render time with the layout's actual placed components,
 * filtered to the ones compatible with the node's kind; this stub is the
 * fallback when it can't enumerate live.
 */
const BINDING_UNBOUND_OPTIONS = [{ value: '', label: '(unbound)' }]

export function bindingParam(): ParamDef {
  return {
    id: 'bindingId',
    label: 'Binding',
    kind: 'enum',
    default: '',
    options: BINDING_UNBOUND_OPTIONS
  }
}
