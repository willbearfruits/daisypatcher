// Harness main for a host-compiled patch.
//
// The generated file's own `main` is renamed to `dp_patch_main` by a
// `-Dmain=` on the command line, so it becomes an ordinary function we can
// call for its side effect: running every node's init. It never returns —
// it ends in `while (1)` — so `System::Delay` throws and we catch that
// here, by which point init has completed and `StartAudio` has handed us
// the audio callback.
//
// Then we render blocks and write raw stereo float32 to stdout, which is
// what `audio-parity.mjs` compares against the same patch rendered through
// the emulator worklets.

#include "dp_host_daisy.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

/** Provided by the generated file (its `main`, renamed on the command line). */
extern int dp_patch_main(void);

int main(int argc, char** argv) {
  const int total = argc > 1 ? std::atoi(argv[1]) : 48000;
  const int block = argc > 2 ? std::atoi(argv[2]) : 48;

  try {
    dp_patch_main();
  } catch (const daisy::DpHostLoopExit&) {
    // Expected: init finished and the generated loop hit its first Delay.
  }

  if (!daisy::dp_host_callback) {
    std::fprintf(stderr, "patch never called StartAudio\n");
    return 2;
  }

  std::vector<float> inL(block, 0.f), inR(block, 0.f);
  std::vector<float> outL(block, 0.f), outR(block, 0.f);
  const float* inPtrs[2] = {inL.data(), inR.data()};
  float* outPtrs[2] = {outL.data(), outR.data()};

  std::vector<float> interleaved;
  interleaved.reserve(static_cast<size_t>(total) * 2);

  for (int done = 0; done < total; done += block) {
    const int n = (total - done) < block ? (total - done) : block;
    // Silence in. A parity run compares generators and processors driven by
    // their own params; feeding noise would only test that two different
    // PRNGs disagree.
    std::fill(outL.begin(), outL.end(), 0.f);
    std::fill(outR.begin(), outR.end(), 0.f);
    daisy::dp_host_callback(inPtrs, outPtrs, static_cast<size_t>(n));
    for (int i = 0; i < n; i++) {
      interleaved.push_back(outL[i]);
      interleaved.push_back(outR[i]);
    }
    // Advance the millisecond clock the way the device's main loop would,
    // so anything time-based (menus, OLED throttles) sees time pass.
    daisy::System::NowRef() += static_cast<uint32_t>((1000.0 * n) / 48000.0);
  }

  std::fwrite(interleaved.data(), sizeof(float), interleaved.size(), stdout);
  return 0;
}
