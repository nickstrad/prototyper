import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.config.ts";
export default mergeConfig(
  base,
  defineConfig({
    optimizeDeps: { entries: ["demos/api/index.html"] },
    build: {
      outDir: "dist-r11",
      rollupOptions: { input: "demos/api/index.html" },
    },
  }),
);
