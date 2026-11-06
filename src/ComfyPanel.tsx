import { useState } from "react";
import { useDialogFocus } from "./useDialogFocus";
import { DEFAULT_DEPTH_WORKFLOW, IMAGE_TOKEN, comfyPing } from "./comfy";

export type BakeState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; msg: string }
  | { kind: "error"; msg: string };

export function ComfyPanel({
  url,
  onUrlChange,
  workflow,
  onWorkflowChange,
  imageName,
  bake,
  onBake,
  onClose,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  workflow: string;
  onWorkflowChange: (json: string) => void;
  /** currently selected parallax image, or null when none is loaded */
  imageName: string | null;
  bake: BakeState;
  onBake: () => void;
  onClose: () => void;
}) {
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
          <h2 id="comfy-title">Tiefenkarte backen</h2>
          <button
            type="button"
            className="mode-btn"
            onClick={onClose}
            title="Schließen (Esc)"
          >
            Schließen
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
            Workflow (ComfyUI-API-Format)
          </label>
          <p className="set-hint">
            In ComfyUI über „Export (API)“ erzeugt. Der Platzhalter{" "}
            <code>{IMAGE_TOKEN}</code> markiert das Eingangsbild; die erste
            gespeicherte Ausgabe wird als Tiefenkarte übernommen. Der
            Standard-Workflow braucht die Custom Nodes{" "}
            <code>comfyui_controlnet_aux</code> — fehlen sie, tausch den
            mittleren Knoten gegen deinen eigenen Tiefen-Schätzer.
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
              onClick={() => onWorkflowChange(DEFAULT_DEPTH_WORKFLOW)}
              disabled={workflow.trim() === DEFAULT_DEPTH_WORKFLOW.trim()}
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
                  ? `Tiefenkarte für ${imageName} backen`
                  : "Erst ein Bild in die Parallax-Szene laden"
              }
            >
              {busy ? "backt…" : "Backen"}
            </button>
            <span className="set-hint">
              {imageName
                ? `Bild: ${imageName}`
                : "Kein Bild geladen — erst „Bild +“ in der Parallax-Szene."}
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
