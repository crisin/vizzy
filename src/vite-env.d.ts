/// <reference types="vite/client" />

/** Injected by `define` in vite.config.ts at build time. */
declare const __VIZZY_BUILD__: {
  /** From package.json, equal to tauri.conf.json (the build checks). */
  version: string;
  /** Commit count on HEAD — grows with every commit, so no two builds from
   *  different commits share it. */
  build: number;
  /** Short hash, with `+dirty` when the tree had uncommitted changes. */
  commit: string;
  /** ISO timestamp of the bundle. */
  builtAt: string;
};
