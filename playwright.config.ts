import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

// PW_TARGET=static runs the suite against the production build served by a
// plain static file server (no COOP/COEP headers). Default: Vite dev server.
// Concurrent builders (plan.md §5) get their own port and output directory via
// PW_PORT / PW_OUT so two runs never share a server or clobber artifacts.
const isStatic = process.env.PW_TARGET === "static";
const port = Number(process.env.PW_PORT ?? (isStatic ? 4173 : 5173));
const outputDir = process.env.PW_OUT ?? "test-results";
// PW_DIST lets a builder serve its own `vite build --outDir <dir>` output.
const dist = process.env.PW_DIST ?? "dist";

export default defineConfig({
  // Every `*.spec.ts` under tests/ (tests/browser, tests/database, ...).
  testDir: "tests",
  outputDir,
  fullyParallel: true,
  // Dev-server runs transform on demand while several pages each start
  // Fiddle workers; 30 s timed out under that load (Wave 1 integration).
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: isStatic
      ? `deno run -A jsr:@std/http@1.0.19/file-server ${dist} --host 127.0.0.1 --port ${port}`
      : `deno run -A npm:vite@8.3.3 --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
