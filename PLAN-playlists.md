# vizzy – Pools, Zuordnungen, Choreografien, Queue & Now Playing

Stand: 2026-11-07 · Ergebnis des Interviews · Phase 1 umgesetzt

## Ziel

vizzy soll wissen, **welcher Song gerade läuft** (inkl. Spotify-Playlist-Kontext), und daraus
entscheiden, **was** gezeigt wird – über selbst gebaute Regeln, kuratierte Pools, Song-Choreografien
und eine Live-Queue. Ohne passende Regel bleibt alles beim heutigen Auto-Switch.

## Entscheidungen aus dem Interview

| Thema | Entscheidung |
|---|---|
| Use Cases | Kuratierte Pools · Song-Choreografie · Live-Queue · Bindung an Spotify-Playlists ("Deutschrap → Preset XYZ"), per Setting abschaltbar. Keine klassische feste Setlist. |
| Standard-Wechsel | **Songwechsel** (pro Eintrag/Regel überschreibbar) |
| Now Playing | **Kombiniert**: Windows SMTC (ohne Login, sofortige Events) + Spotify Web API mit PKCE (Track-ID, Playlist-Kontext) |
| Plattform | Windows zuerst. Mac nur über Spotify-API. |
| Editor-Ort | **Modal** (wie Library) zum Bauen + **Seitenleiste/Cockpit** live neben dem Bild |
| Choreo anlegen | Alle drei: Aufnehmen beim Hören · Section-Liste · Timeline-Editor |
| Cue-Anker | **Je Cue wählbar**: Zeit (mit Beat/Bar-Snap) oder Section-Index |
| Regel-Priorität | **Selbst sortierte Liste**, erste passende Regel gewinnt (Queue liegt immer oben drüber) |
| Einzel-Preset-Regel | **Pro Regel**: "ganzen Song halten" oder "nur zum Start, dann Auto" |
| Keine Regel passt | Normaler Auto-Switch (wie heute) |
| Live-Queue | Buttons in der Library · Mini-Queue-Leiste · Hotkeys |
| Quick-Assign | Buttons im Cockpit · "zu Pool hinzufügen" · **plus** lernende Kontext-Ratings |
| Kontext-Ratings | pro Song · pro Artist · pro Spotify-Playlist |
| new-helper | **Optionale Datenquelle** (Tags/Mood eines Songs als zusätzlicher Regel-Kontext) |
| MVP | **Now Playing + Zuordnungen** zuerst, Choreo-Editor danach |

## Was wir aus new-helper (`feat/saved-songs-rework`) mitnehmen

Nur Logik, kein Code 1:1 (dort ist es ein NestJS-Backend mit Client-Secret):

- Token-Lifecycle: Refresh bei < 60 s Restlaufzeit, ein Refresh gleichzeitig, rotierte Refresh-Tokens
  speichern, Token nur bei `invalid_grant` verwerfen.
- Now-Playing-Polling: 5 s spielend / 15 s idle, `Retry-After` bei 429 respektieren,
  `interpolateProgress()` zwischen den Polls.
- Typen `SpotifyCurrentlyPlayingResponse` / `SpotifyTrackObject`.

**Spotify-Einschränkungen, die das Design prägen:**
- Neue Apps bekommen **kein** `/audio-features`, `/audio-analysis`, keine Genres – egal, vizzy
  analysiert BPM/Beat-Grid/Sections selbst (`tempo.rs`, `phrasing.rs`).
- Kein Push → Polling. SMTC liefert dafür den Songwechsel sofort.
- Dev-Mode-App (nur freigeschaltete Accounts) – für den Eigengebrauch kein Problem.
- Redirect muss `http://127.0.0.1:<port>/…` sein (nicht `localhost`).
- Playlist-Kontext (`context.uri` in `currently-playing`) gibt es **nur** über die API, nicht über SMTC.

## Architektur

```
 Rust                                         Frontend
 ┌────────────────────┐   event "nowplaying"  ┌──────────────────────────┐
 │ nowplaying/smtc.rs │ ────────────────────▶ │ nowPlaying store         │
 │ (GSMTC Events)     │                       │  merge SMTC + Spotify    │
 └────────────────────┘                       │  → TrackInfo, songChange │
 ┌────────────────────┐   poll (JS oder Rust) │                          │
 │ spotify (PKCE,     │ ────────────────────▶ │                          │
 │ Loopback-Callback  │                       └────────────┬─────────────┘
 │ über bridge-HTTP)  │                                    │ songChange / tick
 └────────────────────┘                       ┌────────────▼─────────────┐
                                              │ director (neu)           │
  optional: new-helper ──tags/mood──────────▶ │  Queue > Regeln > Auto   │
                                              │  → entscheidet nächstes  │
                                              │    Preset/Kombi + Blend  │
                                              └────────────┬─────────────┘
                                                           │ ersetzt/umhüllt pickAuto
                                              Render-Loop (App.tsx, wantsAutoSwitch)
```

- **Song-Identität** `trackKey`: `spotify:track:<id>` wenn bekannt, sonst `smtc:<artist>|<title>`
  (normalisiert). Merge: SMTC-Event kommt zuerst, Spotify-Poll ergänzt ID + Kontext per Titel/Artist-Match.
- Songwechsel-Event ersetzt die Stille-Heuristik für `live.trackStartAt` (Heuristik bleibt als Fallback).
- **Director** ist eine neue Schicht zwischen Render-Loop und `pickAuto`:
  1. Queue nicht leer → nächster Queue-Eintrag (an der nächsten musikalischen Grenze).
  2. Choreo für diesen Song aktiv → Cue-Plan.
  3. Erste passende Regel → Ziel (Preset/Kombi halten oder nur Start · Pool rotieren).
  4. Sonst → heutiger `pickAuto` über `browseKeys`.
  Kontext-Ratings fließen in jedem Pool-/Auto-Pick als zusätzlicher Gewichtsfaktor ein.

## Datenmodell (Entwurf)

Speicherung wie `combos.ts`: JSON im App-Data-Ordner via `data_write`, localStorage-Mirror.

```ts
// <app_data>/pools.json
type Pool = {
  id: string; name: string;
  entries: { key: string /* Preset-Key */ | `combo:${string}`; weight?: number }[];
  pick: "smart" | "shuffle" | "order"; // smart = pickAuto-Gewichtung, nur auf diese Liste
  switchOn?: number;                   // überschreibt milkdrop.switchOn
};

// <app_data>/rules.json  – Array-Reihenfolge = Priorität
type Rule = {
  id: string; enabled: boolean; note?: string;
  match:
    | { kind: "song"; trackKey: string; label: string }
    | { kind: "artist"; name: string }
    | { kind: "spotifyPlaylist"; uri: string; name: string }
    | { kind: "tag"; source: "newhelper"; tag: string };
  target:
    | { kind: "preset" | "combo"; ref: string; hold: "song" | "start" }
    | { kind: "pool"; poolId: string }
    | { kind: "choreo"; trackKey: string };
};

// <app_data>/choreos/<trackKeyHash>.json
type Choreo = {
  trackKey: string; title: string; artist: string; durationMs?: number;
  cues: {
    at: { t: number /* ms */; snap: "none" | "beat" | "bar" } | { section: number };
    target: { kind: "preset" | "combo"; ref: string };
    blend?: number;
  }[];
  analysis?: { sections: number[] /* ms */; energy: number[]; bpm?: number }; // beim Hören gesammelt
};

// <app_data>/context-ratings.json
type ContextRatings = {
  song: Record<string, Record<string, number>>;     // trackKey → presetKey → -3..3
  artist: Record<string, Record<string, number>>;
  playlist: Record<string, Record<string, number>>; // Spotify-URI
};

// Queue: nur Laufzeit (nicht persistiert)
type QueueItem = { ref: string; kind: "preset" | "combo"; until?: "boundary" | "song" };
```

## UI

### Cockpit (Seitenleiste, offen lassbar)
- Aktueller Song: Titel, Artist, Quelle (SMTC/Spotify), Spotify-Playlist-Name, Fortschritt.
- **Aktive Regel** ("Regel 3: Playlist Deutschrap → XYZ, hält Song") + "warum dieses Preset".
- Quick-Assign für das aktuelle Preset/Kombi: **An Song / Artist / Playlist binden** ·
  **Zu Pool hinzufügen** (bestehend oder neu, Pool wird dabei an den Kontext gebunden).
- Mini-Queue: nächste Einträge, Drag zum Umsortieren, ✕ zum Entfernen.
- `+`/`-` wirken zusätzlich als Kontext-Rating (Song, Artist, Playlist).

### Modal "Regie" (neue Taste, Tabs)
- **Regeln:** sortierbare Liste (Drag = Priorität), an/aus pro Regel, Match + Ziel + Halten/Start.
- **Pools:** Pool-Liste links, Einträge rechts als Karten (gleiche Preview-Karten wie Library),
  Hinzufügen per Library-Picker, Pick-Modus.
- **Songs/Choreo:** bekannte Songs (aus Now-Playing-Historie) → Choreo öffnen.
  - Section-Liste: erkannte Sections → je ein Preset.
  - Timeline: Energiekurve + Sections, Cue-Blöcke per Drag, Snap Beat/Bar, Anker Zeit/Section.
  - Aufnahme: Song spielen, live Presets wählen → Cues werden mitgeschrieben.
- Live-Kachel wie in der Library.

### Library
- Auf Karten: **Als Nächstes** · **Einreihen** · **Zu Pool…**

### Hotkeys (Tasten noch festlegen, Kollisionen prüfen)
- Aktuelles nochmal in die Queue · Queue überspringen · Queue leeren · Cockpit ein/aus · Regie-Modal.

### Settings
- Neuer Bereich "Regie": Regeln an/aus (global), Spotify verbinden/trennen + Client-ID,
  SMTC-Quelle wählen (welche App), new-helper-URL + Token (optional), Kontext-Lernen an/aus.

## Phasen

**MVP**
1. ✅ **SMTC Now Playing** (`src-tauri/src/nowplaying.rs`, `src/regie/nowPlaying.ts`, `src/regie/Cockpit.tsx`, Taste C) – `nowplaying/smtc.rs` (crate `windows`, `GlobalSystemMediaTransportControlsSessionManager`,
   Media-/Timeline-Events), Tauri-Event, `nowPlaying`-Store, Songwechsel → `live.trackStartAt`.
   Cockpit-Gerüst zeigt den Song.
2. **Spotify PKCE** – Client-ID in Settings, Loopback-Callback (bridge-HTTP-Server mitnutzen),
   Tokens im App-Data, Poll `currently-playing` (5/15 s, 429-Backoff, Interpolation),
   `context.uri` → Playlist-Name (`GET /playlists/{id}`, gecacht). Merge mit SMTC.
3. **Pools + Regeln + Director** – `pools.json`, `rules.json`, Director vor `pickAuto`,
   Regeln-/Pools-Tabs im Modal, Quick-Assign im Cockpit, globaler Schalter.

**Danach**
4. **Live-Queue** – Library-Buttons, Mini-Queue-Leiste, Hotkeys.
5. **Kontext-Ratings** – `+`/`-` schreiben Song/Artist/Playlist-Ratings, Faktor in Pick-Gewichtung.
6. **Choreografie** – Analyse pro Song mitschneiden (Sections, Energie), Section-Liste → Aufnahme → Timeline.
7. **new-helper als Quelle** – Lookup per Spotify-ID → Tags/Mood als Regel-Match `tag`.
   Braucht in new-helper einen Endpoint + Token-Auth für vizzy (dort ist Login heute JWT per Account).

## Offene Punkte

- Welche Spotify-Dev-App? Eigene für vizzy (empfohlen, PKCE, kein Secret) vs. die von new-helper mitbenutzen.
- SMTC-Position bei Spotify-Desktop ist teils grob → für Zeit-Cues Spotify-Progress bevorzugen.
- Section-Anker hängen an stabiler Section-Erkennung – evtl. Analyse-Fingerprint pro Song speichern und vergleichen.
- Choreo + Vorspulen/Seek: Cue-Plan muss bei Positionssprung neu einsteigen.
- Hotkey-Belegung gegen bestehende Tasten (A, L, P, T, +, -, …) prüfen.
- `App.tsx` ist schon 3700 Zeilen – Director + Now Playing als eigene Module, nur dünn im Render-Loop einhängen.
