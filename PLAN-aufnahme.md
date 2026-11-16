# vizzy → Lyrics Helper: Lyrics mithören, später verfeinern — Plan

Stand: 2026-11-16. Noch nichts umgesetzt.

**Ziel:** vizzy hört beim Musikhören ohnehin mit (Whisper). Für Songs, zu denen
Lyrics Helper noch keinen oder keinen synchronen Text hat, soll daraus ein
grober Entwurf mit Zeiten entstehen, der in Lyrics Helper landet und dort
verfeinert wird.

## Ausgangslage

Das Protokoll (`lyrics-log/YYYY-MM-DD.jsonl`) reicht dafür **noch nicht**:

| Braucht der Upload | Steht im Protokoll |
|---|---|
| welcher Song | nur als Anzeigetext `"Artist – Titel"`, an jeder Zeile und als `song`-Eintrag beim Wechsel. **Keine Spotify-ID**, keine Dauer |
| Zeit der Zeile **im Song** | nein. Nur die Uhrzeit, zu der die Zeile feststand (`t`), und wie weit sie hinterher war (`behindS`) |
| eine Aufnahme pro Song | nein, ein Tagesprotokoll über alle Songs, gemischt mit Debug-Einträgen |

Auf der anderen Seite: Ein `Song` in Lyrics Helper hängt an der `spotifyId`
(Pflichtfeld). Der Text liegt geteilt in `SongLyrics` mit `LyricsLine.timestampMs`,
Status `DRAFT / WORK_IN_PROGRESS / FINISHED`, und jede Änderung legt eine
`LyricsVersion` an. Die vizzy-Schnittstelle (`/integrations/vizzy`, API-Token)
kann bisher nur lesen.

## Grundsätze

1. **Eine Aufnahme überschreibt nie Text.** Sie ist Rohmaterial neben dem
   Song; übernommen wird in Lyrics Helper, von Hand, mit Vorschau.
2. **Das Protokoll bleibt, was es ist** (Debuggen, Optimieren). Die Aufnahme
   ist eine eigene, kleine Datei pro Song — das Protokoll bekommt nur die
   fehlenden Felder dazu.
3. **Nur Songs mit Spotify-ID** werden hochgeladen (v1). Twitch, YouTube und
   Co. bleiben lokal liegen.
4. Upload läuft in Rust (`newhelper.rs`), das Token bleibt dort.

## Teil 1 · vizzy: Aufnahme pro Song

**A1 · Song-Infos an den Worker.** `lyrics_song` bekommt statt eines Textes
`{ artist, title, spotifyId, durationMs, positionMs }`. Das Frontend meldet
die Position zusätzlich bei jedem Sprung (Seek, Pause, Fortsetzen) nach. Der
Worker rechnet daraus pro Zeile: `startMs = Position jetzt − wie lange die
Zeile her ist` (`started_ago_s` gibt es seit S3), `endMs` ebenso.

- Ohne Media-Position (kein Spotify, kein SMTC): Zeit seit dem Songwechsel,
  markiert als `clock: "songchange"` — grob, aber besser als nichts.
- Im Protokoll stehen damit ab sofort `spotifyId`, `durationMs` im
  `song`-Eintrag und `startMs`/`endMs` an jeder `line`.

**A2 · Aufnahme-Datei.** Beim Songwechsel (und beim Beenden) schreibt der
Worker `lyrics-takes/<datum>_<zeit> <artist> – <titel>.json`:

```json
{
  "v": 1,
  "spotifyId": "…", "artist": "…", "title": "…", "durationMs": 215000,
  "recordedAt": "2026-11-16T19:02:11Z",
  "clock": "media",
  "coverage": { "fromMs": 4200, "toMs": 209800 },
  "engine": { "model": "large-v3-turbo", "language": "auto", "preset": "ausgeglichen" },
  "lines": [ { "text": "…", "startMs": 30120, "endMs": 33010, "repeat": false } ]
}
```

- `coverage` sagt, wie viel vom Song gehört wurde. Unter 5 Zeilen oder unter
  ~40 % Abdeckung wird nichts geschrieben (reingezappt, übersprungen).
- Ein Seek zurück ersetzt die Zeilen im neu gehörten Bereich.
- Schalter „Aufnahmen mitschreiben“, unabhängig vom Protokoll-Level.

**A3 · Hochladen.** Neuer Abschnitt „Aufnahmen“ im Lyrics-Tab: Liste der
Aufnahmen (Song, Datum, Abdeckung, Zeilen, Zustand: lokal / hochgeladen /
ohne Spotify-ID), je Zeile „Hochladen“, „Ordner öffnen“, Löschen mit Undo.

- Schalter **„Automatisch hochladen“** mit zwei Stufen: *nur wenn Lyrics
  Helper keinen synchronen Text hat* (Vorschlag als Standard) / *immer*.
  vizzy weiß das schon aus der Song-Abfrage (`lines` leer oder ohne Zeiten).
- Rust-Befehl `newhelper_upload_take(file)` → `POST /integrations/vizzy/takes`.
  Nach Erfolg wird die Datei als hochgeladen markiert, nicht gelöscht.

## Teil 2 · Lyrics Helper: annehmen und verfeinern

**B1 · Speichern.** Neues Modell `LyricsTake` (userId, spotifyId, songId?,
title, artist, durationMs, recordedAt, clock, coverage, engine, `lines Json`,
source `"vizzy"`). `POST /integrations/vizzy/takes` mit dem API-Token:
validiert, begrenzt die Größe (z. B. 500 Zeilen), legt den `Song` an, falls
es ihn noch nicht gibt (so wie beim Speichern aus Spotify), und behält pro
Nutzer und Song die letzten drei Aufnahmen. **`SongLyrics` wird nicht
angefasst.**

**B2 · Finden.** Auf der Song-Seite ein Hinweis „Aufnahme aus vizzy vom …
(92 % des Songs, 41 Zeilen)“. Dazu eine kleine Liste „Aufnahmen aus vizzy“
(Dashboard oder Einstellungen) mit allen offenen — das ist die
Verfeinern-Warteschlange.

**B3 · Übernehmen**, je nachdem, was der Song schon hat:

| Song hat | Angebot |
|---|---|
| keinen Text | **„Als Entwurf übernehmen“**: Zeilen + Zeiten werden zum Text, Status `DRAFT`, als neue Version. Weiter im normalen Editor |
| Text ohne Zeiten (z. B. von Genius eingefügt) | **„Nur die Zeiten übernehmen“**: Die gehörten Zeilen werden im vorhandenen Text gesucht (gleiche Wortähnlichkeit wie vizzys `syncCore`), Treffer bekommen ihre Zeit, der Text bleibt. Vorschau: x von y Zeilen getroffen |
| Text mit Zeiten | nur ansehen / vergleichen, nichts vorgeschlagen |

Der zweite Fall ist der wertvollste: sauberer Text aus dem Netz, Zeiten aus
vizzy, fertig sind synchrone Lyrics — und die spielt vizzy beim nächsten Mal
pünktlich ab (S3).

**B4 · Verfeinern.** Kein neuer Editor. Was die Übernahme hinterlässt, sind
normale Zeilen mit `timestampMs`; korrigiert wird mit `LyricsEditor` und dem
vorhandenen Zeitstempel-Werkzeug. Die Aufnahme bleibt als Vergleich daneben
sichtbar, bis sie verworfen wird.

## Reihenfolge

| Schritt | Wo | Ergebnis |
|---|---|---|
| 1 | vizzy | A1: Spotify-ID und Songzeiten im Protokoll. Für sich schon nützlich, klein |
| 2 | vizzy | A2: Aufnahme-Dateien, Schalter, Liste (noch ohne Upload) |
| 3 | Lyrics Helper | B1: Modell, Migration, Endpoint, Tests |
| 4 | vizzy | A3: Hochladen von Hand, dann automatisch |
| 5 | Lyrics Helper | B2 + B3 „Als Entwurf übernehmen“ |
| 6 | Lyrics Helper | B3 „Nur die Zeiten übernehmen“ |

Schritt 3 braucht eine Datenbank-Migration auf der Produktionsinstanz
(Railway deployt `feat/vizzy-integration` bei jedem Push automatisch).

## Offen

- **Mehrere Aufnahmen desselben Songs zusammenführen** (Zeilen, die in zwei
  Durchläufen gleich gehört wurden, sind verlässlicher). Erst mal: die mit
  der besten Abdeckung gewinnt.
- **Songs ohne Spotify-ID**: bräuchten in Lyrics Helper eine Zuordnung von
  Hand. Später.
- **Genauigkeit der Zeiten**: Whispers Segmentgrenzen liegen grob ±0,3–0,5 s
  daneben, die SMTC-Position zusätzlich. Für einen Entwurf reicht das; zu
  messen an einem Song, der in Lyrics Helper schon synchron ist.
- **Wem gehört die Aufnahme?** Der Text in Lyrics Helper ist geteilt. Die
  Aufnahme bleibt privat (pro Nutzer), erst die Übernahme macht sie zum
  geteilten Text.
