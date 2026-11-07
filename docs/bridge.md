# Dev bridge — working on presets from Claude Code

Vizzy can be driven from outside while it runs: a tool like Claude Code
writes a preset, asks the app to render it, reads back an image and any
compile errors, fixes the code, and plays the result. Two mechanisms work
together:

1. **Preset files.** Own presets are JSON files in the app data directory,
   `presets/<id>.json`. The app polls that folder, so a file written by any
   tool appears in the picker within ~1.5 s and reloads in place if it is
   playing.
2. **The bridge.** A small HTTP server inside the app, for everything that
   needs the renderer: preview a preset, play it, take a screenshot, read
   the log.

## Switching it on

Settings (`E`) → System → *Dev-Brücke für Claude Code*. The bridge binds to
`127.0.0.1` on a random port and writes `bridge.json` next to the presets:

```json
{ "url": "http://127.0.0.1:53817", "port": 53817, "token": "…", "header": "X-Vizzy-Token" }
```

Every request needs that token in the `X-Vizzy-Token` header. The file is
deleted when the bridge is switched off.

App data directory:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\com.vizzy.desktop\` |
| macOS | `~/Library/Application Support/com.vizzy.desktop/` |

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/state` | — | mode, playing preset key and label, its tags and rating, layer B, energy level, BPM, last auto-switch reason, own preset keys |
| GET | `/log` | — | last 300 log lines of the app (`[md] …` lines include compile and load failures) |
| POST | `/preview` | `{"key": "…"}` or `{"preset": {…}}` | `{ok, reason, errors, image}` — renders ~2 s at 192×108 against a synthetic beat; `ok` is false if it traps, stays black, white or flat; `errors` carries EEL parse errors and shader compiler messages with line numbers; `image` is a data URL (WebP) |
| POST | `/load` | `{"key": "…"}` or `{"preset": <Vizzy preset>}` | plays it in the main picture (a Vizzy preset is saved first) |
| POST | `/save` | `{"preset": <Vizzy preset>}` | saves the file without playing it |
| POST | `/screenshot` | — | `{ok, image}` of the main Milkdrop picture |

`preset` may be a Vizzy preset (`"format": "vizzy-preset"`) or plain
Butterchurn JSON (`baseVals`, `init_eqs_eel`, `frame_eqs_eel`,
`pixel_eqs_eel`, `warp`, `comp`, `waves`, `shapes`).

## The Vizzy preset format

```json
{
  "format": "vizzy-preset",
  "version": 1,
  "id": "cold-spiral-k3j9x",
  "name": "Cold Spiral",
  "created": 1762500000000,
  "modified": 1762500000000,
  "base": "Flexi - infused with the spiral",
  "parts": {
    "warp": { "from": "Geiss - Thumb Drum" },
    "comp": { "inline": " shader_body { ret = texture(sampler_main, uv).xyz * 1.2; }" },
    "waves": [null, { "from": "martin - disco mix 4" }, null, null]
  },
  "overrides": { "decay": 0.97, "zoom": 1.01 },
  "tags": ["ruhig"],
  "lineage": { "parents": ["Flexi - infused with the spiral"], "op": "edit", "at": 1762500000000 }
}
```

- `base` is the preset every part defaults to (any key: a Butterchurn preset
  name, `vizzy:<curated>`, `user:<own preset>`). Empty means every part is
  inline.
- `parts.<name>` is `{ "from": key }` (take it from another preset) or
  `{ "inline": … }` (written here). Code parts: `init`, `frame`, `pixel`
  (EEL text), `warp`, `comp` (shader text). `baseVals` takes an object.
  `waves` / `shapes` are four slots each.
- `overrides` are baseVals applied last.
- Keys of all presets: `GET /state` for own ones; the Butterchurn names are
  the file names in `node_modules/butterchurn-presets/presets/converted/`.

## A loop that works

```bash
B=$(cat "$APPDATA/com.vizzy.desktop/bridge.json")
URL=$(echo "$B" | jq -r .url); TOK=$(echo "$B" | jq -r .token)

# render a draft and look at the result
curl -s -H "X-Vizzy-Token: $TOK" -d @draft.json "$URL/preview" | jq '{ok, reason, errors}'

# happy? save it into the preset folder and play it
curl -s -H "X-Vizzy-Token: $TOK" -d "{\"preset\": $(cat draft-vizzy.json)}" "$URL/load"
```

Write, preview, read `errors`, fix, repeat. The image from `/preview` is
small on purpose — enough to tell black from alive and calm from busy.
