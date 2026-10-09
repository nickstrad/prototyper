import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  cacheDir: "/tmp/prototyper-r10-vite",
  optimizeDeps: { entries: ["demos/cli/index.html"] },
  worker: { format: "iife" },
  build: {
    outDir: "dist-r10",
    rollupOptions: { input: "demos/cli/index.html" },
  },
});
