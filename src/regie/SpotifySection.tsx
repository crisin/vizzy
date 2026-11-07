// Cockpit block: connect vizzy to Spotify (PKCE, own Spotify app).

import { useState } from "react";
import { spotify, useSpotifyStatus } from "./spotify";

const inTauri = "__TAURI_INTERNALS__" in window;

export function SpotifySection() {
  const st = useSpotifyStatus();
  const [editId, setEditId] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  if (!inTauri) return null;

  const needsId = !st.clientId || editId;

  const copyRedirect = () => {
    void navigator.clipboard?.writeText(st.redirectUri).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section className="cockpit-sec">
      <div className="cockpit-label">Spotify</div>

      {needsId ? (
        <>
          <ol className="sp-steps">
            <li>
              Auf <b>developer.spotify.com/dashboard</b> eine App anlegen („Web API“ anhaken).
            </li>
            <li>
              Als Redirect-URI eintragen:{" "}
              <button type="button" className="sp-uri" onClick={copyRedirect} title="Kopieren">
                {st.redirectUri}
              </button>
              {copied && <span className="sp-ok"> kopiert</span>}
            </li>
            <li>Die Client-ID hier einfügen:</li>
          </ol>
          <form
            className="cockpit-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              void spotify.setClientId(draft.trim());
              setEditId(false);
              setDraft("");
            }}
          >
            <input
              className="sp-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Client-ID"
              spellCheck={false}
              autoComplete="off"
              aria-label="Spotify Client-ID"
            />
            <button type="submit" className="mode-btn" disabled={!draft.trim()}>
              OK
            </button>
            {editId && (
              <button type="button" className="mode-btn" onClick={() => setEditId(false)}>
                ×
              </button>
            )}
          </form>
        </>
      ) : st.connected ? (
        <div className="cockpit-row">
          <span className="cockpit-value">
            <span className="sp-dot" aria-hidden /> {st.user ?? "verbunden"}
          </span>
          <span className="cockpit-spacer" />
          <button type="button" className="mode-btn" onClick={() => void spotify.disconnect()}>
            Trennen
          </button>
        </div>
      ) : st.connecting ? (
        <div className="cockpit-row">
          <span className="cockpit-dim">Im Browser bestätigen …</span>
          <span className="cockpit-spacer" />
          <button type="button" className="mode-btn" onClick={() => spotify.cancel()}>
            Abbrechen
          </button>
        </div>
      ) : (
        <div className="cockpit-row">
          <button type="button" className="mode-btn active" onClick={() => void spotify.connect()}>
            Mit Spotify verbinden
          </button>
          <span className="cockpit-spacer" />
          <button
            type="button"
            className="mode-btn"
            onClick={() => {
              setDraft(st.clientId);
              setEditId(true);
            }}
            title="Client-ID ändern"
          >
            ID
          </button>
        </div>
      )}

      {st.error && <div className="sp-error">{st.error}</div>}
      {st.connected && (
        <div className="cockpit-dim">Liefert Track-ID und Playlist – Grundlage für Zuordnungen.</div>
      )}
    </section>
  );
}
