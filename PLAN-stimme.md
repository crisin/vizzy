# vizzy — Effekte aus Stimme und Text: Plan

Stand: 2026-11-14, nach dem Lyrics-Spike (`src-tauri/src/lyrics.rs`, Overlay `U`).
Noch nichts davon umgesetzt.

## Ausgangslage

Wir haben jetzt drei Arten, „was gesungen wird“ zu kennen. Sie unterscheiden
sich vor allem in der **Latenz**, und daraus folgt, welcher Effekt wohin gehört:

| Quelle | Latenz | Weiß | Geht für |
|---|---|---|---|
| **A · Stimm-Signal** (DSP in Rust, neu) | ~20–50 ms | *dass* und *wie hoch* gesungen wird | alles, auch Twitch |
| **B · Whisper live** (steht) | 1–3 s danach | *was* gesungen wurde | alles, auch unbekannte Songs |
| **C · Synchron-Lyrics** aus Lyrics Helper | 0 s, sogar **vorher** | was *gleich* kommt, Abschnitte (Strophe/Refrain) | Songs, die Lyrics Helper kennt |

Faustregel: **Pro Frame** (Puls, Farbe, Form) nur A. **Pro Zeile** (Text,
Bildwechsel, Stimmung) B oder C. Effekte, die *auf* dem Wort sitzen sollen
(Wort poppt im Takt, Refrain-Drop), brauchen C, denn B kommt immer zu spät.

## Bausteine

### 1 · Stimm-Signal als Modulationsquelle (A)

In `audio.rs` neben Beat und Flux, im selben Frame:

- **`voice`** (0..1): Wahrscheinlichkeit, dass gerade gesungen wird.
  Heuristik ohne Modell: Gesang ist meist **mittig gemischt**. Wir rechnen
  Mid/Side im Sprachband (200 Hz–4 kHz) und kombinieren das mit
  Harmonizität (Autokorrelation/YIN-Konfidenz). Dafür muss die Capture-Schleife
  Stereo statt Mono an den Analyzer geben. Whisper liefert die Wahrheit nach;
  damit lässt sich die Schwelle im Lauf nachkalibrieren.
- **`pitch`** (Hz, 0 = keiner) und **`pitchConf`**: YIN auf dem Mid-Signal,
  geglättet. Im Mix ist das verrauscht, für Farbe/Höhe aber gut genug.
- **Einsatz-Ereignis** `voiceOn` / `voiceOff` mit Hysterese (Strophe beginnt,
  Instrumental beginnt).

Im Frontend: In `listeners.ts` gibt es heute nur Frequenzbänder als Quelle.
Wir ergänzen **„Stimme“, „Tonhöhe“, „Stimm-Einsatz“** als Quellen, dann wirkt
das sofort auf **jeden** Parameter über das vorhandene Routing (Audio-Tab),
ohne neue UI. Zusätzlich gehen beide Werte an Milkdrop (`q`-Variablen) und an
die 3D-Szenen.

**Warum zuerst:** Das ist billig, hat die geringste Latenz, wirkt in allen
Modi und braucht keinen Server. Es ist der Unterschied zwischen „das Bild
tanzt zur Musik“ und „das Bild atmet mit der Sängerin“.

### 2 · Text-Ereignisse und Kinetic Typography (B, später C)

Aus dem Lyrics-Worker werden Ereignisse statt nur Text:

- **`line`**: neue feste Zeile, mit Wortanzahl und Länge.
- **`repeat`**: Die Zeile kam in diesem Song schon einmal vor (Ähnlichkeit
  ist in `lyrics.rs` schon da). Das ist der beste billige **Refrain-Detektor**.
  Er erkennt den Refrain beim zweiten Mal; die Regie kann dann zum Beispiel
  Layer B oder ein „großes“ Preset bringen.
- **`language`**: die erkannte Sprache aus Whispers Antwort, für Schrift
  und Darstellung.

Effekte:

- **Overlay-Modi**, die auf den Takt hören: Wort für Wort *im Beat-Raster*
  statt mit fester Dauer (Beat-Phase liegt im Frame), Zeile pulsiert auf der
  Eins.
- **3D-Szene „Text“**: Wörter als Objekte im Raum (three.js, Glyphen als
  Texturen), sie fliegen auf den Beat ein, zerfallen beim Instrumental in
  Partikel. Neue Szene in `scenes3d.ts`, Text aus dem Lyrics-Store.
- **Milkdrop:** Den Text als Textur einspeisen (Butterchurn-Sprites/eigene
  Textur). Das ist ungeklärt und vermutlich aufwendig, nur als Experiment.

Regie: neue Regel-/Choreo-Auslöser `refrain`, `stimme an`, `stimme aus`
neben den heutigen Section-Ankern (`choreo.ts`).

### 3 · Synchron-Lyrics aus Lyrics Helper, Whisper als Uhr (C + B)

Lyrics Helper hat für viele Songs **zeitgestempelte Zeilen** (LRCLIB, Feld
`LyricsLine.timestampMs`) und **Abschnitte** (`LyricsSection`, Strophe,
Refrain …). Der vizzy-Endpunkt `/integrations/vizzy/song` (Branch
`feat/vizzy-integration`, noch nicht in `main`) liefert heute nur die
Abschnitte mit Startzeit, **nicht die Zeilen**.

1. Endpunkt um `lines: {text, startMs}[]` erweitern (in Lyrics Helper).
2. In vizzy ist ein bekannter Song der Normalfall: Overlay zeigt die echten
   Zeilen **pünktlich**, sogar die nächste Zeile als Vorschau.
3. **Whisper wird zur Uhr:** Die Wiedergabeposition aus SMTC ist grob (offener
   Punkt in `PLAN-playlists.md`). Jede von Whisper erkannte Zeile wird gegen
   die LRC-Zeilen gesucht (Wort-Ähnlichkeit wie in `lyrics.rs`); die
   Differenz ergibt den **Versatz**. Das funktioniert auch bei Seek, Live-
   Versionen und Twitch-Streams, die den Song spielen.
4. Erkennt Whisper keine LRC-Zeile (anderer Song, Live-Version), fällt das
   Overlay automatisch auf Whisper-Text zurück.

Damit werden Effekte **auf dem Wort** möglich: Refrain-Drop genau auf der
ersten Silbe, Text, der kommt, bevor er gesungen wird.

### 4 · Bedeutung (B/C, langsam)

Pro Zeile oder Strophe, nicht pro Frame:

- **Stimmung und Bilder per lokalem LLM** (`llm.rs` steht): Zeile →
  `{stimmung, farben, motive}` → Tags → Director wählt Presets
  („Feuer“, „Regen“, „Nacht“). Latenz egal, es wirkt ab der nächsten Zeile.
- **ComfyUI** (`comfy.rs` steht): pro **Refrain** ein Bild backen
  (Parallax/Morph). Beim ersten Refrain backen, bei jedem weiteren zeigen.
  Mit Synchron-Lyrics vorab für den ganzen Song.

## Reihenfolge (Vorschlag)

| Phase | Was | Aufwand | Sichtbar |
|---|---|---|---|
| **S1** | Stimm-Signal in Rust (Stereo zum Analyzer, Mid/Side + YIN), Routing-Quellen, Milkdrop-`q`, Debug-HUD-Zeile | mittel | sofort, überall |
| **S2** | Text-Ereignisse (`line`, `repeat`), Overlay im Beat-Raster, Regie-Auslöser `refrain` / `stimme an/aus` | klein | ja |
| **S3** | Lyrics Helper liefert Zeilen; Whisper-Abgleich als Uhr; Overlay pünktlich mit Vorschau | mittel, zwei Repos | groß |
| **S4** | 3D-Szene „Text“ (Kinetic Typography) | mittel | Showcase |
| **S5** | LLM-Stimmung → Tags; ComfyUI-Bild pro Refrain | mittel | Wow, langsam |

Nicht vorgesehen: **Echtzeit-Stimmtrennung** (Demucs/MDX). Die Modelle
arbeiten auf Blöcken von Sekunden; das bringt Latenz, die A vermeiden soll,
und B kommt ohne Trennung schon gut aus (gemessen, `docs/learnings.md`).
Falls die Mid/Side-Heuristik bei breit gemischtem Gesang versagt, wäre ein
kleines VAD-/Gesangs-Klassifikationsmodell (ONNX, ~10-ms-Frames) der nächste
Schritt, nicht die Trennung.

## Offene Fragen

- Mid/Side: Wie viele Quellen liefern echtes Stereo (Process-Loopback ja,
  Mikro nein)? Ohne Stereo nur Harmonizität, das ist schwächer.
- Wann geht `feat/vizzy-integration` in Lyrics Helper nach `main`?
- Sollen Lyrics und Stimm-Effekte eigene Regie-Regeln bekommen oder nur
  Choreo-Auslöser?
