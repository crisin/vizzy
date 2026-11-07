// Cockpit block "Bild": what is on screen, which rule put it there, and
// one-click binding of it to the running song / artist / playlist or a pool.

import { useState } from "react";
import { MATCH_ICON, describeMatch, director, splitArtists, useActiveRule, useChoreoState } from "./director";
import { choreos, useRecording } from "./choreo";
import { contextLabel, useNowPlaying, type Track } from "./nowPlaying";
import { contextRatings, useContextRatings, type Scope } from "./contextRatings";
import { regie, useRegie, type RuleMatch } from "./regieStore";

const SCOPE_ICON: Record<Scope, string> = { song: "♪", artist: "☺", playlist: "▤" };

/** "♪ +2 · ▤ -1" — what + / - taught for this picture here; "" if nothing. */
export function fitLine(r: Record<Scope, number>): string {
  return (["song", "artist", "playlist"] as Scope[])
    .filter((s) => r[s] !== 0)
    .map((s) => `${SCOPE_ICON[s]} ${r[s] > 0 ? "+" : ""}${r[s]}`)
    .join(" · ");
}

type Props = {
  presetKey: string;
  presetLabel: string;
  autoSwitch: boolean;
  canAssign: boolean;
  onOpenRegie: () => void;
};

type Ctx = { match: RuleMatch; label: string; short: string };

/** The things the running song can be bound by, most specific first. */
function contextsOf(t: Track): Ctx[] {
  const out: Ctx[] = [
    {
      match: { kind: "song", keys: [...new Set([t.key, t.baseKey])], label: `${t.artist} — ${t.title}` },
      label: `Song „${t.title}“`,
      short: "♪ Song",
    },
  ];
  const artist = splitArtists(t.artist)[0];
  if (artist) out.push({ match: { kind: "artist", name: artist }, label: `Artist ${artist}`, short: "☺ Artist" });
  if (t.context?.name)
    out.push({
      match: { kind: "context", uri: t.context.uri, ctxKind: t.context.kind, name: t.context.name },
      label: contextLabel(t.context),
      short: t.context.kind === "playlist" ? "▤ Playlist" : `▤ ${contextLabel(t.context).split(":")[0]}`,
    });
  return out;
}

export function PictureSection({ presetKey, presetLabel, autoSwitch, canAssign, onOpenRegie }: Props) {
  const { track } = useNowPlaying();
  const { enabled, pools } = useRegie();
  const active = useActiveRule();
  const choreo = useChoreoState();
  const rec = useRecording();
  useContextRatings(); // re-render when + / - learn something
  const [poolMenu, setPoolMenu] = useState(false);
  const [note, setNote] = useState("");

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote((n) => (n === msg ? "" : n)), 2500);
  };

  const ctxs = track && track.status !== "other" ? contextsOf(track) : [];
  const can = canAssign && !!presetKey;

  const bind = (c: Ctx) => {
    regie.upsertRule(c.match, { kind: "preset", key: presetKey, hold: "song" });
    if (!enabled) regie.setEnabled(true);
    flash(`✓ ${c.label} → ${presetLabel}`);
  };

  const activePool =
    active?.rule.target.kind === "pool"
      ? pools.find((p) => active.rule.target.kind === "pool" && p.id === active.rule.target.poolId)
      : undefined;

  const addToPool = (id: string, name: string) => {
    regie.addToPool(id, presetKey);
    setPoolMenu(false);
    flash(`✓ in Pool „${name}“`);
  };

  const newPoolFor = (c: Ctx) => {
    const name = c.match.kind === "song" ? track?.title ?? "Pool" : describeMatch(c.match);
    const pool = regie.createPool(name, [presetKey]);
    regie.upsertRule(c.match, { kind: "pool", poolId: pool.id });
    if (!enabled) regie.setEnabled(true);
    setPoolMenu(false);
    flash(`✓ Pool „${name}“ für ${c.label}`);
  };

  return (
    <section className="cockpit-sec">
      <div className="cockpit-label">Bild</div>
      <div className="cockpit-row">
        <span className="cockpit-value" title={presetLabel}>
          {presetLabel}
        </span>
      </div>
      {rec && (
        <div className="cockpit-rec">
          ● Aufnahme: {rec.title}
          <button type="button" className="mode-btn" onClick={() => choreos.stopRecording()}>
            ■ Stopp
          </button>
        </div>
      )}
      <div className="cockpit-dim cockpit-rule">
        {choreo ? (
          <>
            <span className="cockpit-rule-on">
              Choreo · Cue {Math.min(choreo.fired, choreo.total)}/{choreo.total}
            </span>
            {choreo.nextAt !== null && (
              <>
                {" "}
                · nächster bei {Math.floor(choreo.nextAt / 60000)}:
                {String(Math.floor((choreo.nextAt % 60000) / 1000)).padStart(2, "0")}
              </>
            )}
          </>
        ) : !enabled ? (
          <>Regeln aus · {autoSwitch ? "Auto-Switch" : "manuell"}</>
        ) : active ? (
          <>
            <span className="cockpit-rule-on">
              Regel {active.index + 1}: {MATCH_ICON[active.rule.match.kind]} {describeMatch(active.rule.match)}
            </span>{" "}
            → {director.describeTarget(active.rule)}
            {active.rule.target.kind !== "pool" &&
              (active.rule.target.hold === "song" ? " · hält" : " · dann Auto")}
          </>
        ) : (
          <>Keine Regel · {autoSwitch ? "Auto-Switch" : "manuell"}</>
        )}
      </div>

      {track && track.status !== "other" && presetKey && (() => {
        const line = fitLine(contextRatings.ratingsFor(track, presetKey));
        return line ? (
          <div className="cockpit-dim" title="Gelernt mit + / − während dieser Song lief">
            Passt hier: <span className="cockpit-fit">{line}</span>
          </div>
        ) : null;
      })()}

      {ctxs.length > 0 && (
        <div className="cockpit-assign">
          <span className="cockpit-dim">Binden an</span>
          {ctxs.map((c) => (
            <button
              key={c.match.kind}
              type="button"
              className="mode-btn"
              disabled={!can}
              onClick={() => bind(c)}
              title={`${c.label} spielt immer dieses Bild`}
            >
              {c.short}
            </button>
          ))}
          <button
            type="button"
            className={`mode-btn ${poolMenu ? "active" : ""}`}
            disabled={!can}
            onClick={() => setPoolMenu((v) => !v)}
            aria-expanded={poolMenu}
          >
            + Pool ▾
          </button>
        </div>
      )}

      {poolMenu && can && (
        <div className="cockpit-menu" role="menu">
          {activePool && (
            <button type="button" role="menuitem" onClick={() => addToPool(activePool.id, activePool.name)}>
              In aktiven Pool „{activePool.name}“
            </button>
          )}
          {ctxs.map((c) => (
            <button key={c.match.kind} type="button" role="menuitem" onClick={() => newPoolFor(c)}>
              Neuer Pool für {c.label}
            </button>
          ))}
          {pools
            .filter((p) => p.id !== activePool?.id)
            .map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                disabled={p.entries.includes(presetKey)}
                onClick={() => addToPool(p.id, p.name)}
              >
                In „{p.name}“ ({p.entries.length})
              </button>
            ))}
        </div>
      )}

      {note && <div className="cockpit-note">{note}</div>}
      <button type="button" className="cockpit-link" onClick={onOpenRegie}>
        Regeln & Pools bearbeiten (G)
      </button>
    </section>
  );
}
