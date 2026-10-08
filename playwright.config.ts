import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

// PW_TARGET=static runs the same suite against the production build served by
// a plain static file server (no COOP/COEP headers). Default: Vite dev server.
const isStatic = process.env.PW_TARGET === "static";
const port = isStatic ? 4173 : 5173;

export default defineConfig({
  testDir: "tests/browser",
  outputDir: "test-results",
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: isStatic
      ? `deno run -A jsr:@std/http@1.0.19/file-server dist --host 127.0.0.1 --port ${port}`
      : `deno run -A npm:vite@8.3.3 --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
