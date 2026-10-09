import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "iife" },
  build: {
    outDir: "dist-r13",
    rollupOptions: { input: "demos/combined/index.html" },
  },
});
