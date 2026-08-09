import type { ModelMeta } from "./modelStore";
import { useDialogFocus } from "./useDialogFocus";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function LibraryModal({
  models,
  selectedId,
  onPick,
  onDelete,
  onAdd,
  onClose,
}: {
  models: ModelMeta[];
  selectedId: number | null;
  onPick: (id: number | null) => void;
  onDelete: (id: number) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="library-title">Modell-Library</h2>
          <button
            type="button"
            className="mode-btn"
            onClick={onClose}
            title="Schließen (Esc)"
            aria-label="Modell-Library schließen"
          >
            Schließen
          </button>
        </div>
        <div className="model-grid">
          <button
            type="button"
            className={`model-card ${selectedId == null ? "active" : ""}`}
            onClick={() => onPick(null)}
            title="Eingebauter Platzhalter"
            aria-pressed={selectedId == null}
          >
            <div className="model-thumb thumb-fallback" aria-hidden="true">
              3D
            </div>
            <div className="model-name">Platzhalter</div>
            <div className="model-size">eingebaut</div>
          </button>
          {models.map((m) => (
            <div
              key={m.id}
              className="model-card-shell"
            >
              <button
                type="button"
                className={`model-card ${selectedId === m.id ? "active" : ""}`}
                onClick={() => onPick(m.id)}
                aria-label={`${m.name} auswählen`}
                aria-pressed={selectedId === m.id}
              >
                {m.thumb ? (
                  <img className="model-thumb" src={m.thumb} alt="" />
                ) : (
                  <div className="model-thumb thumb-fallback" aria-hidden="true">
                    Vorschau
                  </div>
                )}
                <div className="model-name" title={m.name}>
                  {m.name}
                </div>
                <div className="model-size">{formatSize(m.size)}</div>
              </button>
              <button
                type="button"
                className="model-del"
                onClick={() => onDelete(m.id)}
                title="Aus der Library löschen"
                aria-label={`${m.name} löschen`}
              >
                Löschen
              </button>
            </div>
          ))}
          <button type="button" className="model-card add-card" onClick={onAdd}>
            <div className="model-thumb thumb-fallback" aria-hidden="true">
              Datei
            </div>
            <div className="model-name">Hinzufügen…</div>
            <div className="model-size">.glb / .gltf / .zip</div>
          </button>
        </div>
      </div>
    </div>
  );
}
