import { defineConfig } from "@playwright/test";
import process from "node:process";
import { resolve } from "node:path";
const staticTarget = process.env.PW_TARGET === "static";
const port = staticTarget ? 4300 : 5300;
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: resolve(process.cwd(), process.env.PW_OUT ?? "test-results-r11"),
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: staticTarget
      ? `/root/.deno/bin/deno run -A jsr:@std/http@1.0.19/file-server ${
        process.env.PW_DIST ?? "dist-r11"
      } --host 127.0.0.1 --port ${port}`
      : `/root/.deno/bin/deno run -A npm:vite@8.3.3 --config demos/api/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: process.cwd(),
    url: `http://127.0.0.1:${port}/demos/api/`,
    reuseExistingServer: false,
  },
});
