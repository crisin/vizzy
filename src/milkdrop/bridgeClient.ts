// Frontend half of the dev bridge (src-tauri/src/bridge.rs): answers the
// commands the HTTP server forwards and keeps `GET /state` current.
//
// The app registers its hooks once (`setBridgeHooks`); the bridge itself is
// switched by the `dev.bridge` parameter and follows it within a second.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { params } from "../params";
import { presetStore } from "./presetStore";
import { probe } from "./remix";
import { compose, sanitize } from "./vpreset";

const inTauri = "__TAURI_INTERNALS__" in window;

export type BridgeHooks = {
  /** what is on screen, for GET /state */
  state: () => Record<string, unknown>;
  /** play a preset key in the main picture */
  play: (key: string) => void;
  resolve: (key: string) => unknown | null;
  /** the main Milkdrop canvas (2D output of Butterchurn) */
  canvas: () => HTMLCanvasElement | null;
};

let hooks: BridgeHooks | null = null;
let running = false;
let info: { port: number; token: string; file: string } | null = null;
const listeners = new Set<() => void>();

export function setBridgeHooks(h: BridgeHooks) {
  hooks = h;
}

export function bridgeInfo() {
  return running ? info : null;
}

export function onBridgeChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type Command = { id: number; kind: string; body: Record<string, unknown> };

/** A preset in the request body: a key, a Vizzy preset or Butterchurn JSON. */
function presetFromBody(body: Record<string, unknown>): { json: unknown | null; error?: string } {
  if (!hooks) return { json: null, error: "app not ready" };
  if (typeof body.key === "string") {
    const json = hooks.resolve(body.key);
    return json ? { json } : { json: null, error: `unknown preset key: ${body.key}` };
  }
  const p = body.preset;
  if (!p || typeof p !== "object") return { json: null, error: "body needs `key` or `preset`" };
  const vp = sanitize(p);
  if (vp && (p as { format?: string }).format === "vizzy-preset") {
    const json = compose(vp, (k) => hooks!.resolve(k));
    return json ? { json } : { json: null, error: `base or part reference does not resolve (base: ${vp.base})` };
  }
  return { json: p };
}

async function handle(cmd: Command): Promise<unknown> {
  if (!hooks) return { error: "app not ready" };
  const body = cmd.body ?? {};
  switch (cmd.kind) {
    case "preview": {
      const { json, error } = presetFromBody(body);
      if (!json) return { ok: false, error };
      const r = await probe(json);
      return { ok: r.ok, reason: r.reason, errors: r.errors ?? "", image: r.thumb };
    }
    case "load": {
      if (typeof body.key === "string") {
        if (!hooks.resolve(body.key)) return { ok: false, error: `unknown preset key: ${body.key}` };
        hooks.play(body.key);
        return { ok: true, key: body.key };
      }
      const vp = sanitize(body.preset);
      if (!vp) return { ok: false, error: "body needs `key` or a Vizzy `preset` (format vizzy-preset)" };
      await presetStore.save(vp);
      hooks.play(`user:${vp.name}`);
      return { ok: true, key: `user:${vp.name}` };
    }
    case "save": {
      const vp = sanitize(body.preset);
      if (!vp) return { ok: false, error: "body needs a Vizzy `preset`" };
      await presetStore.save(vp);
      return { ok: true, key: `user:${vp.name}` };
    }
    case "screenshot": {
      const c = hooks.canvas();
      if (!c) return { ok: false, error: "no canvas" };
      return { ok: true, image: c.toDataURL("image/webp", 0.85) };
    }
    default:
      return { error: `unknown command ${cmd.kind}` };
  }
}

async function start() {
  info = await invoke<{ port: number; token: string; file: string }>("bridge_start");
  running = true;
  for (const fn of listeners) fn();
}

async function stop() {
  await invoke("bridge_stop").catch(() => {});
  running = false;
  info = null;
  for (const fn of listeners) fn();
}

if (inTauri) {
  void listen<Command>("bridge-command", async (ev) => {
    let out: unknown;
    try {
      out = await handle(ev.payload);
    } catch (e) {
      out = { ok: false, error: String(e) };
    }
    await invoke("bridge_reply", { id: ev.payload.id, json: JSON.stringify(out) });
  });

  window.setInterval(() => {
    const want = params.get("dev", "bridge") >= 0.5;
    if (want && !running) void start().catch((e) => console.error("[bridge]", e));
    else if (!want && running) void stop();
    if (running && hooks) {
      void invoke("bridge_set_state", { json: JSON.stringify(hooks.state()) }).catch(() => {});
    }
  }, 1000);
}
