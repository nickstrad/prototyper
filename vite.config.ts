import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { demos } from "./demos/registry.ts";

// Split vendor chunks so the size of each dependency is visible in the build
// output and in docs/integrations.md.
const vendorChunk = (id: string): string | undefined => {
  for (const pkg of ["just-bash", "@xterm", "effect", "react-dom", "react"]) {
    if (id.includes(`/node_modules/${pkg}/`)) {
      return `vendor-${pkg.replace("@", "")}`;
    }
  }
};

export default defineConfig({
  plugins: [react()],
  // Classic (iife) workers: the engine worker loads the vendored Fiddle bundle
  // with importScripts(), which module workers do not support.
  worker: { format: "iife" },
  build: {
    outDir: process.env.PW_DIST ?? "dist",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: [
        "index.html",
        "demos/index.html",
        // Existing browser acceptance fixtures must also be plain static pages.
        "tests/native/browser.html",
        "tests/persistence/sqlite/index.html",
        "tests/transfer/index.html",
        ...demos.map((demo) => `demos/${demo.id}/index.html`),
      ],
      output: { manualChunks: vendorChunk },
    },
  },
});
