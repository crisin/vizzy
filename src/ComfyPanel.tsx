import { useState } from "react";
import { useDialogFocus } from "./useDialogFocus";
import {
  DEFAULT_WORKFLOW,
  GRID_SIZES,
  IMAGE_TOKEN,
  X_TOKEN,
  Y_TOKEN,
  comfyPing,
  type AxisRanges,
  type BakeKind,
} from "./comfy";

export type BakeState =
  | { kind: "idle" }
  | { kind: "running"; msg?: string }
  | { kind: "ok"; msg: string }
  | { kind: "error"; msg: string };

const COPY: Record<
  BakeKind,
  { title: string; label: string; hint: string; button: string }
> = {
  depth: {
    title: "Tiefenkarte backen",
    label: "Workflow — Tiefenkarte",
    hint:
      "Die erste gespeicherte Ausgabe wird als Tiefenkarte des Bildes übernommen. " +
      "Der Standard braucht die Custom Nodes comfyui_controlnet_aux — fehlen sie, " +
      "tausch den mittleren Knoten gegen deinen eigenen Tiefen-Schätzer.",
    button: "Tiefenkarte backen",
  },
  variants: {
    title: "Varianten backen",
    label: "Workflow — eine Zelle",
    hint:
      "Der Workflow läuft einmal pro Rasterzelle. Setz den Seed im Workflow auf " +
      "einen festen Wert — nur dann teilen sich die Varianten die Komposition, " +
      "und nur dann wirkt die Mischung wie ein Bild, das sich verändert. " +
      "Der Standard kommt mit Core Nodes aus; passe ckpt_name an ein " +
      "Checkpoint an, das du hast.",
    button: "Varianten backen",
  },
};

export function ComfyPanel({
  kind,
  onKindChange,
  url,
  onUrlChange,
  workflow,
  onWorkflowChange,
  axes,
  onAxesChange,
  imageName,
  bake,
  onBake,
  onClose,
}: {
  kind: BakeKind;
  onKindChange: (kind: BakeKind) => void;
  url: string;
  onUrlChange: (url: string) => void;
  axes: AxisRanges;
  onAxesChange: (axes: AxisRanges) => void;
  workflow: string;
  onWorkflowChange: (json: string) => void;
  /** currently selected parallax image — the source for both bakes */
  imageName: string | null;
  bake: BakeState;
  onBake: () => void;
  onClose: () => void;
}) {
  const copy = COPY[kind];
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [ping, setPing] = useState<BakeState>({ kind: "idle" });

  const busy = bake.kind === "running";
  const workflowValid = (() => {
    try {
      JSON.parse(workflow);
      return true;
    } catch {
      return false;
    }
  })();
  const hasToken = workflow.includes(IMAGE_TOKEN);
  // a variant bake with neither axis in the template renders the same cell
  // N times — worth catching before it burns N runs
  const hasAxis =
    workflow.includes(X_TOKEN) || workflow.includes(Y_TOKEN);

  const testConnection = async () => {
    setPing({ kind: "running" });
    try {
      setPing({ kind: "ok", msg: await comfyPing(url) });
    } catch (err) {
      setPing({ kind: "error", msg: String(err) });
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comfy-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="comfy-title">{copy.title}</h2>
          <button
            type="button"
            className="mode-btn"
            onClick={onClose}
            title="Schließen (Esc)"
          >
            Schließen
          </button>
        </div>

        <div className="comfy-row" role="group" aria-label="Was gebacken wird">
          <button
            type="button"
            className={`mode-btn ${kind === "depth" ? "active" : ""}`}
            onClick={() => onKindChange("depth")}
            aria-pressed={kind === "depth"}
            disabled={busy}
          >
            Tiefenkarte → Parallax
          </button>
          <button
            type="button"
            className={`mode-btn ${kind === "variants" ? "active" : ""}`}
            onClick={() => onKindChange("variants")}
            aria-pressed={kind === "variants"}
            disabled={busy}
          >
            Varianten → Morph-Grid
          </button>
        </div>

        <div className="comfy-field">
          <label className="set-field-label" htmlFor="comfy-url">
            ComfyUI-Adresse
          </label>
          <div className="comfy-row">
            <input
              id="comfy-url"
              className="src-select comfy-input"
              value={url}
              spellCheck={false}
              onChange={(e) => onUrlChange(e.target.value)}
              placeholder="http://127.0.0.1:8188"
            />
            <button
              type="button"
              className="mode-btn"
              onClick={() => void testConnection()}
              disabled={ping.kind === "running"}
            >
              {ping.kind === "running" ? "prüft…" : "Verbindung testen"}
            </button>
          </div>
          {ping.kind === "ok" && (
            <p className="set-hint comfy-ok">✓ {ping.msg}</p>
          )}
          {ping.kind === "error" && (
            <p className="set-hint comfy-err">{ping.msg}</p>
          )}
        </div>

        {kind === "variants" && (
          <div className="comfy-field">
            <span className="set-field-label">Raster und Achsen</span>
            <p className="set-hint">
              Jede Zelle ist ein eigener Lauf. <code>{X_TOKEN}</code> und{" "}
              <code>{Y_TOKEN}</code> im Workflow werden durch die Koordinaten
              der Zelle ersetzt — als blanke Zahl, also sowohl im Prompt
              (<code>(golden hour:{X_TOKEN})</code>) als auch direkt als
              Node-Eingang brauchbar. X ist im Morph-Grid die Klangfarbe,
              Y die Energie; Zeile 1 ist das untere Ende der Energieachse.
            </p>
            <div className="comfy-row">
              <label className="comfy-num">
                Raster
                <select
                  className="src-select"
                  value={axes.side}
                  onChange={(e) =>
                    onAxesChange({ ...axes, side: Number(e.target.value) })
                  }
                >
                  {GRID_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}×{n} = {n * n} Läufe
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ["X von", "xFrom"],
                  ["X bis", "xTo"],
                  ["Y von", "yFrom"],
                  ["Y bis", "yTo"],
                ] as const
              ).map(([label, key]) => (
                <label key={key} className="comfy-num">
                  {label}
                  <input
                    className="src-select"
                    type="number"
                    step="0.1"
                    value={axes[key]}
                    onChange={(e) =>
                      onAxesChange({
                        ...axes,
                        [key]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="comfy-field">
          <label className="set-field-label" htmlFor="comfy-workflow">
            {copy.label} (ComfyUI-API-Format)
          </label>
          <p className="set-hint">
            In ComfyUI über „Export (API)“ erzeugt. Der Platzhalter{" "}
            <code>{IMAGE_TOKEN}</code> markiert das Eingangsbild. {copy.hint}
          </p>
          <textarea
            id="comfy-workflow"
            className="comfy-textarea"
            value={workflow}
            spellCheck={false}
            rows={12}
            onChange={(e) => onWorkflowChange(e.target.value)}
          />
          <div className="comfy-row">
            <button
              type="button"
              className="mode-btn"
              onClick={() => onWorkflowChange(DEFAULT_WORKFLOW[kind])}
              disabled={workflow.trim() === DEFAULT_WORKFLOW[kind].trim()}
            >
              Auf Standard zurücksetzen
            </button>
            {!workflowValid && (
              <span className="set-hint comfy-err">kein gültiges JSON</span>
            )}
            {workflowValid && !hasToken && (
              <span className="set-hint comfy-err">
                Platzhalter {IMAGE_TOKEN} fehlt
              </span>
            )}
            {workflowValid && hasToken && kind === "variants" && !hasAxis && (
              <span className="set-hint comfy-err">
                Weder {X_TOKEN} noch {Y_TOKEN} im Workflow — alle Zellen
                würden gleich aussehen
              </span>
            )}
          </div>
        </div>

        <div className="comfy-field">
          <div className="comfy-row">
            <button
              type="button"
              className="mode-btn active"
              onClick={onBake}
              disabled={
                busy ||
                !imageName ||
                !workflowValid ||
                !hasToken ||
                (kind === "variants" && !hasAxis)
              }
              title={
                imageName
                  ? `${copy.button} — Quelle: ${imageName}`
                  : "Erst ein Bild in die Parallax-Szene laden"
              }
            >
              {busy ? "backt…" : copy.button}
            </button>
            <span className="set-hint">
              {imageName
                ? `Quellbild: ${imageName}`
                : "Kein Quellbild — erst „Bild +“ in der Parallax-Szene laden."}
            </span>
          </div>
          {bake.kind === "running" && (
            <p className="set-hint">
              {bake.msg ? `${bake.msg} · ` : ""}Der erste Durchlauf lädt das
              Modell von der Platte und kann eine Minute dauern.
            </p>
          )}
          {bake.kind === "ok" && (
            <p className="set-hint comfy-ok">✓ {bake.msg}</p>
          )}
          {bake.kind === "error" && (
            <p className="set-hint comfy-err comfy-pre">{bake.msg}</p>
          )}
        </div>
      </div>
    </div>
  );
}
