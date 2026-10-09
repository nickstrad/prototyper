import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

const staticTarget = process.env.PW_TARGET === "static";
const port = staticTarget ? 4302 : 5302;
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: `../../${process.env.PW_OUT ?? "test-results-r13"}`,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: staticTarget
      ? `/root/.deno/bin/deno run -A jsr:@std/http@1.0.19/file-server ${
        process.env.PW_DIST ?? "dist-r13"
      } --host 127.0.0.1 --port ${port}`
      : `/root/.deno/bin/deno run -A npm:vite@8.3.3 --config demos/combined/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "../..",
    url: `http://127.0.0.1:${port}/demos/combined/`,
    reuseExistingServer: false,
  },
});
