# vizzy — Milkdrop-Ausbau: Implementierungsplan

Stand: 2026-11-07. Ergebnis des Interviews zu Crash, Preset-Bibliothek,
Config-UI, Layering, Editor, Remix und Parallax-Kombination.

## Entscheidungen aus dem Interview

| Thema | Entscheidung |
|---|---|
| Crash bei Presets | WASM-Opcode patchen (saturierendes trunc), bestehende Trap-Recovery bleibt als Sicherheitsnetz |
| Bibliothek | Grid aus Vorschauen + eine große Live-Kachel; Vorschauen wahlweise Standbild oder kurzer Clip, der Audio-Dynamik, Tweak-Streuung und Zeitverlauf zeigt |
| Tags | Freie Tags wie Favoriten, vergeben über Library, Code und eine Live-Tag-Leiste; Abspielen nach Tag filterbar; Auto-Switch wählt anhand Energie-Tags passend zu Pegel und Song-Abschnitt. Teil von M1 |
| Vorschauen | In-App im Hintergrund generiert (auch für eigene Presets), Ablage in IndexedDB |
| Config-UI | Ein rechter Drawer für alles: Settings, Tweaks, Routing, ComfyUI, Hilfe, Preset-Studio |
| Layering | Alle drei Formen, Reihenfolge: zwei Presets übereinander → Mashup aus Teilen → Milkdrop in 3D-Szenen |
| Editor | Mashup-Composer, Code-Editor (EEL + GLSL), KI-gestützt |
| Remix | Evolutionär **und** manuell, beides auf dem Composer-Bausteinmodell |
| KI | Lokale Modelle (Ollama-kompatibel) **plus** eine Dev-Brücke, über die Claude Code Presets schreiben, laden und begutachten kann. Kein Cloud-API-Key in der App |
| Speicherung | Eine JSON-Datei pro Preset im App-Datenordner, Stammbaum als Metadaten, einmalige Migration aus localStorage |
| Parallax | Milkdrop als Licht/Textur im Bild, tiefenabhängig |
| Reihenfolge | M0 Crash → M1 Library → M2 Drawer → M3 Layering → M4 Editor → M5 Remix → M6 Parallax |

## Ist-Stand, auf dem das aufsetzt

- Butterchurn 3.0.0-beta.5 kompiliert Preset-Gleichungen per eel-wasm zu
  WASM. Ein Preset ist JSON mit `baseVals`, `shapes[4]`, `waves[4]`,
  `init_eqs_eel`, `frame_eqs_eel`, `pixel_eqs_eel`, `warp`, `comp`
  (`node_modules/butterchurn-presets/presets/converted/*.json`).
- Eigene Presets sind heute `base + overrides` (nur baseVals) in
  localStorage (`src/mdTweaks.ts`), kuratierte in `src/curated.ts`.
- Milkdrop-Rendering, Auto-Switch und Trap-Recovery liegen in `src/App.tsx`
  (ab `renderMilkdrop`, ca. Zeile 2139–2340). App.tsx hat 3191 Zeilen; jede
  Phase zieht ihren Teil heraus.
- Hintergrund-Layer existiert bereits (`bgLayer`: 2D-Modus über Milkdrop
  oder 3D, CSS `mix-blend-mode`), aber kein Milkdrop über Milkdrop.
- Parallax (`src/parallax.ts`) rendert eine Depth-Ebene in three.js,
  Milkdrop lebt in einem eigenen Canvas mit eigenem WebGL-Kontext.

---

## M0 — Crash-Fix (klein, zuerst)

**Ursache.** `float unrepresentable in integer range` ist der WASM-Trap
von `i32.trunc_f64_s` (Opcode `0xaa`). eel-wasm emittiert ihn für jede
Float→Int-Wandlung (`%`, `megabuf(i)`, `loop(n, …)`, `int()`). Das
Original-Milkdrop castet in C und bekommt bei NaN/Überlauf einfach
irgendeine Zahl; Presets wie *alien fish pond* (Physik-Sim mit `gmegabuf`)
verlassen sich darauf. Sobald ihr Zustand einmal NaN ist, trappt jeder
Frame.

**Fix.** Vite-Plugin (`vite.config.ts`), das beim Bundeln in
`butterchurn.js` die vier Emissionsstellen von
`encoding_1.op.i32_trunc_f64_s` durch die saturierende Zwei-Byte-Sequenz
`0xfc, 0x02` (`i32.trunc_sat_f64_s`) ersetzt. NaN wird 0, Überlauf wird
geklemmt. Nicht-trappende Float→Int ist seit Chrome 75 / Safari 15 Standard,
also in WebView2 und WKWebView (macOS 14.4) verfügbar.

- Beim Implementieren prüfen, ob die vier Stellen in Array-Literalen stehen
  (dann reicht der Textersatz) oder einzeln gepusht werden (dann Helfer
  einfügen). Zur Sicherheit: Plugin schlägt den Build fehl, wenn die
  Fundstellen-Zahl nicht stimmt — so fällt ein Butterchurn-Update sofort auf.
- Recovery (`onMilkdropTrap`) bleibt. Zusätzlich: statt stumm zu skippen,
  Preset in eine persistente Quarantäne (`vizzy.mdquarantine`) legen, in der
  Library markieren, per Klick freigeben.
- Verifikation: *alien fish pond* und *astral projection* fünf Minuten
  laufen lassen, Debug-HUD (`D`) ohne `render FAILED`.

**Dateien:** `vite.config.ts`, `src/App.tsx` (Quarantäne), später
`src/milkdrop/` (siehe M1).

---

## M1 — Preset-Bibliothek mit Browse-Modus

**Ziel.** Ein Vollbild-Modal (wie `LibraryModal` für Modelle), das die
107 + kuratierten + eigenen Presets als Grid zeigt, mit Suche, Filter
(Favoriten, Autor, Quarantäne, eigene), Sortierung, Sternen, und einer
großen Live-Kachel für das markierte Preset.

**Schritte.**

1. **Milkdrop-Modul herauslösen.** `src/milkdrop/engine.ts`: eine Klasse
   `MilkdropEngine` kapselt Butterchurn-Instanz, Preset-Laden, Overrides,
   Trap-Recovery, Audio-Einspeisung. App.tsx behält nur noch die
   Modus-Logik. Das ist die Voraussetzung für alles Weitere, weil Library,
   Layering und Editor **mehrere** Instanzen brauchen.
2. **Preset-Katalog.** `src/milkdrop/catalog.ts`: ein Eintrag pro Preset
   mit `key`, `name`, `author` (aus dem Namen geparst: `Flexi`, `Geiss`,
   `Rovastar`, Mashups mit `+`), `source` (butterchurn | curated | user),
   `tags`, `favorite`, `quarantined`. Ersetzt die drei Listen, die heute in
   App.tsx zusammengesetzt werden.
3. **Vorschau-Generator.** `src/milkdrop/previews.ts`: Offscreen-Canvas
   (z. B. 320×180), eine eigene Engine-Instanz, synthetisches Audio
   (Bassdrum-Puls + Rauschen + Sweep; Rust-Analyse wird nicht gebraucht,
   Butterchurn bekommt direkt eine Wellenform). Läuft als Warteschlange im
   Hintergrund, wenn die Library offen ist oder die App idle ist, ein
   Preset nach dem anderen, Ergebnis nach IndexedDB (`src/idb.ts` erweitern,
   Store `mdpreviews`, Key = Preset-Key + Preset-Hash, damit geänderte eigene
   Presets neu gerendert werden).
   - **Standbild:** Frame nach ~3 s Einschwingen, WebP.
   - **Clip:** 12–16 Frames à 320×180 als animiertes WebP (Encoder in
     Rust via `image`-Crate, Frames per IPC) oder — einfacher und zuerst —
     als Sprite-Sheet, das die Kachel per CSS-Animation abspielt. Der Clip
     ist eine Sequenz aus drei Abschnitten: leise → laut → Beat-Drop
     (Audio-Dynamik), dann 2–3 Frames mit zufällig gestreuten
     `zoom/rot/warp/decay` (Tweak-Streuung), eingebettet in einen längeren
     Zeitverlauf. Einstellbar in den Settings: Standbild / Clip, Clip-Länge.
   - Kostenrahmen: ein Preset braucht ~4 s Renderzeit bei Vollgeschwindigkeit;
     bei 110 Presets also ~8 Minuten Hintergrundarbeit beim ersten Mal.
     Gedrosselt rendern (ein Preview-Frame pro Haupt-Frame), damit das
     Hauptbild nicht ruckelt.
4. **Live-Kachel.** Zweite `MilkdropEngine` auf einem Canvas im Modal,
   bekommt dieselben Audio-Frames wie das Hauptbild, zeigt das
   markierte/gehoverte Preset. Hover-Wechsel entprellt (300 ms), damit beim
   Überfahren nicht 20 Presets kompiliert werden.
5. **Modal-UI.** `src/milkdrop/LibraryModal.tsx`: Toolbar (Suche,
   Filter-Chips, Sortierung, Ansicht Bild/Clip, Kachelgröße), Grid,
   rechts die Live-Kachel mit Name, Autor, Stern, "Anwenden", "Tweaks",
   später "Als Basis im Studio". Tastatur: Pfeile, Enter, `S` für Stern.
   Ersetzt das `<select>` in der Milkdrop-Toolbar; `←/→/Zufall/auto/nur ★`
   bleiben.
6. **Tweak-Variante übernehmen.** Aus der Tweak-Streuung im Clip kann eine
   Variante direkt als Overrides übernommen werden (Klick auf den Frame).
7. **Tag-System.** Tags funktionieren wie Favoriten (der Stern wird intern
   selbst ein Tag `★`), nur beliebig viele und benannt.
   - **Modell.** `src/milkdrop/tags.ts`: `tags: Record<presetKey, string[]>`
     plus eine Tag-Liste mit Farbe. Speicherung in `AppData/vizzy/tags.json`
     (Tauri fs, gleicher Ordner wie später die Preset-Dateien; einmalige
     Migration der Favoriten aus `vizzy.favorites`). Im Browser-Fallback
     localStorage. Eigene Presets tragen ihre Tags zusätzlich in der
     Preset-Datei, damit sie beim Teilen mitgehen.
   - **Reservierte Tags mit Bedeutung.** Freie Tags sind reine Labels.
     Drei Gruppen versteht der Auto-Switch: Energie `ruhig` / `mittel` /
     `hoch`, Abschnitt `intro` / `build` / `drop` / `break` / `outro`, und
     `nie-auto` (nur manuell). Sie werden beim ersten Start angelegt und in
     der Tag-Leiste zuerst gezeigt; alles andere ist frei (`spiral`,
     `organisch`, `psy`, `langsam`, …).
   - **Drei Wege zu taggen.**
     1. *Library:* Tag-Chips unter jeder Kachel, Mehrfachauswahl → ein Tag
        auf alle markierten anwenden, Filter-Chips oben (UND/ODER).
     2. *Code:* `curated.ts` und Preset-Dateien bekommen ein Feld `tags`;
        dazu eine Datei `src/milkdrop/tagSeeds.ts` mit Start-Tags für die
        107 Butterchurn-Presets (grob nach Autor und Name; Chris verfeinert
        live). Code-Tags sind Defaults, die Nutzer-Datei gewinnt.
     3. *Live:* Taste `T` öffnet eine schmale Tag-Leiste am unteren Rand
        über dem Bild: die Tags als Chips, Klick toggelt für das laufende
        Preset, Ziffern `1`–`9` schalten die ersten neun Chips, Enter mit
        Text legt ein neues Tag an. Bleibt offen, bis `T`/`Esc`, damit man
        beim Durchhören einfach mitklicken kann. Mausfrei bedienbar, weil
        das meist von der Couch passiert.
   - **Abspielen nach Tag.** `nur ★` wird zu einem Tag-Filter: ein oder
     mehrere Tags wählen (UND/ODER), gilt wie heute für `←/→`, Zufall und
     Auto. Der aktive Filter steht als Chip in der Toolbar.
   - **Vorschlag aus der Vorschau.** Der Preview-Generator misst nebenbei
     Bewegung (Frame-Differenz) und Helligkeit und schlägt daraus ein
     Energie-Tag vor; es wird als *Vorschlag* (gestrichelter Chip) gezeigt
     und erst durch Bestätigung ein Tag. So ist das Energie-Set nach dem
     ersten Durchlauf grob vorsortiert.
8. **Auto-Switch nach Tags.** Der Auto-Algorithmus (`wantsAutoSwitch` /
   `onAutoSwitch`, wandert mit in `src/milkdrop/autoswitch.ts`) wählt
   nicht mehr gleichverteilt, sondern gewichtet:
   - **Energie-Pegel.** Aus der Rust-Analyse kommt bereits RMS und die
     Phrasen-/Sektionsverfolgung (`phrasing.rs`). Ein geglätteter Pegel
     über die letzten ~8 s wird in drei Stufen geteilt (Schwellen
     adaptiv, wie `AutoRange` im Morph-Grid, damit leise Alben nicht
     dauerhaft `ruhig` sind). Presets mit passendem Energie-Tag bekommen
     Gewicht 1, Nachbarstufe 0.3, Gegenstufe 0.05, ungetaggte 0.5.
   - **Abschnitt.** Sektionswechsel mit Energiesprung nach oben wählt aus
     `drop`, nach unten aus `break`; die ersten 30 s eines erkannten
     Tracks (Stille davor) bevorzugen `intro`. Ohne Abschnitts-Tags greift
     nur die Energie-Gewichtung.
   - **Abwechslung.** Zuletzt gespielte Presets werden abgewertet, damit
     ein kleiner Tag-Pool nicht pendelt.
   - **Verhalten.** Parameter in den Settings: Tag-Steuerung aus / sanft /
     streng (streng = nur passende Tags, sonst Fallback auf alle). Das
     Debug-HUD zeigt Pegelstufe und den Grund der letzten Wahl
     (`auto: hoch → "Flexi - area 51" (tag hoch, w=1.0)`), damit man die
     Gewichtung beim Hören nachvollziehen kann.
   - Der Zucht-Modus aus M5 erbt die Gewichtung: Kinder bekommen die
     Energie-Tags ihrer Eltern.

**Dateien:** neu `src/milkdrop/{engine,catalog,previews,tags,tagSeeds,autoswitch,LibraryModal,TagBar}.ts(x)`,
`src-tauri/src/presets.rs` (nur der Tags-Teil, Rest in M4a),
`src/idb.ts`, `src/App.tsx` (Entflechtung), `src/App.css`.

**Risiken.** WebGL-Kontextlimit (Browser: ~16): Haupt + Hintergrund-Layer
+ Live-Kachel + Preview-Generator = 4, das ist sicher. Preview-Generator
pausiert bei Vollbild-Wiedergabe.

---

## M2 — Config-Drawer

**Ziel.** Ein einziger rechter Drawer ersetzt `SettingsPanel`,
`MdTweakPanel`, `RoutingModal`, `ComfyPanel`, `HelpPanel`. Gleiche
Zeilen-Komponente überall, nichts mehr abgeschnitten (das Tweak-Panel ist
heute 330 px breit mit horizontalem Scrollbalken).

**Bausteine.**

- `src/ui/Drawer.tsx`: rechts, 420–520 px, Vertikal-Tabs oder Sektionen
  links (Audio, Bild, Milkdrop, Layer, Routing, ComfyUI, Bedienung, System,
  Hilfe; später Studio). Breite ziehbar, Zustand persistent, `E`/`Esc` wie
  bisher. Auf schmalen Fenstern Vollbreite.
- `src/ui/ParamRow.tsx`: Label, Slider, **Zahlfeld** (tippen, Pfeiltasten
  ±Schritt, Shift ±10×), Reset-Punkt pro Wert, "geändert"-Markierung,
  Hint als Tooltip/Untertitel. Slider bekommt Mausrad-Feinschritt.
  Routing-Indikator, wenn ein Frequenz-Listener auf dem Wert sitzt.
- `src/ui/Section.tsx`: Collapsible mit Reset-Button für die Gruppe,
  Zustand pro Sektion gemerkt.
- Tweaks wandern als Sektion "Preset-Tweaks" in den Drawer, gruppiert:
  Bewegung (decay, zoom, zoomexp, rot, warp, cx, cy, sx, sy), Wave
  (wave_*), Echo, Farbe/Gamma. Nur Gruppen zeigen, die das Preset nutzt;
  Fußzeile Verwerfen / Speichern unter / Löschen bleibt.
- `params.ts` bleibt die Quelle der Wahrheit; `ParamGroup` wird auf
  `ParamRow` umgestellt, damit Tweaks und Settings identisch aussehen.
- Milkdrop-Toolbar im Hauptbild wird auf das Nötigste reduziert
  (Library, ←/→, Zufall, auto, ★, Tweaks-Shortcut), Rest im Drawer.

**Reihenfolge innerhalb M2.** Drawer-Hülle + ParamRow → Settings-Tabs
migrieren → Tweaks → Routing → ComfyUI → Hilfe → alte Panels löschen.

**Dateien:** neu `src/ui/`, Umbau `SettingsPanel.tsx`, `MdTweakPanel.tsx`,
`RoutingModal.tsx`, `ComfyPanel.tsx`, `HelpPanel.tsx`, `App.css`.

---

## M3 — Layering

Drei Stufen, jede für sich nutzbar.

### M3a — Zwei Presets übereinander

- Zweite `MilkdropEngine` auf einem zweiten Canvas (Layer B) hinter oder
  über Layer A. Mischung per `mix-blend-mode` + Opacity (CSS, wie heute
  beim `bgLayer`), plus optional Blur/Dim pro Layer.
- Pro Layer: eigenes Preset, eigene Tweaks, eigener Auto-Switch (oder
  gekoppelt: B wechselt eine Phrase nach A), eigener Audio-Gain und
  Frequenz-Routing (Bass → A, Höhen → B).
- UI: Sektion "Layer" im Drawer mit zwei Preset-Slots (jeweils Library
  öffnen), Blend-Modus-Auswahl, Opacity. Im Hauptbild ein kleines
  Layer-Badge.
- Ein Layer-Setup ist speicherbar als "Combo" (Datei, siehe M4-Format).

### M3b — Mashup aus Teilen

Das ist der Kern für Editor und Remix und bekommt ein eigenes Datenmodell:

```
VizzyPreset {
  id, name, author: "du", created, modified,
  base?: string            // Butterchurn-Key, falls reine Tweak-Ableitung
  parts: {                 // jeder Teil: Referenz auf ein Preset oder Inline
    baseVals:  Ref | Inline
    init:      Ref | Inline   // init_eqs_eel
    frame:     Ref | Inline   // frame_eqs_eel
    pixel:     Ref | Inline   // pixel_eqs_eel
    warp:      Ref | Inline   // Warp-Shader
    comp:      Ref | Inline   // Comp-Shader
    waves:     (Ref | Inline)[4]
    shapes:    (Ref | Inline)[4]
  }
  overrides: Record<string, number>
  lineage: { parents: id[], op: "tweak" | "mashup" | "mutate" | "cross" | "edit" | "ai" }
  rating?: number, plays?: number
}
```

- `src/milkdrop/compose.ts` löst ein `VizzyPreset` zu einem
  Butterchurn-JSON auf. Variablen-Konflikte sind in Milkdrop-Mashups
  üblich und erlaubt (Frame-Gleichungen von X setzen `q1..q32`, Shader von
  Y lesen sie); der Composer zeigt nur eine Warnung, wenn `q`-Variablen
  gelesen aber nie gesetzt werden.
- UI im Studio (M4): acht Slots, pro Slot "aus Preset wählen" (Library
  als Picker) oder "behalten", sofortige Vorschau in der Live-Kachel,
  "Würfeln" füllt alle Slots zufällig aus den Favoriten.

### M3c — Milkdrop in 3D-Szenen

- Milkdrop-Canvas als `THREE.CanvasTexture` in die 3D-Szenen: Orb-Material,
  Tunnelwände, Terrain-Farbe. Shared WebGL geht nicht (eigener Kontext),
  darum einmal pro Frame `texture.needsUpdate` — bei 1080p-Milkdrop ist das
  ein GPU→GPU-Upload über die CPU, also Milkdrop-Layer auf 50 % Auflösung
  rendern, wenn er als Textur dient.
- Parameter pro Szene: `mdTexture: off | background | material | both`.
  Die Parallax-Variante (M6) baut darauf auf.

**Dateien:** `src/milkdrop/{engine,compose}.ts`, `src/scenes3d.ts`,
`src/App.tsx`, Drawer-Sektion Layer.

---

## M4 — Preset-Studio (In-App-Erstellung)

Ein Drawer-Tab "Studio" mit drei Werkzeugen über demselben `VizzyPreset`.

### M4a — Speicherung auf Dateien

- `src-tauri/src/presets.rs`: Tauri-Commands `list_presets`, `read_preset`,
  `write_preset`, `delete_preset` über `AppData/vizzy/presets/*.json`
  (Tauri `app_data_dir`). Datei-Watcher (`notify`-Crate) meldet
  Änderungen per Event ans Frontend → Hot-Reload, wenn das Preset gerade
  läuft. Das ist auch die Dev-Brücke: Claude Code schreibt eine Datei, die
  App zeigt sie sofort.
- Einmalige Migration aus `vizzy.mdpresets.v1`. Export/Import als JSON,
  Ordner im Explorer öffnen (`plugin-opener` ist schon da).
- Eigene Presets bekommen im Katalog Quelle `user` und laufen durch den
  Preview-Generator.

### M4b — Mashup-Composer

Siehe M3b. Plus: Tweak-Sektion arbeitet direkt auf `overrides` des
offenen Studio-Presets; "Speichern" schreibt die Datei; "Speichern als"
legt ein Kind mit `lineage.parents=[id]` an.

### M4c — Code-Editor

- CodeMirror 6 (klein, MIT) mit einfachem EEL-Highlighting (Schlüsselwörter,
  `q1..q32`, `megabuf`) und GLSL-Modus. Tabs: Init, Frame, Pixel, Warp,
  Comp, je Wave/Shape ein Unterabschnitt.
- Live-Reload mit 400 ms Entprellung in die Live-Kachel (nicht ins
  Hauptbild, bis "Anwenden"). Compile-Fehler von Butterchurn (eel-wasm
  Parse-Fehler, GLSL-Fehler aus `gl.getShaderInfoLog`) in einer
  Fehlerzeile unter dem Editor; die Engine muss dafür Fehler nach außen
  reichen statt nur zu loggen.
- Referenz-Panel: Liste der Milkdrop-Variablen (`bass`, `treble`, `time`,
  `frame`, `fps`, `q1..q32`, `rad`, `ang`, `zoom`, …) mit Einzeiler.
- Vizzy-Erweiterung: zusätzliche Variablen aus der Rust-Analyse
  (`vz_bpm`, `vz_phrase`, `vz_bar`, `vz_section`, `vz_grid`) werden vor
  dem Frame in die Engine gesetzt, damit eigene Presets auf Takt und
  Phrase reagieren können — das kann kein anderes Milkdrop.

### M4d — KI-gestützt: lokale Modelle + Claude-Code-Brücke

Zwei Wege, eine Schnittstelle. `src/milkdrop/agent.ts` definiert einen
`PresetAgent`: `propose(preset, instruction) → VizzyPreset[]` plus
`explain(preset)`.

1. **Lokal (in-App):** Backend "OpenAI-kompatibler Endpunkt" (Ollama,
   LM Studio, llama.cpp-Server), URL + Modell in den Settings. Rust macht
   den HTTP-Call (wie bei ComfyUI, wegen CORS). Prompt enthält den
   EEL/GLSL-Spickzettel, das aktuelle Preset und die Anweisung; Antwort
   als JSON-Patch auf die `parts`. Ergebnis landet nur in der Live-Kachel,
   "Behalten" schreibt ein Kind mit `lineage.op="ai"`. Erwartung ehrlich:
   kleine Modelle liefern bei EEL eher Variationen von Konstanten und
   baseVals als neue Algorithmen; dafür reicht es, und mit Qwen-Coder-
   Klassen ab 14B wird es brauchbar.
2. **Claude Code (Dev-Brücke):** kein Modell in der App, sondern die App
   macht sich für einen Agenten bedienbar:
   - Presets sind Dateien (M4a) → Claude Code kann sie lesen und schreiben,
     die App lädt sie live.
   - `src-tauri/src/bridge.rs`: lokaler HTTP-Server auf `127.0.0.1`
     (nur bei aktiviertem Dev-Modus in den Settings, zufälliger Port in
     `AppData/vizzy/bridge.json`): `GET /state` (Modus, Preset, Layer,
     fps), `POST /preset/load`, `POST /preset/preview` (rendert ein
     Preset-JSON 3 s mit Synthetik-Audio und liefert ein PNG),
     `GET /log` (die flog-Zeilen inkl. Compile-Fehler), `POST /screenshot`.
   - Ein kleines Skill-/Doku-Blatt im Repo (`docs/bridge.md`) beschreibt
     die Endpunkte, sodass eine Claude-Code-Session Presets iterativ bauen
     kann: schreiben → Vorschau holen → Fehler lesen → nachbessern. Später
     optional als MCP-Server verpacken.

**Dateien:** `src-tauri/src/{presets,bridge}.rs`, `src/milkdrop/{agent,
studio/*}.tsx`, Settings-Sektion "KI & Dev".

---

## M5 — Remix-System

Baut auf `VizzyPreset.lineage` und dem Composer auf.

- **Operatoren** (`src/milkdrop/evolve.ts`):
  - `mutate(p)`: baseVals streuen (gauss, pro Key sinnvolle Breite), in
    Gleichungen numerische Konstanten um ±10–30 % verändern (Tokenizer
    über EEL, Zahlen ersetzen, Rest unberührt), Wave/Shape-Flags kippen.
  - `cross(a, b)`: Teile-weise Kreuzung (Slots zufällig aus a oder b),
    oder baseVals-Mittelung.
  - Immer kompilieren und 2 s probe-rendern, bevor ein Kind in den Pool
    kommt (Trap, Schwarzbild, NaN-Ausgabe → verwerfen).
- **Manuell:** im Studio "Mutieren" / "Mit … kreuzen" (Library-Picker),
  Ergebnis als 4–6 Kinder in einer Vorschau-Reihe, eins behalten → Datei
  mit Stammbaum. Stammbaum-Ansicht in der Library (Eltern/Kinder als
  Baum, Klick springt).
- **Evolutionär:** Modus "Zucht" im Auto-Switch: der Pool ist eine
  Population (Start: Favoriten), jeder Wechsel zeigt mit Wahrscheinlichkeit
  *p* ein Kind statt eines Elternteils. Bewertung im Vorbeigehen: Tasten
  `+`/`-` (oder Daumen im HUD), Verweildauer zählt leicht positiv,
  manuelles Wegklicken negativ. Fitness-Score auf dem Preset; alle N
  Generationen wird der Pool beschnitten, Gewinner werden Dateien. Alles
  andere bleibt im Pool-Ordner `presets/evolve/` und wird aufgeräumt.
- Einstellungen: Mutationsstärke, Kind-Anteil, Pool-Größe, "nur baseVals
  mutieren" (sicherer) vs. "auch Gleichungen".

**Dateien:** `src/milkdrop/evolve.ts`, Studio-Tab "Remix", HUD-Bewertung,
Library-Stammbaum.

---

## M6 — Parallax × Milkdrop: Milkdrop als Licht im Bild

- Milkdrop-Canvas als Textur in `ParallaxScene` (Mechanik aus M3c).
- Im Parallax-Fragment-Shader drei Mischmodi, tiefenabhängig gewichtet
  (`w = mix(nearWeight, farWeight, depth)`):
  - **Licht:** Milkdrop-Luminanz moduliert Helligkeit/Farbe des Bildes
    (multiplikativ + additiver Anteil, Schwelle gegen Grauschleier).
  - **Verzerrung:** Milkdrop-Farbgradient als UV-Offset, Stärke × Tiefe
    → der Vordergrund wabert, der Hintergrund bleibt ruhig (oder
    umgekehrt).
  - **Reflexion:** Milkdrop nur in den hellen Bildanteilen, als würde die
    Visualisierung sich im Bild spiegeln.
- Parameter: Modus, Stärke nah/fern, Blur der Milkdrop-Textur, Beat-Kick
  auf die Stärke. Alle über Routing modulierbar.
- Gleiche Erweiterung für den Morph-Grid, da derselbe Shader-Pfad.

**Dateien:** `src/parallax.ts`, `src/morph.ts`, Parameter in `params.ts`.

---

## Reihenfolge, Umfang, Lieferung

| Phase | Umfang | Branch / PR |
|---|---|---|
| M0 Crash | klein | `fix/md-trunc-sat` |
| M1 Library | mittel-groß; enthält Engine-Entflechtung, Tags und Tag-Auto-Switch | `feat/md-library` |
| M2 Drawer | mittel-groß | `feat/ui-drawer` |
| M3a Layer A+B | klein | `feat/md-layers` |
| M3b Composer-Modell | mittel | `feat/md-compose` |
| M3c Milkdrop in 3D | klein | `feat/md-texture-3d` |
| M4a Dateien + Watcher | klein | `feat/md-preset-files` |
| M4b Studio-Composer | mittel | `feat/md-studio` |
| M4c Code-Editor | mittel | `feat/md-code-editor` |
| M4d Agent + Brücke | mittel | `feat/md-agent` |
| M5 Remix | mittel | `feat/md-evolve` |
| M6 Parallax-Licht | klein-mittel | `feat/parallax-md-light` |

Jede Phase endet mit: Typecheck grün, Verifikation im laufenden Tauri-Dev
über Audio-Logs und Debug-HUD, README-Abschnitt, Commit.

## Offene Punkte für später

- Import fremder `.milk`-Dateien braucht den HLSL→GLSL-Konverter von
  Butterchurn (schwer, Emscripten). Erst wenn die eigenen Presets stehen.
- Lizenz der Community-Presets vor jeder Weitergabe eigener Remixe prüfen
  (steht schon in PLAN.md).
- Butterchurn-Upgrade von beta.5: das Opcode-Plugin bricht den Build
  absichtlich, wenn sich die Fundstellen ändern.
