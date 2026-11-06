import { useState } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { DEFAULT_WORKFLOW, IMAGE_TOKEN, comfyPing, type BakeKind } from "./comfy";

export type BakeState =
  | { kind: "idle" }
  | { kind: "running" }
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
    label: "Workflow — Varianten",
    hint:
      "Alle gespeicherten Ausgaben werden in ihrer Reihenfolge zu einem Morph-Satz. " +
      "Der Standard kommt mit Core Nodes aus (RepeatLatentBatch + img2img bei " +
      "denoise 0.45): neun Varianten, die sich die Komposition teilen. Die " +
      "Reihenfolge ist dabei allerdings beliebig — für Achsen, die wirklich " +
      "etwas bedeuten, muss pro Ausgabe ein Prompt- oder IP-Adapter-Gewicht " +
      "variieren. Passe ckpt_name an ein Checkpoint an, das du hast.",
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
  imageName,
  bake,
  onBake,
  onClose,
}: {
  kind: BakeKind;
  onKindChange: (kind: BakeKind) => void;
  url: string;
  onUrlChange: (url: string) => void;
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
          </div>
        </div>

        <div className="comfy-field">
          <div className="comfy-row">
            <button
              type="button"
              className="mode-btn active"
              onClick={onBake}
              disabled={busy || !imageName || !workflowValid || !hasToken}
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
              Läuft. Der erste Durchlauf lädt das Modell von der Platte und
              kann eine Minute dauern.
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
