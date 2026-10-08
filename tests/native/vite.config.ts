// Isolated production import test; never builds other prototype slices.
import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "iife" },
  build: {
    outDir: "dist-r9",
    rollupOptions: { input: "tests/native/browser.html" },
  },
});
