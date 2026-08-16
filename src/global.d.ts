/// <reference types="vite/client" />
import type {
  DaisyPatcherAPI,
  SdkStatus,
  BuildInput,
  BuildResult,
  FlashDevice,
  FlashStatus,
  SerialPortInfo,
  SerialOpenResult,
  DetectionResult,
  UpdateStatusPayload,
  UpdateProgressPayload
} from '../electron/preload'

declare global {
  interface Window {
    daisy: DaisyPatcherAPI
  }
  /** Injected by electron-vite from package.json at build time. */
  const __APP_VERSION__: string
  // Re-export bridge DTOs for renderer-side consumers.
  type DaisySdkStatus = SdkStatus
  type DaisyBuildInput = BuildInput
  type DaisyBuildResult = BuildResult
  type DaisyFlashDevice = FlashDevice
  type DaisyFlashStatus = FlashStatus
  type DaisySerialPortInfo = SerialPortInfo
  type DaisySerialOpenResult = SerialOpenResult
  type DaisyDetectionResult = DetectionResult
  type DaisyUpdateStatus = UpdateStatusPayload
  type DaisyUpdateProgress = UpdateProgressPayload
}

export {}
