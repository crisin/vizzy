import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** Build identity, baked into the bundle so every build can be told apart:
 *  the version from package.json (which has to match tauri.conf.json, or the
 *  installer would carry a different number than the app), the commit count
 *  as a monotonically growing build number, the short hash, and whether the
 *  tree had uncommitted changes. */
function buildInfo() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };
  const tauri = JSON.parse(
    readFileSync("src-tauri/tauri.conf.json", "utf8"),
  ) as { version: string };
  if (pkg.version !== tauri.version) {
    throw new Error(
      `Version mismatch: package.json says ${pkg.version}, ` +
        `src-tauri/tauri.conf.json says ${tauri.version}. Keep them equal.`,
    );
  }
  const commit = git("rev-parse --short HEAD") || "nogit";
  const count = git("rev-list --count HEAD") || "0";
  const dirty = git("status --porcelain").length > 0;
  return {
    version: pkg.version,
    build: Number(count),
    commit: dirty ? `${commit}+dirty` : commit,
    builtAt: new Date().toISOString(),
  };
}

/**
 * Butterchurn compiles preset equations to WASM (eel-wasm) and converts
 * float→int with `i32.trunc_f64_s`, which *traps* on NaN or out-of-range
 * values ("float unrepresentable in integer range"). Original Milkdrop casts
 * in C and just carries on, and plenty of presets rely on that — a physics
 * sim whose state has gone NaN would otherwise trap on every frame until it
 * is reloaded. This swaps the opcode for the saturating `i32.trunc_sat_f64_s`
 * (0xfc 0x02: NaN → 0, overflow clamped), which every WebView we target
 * supports. The count is asserted so a Butterchurn update that moves the
 * emission sites fails the build instead of silently reviving the traps.
 */
function butterchurnSaturatingTrunc() {
  const needle = "encoding_1.op.i32_trunc_f64_s,";
  const expected = 4;
  return {
    name: "vizzy:butterchurn-saturating-trunc",
    transform(code: string, id: string) {
      const file = id.replace(/\\/g, "/").split("?")[0];
      if (!file.endsWith("/node_modules/butterchurn/dist/butterchurn.js")) {
        return null;
      }
      const count = code.split(needle).length - 1;
      if (count !== expected) {
        throw new Error(
          `butterchurn: expected ${expected} i32.trunc_f64_s emission sites, ` +
            `found ${count} — check the patch in vite.config.ts against this ` +
            `Butterchurn version`,
        );
      }
      return {
        code: code.replaceAll(needle, "0xfc, 0x02, /* i32.trunc_sat_f64_s */"),
        map: null,
      };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), butterchurnSaturatingTrunc()],

  // Pre-bundled deps bypass plugin transforms, and the patch above has to
  // apply in `tauri dev` too. The dist is a self-contained ES module.
  optimizeDeps: { exclude: ["butterchurn"] },

  define: {
    __VIZZY_BUILD__: JSON.stringify(buildInfo()),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
