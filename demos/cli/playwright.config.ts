import { defineConfig } from "@playwright/test";
import process from "node:process";
import { resolve } from "node:path";
const isStatic = process.env.PW_TARGET === "static";
const port = Number(process.env.PW_PORT ?? (isStatic ? 4199 : 5199));
const outputDir = resolve(
  process.cwd(),
  process.env.PW_OUT ?? "test-results-r10",
);
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 1000 },
  },
  webServer: {
    command: isStatic
      ? `/root/.deno/bin/deno run -A jsr:@std/http@1.0.19/file-server ${
        process.env.PW_DIST ?? "dist-r10"
      } --host 127.0.0.1 --port ${port}`
      : `/root/.deno/bin/deno run -A npm:vite@8.3.3 --config demos/cli/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "../..",
    url: `http://127.0.0.1:${port}/demos/cli/`,
    reuseExistingServer: false,
  },
});
