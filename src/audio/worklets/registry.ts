/**
 * Worklet module registry. Maps each `NodeKind` that has a dedicated
 * AudioWorkletProcessor to its registered processor name and the URL of
 * the worklet module (resolved by Vite at build time via
 * `new URL('./x.worklet.js', import.meta.url)`).
 *
 * `audio_output` is intentionally omitted — it maps to the live
 * `AudioContext.destination` in the engine, not a worklet.
 */

import type { NodeKind } from '@/types/graph'
import { SYNTHESIS_REGISTRY } from './registry.synthesis'
import { SEQUENCING_REGISTRY } from './registry.sequencing'
import { EFFECTS_REGISTRY } from './registry.effects'
import { VISUAL_REGISTRY } from './registry.visual'
import { HARDWARE_REGISTRY } from './registry.hardware'
import { LOGIC_REGISTRY } from './registry.logic'

export interface WorkletEntry {
  processorName: string
  moduleUrl: URL
}

const CORE_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  oscillator: {
    processorName: 'dp-oscillator',
    moduleUrl: new URL('./oscillator.worklet.js', import.meta.url)
  },
  noise: {
    processorName: 'dp-noise',
    moduleUrl: new URL('./noise.worklet.js', import.meta.url)
  },
  lfo: {
    processorName: 'dp-lfo',
    moduleUrl: new URL('./lfo.worklet.js', import.meta.url)
  },
  constant: {
    processorName: 'dp-constant',
    moduleUrl: new URL('./constant.worklet.js', import.meta.url)
  },
  gain: {
    processorName: 'dp-gain',
    moduleUrl: new URL('./gain.worklet.js', import.meta.url)
  },
  vca: {
    processorName: 'dp-vca',
    moduleUrl: new URL('./vca.worklet.js', import.meta.url)
  },
  mixer4: {
    processorName: 'dp-mixer4',
    moduleUrl: new URL('./mixer4.worklet.js', import.meta.url)
  },
  pan: {
    processorName: 'dp-pan',
    moduleUrl: new URL('./pan.worklet.js', import.meta.url)
  },
  clip: {
    processorName: 'dp-clip',
    moduleUrl: new URL('./clip.worklet.js', import.meta.url)
  },
  sum: {
    processorName: 'dp-sum',
    moduleUrl: new URL('./sum.worklet.js', import.meta.url)
  },
  multiply: {
    processorName: 'dp-multiply',
    moduleUrl: new URL('./multiply.worklet.js', import.meta.url)
  },
  crossfade: {
    processorName: 'dp-crossfade',
    moduleUrl: new URL('./crossfade.worklet.js', import.meta.url)
  },
  filter_svf: {
    processorName: 'dp-filter-svf',
    moduleUrl: new URL('./filter_svf.worklet.js', import.meta.url)
  },
  filter_moog: {
    processorName: 'dp-filter-moog',
    moduleUrl: new URL('./filter_moog.worklet.js', import.meta.url)
  },
  adsr: {
    processorName: 'dp-adsr',
    moduleUrl: new URL('./adsr.worklet.js', import.meta.url)
  },
  ar: {
    processorName: 'dp-ar',
    moduleUrl: new URL('./ar.worklet.js', import.meta.url)
  },
  envelope_follower: {
    processorName: 'dp-envelope-follower',
    moduleUrl: new URL('./envelope_follower.worklet.js', import.meta.url)
  },
  slew: {
    processorName: 'dp-slew',
    moduleUrl: new URL('./slew.worklet.js', import.meta.url)
  },
  sample_hold: {
    processorName: 'dp-sample-hold',
    moduleUrl: new URL('./sample_hold.worklet.js', import.meta.url)
  },
  inverter: {
    processorName: 'dp-inverter',
    moduleUrl: new URL('./inverter.worklet.js', import.meta.url)
  },
  scale: {
    processorName: 'dp-scale',
    moduleUrl: new URL('./scale.worklet.js', import.meta.url)
  },
  range: {
    processorName: 'dp-range',
    moduleUrl: new URL('./range.worklet.js', import.meta.url)
  },
  comparator: {
    processorName: 'dp-comparator',
    moduleUrl: new URL('./comparator.worklet.js', import.meta.url)
  },
  delay: {
    processorName: 'dp-delay',
    moduleUrl: new URL('./delay.worklet.js', import.meta.url)
  },
  reverb: {
    processorName: 'dp-reverb',
    moduleUrl: new URL('./reverb.worklet.js', import.meta.url)
  },
  overdrive: {
    processorName: 'dp-overdrive',
    moduleUrl: new URL('./overdrive.worklet.js', import.meta.url)
  },
  chorus: {
    processorName: 'dp-chorus',
    moduleUrl: new URL('./chorus.worklet.js', import.meta.url)
  },
  bitcrush: {
    processorName: 'dp-bitcrush',
    moduleUrl: new URL('./bitcrush.worklet.js', import.meta.url)
  },
  audio_in: {
    processorName: 'dp-audio-in',
    moduleUrl: new URL('./audio_in.worklet.js', import.meta.url)
  },
  knob_in: {
    processorName: 'dp-knob-in',
    moduleUrl: new URL('./knob_in.worklet.js', import.meta.url)
  },
  gate_in: {
    processorName: 'dp-gate-in',
    moduleUrl: new URL('./gate_in.worklet.js', import.meta.url)
  }
}

export const WORKLET_REGISTRY: Partial<Record<NodeKind, WorkletEntry>> = {
  ...CORE_REGISTRY,
  ...SYNTHESIS_REGISTRY,
  ...SEQUENCING_REGISTRY,
  ...EFFECTS_REGISTRY,
  ...VISUAL_REGISTRY,
  ...HARDWARE_REGISTRY,
  ...LOGIC_REGISTRY
}

export function workletEntriesToLoad(): WorkletEntry[] {
  return Object.values(WORKLET_REGISTRY).filter(
    (e): e is WorkletEntry => e !== undefined
  )
}
