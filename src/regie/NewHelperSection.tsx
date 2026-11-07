// Cockpit blocks for new-helper: the song's tags under the now-playing card,
// and the connection (URL + personal API token) further down.

import { useState } from "react";
import { newHelper, useNewHelper } from "./newHelper";
import { useNowPlaying } from "./nowPlaying";

const inTauri = "__TAURI_INTERNALS__" in window;

/** "#party #aggressiv ♥" for the playing song, if new-helper knows it. */
export function NhTagsLine() {
  const { track } = useNowPlaying();
  const nh = useNewHelper();
  const info = track ? nh.info[track.baseKey] : undefined;
  if (!info?.found) return null;
  const moods = info.tags.filter((t) => t.type === "MOOD");
  const ctx = info.tags.filter((t) => t.type !== "MOOD");
  if (!moods.length && !ctx.length && !info.isFavorite) return null;
  return (
    <div className="nh-tags" title="aus new-helper">
      {info.isFavorite && <span className="nh-fav">♥</span>}
      {moods.map((t) => (
        <span key={t.tag} className="nh-tag mood">
          #{t.tag}
        </span>
      ))}
      {ctx.map((t) => (
        <span key={t.tag} className="nh-tag">
          #{t.tag}
        </span>
      ))}
    </div>
  );
}

export function NewHelperSection() {
  const nh = useNewHelper();
  const [edit, setEdit] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  if (!inTauri) return null;
  const configured = nh.status.baseUrl && nh.status.hasToken;
  const editing = edit || !configured;

  return (
    <section className="cockpit-sec">
      <div className="cockpit-label">new-helper (optional)</div>
      {editing ? (
        <form
          className="nh-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setOk(false);
            void newHelper
              .configure(url.trim() || nh.status.baseUrl, token.trim() ? token.trim() : null)
              .then((err) => {
                setBusy(false);
                if (!err) {
                  setOk(true);
                  setEdit(false);
                  setToken("");
                }
              });
          }}
        >
          <span className="cockpit-dim">
            Tags und Mood deiner Songs als Regel-Kontext. Token in new-helper unter Einstellungen → Verbundene Apps
            erstellen.
          </span>
          <input
            className="sp-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={nh.status.baseUrl || "Backend-URL, z. B. http://localhost:3001"}
            spellCheck={false}
            aria-label="new-helper Backend-URL"
          />
          <input
            className="sp-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={nh.status.hasToken ? "Token (unverändert lassen)" : "API-Token nh_…"}
            autoComplete="off"
            spellCheck={false}
            aria-label="new-helper API-Token"
          />
          <div className="cockpit-row">
            <button
              type="submit"
              className="mode-btn active"
              disabled={busy || !(url.trim() || nh.status.baseUrl) || !(token.trim() || nh.status.hasToken)}
            >
              {busy ? "Prüfe …" : "Verbinden"}
            </button>
            {configured && (
              <button type="button" className="mode-btn" onClick={() => setEdit(false)}>
                Abbrechen
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="cockpit-row">
          <span className="cockpit-value" title={nh.status.baseUrl}>
            <span className="sp-dot nh-dot" aria-hidden /> {nh.status.baseUrl.replace(/^https?:\/\//, "")}
          </span>
          <span className="cockpit-spacer" />
          <button
            type="button"
            className="mode-btn"
            onClick={() => {
              setUrl(nh.status.baseUrl);
              setEdit(true);
              setOk(false);
            }}
          >
            Ändern
          </button>
        </div>
      )}
      {ok && !nh.error && <div className="cockpit-note">✓ verbunden</div>}
      {nh.error && <div className="sp-error">{nh.error}</div>}
    </section>
  );
}
