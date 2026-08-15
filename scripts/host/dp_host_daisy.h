// Minimal libDaisy stand-in, so generated firmware compiles on this machine.
//
// The point is to run the REAL DSP — DaisySP is portable C++ and builds for
// x86 unchanged, so an oscillator here is bit-for-bit the oscillator on the
// device. What does not port is libDaisy, which is the hardware half: the
// codec, the ADC, GPIO, the SAI clocks. None of that is DSP, and none of it
// can be compared against a browser anyway.
//
// So this provides just enough `daisy::` surface for the generated file to
// compile untouched. Untouched matters: the moment a parity harness starts
// rewriting the source it is testing, it is testing something else.
//
// TWO TRICKS let `main()` run without a device:
//
//   1. `StartAudio` stores the callback instead of starting a codec, so the
//      harness can drive it at its own pace.
//   2. `System::Delay` throws, which unwinds out of the generated
//      `while (1)` on its first iteration. Init has already run by then,
//      which is all we needed from main().
//
// Everything else is a no-op that returns a plausible constant. Anything
// reading real hardware (knobs, encoders) therefore reads a constant, which
// is why `audio-parity.mjs` skips patches with hardware bindings rather
// than pretending the comparison means something.

#pragma once

/*
 * libDaisy places big buffers in external SDRAM with these attributes. On
 * the host they are ordinary globals, so the macros expand to nothing —
 * the DSP is unchanged, only where the memory lives.
 */
#ifndef DSY_SDRAM_BSS
#define DSY_SDRAM_BSS
#endif
#ifndef DSY_QSPI_BSS
#define DSY_QSPI_BSS
#endif
#ifndef DTCM_MEM_SECTION
#define DTCM_MEM_SECTION
#endif

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>

namespace daisy {

/** Thrown by System::Delay to break out of the generated main loop. */
struct DpHostLoopExit {};

struct AudioHandle {
  using InputBuffer = const float* const*;
  using OutputBuffer = float* const*;
  using AudioCallback = void (*)(InputBuffer, OutputBuffer, size_t);
};

/** Set by StartAudio; the harness calls it directly. */
inline AudioHandle::AudioCallback dp_host_callback = nullptr;

struct System {
  static void Delay(uint32_t) { throw DpHostLoopExit{}; }
  /** Monotonic ms. Advanced by the harness between blocks. */
  static uint32_t& NowRef() {
    static uint32_t now = 0;
    return now;
  }
  static uint32_t GetNow() { return NowRef(); }
};

/**
 * libDaisy's `Random` — the STM32's hardware RNG peripheral.
 *
 * There is no such peripheral here, so this is a deterministic stand-in.
 * Determinism is the right call for a comparison harness: a seeded PRNG
 * gives the same sequence on every run, so a `random`/`dust` regression
 * shows up as a changed number rather than as noise you have to squint at.
 * It will never match the device sample-for-sample either way — nothing
 * can — so the parity check on these kinds is about level and rate.
 *
 * Without this, `random` and `dust` did not compile in the harness at all
 * and were silently absent from every parity run.
 */
struct Random {
  static void Init() {}
  static void DeInit() {}
  static bool IsReady() { return true; }
  static uint32_t GetValue() {
    // xorshift32, fixed seed.
    static uint32_t s = 0x2545F491u;
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
  }
  static float GetFloat(float min = 0.f, float max = 1.f) {
    return min + (max - min) * (static_cast<float>(GetValue()) / 4294967296.f);
  }
};

struct Pin {
  int index = 0;
};

/** Analog inputs read a fixed mid-scale value — see the file header. */
struct AdcChannelConfig {
  void InitSingle(Pin) {}
};

struct AdcHandle {
  void Init(AdcChannelConfig*, size_t) {}
  void Start() {}
  float GetFloat(size_t) { return 0.5f; }
};

struct GPIO {
  struct Config {};
  enum class Mode { INPUT, OUTPUT };
  enum class Pull { NOPULL, PULLUP, PULLDOWN };
  void Init(Pin, Mode, Pull) {}
  void Init(Pin, Mode) {}
  bool Read() { return false; }
  void Write(bool) {}
};

struct Encoder {
  void Init(Pin, Pin, Pin) {}
  void Debounce() {}
  int32_t Increment() { return 0; }
  bool Pressed() { return false; }
  bool RisingEdge() { return false; }
};

struct I2CHandle {
  struct Config {
    enum class Peripheral { I2C_1, I2C_2, I2C_3, I2C_4 };
    enum class Speed { I2C_100KHZ, I2C_400KHZ, I2C_1MHZ };
    enum class Mode { I2C_MASTER, I2C_SLAVE };
    struct PinConfig {
      Pin scl;
      Pin sda;
    };
    Peripheral periph = Peripheral::I2C_1;
    Speed speed = Speed::I2C_400KHZ;
    Mode mode = Mode::I2C_MASTER;
    PinConfig pin_config;
  };
  enum class Result { OK, ERR };
  Result Init(const Config&) { return Result::OK; }
  Result TransmitBlocking(uint16_t, uint8_t*, uint16_t, uint32_t) { return Result::OK; }
  Result ReceiveBlocking(uint16_t, uint8_t*, uint16_t, uint32_t) { return Result::OK; }
  Result ReadDataAtAddress(uint16_t, uint16_t, uint16_t, uint8_t* data, uint16_t size, uint32_t) {
    // Zeroed rather than random: a sensor that reads flat is easier to
    // reason about than one that reads noise.
    std::memset(data, 0, size);
    return Result::OK;
  }
  Result WriteDataAtAddress(uint16_t, uint16_t, uint16_t, uint8_t*, uint16_t, uint32_t) {
    return Result::OK;
  }
};

struct DaisySeed {
  AdcHandle adc;
  void Init(bool = false) {}
  void SetAudioBlockSize(size_t n) { block_ = n; }
  float AudioSampleRate() const { return 48000.f; }
  size_t AudioBlockSize() const { return block_; }
  Pin GetPin(int i) { return Pin{i}; }
  void StartAudio(AudioHandle::AudioCallback cb) { dp_host_callback = cb; }
  void StartLog(bool = false) {}
  void PrintLine(const char*, ...) {}
  size_t block_ = 48;
};

/* ---- display ---- */

struct FontDef {
  uint8_t width = 6;
  uint8_t height = 8;
};

struct SSD130xI2c128x64Driver {
  struct Config {
    struct Transport {
      struct I2CConfig {
        I2CHandle::Config i2c_config;
        uint8_t i2c_address = 0x3C;
      } i2c_config;
      uint8_t i2c_address = 0x3C;
    } transport_config;
  };
};

template <typename Driver>
struct OledDisplay {
  struct Config {
    typename Driver::Config driver_config;
  };
  void Init(const Config&) {}
  void Fill(bool) {}
  void Update() {}
  void SetCursor(int, int) {}
  void WriteString(const char*, FontDef, bool) {}
  void DrawPixel(int, int, bool) {}
  void DrawLine(int, int, int, int, bool) {}
  void DrawRect(int, int, int, int, bool, bool = false) {}
  void DrawCircle(int, int, int, bool) {}
};

/* ---- MIDI ---- */

struct MidiEvent {
  int type = 0;
  int channel = 0;
  uint8_t data[2] = {0, 0};
};

struct MidiUsbHandler {
  struct Config {
    enum Transport { INTERNAL, EXTERNAL };
    Transport transport_config = INTERNAL;
  };
  void Init(const Config&) {}
  void StartReceive() {}
  void Listen() {}
  bool HasEvents() { return false; }
  MidiEvent PopEvent() { return MidiEvent{}; }
  void SendNoteOn(int, int, int) {}
  void SendNoteOff(int, int, int) {}
};

}  // namespace daisy

/* Fonts the OLED emitter names. Sizes match libDaisy's real ones. */
inline daisy::FontDef Font_6x8{6, 8};
inline daisy::FontDef Font_7x10{7, 10};
inline daisy::FontDef Font_11x18{11, 18};
inline daisy::FontDef Font_16x26{16, 26};
