import type { ModelMeta } from "./modelStore";

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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Modell-Library</span>
          <button className="mode-btn" onClick={onClose} title="Schließen (Esc)">
            ✕
          </button>
        </div>
        <div className="model-grid">
          <button
            className={`model-card ${selectedId == null ? "active" : ""}`}
            onClick={() => onPick(null)}
            title="Eingebauter Platzhalter"
          >
            <div className="model-thumb thumb-fallback">🌭</div>
            <div className="model-name">Platzhalter</div>
            <div className="model-size">eingebaut</div>
          </button>
          {models.map((m) => (
            <div
              key={m.id}
              className={`model-card ${selectedId === m.id ? "active" : ""}`}
              onClick={() => onPick(m.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") onPick(m.id);
              }}
            >
              {m.thumb ? (
                <img className="model-thumb" src={m.thumb} alt={m.name} />
              ) : (
                <div className="model-thumb thumb-fallback">▦</div>
              )}
              <div className="model-name" title={m.name}>
                {m.name}
              </div>
              <div className="model-size">{formatSize(m.size)}</div>
              <button
                className="model-del"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(m.id);
                }}
                title="Aus der Library löschen"
              >
                ✕
              </button>
            </div>
          ))}
          <button className="model-card add-card" onClick={onAdd}>
            <div className="model-thumb thumb-fallback">＋</div>
            <div className="model-name">Hinzufügen…</div>
            <div className="model-size">.glb / .gltf / .zip</div>
          </button>
        </div>
      </div>
    </div>
  );
}
