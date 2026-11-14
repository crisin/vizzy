# vizzy — Effekte aus Stimme und Text: Plan

Stand: 2026-11-14, nach dem Lyrics-Spike (`src-tauri/src/lyrics.rs`, Overlay `U`).
S1 ist umgesetzt (siehe dort), der Rest noch nicht.

## Ausgangslage

Wir haben jetzt drei Arten, „was gesungen wird“ zu kennen. Sie unterscheiden
sich vor allem in der **Latenz**, und daraus folgt, welcher Effekt wohin gehört:

| Quelle | Latenz | Weiß | Geht für |
|---|---|---|---|
| **A · Stimm-Signal** (DSP in Rust, neu) | ~20–50 ms | *dass* und *wie hoch* gesungen wird | alles, auch Twitch |
| **B · Whisper live** (steht) | 1–3 s danach | *was* gesungen wurde | alles, auch unbekannte Songs |
| **C · Synchron-Lyrics** aus Lyrics Helper | 0 s, sogar **vorher** | was *gleich* kommt, Abschnitte (Strophe/Refrain) | Songs, die Lyrics Helper kennt |
| **D · Stimm-Fingerabdruck** (Speaker-Embedding, neu, Baustein 5) | 1–2 s danach | *wer* singt oder spricht | Sprache gut, Gesang im Mix ungeklärt |

Faustregel: **Pro Frame** (Puls, Farbe, Form) nur A. **Pro Zeile** (Text,
Bildwechsel, Stimmung) B oder C. Effekte, die *auf* dem Wort sitzen sollen
(Wort poppt im Takt, Refrain-Drop), brauchen C, denn B kommt immer zu spät.

## Bausteine

### 1 · Stimm-Signal als Modulationsquelle (A) — ✅ umgesetzt

> **Stand 2026-11-14:** `src-tauri/src/voice.rs`. Anders als unten geplant:
> Die Periodizität (YIN) auf dem Mix half kaum (AUC ~0,5 bei drei von vier
> Songs, Synths und Gitarren sind genauso tonal). Was trägt, ist eine
> **Mitte-Maske pro FFT-Bin** (250 Hz–4 kHz, Side ≪ Mid): ihr Pegel relativ
> zum Song × ihr Anteil am Band. Gegen Demucs-Vocals auf vier Songs: AUC
> 0,63–0,92, Gate 73 % richtig (Monsun 84 %, Candy Shop 65 %: Rap über
> einem Beat, der auch in der Mitte sitzt). YIN läuft auf dem
> zurücktransformierten Mitte-Signal: Tonhöhe in 59–87 % der Fälle auf
> ±1 Halbton. Frame `[14..18]` = voice, gate, pitch, pitchConf, Mitte-Anteil;
> Routing-Quellen „Stimme“, „Gesang an/aus“, „Tonhöhe“; Debug-HUD-Zeile.
> **Milkdrop-`q` entfällt:** Butterchurn nimmt nur die Wellenform, eigene
> Variablen gingen nur über einen Patch (CLAUDE.md, Regel 5). Milkdrop
> erreicht die Stimme über das Routing auf Parameter.


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

### 2 · Text-Ereignisse und Kinetic Typography (B, später C) — ✅ umgesetzt

> **Stand 2026-11-14:** Der Worker markiert jede Zeile, die im Song schon
> vorkam (Wort-LCS ≥ 0,7, mindestens drei Wörter; „oh yeah“ zählt nie),
> und vergisst das beim Songwechsel. `src/lyrics/events.ts` macht daraus
> `refrain` / `refrainEnd`, aus dem Stimm-Gate `voiceOn` / `voiceOff`
> (Instrumental ab x s). Reaktionen in Einstellungen → Automatik
> (`src/lyrics/reactions.ts`): Bildwechsel über den Auto-Wechsel (Regie hat
> Vorrang), Zufallspreset, Layer B für die Dauer des Refrains,
> Milkdrop-Stoß. Wort für Wort im Achtel-Raster. Auf „Take on me“ (ganzer
> Song, offline) sind beide Refrains markiert, die zweite Strophe nicht.
> Choreo-Auslöser `refrain` entfällt vorerst: Choreos sind Zeitachsen pro
> Song, die Reaktionen gelten für alle Songs. Die 3D-Szene „Text“ ist S4.


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

### 3 · Synchron-Lyrics aus Lyrics Helper, Whisper als Uhr (C + B) — ✅ umgesetzt (vizzy), wartet auf Deploy (Lyrics Helper)

> **Stand 2026-11-14:** Lyrics Helper liefert in `/integrations/vizzy/song`
> jetzt `lines: {text, startMs}[]` (Branch `feat/vizzy-integration`, Commit
> `e255297`, weder gepusht noch deployt — vizzy spricht mit der
> Railway-Instanz, bis dahin fehlen die Zeilen und vizzy bleibt bei
> Whisper). vizzy: `src/lyrics/syncCore.ts` (Abgleich, Uhr; Checks mit
> `node src/lyrics/syncCore.test.ts`), `src/lyrics/synced.ts` (folgt Song,
> zeigt die fällige Zeile, die nächste als Vorschau). Uhr = Media-Position
> + Versatz; jede Whisper-Zeile wird im Synchrontext gesucht (±25 s um die
> erwartete Stelle, Refrains: die nähere gewinnt) und stellt den Versatz
> nach (Median, ein Sprung erst, wenn zwei Treffer ihn bestätigen). Ohne
> Media-Position startet ein Treffer eine eigene Uhr (45 s ohne Treffer:
> aus). Refrain-Ereignisse kommen dann pünktlich aus dem Synchrontext
> (wiederholte Zeilen und Abschnitte namens Chorus/Refrain/Hook).
> Text-Quelle in den Einstellungen: synchron wenn möglich / immer Whisper /
> nur synchron.


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

### 5 · Stimm-Fingerabdruck: wer singt oder spricht (D)

Idee vom 2026-11-14, noch nichts gemessen. Effekte sollen davon abhängen,
**wer** gerade dran ist (Feature-Part, Duett, zweiter Sprecher im Stream).

**Whisper liefert das nicht.** whisper.cpp kennt Text und Zeiten, keine
Sprecher. `tinydiarize` erkennt nur Sprecherwechsel, nur auf Englisch und
nicht mit `large-v3-turbo`. Es braucht ein zweites, kleines Modell daneben.

**Der Fingerabdruck ist ein Speaker-Embedding.** Ein Modell wie ECAPA-TDNN,
CAM++ oder TitaNet (je 5–25 MB als ONNX) macht aus 1–3 s Audio einen Vektor
mit rund 192 Zahlen. Gleiche Stimme ergibt ähnliche Vektoren, verglichen wird
per Cosinus-Ähnlichkeit. Das Modell braucht mindestens etwa 1 s Stimme, also
ist D eine Quelle **pro Zeile** wie B, nie pro Frame.

Erwartung je Quelle (Einschätzung, keine Messung):

| Quelle | Erwartung |
|---|---|
| Sprache (Twitch, Podcast, Mikro, mehrere Leute im Raum) | gut, dafür sind die Modelle trainiert; zwei bis fünf Sprecher trennbar |
| Rap, Sprechgesang, Feature-Parts | vermutlich brauchbar, nah an Sprache |
| Gesang im vollen Mix | unsicher: das Instrumental färbt den Vektor, er beschreibt dann eher den Song als die Stimme. Mann/Frau oder Duett-Wechsel im selben Song könnten trotzdem gehen |
| Zwei Stimmen gleichzeitig | geht nicht, es gibt einen Vektor pro Fenster |

Warnzeichen: Silero VAD (auch auf Sprache trainiert) hat ganze gesungene
Zeilen verworfen (`docs/learnings.md`).

Einbau:

- **Rust, neben `lyrics.rs`:** Derselbe 16-kHz-Puffer geht pro Schritt
  zusätzlich durch das Embedding-Modell, über die `ort`-Crate oder als zweiter
  Endpunkt im Whisper-Container (`tools/whisper-server`). Die Analyse bleibt
  in Rust.
- **Zuordnung im Lauf:** Online-Clustering gibt jedem Vektor den nächsten
  bekannten Sprecher oder legt einen neuen an. Ereignis pro Zeile:
  `speaker: {id, confidence}`.
- **Zwei Modi:** anonym pro Song („Stimme 1/2/3“, ohne Einrichtung) und
  benannte Profile (einmal 10 s aufnehmen, Vektor als JSON über `store.rs`
  im App-Datenordner).
- **Effekte:** Sprecher als Routing-Quelle und als Regie-/Choreo-Auslöser
  („Stimme wechselt“, „Stimme 2 aktiv“): Farbpalette pro Stimme, Layer B
  oder Presetwechsel beim Feature-Part, Untertitel in Sprecherfarbe.
- **Zusammenspiel mit A:** Der Sprecher wählt die Palette, `voice` und
  `pitch` bewegen sie pro Frame.

**Zuerst ein Offline-Spike** (etwa ein halber Tag), bevor etwas in die App
wandert: Über die `.f32`-Mitschnitte aus dem Lyrics-Log ein ECAPA-ONNX laufen
lassen und prüfen, ob die Vektoren bei einem Duett, einem Rap-Feature und
einem Twitch-Mitschnitt sauber in Gruppen zerfallen. Dafür braucht es zwei
oder drei Mitschnitte, bei denen bekannt ist, wer wann dran ist. Trägt es nur
für Sprache, bleibt es ein Feature für Twitch und Mikro.

## Reihenfolge (Vorschlag)

| Phase | Was | Aufwand | Sichtbar |
|---|---|---|---|
| **S1** ✅ | Stimm-Signal in Rust (Stereo zum Analyzer, Mitte-Maske + YIN), Routing-Quellen, Debug-HUD-Zeile | mittel | sofort, überall |
| **S2** ✅ | Text-Ereignisse (`line`, `repeat`), Overlay im Beat-Raster, Regie-Auslöser `refrain` / `stimme an/aus` | klein | ja |
| **S3** ✅ | Lyrics Helper liefert Zeilen; Whisper-Abgleich als Uhr; Overlay pünktlich mit Vorschau | mittel, zwei Repos | groß |
| **S4** | 3D-Szene „Text“ (Kinetic Typography) | mittel | Showcase |
| **S5** | LLM-Stimmung → Tags; ComfyUI-Bild pro Refrain | mittel | Wow, langsam |
| **S6** | Stimm-Fingerabdruck: erst Offline-Spike, dann Embedding-Worker, Ereignis `speaker`, Routing-Quelle und Regie-Auslöser. Setzt S2 voraus (Text-Ereignisse, Auslöser), nicht S3–S5 | Spike klein, Einbau mittel | bei Sprache groß, bei Gesang offen |

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
- Stimm-Fingerabdruck: Trennt ein Speaker-Embedding Sänger im vollen Mix,
  oder nur Sprache? Klärt der Offline-Spike (Baustein 5).
- Stimm-Fingerabdruck: Modell in Rust (`ort`) oder im Whisper-Container?
