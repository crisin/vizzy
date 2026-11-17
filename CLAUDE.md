<!-- Draft written 2026-11-10 from README.md, PLAN*.md, docs/bridge.md and the module
     headers. Review it against how you actually work before committing. -->

# vizzy — Claude Code instructions

Audio visualizer for Windows and macOS. Tauri 2: a Rust core captures and analyses audio,
a web frontend (React 19, TypeScript, three.js, Butterchurn) renders.

**Read before larger work:**

1. [`README.md`](README.md) — features, how the app is used, build and release.
2. [`PLAN-ux.md`](PLAN-ux.md) — the UX principles every UI change follows.
3. [`PLAN-playlists.md`](PLAN-playlists.md) — now playing, Regie (rules, pools, queue, choreo).
4. [`PLAN-milkdrop.md`](PLAN-milkdrop.md) — presets, library, studio, layers.
5. [`docs/bridge.md`](docs/bridge.md) — the dev bridge and the Vizzy preset format.

## Architecture in one breath

- **Rust** (`src-tauri/src/`): `audio.rs` + `audio/mac.rs` capture (WASAPI / Core Audio
  process taps) and analysis (FFT, 64 log bands, onset) into one flat `f32` frame;
  `tempo.rs` and `phrasing.rs` turn onsets into tempo, a beat grid, bars and sections;
  `nowplaying.rs` (Windows media session) and `spotify.rs` (PKCE) say what is playing;
  `newhelper.rs` asks Lyrics Helper about the song; `comfy.rs` and `llm.rs` talk to local
  servers; `bridge.rs` is the dev bridge; `store.rs` reads and writes JSON documents in the
  app data directory.
- **Frontend** (`src/`): `App.tsx` holds the render loop and the global key handler;
  `milkdrop/` is everything Butterchurn (engine, preset format, store, auto-switch,
  breeding, remix, tags, layer B, library, studio); `regie/` is everything that decides
  what plays for which song (now playing, director, queue, choreo, ratings, cockpit);
  `scenes3d.ts` and friends are the three.js scenes; `ui/` holds shared pieces.

## Rules

1. **Analysis stays in Rust.** The frontend gets finished, compact frames; it does not
   run its own FFT.
2. **No `fetch` from the webview to local servers.** ComfyUI, local LLM servers and Lyrics
   Helper send no CORS headers; requests run in Rust and are exposed as Tauri commands.
   Tokens and secrets never reach the webview.
3. **One key table.** Every global shortcut lives in `src/keys.ts`; the handler, the help
   window and the tooltips read from it. Do not hard-code a key anywhere else.
4. **Version in two places.** `package.json` and `src-tauri/tauri.conf.json` must agree;
   the build refuses to run otherwise.
5. **Do not touch the Butterchurn patch casually.** `vite.config.ts` swaps a trapping WASM
   opcode for the saturating one and counts the sites it expects. After a Butterchurn
   update, check that count.
6. **User data is files.** Own presets, tags, combos, rules, pools and choreos are JSON in
   the app data directory through `store.rs` (bare file names or one sub folder, nothing
   else). Images and models live in IndexedDB, parameter values in localStorage.
7. **Platform code degrades, it never breaks the build.** Windows is the primary platform.
   A feature without an implementation on the other OS reports nothing or hides itself
   (`nowplaying.rs` is the pattern).
8. **UX principles are binding** (`PLAN-ux.md`): the picture is the product; every function
   has exactly one place; three kinds of window (stage, side panels, workshops); deleting
   offers undo; no empty screen without a hint.
9. **`App.tsx` is about 4,000 lines.** New logic goes into its own module and hooks into
   the render loop thinly.
10. **Language:** UI text and user-facing error messages are German; code, comments and
    commits are English.
11. **New things are announced.** A feature the user can see or set gets an entry at the
    top of `src/news/news.ts` (the "Aktuell" tab), naming its controls. A control shown
    there is the same component as at its fixed place (`ui/ParamControl.tsx`,
    `lyrics/controls.tsx`, the `app` map in `SettingsPanel.tsx`) — never a second copy.

## Commands

```bash
npm install
npm run app          # desktop app in dev mode (hot reload + audio capture)
npm run dev          # frontend only, in a browser with animated demo data
npm run typecheck    # TypeScript check — must be clean before you propose a commit
npm run release      # release build for the host platform
```

Rust tests live in `src-tauri/tests/` (the ComfyUI client against a Python stand-in; the
live suite only runs with `VIZZY_COMFY_URL` set). There are no frontend tests and no CI yet.

## Seeing what you built

Use the dev bridge instead of guessing: Settings → System → *Dev-Brücke für Claude Code*
writes `bridge.json` (URL and token) into the app data directory. `POST /preview` renders a
preset and returns an image plus compile errors, `GET /state` and `GET /log` show what the
app is doing, `POST /screenshot` returns the main picture. Details: `docs/bridge.md`.

## Connected apps

- **Lyrics Helper** is called `new-helper` in this code base (`newhelper.rs`,
  `regie/newHelper.ts`, `newhelper.json` in the app data directory). Keep those names until
  the config file gets a migration — see `kosmos/entscheidungen/002-…`.
- **Spotify**: own PKCE login, redirect `http://127.0.0.1:43821/callback`.

## Shared knowledge (kosmos)

Knowledge that concerns more than one project lives in the `kosmos` repo: locally as a
sibling folder (`D:\Projekte\dev\kosmos`), otherwise on GitHub. It is written in German.

- Before you start: read the playbooks for this task's topics
  (`kosmos/playbooks/`: spotify, tauri-release, audio-capture, comfyui, lokale-modelle).
- Before you start: read `docs/learnings.md` in this repo, once it exists.
- When done: add a learning to `docs/learnings.md`, or say "no learning" explicitly in
  your summary.
- Commits follow the logbook format (`kosmos/konventionen/logbuch-commits.md`).
