import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Split vendor chunks so the size of each dependency is visible in build output.
const vendorChunk = (id: string): string | undefined => {
  for (const pkg of ["just-bash", "@xterm", "effect", "react-dom", "react"]) {
    if (id.includes(`/node_modules/${pkg}/`)) {
      return `vendor-${pkg.replace("@", "")}`;
    }
  }
};

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
});
