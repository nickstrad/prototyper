import { defineConfig } from "@playwright/test";
import process from "node:process";
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  workers: 1,
  outputDir: process.env.PW_OUT ?? "/tmp/r12-playwright",
  timeout: 120_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5301", trace: "retain-on-failure" },
  webServer: {
    command:
      "/root/.deno/bin/deno run -A npm:vite@8.3.3 --host 127.0.0.1 --port 5301 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:5301",
    reuseExistingServer: false,
  },
});
