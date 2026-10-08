// Shared helpers for the DB0 DatabaseEditor suite. Everything typed into the
// console goes through xterm.js keystrokes (page.keyboard), so the shell sees
// what a user would type; evidence files hold the real terminal buffer.
import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import type {} from "../../packages/database-editor/sqlite-shell-workbench.tsx";

export const target = process.env.PW_TARGET ?? "dev";
export const outDir = process.env.PW_OUT ?? "test-results";
export const evidenceDir = `${outDir}/db0-evidence`;

export const MAIN_PROMPT = "SQLite-3.54 fiddle.sqlite3-> ";
export const CONTINUATION_PROMPT = "   ...> ";

export function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

/** Waits for the DB0 workbench runtime and the mounted console. */
export async function openEditor(page: Page) {
  await page.goto("/");
  await expect.poll(
    () => page.evaluate(() => Boolean(globalThis.window.__db0)),
    { timeout: 30_000 },
  ).toBe(true);
  await expect(page.getByTestId("db-console").locator(".xterm")).toBeVisible();
  await expect.poll(() => screen(page)).toContain(MAIN_PROMPT);
  await page.getByTestId("db-console").locator(".xterm").click();
}

export const screen = (page: Page) =>
  page.evaluate(() => globalThis.window.__db0!.binding.screen());

/** Waits until no shell submission and no change detection is in flight. */
export const idle = (page: Page) =>
  page.evaluate(async () => {
    const hooks = globalThis.window.__db0!;
    await hooks.binding.idle();
    await hooks.service.idle();
  });

/** Types one line into the console, presses Enter and waits for the prompt. */
export async function typeLine(page: Page, line: string) {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
  await idle(page);
}

/**
 * Terminal text after the last occurrence of `marker` that ends a line the
 * user typed (a line starting with the main or continuation prompt), so a
 * shell error echo such as "  SELEC 1;" never matches.
 */
export const after = (text: string, marker: string) => {
  let i = text.lastIndexOf(marker);
  while (i >= 0) {
    const lineStart = text.lastIndexOf("\n", i - 1) + 1;
    const line = text.slice(lineStart, i + marker.length);
    if (line.startsWith(MAIN_PROMPT) || line.startsWith(CONTINUATION_PROMPT)) {
      return text.slice(i + marker.length);
    }
    i = i > 0 ? text.lastIndexOf(marker, i - 1) : -1;
  }
  return "";
};

export function saveEvidence(name: string, content: string) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/${name}`, content);
}

export const screenshot = (page: Page, name: string) =>
  page.screenshot({
    path: `${evidenceDir}/${name}-${target}.png`,
    fullPage: true,
  });
