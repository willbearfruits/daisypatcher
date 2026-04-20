import type {
  DaisyPatcherAPI,
  SdkStatus,
  BuildInput,
  BuildResult,
  FlashDevice,
  FlashStatus,
  SerialPortInfo,
  SerialOpenResult
} from '../electron/preload'

declare global {
  interface Window {
    daisy: DaisyPatcherAPI
  }
  // Re-export bridge DTOs for renderer-side consumers.
  type DaisySdkStatus = SdkStatus
  type DaisyBuildInput = BuildInput
  type DaisyBuildResult = BuildResult
  type DaisyFlashDevice = FlashDevice
  type DaisyFlashStatus = FlashStatus
  type DaisySerialPortInfo = SerialPortInfo
  type DaisySerialOpenResult = SerialOpenResult
}

export {}
