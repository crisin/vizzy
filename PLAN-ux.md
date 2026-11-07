# vizzy — UX-Umbau: Konzept

Stand: 2026-11-07. Ergebnis einer Durchsicht von Features, offenen Plänen
(`PLAN-milkdrop.md`, `PLAN-playlists.md`) und der UI im Browser-Demo.
Noch nichts davon umgesetzt.

## Befund in einem Satz

Jedes Feature hat seinen eigenen Knopf, Tab oder eigenes Fenster bekommen,
aber die App hat keinen **Hauptweg** — Laufenlassen, Kuratieren und Bauen
stehen gleichrangig nebeneinander, vieles gibt es zwei- oder dreimal, und
es gibt fünf verschiedene Arten von Fenstern.

## Leitprinzipien

1. **Das Bild ist das Produkt.** Im Normalbetrieb ist so wenig UI wie
   möglich sichtbar; was sichtbar ist, dient dem Laufenlassen.
2. **Jede Funktion hat genau einen Ort.** Abkürzungen (Tasten, Kontext-
   menüs) dürfen zusätzlich existieren, sichtbare Duplikate nicht.
3. **Drei Ebenen, drei Fensterarten** — und nicht mehr (siehe unten).
4. **Nichts verschwindet je nach Modus.** Was im aktuellen Modus nicht
   passt, wird ausgegraut mit Hinweis, statt die Navigation umzubauen.
5. **Nichts Teures geht still verloren.** Löschen mit Rückgängig,
   ungespeicherte Arbeit fragt nach.
6. **Leere Zustände sagen, was zu tun ist.** Nie ein schwarzer Bildschirm
   ohne Hinweis.

## Drei Nutzungsebenen

| Ebene | Situation | Wo | Wie oft |
|---|---|---|---|
| **1 · Bühne** | Musik läuft, Bild soll gut aussehen und selbst wechseln | HUD über dem Bild | immer |
| **2 · Pult** | nachjustieren: Quelle, Empfindlichkeit, Automatik, Layer, Song-Kontext | Seitenleisten (Drawer / Cockpit), Bild läuft weiter | ab und zu |
| **3 · Werkstatt** | kuratieren und bauen: Library, Studio, Regie | Vollbild-Fenster | in eigenen Sitzungen |

## Fenster-Grammatik

Heute: Vollbild-Modal (Library, Studio), schwebende Karte (Cockpit),
Popover (Tag-Filter), Overlay-Leiste (Tag-Leiste), Drawer rechts — jedes
mit eigenem Verhalten bei Esc, Klick daneben und Tasten.

Neu, nur noch drei Arten:

| Art | Beispiele | Verhalten |
|---|---|---|
| **Seitenleiste** | Einstellungen (rechts), Cockpit (links) | nicht modal, Bild und Tasten laufen weiter; **schiebt** die HUD-Zeile zusammen statt sie zu verdecken; Esc schließt |
| **Werkstatt** | Library, Studio, Regie | Vollbild, besitzt die Tastatur; Klick daneben schließt **nicht**; Esc / Schließen fragt bei ungespeicherter Arbeit |
| **Overlay-Leiste** | Tag-Leiste, Toasts | unten über dem Bild, klein, eigene Tasten im Capture |

Der Tag-Filter-Popover wandert in die Library (siehe dort).

## Ebene 1 — Bühne (HUD)

### Heute (Milkdrop)

```
VIZZY [Quelle ▾]               [Balken|Radial|Welle|Spektro|Milkdrop|3D] ♪ ⚙ ? ⛶
[Zurück][Library][Dropdown mit 107+ Presets ▾][☆][Weiter][Zufall][auto][nur ★][Tags ▾][🏷][B][Tweaks][Studio]
```

13 gleichgewichtige Elemente in der zweiten Zeile; Favoriten, Auto,
nur ★ stehen zusätzlich im Drawer.

### Neu

```
VIZZY [♪ Quelle ▾]                           [Milkdrop|3D|Klassisch ▾]   ♪  ⚙  ⛶
         ‹  Airhandler (Kali Mix) — Canvas Mix  ›   ☆   ⟳ Auto   ⊞ Library   ⋯
```

- **Preset-Pille** in der Mitte: Name, `‹ ›`, Klick auf den Namen öffnet
  die Library (statt des 107er-Dropdowns). Unter dem Namen klein, wenn
  aktiv: `Tags: drop | build` · `nur ★` · `+ Layer B: …` — Zustand
  sichtbar, Klick führt zur Stelle, wo er geändert wird.
- **Sichtbar bleibt nur:** ‹ › · ☆ · Auto · Library · `⋯`.
- **`⋯`-Menü** (eine Liste, mit Tasten daneben): Zufall `R` · Taggen `T`
  · Layer B an/aus `B` · Im Studio öffnen `P` · Preset anpassen (öffnet
  Studio-Tab „Anpassen“) · Nur Favoriten · Hilfe `?`.
- **Hilfe** wandert aus der Kopfzeile ins `⋯`-Menü und als Tab in die
  Einstellungen; `?` bleibt als Taste.
- **Modus-Wahl:** Milkdrop und 3D sind eigene Welten, die vier 2D-Modi
  sind kleine Varianten. Daher: `Milkdrop | 3D | Klassisch ▾`
  (Klassisch = Balken/Radial/Welle/Spektro, der Knopf zeigt den zuletzt
  gewählten). Tasten `1`–`6` bleiben.

### 3D

Heute: 13 Szenen-Knöpfe plus szenenabhängige Aktionen (Bild +, Tiefenkarte
+, Backen, ✕) in derselben Zeile; Namen sind Code-IDs (`bars3d`,
`critters`).

Neu:

```
         ‹  Parallax ▾  ›     ⟲ Kamera     ⋯
         [Bild: Flusstal ◆ ▾]  [+ Bild]  [Backen ✨]
```

- Szenenwahl als Pille wie bei Milkdrop: `‹ ›` plus Dropdown mit
  deutschen Namen und Ein-Zeilen-Beschreibung (Kugel, Gebirge, Tunnel,
  Säulen, Kreisel, Blob, Würfel, Wesen, Brandung, Flora, Parallax,
  Morph, Eigenes Modell).
- Szenen-Aktionen in einer **eigenen Zeile** darunter, nur wenn die Szene
  welche hat. Löschen (✕) wandert ins Bild-Dropdown bzw. die Modell-
  Library, mit Rückgängig-Toast.
- **Leere Zustände:** Morph ohne Satz zeigt wie Parallax einen Platzhalter
  mit „Varianten laden →“ / „Aus Parallax-Bild backen →“; Modell ohne
  Modell „Modell laden →“.

## Ebene 2 — Pult

### Einstellungen (Drawer rechts)

Heute 9 Tabs, davon 4 modusabhängig (Tweaks, Layer, ComfyUI, Routing
teils doppelt), passen nicht in die Breite. „Bild“ und „Milkdrop“
zeigen im Milkdrop-Modus dieselbe Parametergruppe.

Neu: **6 feste Tabs**, immer in derselben Reihenfolge:

| Tab | Inhalt | Kommt von |
|---|---|---|
| **Audio** | Quelle, Empfindlichkeit/Attack/Release/Beat, Frequenz-Routing (eingebettet, kein eigener Tab mehr) | Audio + Routing |
| **Bild** | Parameter des aktuellen Modus/der Szene, Hintergrund-Layer, Milkdrop-in-3D, Rendering (Auflösung, FPS) | Bild |
| **Automatik** | Auto-Wechsel an/aus, Überblendzeit, Wartezeit, Phrasen-Dynamik, Wechsel auf, Auswahl nach Tags, Zucht-Anteil/-Stärke; später Regie-Regeln an/aus | Milkdrop (ohne Duplikate) |
| **Layer B** | heutiges LayerPanel inkl. Kombis; außerhalb Milkdrop ausgegraut mit „nur im Milkdrop-Modus“ | Layer |
| **Bedienung** | UI-Größe, Ausblenden, Cursor, BPM-Anzeige, Diagnose | Bedienung |
| **System** | ComfyUI (Adresse, Workflows), lokale KI, Dev-Brücke, Zurücksetzen, Über | System + ComfyUI |

Raus aus dem Drawer:

- **Favoritenliste, eigene Presets, „Preset-Tweaks öffnen“** → Library
  (Filter „Favoriten“, „Eigene“) und Studio.
- **Tweaks-Tab** → Studio-Tab „Anpassen“.
- **Hilfe-Tab** → eigenes kleines Fenster über `?` und das `⋯`-Menü.

Der Drawer **schiebt** die HUD-Zeilen nach links (Breite bekannt, per
CSS-Variable), statt sie zu überdecken. Tab-Leiste: wenn trotzdem zu eng,
Icons + Tooltip statt Überlauf.

### Cockpit (Seitenleiste links)

Heute schwebende Karte, die bei schmalem Fenster die Preset-Zeile
verdeckt. Neu als linke Seitenleiste mit derselben Schiebe-Logik.
Inhalt wächst mit `PLAN-playlists.md`: Song, aktive Regel + „warum dieses
Preset“, Quick-Assign, Mini-Queue. Das Cockpit ist damit **die** Stelle
für „was passiert gerade und warum“ — der Debug-HUD bleibt für Technik.

## Ebene 3 — Werkstätten

### Library = Zentrale für Presets

Alles, was ein Preset *auswählt, markiert oder filtert*, lebt hier:

- Auswählen (ersetzt das HUD-Dropdown), Favorit, Tags, „als Layer B“,
  „im Studio öffnen“, später „Als Nächstes / Einreihen / Zu Pool…“.
- **Rotation festlegen:** Der heutige „Tags ▾“-Popover und „nur ★“ werden
  ein Bereich oben in der Library: *„In der Rotation: alle · nur ★ ·
  Tags [drop] [build] (ODER/UND) — 23 Presets“*. Die aktuelle
  Filteransicht der Library und die Rotation sind getrennt sichtbar
  (Knopf „Diese Auswahl als Rotation“).
- Ladezustand für Vorschauen (Schimmer + „Vorschauen werden erzeugt
  12/108“), statt schwarzer Kacheln.

### Studio absorbiert Tweaks

Heute drei Bearbeitungsorte: Tweaks (Drawer), Studio (Bausteine, Code,
Remix, KI), Zucht (Einstellungen). Neu:

| Studio-Tab | Für wen |
|---|---|
| **Anpassen** (neu, erster Tab) | heutiges Tweak-Panel: Regler auf die Grundwerte, live, „Als eigenes Preset speichern“ |
| Bausteine | wie heute |
| Code | wie heute |
| Remix | wie heute |
| KI | wie heute |

„Preset anpassen“ im `⋯`-Menü öffnet das Studio direkt auf „Anpassen“.
Zucht bleibt als Automatik-Einstellung (sie *spielt* Varianten, baut
keine).

Pflicht: Esc / Schließen / Klick daneben bei „● ungespeichert“ →
Nachfrage im Fenster („Verwerfen · Speichern · Zurück“). Die Taste, mit
der das Studio geöffnet wurde, darf nicht ins Namensfeld fallen.

### Regie (aus PLAN-playlists)

Kommt als dritte Werkstatt dazu (Taste `G`), mit denselben Karten wie die
Library. Dadurch braucht die Playlist-Planung keine eigenen HUD-Knöpfe:
Queue-Aktionen sitzen auf Library-Karten und im Cockpit.

## Tastenbelegung

Heute: `B` = BPM, der Knopf „B“ in der Leiste = Layer B (`Shift+B`).
README sagt 1–5 Modi, es sind 6.

Neu:

| Taste | Heute | Neu |
|---|---|---|
| `B` | BPM-Anzeige | **Layer B an/aus** (passt zum Knopf) |
| `Shift+B` | Layer B | Layer-B-Einstellungen |
| `I` | — | **Info-Overlay**: BPM + Song + Preset-Name kurz einblenden (ersetzt die BPM-Taste) |
| `H` | — | Präsentationsmodus an/aus |
| `F` | Vollbild | bleibt; **Esc verlässt das Vollbild nicht mehr** |
| `G` | — | Regie (geplant) |
| `Q` / `N` / `Shift+Q` | — | Einreihen / Queue überspringen / leeren (geplant) |
| `?` | Hilfe | bleibt |

Freie Tasten danach noch: J K M O U V W X Y Z.

Eine Quelle der Wahrheit: die Tastenliste lebt an *einer* Stelle im Code
(Tabelle mit Taste, Aktion, Modus), aus der Handler, Hilfe, Tooltips und
`⋯`-Menü generiert werden. Damit können Hilfe und README nicht mehr
auseinanderlaufen.

## Live-Betrieb (TV / Party)

vizzy läuft meist im Vollbild auf einem zweiten Bildschirm oder unbeaufsichtigt
auf einer Party. Daraus folgen Regeln, die über das Aufräumen hinausgehen:

- **Präsentationsmodus** (Taste `H`, auch im `⋯`-Menü): Die Leiste und der
  Cursor kommen bei Mausbewegung **nicht** zurück. Tasten wirken weiter.
  `H` oder ein Doppelklick holt die Bedienung zurück. Der Modus bleibt über
  einen Neustart erhalten, damit eine Party-Maschine direkt sauber startet.
- **Rückmeldung bei Tasten (OSD):** Jede Taste ohne sichtbares Panel zeigt
  1,5 s eine kleine Einblendung unten mittig, etwa „Auto an“, „★ Favorit“,
  „Layer B aus“, „Tags: drop“. Das ersetzt die heute fehlende Antwort im
  Vollbild, wo die Leiste ausgeblendet ist.
- **Info-Einblendung `I`:** Song, Artist, Preset und BPM für etwa 4 s
  groß unten links. Optional automatisch bei jedem Songwechsel
  (Einstellung in „Bedienung“).
- **Esc verlässt das Vollbild nicht mehr.** Heute wirft ein Esc zu viel
  aus dem Vollbild. Das Vollbild schaltet nur noch `F`. Esc schließt
  ausschließlich Panels.
- **Keine gefährlichen Einzeltasten:** Keine Taste löscht etwas oder öffnet
  im Präsentationsmodus eine Werkstatt, die das Bild verdeckt. `L` und `P`
  holen dort zuerst die Bedienung zurück.
- **Bildschirm merken:** Vollbild öffnet auf dem Monitor, auf dem das
  Fenster zuletzt im Vollbild war. Ziel: Start → läuft auf dem TV.
- **Robust laufen:** Wenn die Quelle verschwindet, wechselt vizzy heute
  schon automatisch auf eine andere. Das soll künftig sichtbar sein:
  als OSD „Quelle gewechselt: …“ und im Cockpit, statt still zu
  passieren.
- **Lesbar auf Distanz:** Die UI-Größe „TV“ gibt es schon. Für den
  Präsentationsmodus und die Info-Einblendung gilt sie automatisch.
- *Später:* Fernbedienung vom Handy über die vorhandene lokale
  HTTP-Brücke (nächstes/vorheriges Preset, Auto, Favorit). Gehört nicht
  zu diesem Umbau.

## Sicherheit und Rückmeldung

- **Löschen** (Bild, Morph-Satz, Modell, eigenes Preset, Kombi): sofort
  ausführen, aber 8 s lang Toast „Gelöscht · Rückgängig“; das Objekt bleibt
  so lange im Speicher. Kein Bestätigungsdialog.
- **Backen läuft:** Fortschritt nicht nur im ComfyUI-Tab, sondern als
  kleine Statuspille in der HUD-Zeile (sichtbar, auch wenn der Drawer zu
  ist).
- **Toasts** einheitlich unten mittig, mit optionaler Aktion.

## Umsetzung in Phasen

Jede Phase endet wie gewohnt: Typecheck grün, Sichtprüfung im Tauri-Dev,
README angepasst, Commit.

**Stand 2026-11-08: U0–U4 umgesetzt.** U0 994c42c · U1 a8defed · U2 7a963fa ·
U3 d4888ca + 5df9844 · U4 im Commit danach. Abweichungen vom Konzept:

- **Tweaks** gibt es als Drawer-Tab nicht mehr; sie sind der Studio-Tab
  „Anpassen“ und starten mit den Live-Tweaks des Hauptbilds (etwa einer
  Library-Variante).
- **ComfyUI** sitzt im Tab „Bild“ (dort, wo gebacken wird), nicht in
  „System“; Spotify und new-helper bleiben im Cockpit.
- **Hilfe** steht weiter als `?` oben in der Leiste (das `⋯`-Menü gibt es nur
  bei Milkdrop) und öffnet ein eigenes kleines Fenster.
- **Quellenwechsel** braucht eine Rust-Änderung: Der Capture-Thread zählt
  seine Rückfälle (`audio_fallbacks`), die App fragt alle 3 s nach.
- Ungeprüft in der Tauri-App: Vollbild-Monitor merken, Quellenwechsel-OSD,
  Präsentationsmodus nach Neustart.

| Phase | Inhalt | Umfang |
|---|---|---|
| **U0 Bugfixes** | `P` leakt ins Studio; Studio-Dirty-Check; doppelte Milkdrop-Gruppe; Löschen mit Rückgängig; Morph-Leerzustand; Library-Ladezustand; README 1–6 | klein |
| **U1 Gerüst + Live** | Tastentabelle als Quelle der Wahrheit inkl. `B`/`I`/`H`; OSD-Rückmeldung; Präsentationsmodus; Esc ohne Vollbild-Ausstieg; Fenster-Grammatik (Seitenleisten schieben die HUD, Werkstätten fangen Klick daneben ab); Cockpit als linke Seitenleiste | mittel |
| **U2 Drawer** | 6 feste Tabs, Routing/ComfyUI eingegliedert, Automatik-Tab, Duplikate raus, Ausgrauen statt Verschwinden | mittel |
| **U3 Bühne** | Preset-Pille, `⋯`-Menü, `Milkdrop \| 3D \| Klassisch ▾`, Library als Auswahl (Dropdown raus), Rotation in der Library, 3D-Pille mit deutschen Namen + Aktionszeile, Info-Einblendung, Hilfe als kleines Fenster, Vollbild-Monitor merken | mittel–groß |
| **U4 Studio** | Tab „Anpassen“ ersetzt den Tweaks-Tab | klein–mittel |
| danach | Playlist-Plan (Spotify, Regie, Queue) setzt auf das neue Gerüst auf | — |

U1 ist auch ein guter Moment, die UI-Teile aus `App.tsx` (3700 Zeilen)
in eigene Komponenten zu ziehen (`Hud`, `PresetPill`, `ScenePill`,
`MoreMenu`), wie es `PLAN-playlists.md` ohnehin anmahnt.

## Entscheidungen (2026-11-07)

1. **Modus-Wahl:** `Milkdrop | 3D | Klassisch ▾`. Die Tasten `1`–`6`
   bleiben.
2. **Einsatz:** hauptsächlich **zweiter Bildschirm / TV** und **live /
   Party**. Daraus folgt der Abschnitt „Live-Betrieb“ unten: Bedienung
   per Tastatur zuerst, ein Präsentationsmodus ohne Leiste und nichts, was
   versehentlich das Bild stört.
3. **Hilfe:** eigenes kleines Fenster (`?` und `⋯`-Menü), kein Tab.
4. **`B` wird umbelegt:** `B` schaltet Layer B, `I` zeigt die Info-Einblendung.
