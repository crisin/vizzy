import { useEffect, useReducer, useState } from "react";
import { GROUP_LABELS, PARAM_SCHEMAS } from "./params";
import { routing } from "./listeners";

const TARGETS: { value: string; label: string }[] = Object.entries(
  PARAM_SCHEMAS,
).flatMap(([group, defs]) =>
  defs.map((d) => ({
    value: `${group}.${d.key}`,
    label: `${GROUP_LABELS[group] ?? group}: ${d.label}`,
  })),
);

export function RoutingModal({ onClose }: { onClose: () => void }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [meters, setMeters] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    const t = window.setInterval(() => {
      setMeters(new Map(routing.values));
    }, 100);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal routing-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Frequenz-Listener & Routing</span>
          <button className="mode-btn" onClick={onClose} title="Schließen (Esc)">
            ✕
          </button>
        </div>

        <div className="editor-group-head">
          <span>Listener</span>
          <button
            className="mode-btn editor-reset"
            onClick={() => {
              routing.addListener();
              bump();
            }}
          >
            + Listener
          </button>
        </div>
        {routing.listeners.map((l) => (
          <div key={l.id} className="routing-row">
            <input
              className="routing-name"
              value={l.name}
              onChange={(e) => {
                l.name = e.target.value;
                routing.save();
                bump();
              }}
            />
            <label>
              von
              <input
                type="number"
                className="routing-hz"
                min={20}
                max={20000}
                value={l.from}
                onChange={(e) => {
                  l.from = Number(e.target.value) || 20;
                  routing.save();
                  bump();
                }}
              />
            </label>
            <label>
              bis
              <input
                type="number"
                className="routing-hz"
                min={20}
                max={20000}
                value={l.to}
                onChange={(e) => {
                  l.to = Number(e.target.value) || 20;
                  routing.save();
                  bump();
                }}
              />
              Hz
            </label>
            <label>
              Gain
              <input
                type="range"
                min={0.2}
                max={4}
                step={0.1}
                value={l.gain}
                onChange={(e) => {
                  l.gain = Number(e.target.value);
                  routing.save();
                  bump();
                }}
              />
            </label>
            <div className="routing-meter" title="Live-Pegel">
              <div
                className="routing-meter-fill"
                style={{
                  width: `${Math.min(100, (meters.get(l.id) ?? 0) * 100)}%`,
                }}
              />
            </div>
            <button
              className="model-del routing-del"
              onClick={() => {
                routing.removeListener(l.id);
                bump();
              }}
              title="Listener löschen"
            >
              ✕
            </button>
          </div>
        ))}

        <div className="editor-group-head routing-section">
          <span>Zuordnungen</span>
          <button
            className="mode-btn editor-reset"
            onClick={() => {
              routing.addAssignment();
              bump();
            }}
          >
            + Zuordnung
          </button>
        </div>
        {routing.assignments.length === 0 && (
          <div className="routing-hint">
            Noch keine Zuordnungen — leg eine an und route z.B. „Bass" auf
            „Radial: Radius".
          </div>
        )}
        {routing.assignments.map((a) => (
          <div key={a.id} className="routing-row">
            <select
              className="src-select routing-select"
              value={a.listenerId}
              onChange={(e) => {
                a.listenerId = Number(e.target.value);
                routing.save();
                bump();
              }}
            >
              {routing.listeners.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <span className="routing-arrow">→</span>
            <select
              className="src-select routing-select routing-target"
              value={`${a.group}.${a.key}`}
              onChange={(e) => {
                const [group, key] = e.target.value.split(".");
                a.group = group;
                a.key = key;
                routing.save();
                bump();
              }}
            >
              {TARGETS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <label>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={a.amount}
                onChange={(e) => {
                  a.amount = Number(e.target.value);
                  routing.save();
                  bump();
                }}
              />
              <span className="editor-value">
                {(a.amount * 100).toFixed(0)}%
              </span>
            </label>
            <button
              className="model-del routing-del"
              onClick={() => {
                routing.removeAssignment(a.id);
                bump();
              }}
              title="Zuordnung löschen"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
