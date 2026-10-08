import { defineConfig } from "vite";

// No COOP/COEP headers on purpose: the POC proves the mvp/eh bundles work
// without cross-origin isolation. Set COI=1 to add them for comparison.
const coi = process.env.COI === "1"
  ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
  : {};

export default defineConfig({
  server: { headers: coi },
  preview: { headers: coi },
  // duckdb packages are ESM and load ?url assets; their CJS xterm deps must be prebundled.
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm", "@duckdb/duckdb-wasm-shell"],
    include: ["xterm", "xterm-addon-fit", "xterm-addon-web-links", "xterm-addon-webgl", "apache-arrow"],
  },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
