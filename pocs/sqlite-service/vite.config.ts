import { defineConfig } from "vite";

// COI=1 adds COOP/COEP to the dev/preview server (needed only for the "opfs"/"opfs-wl" VFS).
const coi = process.env.COI === "1"
  ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
  : {};

export default defineConfig({
  server: { headers: coi },
  preview: { headers: coi },
  // NO_EXCLUDE=1 is only for the POC experiment that shows why the exclude is needed.
  optimizeDeps: { exclude: process.env.NO_EXCLUDE === "1" ? [] : ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { target: "es2022" },
});
