# Learnings

Short, dated notes on what surprised us. Newest first.

## 2026-11-17 — "Aktuell": news with live controls

- **"One place per function" survives a second view if the control is one
  component.** The news tab does not copy switches; it renders the same
  component (`ParamControl`, `LyricsControl`, the drawer's `app` elements)
  and links to the fixed place. What had to change first: the switches were
  inline JSX inside their tabs and had to become addressable by name.
- **A changelog in the UI rots unless it checks itself.** Entries name
  controls by id; an id that resolves to nothing is dropped, an entry left
  with nothing disappears, and the dev console names the stale reference.
- **Mark "seen" on mount, show "new" from a snapshot.** React's strict mode
  runs effects twice in dev, so "mark seen when the tab closes" fires at
  once. Taking the unseen ids into state first keeps the badges for the
  visit while the dot on ⚙ goes immediately.
- **A bigger settings view does not need a second UI.** The drawer was
  already resizable; a container query on its own width turns the tabs into
  a left navigation and lets the body flow in CSS columns. Every panel that
  is wired into the drawer (source, routing, ComfyUI, layer B) comes along
  for free, and a third of the picture stays visible as the live preview.
- **A search field must not be a dialog's first focusable.** The drawer
  focuses its first control on opening; with the field there, the opening
  key (`E`) landed in it and every shortcut after it too. DOM order keeps
  the close button first, CSS `order` puts the field where it belongs.
- **"Only what changed" is a CSS filter once rows carry a `changed`
  class** (`:has()` hides sections without one); collapsed sections have to
  be forced open for it, through a context.
- **A link into a tab that is not mounted yet needs a hand-over.** The jump
  sets a pending section id; the section takes it when it mounts (or on the
  event, if it is already there), opens, scrolls and glows.

## 2026-11-16 — One debug switch for lyrics

- **A debug recording has to be openable without tools.** The log's audio
  was raw `.f32` (fine for the offline test, useless in a player). It is
  16-bit WAV now — the very samples Whisper gets, half the size. The header
  sizes are rewritten after every block, so the file is valid whenever the
  app stops; that needs a file opened for writing, not appending (append
  mode ignores seeks).
- **Two halves of a story belong in one file.** The worker knows what was
  heard, the webview what the synced lyrics did with it. The webview's notes
  (`lyrics_note`) go through the worker into the same JSONL, stamped when
  they were made, instead of a second log to line up by hand.

## 2026-11-16 — Takes: song times for heard lines

- **A line's song time is asked for a moment in the past.** The worker knows
  how long ago a line ended; the media position is an anchor (position, when,
  playing). While paused the position stands still from the anchor on, but a
  line sung before the pause still lies before it — treating "paused" as one
  fixed position puts the last line of every pause ~2 s late.
- **Tell the worker the position only when it jumps.** The media session's
  samples jitter by about a second; re-anchoring on each one moves that jitter
  into the line times. One anchor that keeps running, replaced when the new
  sample is more than 1.5 s off (seek, pause), is steadier.
- **Measure "how much of the song" in audio heard, not in the span of the
  lines.** Skipping to the end makes the span 100 %.
- **Write the file as you go.** A worker has no reliable "app quits" moment;
  rewriting a small JSON after each line (temp file, rename) needs none.
- **A strict receiver wants exactly its fields.** Lyrics Helper validates
  with `forbidNonWhitelisted`, so one extra key in the take (our own
  `uploaded` note) is a 400. Strip bookkeeping before sending, and pass the
  receiver's `message` on to the user instead of a bare status code.
- **"Done" is an event of its own.** The file appearing and the take being
  complete are different moments; uploading on the first would send a third
  of a song. The worker says `lyrics-take-done` when the song changes.

## 2026-11-14 — Chorus and synced lyrics

- **A chorus is just a line the song had before.** Word-LCS ≥ 0.7 against
  every earlier committed line (≥ 3 words, so "oh yeah" never counts) found
  both choruses of "Take On Me" end to end and left verse 2 alone.
- **Whisper as a clock:** a heard line located in the LRC text gives the
  offset to the media position. Take the median and only jump after two
  agreeing matches — a single chorus line matched to the wrong chorus is the
  usual error, so search near the expected time first.
- **Pure logic in its own file runs under plain Node 26** (type stripping):
  checks without adding a test framework; `tsconfig` excludes `*.test.ts`.

## 2026-11-14 — Overlay mode

- **A click-through window needs a way out that is not the window.** With
  `set_ignore_cursor_events(true)` vizzy never gets focus, so its own keys
  are dead; a global shortcut (`tauri-plugin-global-shortcut`, Rust side,
  no webview permission) is the exit. The mode is never persisted.
- **Transparency is a creation-time window property** (`transparent` in
  `tauri.conf.json`); normal mode stays opaque because the page paints its
  own background.
- **Do not test global shortcuts by injecting keys into the user's
  desktop** — whatever has focus gets them too (here: a running game).

## 2026-11-14 — Singing voice without a model

- **Pitch trackers don't find voices in a mix.** YIN periodicity on the
  vocal band of the full mix scored AUC ~0.5 (chance) on three of four
  songs against Demucs vocals: synths and guitars are just as periodic.
- **The stereo image does.** Per FFT bin, keep only what sits dead centre
  (side < 0.1 × mid): its share of the band is 0.7–0.8 while singing,
  0.25–0.4 otherwise. Its level alone matched the four-feature logistic
  fit. Pure relative loudness needs that absolute anchor — a constantly
  empty centre otherwise normalizes to "always singing".
- **Demucs on CPU in a throwaway `python:3.11-slim` container** is enough
  for 60 s calibration clips (a few minutes, no CUDA build, no VM OOM).
  Ground truth: vocals stem above −26 dBFS per 512-sample hop.
- Rap over a centred beat is the hard case (gate 65 %); speech streams are
  "voice" too, which is fine for effects.

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
