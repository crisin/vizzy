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

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

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
