// Regie (key G): build rules and pools.
//   Regeln — ordered list, first match wins; drag (or ↑/↓) to change priority
//   Pools  — curated preset lists a rule can point to
// Choreos get their own tab in phase 6.

import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDialogFocus } from "../useDialogFocus";
import { useCombos } from "../milkdrop/combos";
import { MATCH_ICON, MATCH_KIND_LABEL, describeMatch, useActiveRule } from "./director";
import { contextLabel, useNowPlaying } from "./nowPlaying";
import {
  COMBO_PREFIX,
  regie,
  useRegie,
  type Hold,
  type Pool,
  type PoolPick,
  type Rule,
  type RuleMatch,
  type RuleTarget,
} from "./regieStore";
import { useSpotifyStatus } from "./spotify";
import { LEARNED_START, contextRatings, useContextRatings, type Scope } from "./contextRatings";
import "./regie.css";

const inTauri = "__TAURI_INTERNALS__" in window;

type Props = {
  presetKeys: string[];
  label: (key: string) => string;
  currentKey: string;
  onPlay: (key: string) => void;
  onClose: () => void;
};

type Tab = "rules" | "pools" | "learned";

const TAB_LABEL: Record<Tab, string> = { rules: "Regeln", pools: "Pools", learned: "Gelernt" };

export function RegieModal(props: Props) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [tab, setTab] = useState<Tab>("rules");
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="modal regie-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="regie-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="regie-title">REGIE</h2>
          <div className="seg" role="tablist">
            {(["rules", "pools", "learned"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`mode-btn ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          <button type="button" className="mode-btn" onClick={props.onClose} title="Schließen (Esc)">
            ×
          </button>
        </div>
        {tab === "rules" ? (
          <RulesTab {...props} />
        ) : tab === "pools" ? (
          <PoolsTab {...props} />
        ) : (
          <LearnedTab {...props} />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- pickers

/** Text field with suggestions over all presets (and combos). */
function PresetPicker({
  presetKeys,
  label,
  withCombos,
  placeholder,
  current,
  onPick,
}: {
  presetKeys: string[];
  label: (k: string) => string;
  withCombos?: boolean;
  placeholder: string;
  /** shown as the field's resting text, so the field doubles as the display */
  current?: string;
  onPick: (key: string) => void;
}) {
  const combos = useCombos();
  const [text, setText] = useState("");
  const [listId] = useState(() => `pp-${Math.random().toString(36).slice(2)}`);
  const options = useMemo(() => {
    const m = new Map<string, string>();
    if (withCombos) for (const c of combos) m.set(`Kombi: ${c.name}`, COMBO_PREFIX + c.name);
    for (const k of presetKeys) {
      const l = label(k);
      m.set(m.has(l) ? `${l} (${k})` : l, k);
    }
    return m;
  }, [presetKeys, label, combos, withCombos]);
  return (
    <>
      <input
        className={`regie-input ${current ? "has-current" : ""}`}
        list={listId}
        value={text}
        placeholder={current ?? placeholder}
        title={current ? `${current} — tippen zum Ändern` : undefined}
        onChange={(e) => {
          const v = e.target.value;
          const key = options.get(v);
          if (key) {
            onPick(key);
            setText("");
          } else setText(v);
        }}
      />
      <datalist id={listId}>
        {[...options.keys()].map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </>
  );
}

function entryLabel(e: string, label: (k: string) => string): string {
  return e.startsWith(COMBO_PREFIX) ? `Kombi: ${e.slice(COMBO_PREFIX.length)}` : label(e);
}

// ------------------------------------------------------------- rules

function RulesTab({ presetKeys, label, currentKey }: Props) {
  const { enabled, rules, pools } = useRegie();
  const { track } = useNowPlaying();
  const active = useActiveRule();
  const sp = useSpotifyStatus();
  const [dragId, setDragId] = useState<string | null>(null);
  const [artist, setArtist] = useState("");
  const [playlists, setPlaylists] = useState<{ uri: string; name: string; owner: string }[] | null>(null);
  const [plError, setPlError] = useState("");

  const defaultTarget: RuleTarget = { kind: "preset", key: currentKey, hold: "song" };
  const add = (m: RuleMatch) => regie.upsertRule(m, defaultTarget);

  const loadPlaylists = () => {
    setPlError("");
    invoke<{ uri: string; name: string; owner: string }[]>("spotify_playlists")
      .then(setPlaylists)
      .catch((e) => setPlError(String(e)));
  };

  return (
    <div className="regie-body">
      <label className="regie-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => regie.setEnabled(e.target.checked)} />
        Regeln aktiv
        <span className="regie-dim">
          — die erste passende Regel gewinnt. Ohne Treffer läuft der normale Auto-Switch.
        </span>
      </label>

      <div className="regie-add">
        <span className="regie-dim">Neue Regel mit dem laufenden Bild:</span>
        <button
          type="button"
          className="mode-btn"
          disabled={!track}
          onClick={() =>
            track &&
            add({
              kind: "song",
              keys: [...new Set([track.key, track.baseKey])],
              label: `${track.artist} — ${track.title}`,
            })
          }
        >
          ♪ dieser Song
        </button>
        <button
          type="button"
          className="mode-btn"
          disabled={!track?.context}
          onClick={() =>
            track?.context &&
            add({
              kind: "context",
              uri: track.context.uri,
              ctxKind: track.context.kind,
              name: track.context.name ?? track.context.uri,
            })
          }
          title={track?.context ? contextLabel(track.context) : "Nur mit Spotify-Verbindung"}
        >
          ▤ diese Playlist
        </button>
        <form
          className="regie-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (artist.trim()) add({ kind: "artist", name: artist.trim() });
            setArtist("");
          }}
        >
          <input
            className="regie-input"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder={track ? `Artist, z. B. ${track.artist.split(",")[0]}` : "Artist"}
          />
          <button type="submit" className="mode-btn" disabled={!artist.trim()}>
            ☺ +
          </button>
        </form>
        {inTauri && sp.connected && (
          playlists ? (
            <select
              className="src-select"
              value=""
              onChange={(e) => {
                const p = playlists.find((x) => x.uri === e.target.value);
                if (p) add({ kind: "context", uri: p.uri, ctxKind: "playlist", name: p.name });
              }}
            >
              <option value="">Spotify-Playlist wählen …</option>
              {playlists.map((p) => (
                <option key={p.uri} value={p.uri}>
                  {p.name}
                  {p.owner && p.owner !== sp.user ? ` · ${p.owner}` : ""}
                </option>
              ))}
            </select>
          ) : (
            <button type="button" className="mode-btn" onClick={loadPlaylists}>
              ▤ aus meinen Playlists …
            </button>
          )
        )}
      </div>
      {plError && <div className="sp-error">{plError}</div>}

      {rules.length === 0 ? (
        <p className="regie-empty">
          Noch keine Regeln. Lege oben eine für den laufenden Song, eine Playlist oder einen Artist an –
          oder im Cockpit (C) mit einem Klick.
        </p>
      ) : (
        <ol className="rule-list">
          {rules.map((r, i) => (
            <li
              key={r.id}
              className={`rule-row ${active?.rule.id === r.id ? "is-active" : ""} ${r.enabled ? "" : "is-off"} ${
                dragId === r.id ? "is-drag" : ""
              }`}
              draggable
              onDragStart={(e) => {
                setDragId(r.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => {
                if (!dragId || dragId === r.id) return;
                e.preventDefault();
                regie.moveRule(dragId, i);
              }}
            >
              <span className="rule-grip" aria-hidden>
                ⠿
              </span>
              <span className="rule-prio">{i + 1}</span>
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={(e) => regie.updateRule(r.id, { enabled: e.target.checked })}
                aria-label="Regel aktiv"
              />
              <span className="rule-match" title={MATCH_KIND_LABEL[r.match.kind]}>
                <span className="rule-icon">{MATCH_ICON[r.match.kind]}</span>
                {describeMatch(r.match)}
              </span>
              <span className="rule-arrow">→</span>
              <TargetEditor rule={r} pools={pools} presetKeys={presetKeys} label={label} />
              <span className="rule-tools">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={i === 0}
                  onClick={() => regie.moveRule(r.id, i - 1)}
                  aria-label="Höher"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={i === rules.length - 1}
                  onClick={() => regie.moveRule(r.id, i + 1)}
                  aria-label="Tiefer"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => regie.removeRule(r.id)}
                  aria-label="Regel löschen"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TargetEditor({
  rule,
  pools,
  presetKeys,
  label,
}: {
  rule: Rule;
  pools: Pool[];
  presetKeys: string[];
  label: (k: string) => string;
}) {
  const combos = useCombos();
  const t = rule.target;
  const set = (target: RuleTarget) => regie.updateRule(rule.id, { target });
  const hold: Hold = t.kind === "pool" ? "song" : t.hold;

  return (
    <span className="rule-target">
      <select
        className="src-select rule-kind"
        value={t.kind}
        onChange={(e) => {
          const k = e.target.value as RuleTarget["kind"];
          if (k === "preset") set({ kind: "preset", key: presetKeys[0], hold });
          else if (k === "combo") set({ kind: "combo", name: combos[0]?.name ?? "", hold });
          else set({ kind: "pool", poolId: pools[0]?.id ?? "" });
        }}
        aria-label="Ziel-Art"
      >
        <option value="preset">Preset</option>
        <option value="combo" disabled={combos.length === 0}>
          Kombi
        </option>
        <option value="pool" disabled={pools.length === 0}>
          Pool
        </option>
      </select>

      {t.kind === "preset" && (
        <span className="rule-value">
          <PresetPicker
            presetKeys={presetKeys}
            label={label}
            placeholder="Preset wählen …"
            current={label(t.key)}
            onPick={(key) => set({ ...t, key })}
          />
        </span>
      )}
      {t.kind === "combo" && (
        <select
          className="src-select"
          value={t.name}
          onChange={(e) => set({ ...t, name: e.target.value })}
          aria-label="Kombi"
        >
          {combos.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {t.kind === "pool" && (
        <select
          className="src-select"
          value={t.poolId}
          onChange={(e) => set({ kind: "pool", poolId: e.target.value })}
          aria-label="Pool"
        >
          {pools.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.entries.length})
            </option>
          ))}
        </select>
      )}
      {t.kind !== "pool" && (
        <select
          className="src-select rule-hold"
          value={t.hold}
          onChange={(e) => set({ ...t, hold: e.target.value as Hold })}
          aria-label="Halten"
        >
          <option value="song">hält Song</option>
          <option value="start">nur Start</option>
        </select>
      )}
    </span>
  );
}

// ------------------------------------------------------------- pools

const PICK_LABEL: Record<PoolPick, string> = {
  smart: "Smart (Tags, Energie, Bewertung)",
  shuffle: "Zufällig",
  order: "Der Reihe nach",
};

function PoolsTab({ presetKeys, label, currentKey, onPlay }: Props) {
  const { pools, rules } = useRegie();
  const [sel, setSel] = useState<string | null>(pools[0]?.id ?? null);
  const [confirmDel, setConfirmDel] = useState(false);
  const pool = pools.find((p) => p.id === sel) ?? null;
  const bindings = pool ? rules.filter((r) => r.target.kind === "pool" && r.target.poolId === pool.id) : [];

  const move = (p: Pool, from: number, to: number) => {
    const entries = [...p.entries];
    const [e] = entries.splice(from, 1);
    entries.splice(to, 0, e);
    regie.updatePool(p.id, { entries });
  };

  return (
    <div className="regie-body pools">
      <div className="pool-side">
        <ul className="pool-list">
          {pools.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`pool-item ${p.id === sel ? "active" : ""}`}
                onClick={() => {
                  setSel(p.id);
                  setConfirmDel(false);
                }}
              >
                <span>{p.name}</span>
                <span className="regie-dim">{p.entries.length}</span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="mode-btn"
          onClick={() => {
            const p = regie.createPool(`Pool ${pools.length + 1}`, currentKey ? [currentKey] : []);
            setSel(p.id);
          }}
        >
          + Neuer Pool
        </button>
      </div>

      {pool ? (
        <div className="pool-main">
          <div className="regie-inline">
            <input
              className="regie-input pool-name"
              value={pool.name}
              onChange={(e) => regie.updatePool(pool.id, { name: e.target.value })}
              aria-label="Pool-Name"
            />
            <select
              className="src-select"
              value={pool.pick}
              onChange={(e) => regie.updatePool(pool.id, { pick: e.target.value as PoolPick })}
              aria-label="Auswahl"
            >
              {(Object.keys(PICK_LABEL) as PoolPick[]).map((k) => (
                <option key={k} value={k}>
                  {PICK_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          <div className="regie-inline">
            <PresetPicker
              presetKeys={presetKeys}
              label={label}
              withCombos
              placeholder="Preset oder Kombi hinzufügen …"
              onPick={(k) => regie.addToPool(pool.id, k)}
            />
            <button
              type="button"
              className="mode-btn"
              disabled={!currentKey || pool.entries.includes(currentKey)}
              onClick={() => regie.addToPool(pool.id, currentKey)}
              title={label(currentKey)}
            >
              + laufendes
            </button>
          </div>

          {pool.entries.length === 0 ? (
            <p className="regie-empty">Leer. Füge Presets hinzu – ab zwei Einträgen rotiert der Auto-Switch darin.</p>
          ) : (
            <ol className="pool-entries">
              {pool.entries.map((e, i) => (
                <li key={e} className={e === currentKey ? "is-current" : ""}>
                  <span className="rule-prio">{i + 1}</span>
                  <span className="pool-entry-name" title={e}>
                    {entryLabel(e, label)}
                  </span>
                  <span className="rule-tools">
                    {!e.startsWith(COMBO_PREFIX) && (
                      <button type="button" className="icon-btn" onClick={() => onPlay(e)} aria-label="Anspielen">
                        ▶
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={i === 0}
                      onClick={() => move(pool, i, i - 1)}
                      aria-label="Höher"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={i === pool.entries.length - 1}
                      onClick={() => move(pool, i, i + 1)}
                      aria-label="Tiefer"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => regie.removeFromPool(pool.id, e)}
                      aria-label="Entfernen"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}

          <div className="pool-bindings">
            <span className="cockpit-label">Gebunden an</span>
            {bindings.length === 0 ? (
              <span className="regie-dim">
                noch nichts – im Tab „Regeln“ als Ziel wählen, oder im Cockpit „+ Pool“.
              </span>
            ) : (
              bindings.map((r) => (
                <span key={r.id} className="pool-binding">
                  {MATCH_ICON[r.match.kind]} {describeMatch(r.match)}
                </span>
              ))
            )}
          </div>

          <div className="regie-inline pool-danger">
            {confirmDel ? (
              <>
                <span className="sp-error">
                  Pool löschen{bindings.length ? ` und ${bindings.length} Regel(n) dazu` : ""}?
                </span>
                <button
                  type="button"
                  className="mode-btn danger"
                  onClick={() => {
                    regie.removePool(pool.id);
                    setSel(pools.find((p) => p.id !== pool.id)?.id ?? null);
                    setConfirmDel(false);
                  }}
                >
                  Ja, löschen
                </button>
                <button type="button" className="mode-btn" onClick={() => setConfirmDel(false)}>
                  Abbrechen
                </button>
              </>
            ) : (
              <button type="button" className="mode-btn" onClick={() => setConfirmDel(true)}>
                Pool löschen …
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="regie-empty">
          Ein Pool ist eine Preset-Auswahl, durch die der Auto-Switch rotiert – z. B. „Deutschrap hart“. Lege links
          einen an.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------- learned

const SCOPE_ICON: Record<Scope, string> = { song: "♪", artist: "☺", playlist: "▤" };
const SCOPE_NAME: Record<Scope, string> = { song: "Song", artist: "Artist", playlist: "Playlist" };

function LearnedTab({ label, currentKey, onPlay }: Props) {
  const data = useContextRatings();
  const { track } = useNowPlaying();
  const [confirmAll, setConfirmAll] = useState(false);
  const counts = contextRatings.counts();
  const known = track ? contextRatings.known(track) : [];

  return (
    <div className="regie-body">
      <label className="regie-toggle">
        <input
          type="checkbox"
          checked={data.enabled}
          onChange={(e) => contextRatings.setEnabled(e.target.checked)}
        />
        Mitlernen
        <span className="regie-dim">
          — + / − merken sich auch Song, Artist und Playlist. Das gewichtet Auto-Switch und Smart-Pools; ein Song
          mit klarem Favoriten (Wert ≥ {LEARNED_START}) startet damit.
        </span>
      </label>

      <div className="regie-dim">
        Gelernt für {counts.song} {counts.song === 1 ? "Song" : "Songs"} · {counts.artist}{" "}
        {counts.artist === 1 ? "Artist" : "Artists"} · {counts.playlist}{" "}
        {counts.playlist === 1 ? "Playlist" : "Playlists"}
      </div>

      {!track ? (
        <p className="regie-empty">Kein Song erkannt – hier erscheint, was für den laufenden Song gelernt ist.</p>
      ) : known.length === 0 ? (
        <p className="regie-empty">
          Für „{track.title}“ ist noch nichts gelernt. Drück + bei einem Bild, das passt, − bei einem, das nicht passt.
        </p>
      ) : (
        <>
          <div className="cockpit-label">
            Für „{track.title}“ · {track.artist}
            {track.context?.name ? ` · ${track.context.name}` : ""}
          </div>
          <ol className="learned-list">
            {known.map((k) => (
              <li key={k.preset} className={k.preset === currentKey ? "is-current" : ""}>
                <span
                  className={`learned-score ${k.score >= LEARNED_START ? "is-start" : ""}`}
                  title={k.score >= LEARNED_START ? "startet den Song" : "Gewicht im Auto-Switch"}
                >
                  {k.score > 0 ? "+" : ""}
                  {k.score.toFixed(1)}
                </span>
                <span className="learned-name" title={k.preset}>
                  {label(k.preset)}
                </span>
                {(["song", "artist", "playlist"] as Scope[])
                  .filter((s) => k.r[s] !== 0)
                  .map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`fit-chip ${k.r[s] > 0 ? "pos" : "neg"}`}
                      onClick={() => contextRatings.forget(track, k.preset, s)}
                      title={`${SCOPE_NAME[s]}: vergessen`}
                    >
                      {SCOPE_ICON[s]} {k.r[s] > 0 ? "+" : ""}
                      {k.r[s]}
                    </button>
                  ))}
                <span className="rule-tools">
                  <button type="button" className="icon-btn" onClick={() => onPlay(k.preset)} aria-label="Anspielen">
                    ▶
                  </button>
                  {k.score > 0 && (
                    <button
                      type="button"
                      className="mode-btn"
                      onClick={() =>
                        regie.upsertRule(
                          {
                            kind: "song",
                            keys: [...new Set([track.key, track.baseKey])],
                            label: `${track.artist} — ${track.title}`,
                          },
                          { kind: "preset", key: k.preset, hold: "song" },
                        )
                      }
                      title="Als feste Regel für diesen Song"
                    >
                      → Regel
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="regie-inline pool-danger">
        {confirmAll ? (
          <>
            <span className="sp-error">Alles Gelernte vergessen? Regeln und Bewertungen bleiben.</span>
            <button
              type="button"
              className="mode-btn danger"
              onClick={() => {
                contextRatings.forgetAll();
                setConfirmAll(false);
              }}
            >
              Ja, vergessen
            </button>
            <button type="button" className="mode-btn" onClick={() => setConfirmAll(false)}>
              Abbrechen
            </button>
          </>
        ) : (
          <button type="button" className="mode-btn" onClick={() => setConfirmAll(true)}>
            Alles vergessen …
          </button>
        )}
      </div>
    </div>
  );
}
