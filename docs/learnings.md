# Learnings

Short, dated notes on what surprised us. Newest first.

## 2026-11-14 — Lyrics profiles and transcript log

- **Shorter isn't just faster, it's wronger.** Offline over five songs:
  step 300 ms / window 1.2–8 s is ~1.6 s behind (standard 2.4 s), but on
  sung German it invents lines in other languages ("Eyvuz dövdürmen zun")
  where the standard hears the right ones. More context helps less than
  expected: 700 ms / 2.5–15 s is 2.7 s behind and only slightly cleaner.
  Raising the agreement threshold (0.88) and the logprob floor made things
  worse — an invented outro line got through. Profiles in `store.ts`.
- **Record what Whisper heard, not the source.** The log's `.f32` per song
  replays through `lyrics_offline` with the same lines as live — a song
  that went wrong at a party can be tuned at the desk afterwards.
- **`serde_json::to_value` widens f32 to f64** (`0.7` → `0.699999988`).
  Go through `to_string` for logs people read.

## 2026-11-14 — Live lyrics with Whisper

- **Whisper on music works better than expected.** `large-v3-turbo` on the mixed
  signal (no vocal separation) gets German, English, Spanish and fast rap nearly word
  for word. ~200 ms per 5–12 s window on an RTX 5070.
- **whisper.cpp's `no_speech_prob` is useless on music.** It reported 7e-11 for a
  purely instrumental intro that it transcribed as "Музыка". What does work: drop a
  window whose whole answer is filler ("Thank you.", "Bye.", "you"), and when the
  window is full without agreement, drop the first segment unless the previous run
  heard it too. Invented text is rarely stable; sung text is.
- **Silero VAD drops sung lines.** At every threshold from 0.1 to 0.5 whole lines
  went missing (a rock vocal entirely). It stays opt-in in the container
  (`WHISPER_VAD=1`).
- **Whisper loops on repetitive vocals** ("I'm in, I'm in, …" for a whole window,
  3× slower). Cap repeated phrases of 1–4 words at four repetitions.
- **A settings tab can drive a Rust worker live without restarts.** The
  worker re-reads its config every step; the webview debounces saves to
  `lyrics.json` (300 ms) and shows back what Rust clamped. Lets you tune the
  agreement knobs while the song plays.
- **Do not build ggml-cuda inside Docker Desktop.** The CUDA template instances ran
  the Docker VM out of memory, even at `-j 6`; the OOM killer took other running
  containers with it. The project's own image `ghcr.io/ggml-org/whisper.cpp:main-cuda`
  ships CUDA 13.0 and runs on Blackwell (sm_120).
