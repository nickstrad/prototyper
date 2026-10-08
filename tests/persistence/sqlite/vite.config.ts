import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone entry keeps R7 independent of shared playground ownership.
export default defineConfig({
  plugins: [react()],
  worker: { format: "iife" },
  build: {
    outDir: "dist-r7",
    rollupOptions: { input: "tests/persistence/sqlite/index.html" },
  },
});
