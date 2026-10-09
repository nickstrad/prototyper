import { defineConfig, devices } from "@playwright/test";
import process from "node:process";
const isStatic = process.env.PW_TARGET === "static";
const port = isStatic ? 4198 : 5198;
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 120_000,
  outputDir: process.env.PW_OUT ?? "test-results-r8",
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    cwd: process.cwd(),
    command: isStatic
      ? `/root/.deno/bin/deno run -A jsr:@std/http@1.0.19/file-server ${
        process.env.PW_DIST ?? "dist-r8"
      } --host 127.0.0.1 --port ${port}`
      : `/root/.deno/bin/deno run -A npm:vite@8.3.3 --config tests/transfer/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/tests/transfer/index.html`,
    reuseExistingServer: false,
  },
});
