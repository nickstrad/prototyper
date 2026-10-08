// Shared helpers for the R4 browser suites: page problems, worker counting,
// live listener counting, and the hooks the playground publishes.
//
// Listener counting tracks DISTINCT live registrations on window and
// document (target + type + listener identity + capture), installed before
// any app script runs. A removeEventListener that matches nothing does not
// count, so repeated removals cannot mask growth; a leak shows as a count
// that keeps rising across close/reopen cycles. `{ once: true }` listeners
// are released when they fire (companion listener); listeners removed only
// through an AbortSignal stay counted, which can over-count (a visible false
// failure), never hide a leak.
import { expect, type Page } from "@playwright/test";

export function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

export type ListenerCounts = { window: number; document: number };

/** Installs live-listener accounting before the app loads. */
export const installListenerCounter = (page: Page) =>
  page.addInitScript(() => {
    const ids = new WeakMap<object, number>();
    let nextId = 1;
    const idOf = (listener: unknown): string => {
      if (
        typeof listener !== "function" &&
        (typeof listener !== "object" || listener === null)
      ) {
        return "null";
      }
      let id = ids.get(listener as object);
      if (!id) {
        id = nextId++;
        ids.set(listener as object, id);
      }
      return String(id);
    };
    const live = { window: new Set<string>(), document: new Set<string>() };
    const bucket = (t: EventTarget) =>
      t === globalThis
        ? live.window
        : t === globalThis.document
        ? live.document
        : null;
    const captureOf = (o: unknown) =>
      typeof o === "boolean"
        ? o
        : Boolean((o as { capture?: boolean } | undefined)?.capture);
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: unknown,
      options?: unknown,
    ) {
      const key = `${type}|${idOf(listener)}|${captureOf(options)}`;
      const b = bucket(this);
      if (b) {
        b.add(key);
        // `{ once: true }` registrations remove themselves when they fire and
        // never reach removeEventListener: a companion once-listener on the
        // same event releases the key at that moment, so a once-listener that
        // never fires stays counted (a leak), and one that fired does not.
        const once = typeof options === "object" && options !== null &&
          (options as { once?: boolean }).once === true;
        if (once) {
          add.call(this, type, () => b.delete(key), {
            once: true,
            capture: captureOf(options),
          });
        }
      }
      return add.call(
        this,
        type,
        listener as EventListener,
        options as boolean,
      );
    };
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: unknown,
      options?: unknown,
    ) {
      bucket(this)?.delete(`${type}|${idOf(listener)}|${captureOf(options)}`);
      return remove.call(
        this,
        type,
        listener as EventListener,
        options as boolean,
      );
    };
    (globalThis as unknown as { __liveListeners: () => ListenerCounts })
      .__liveListeners = () => ({
        window: live.window.size,
        document: live.document.size,
      });
  });

export const listenerCounts = (page: Page): Promise<ListenerCounts> =>
  page.evaluate(() =>
    (globalThis as unknown as {
      __liveListeners: () => { window: number; document: number };
    })
      .__liveListeners()
  );

/** Listener counts once they have stopped changing for `quietMs`. */
export async function stableListenerCounts(
  page: Page,
  quietMs = 400,
): Promise<ListenerCounts> {
  let last = await listenerCounts(page);
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(quietMs);
    const next = await listenerCounts(page);
    if (next.window === last.window && next.document === last.document) {
      return next;
    }
    last = next;
  }
  return last;
}

export const workers = (page: Page) => page.workers().length;

type Hooks = {
  __playground?: {
    r4?: {
      generation: number;
      editor(): {
        submit(l: string): Promise<void>;
        screen(): string;
        idle(): Promise<void>;
        visible(): boolean;
        toggle(): void;
      } | undefined;
      tasksPanelVisible(): boolean;
      toggleTasksPanel(): void;
    };
    d1?: { events: readonly unknown[] };
    r1?: { loads(): number };
    r3?: {
      call(
        m: string,
        p: string,
        b?: string,
      ): Promise<{ status: number; body: string }>;
    };
  };
  __playgroundLifecycle?: {
    generation(): number;
    isOpen(): boolean;
    close(): void;
    reopen(): void;
  };
};

/** Waits until every panel of the current instance has published its hooks. */
export async function instanceReady(page: Page) {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as Hooks;
      return Boolean(
        w.__playground?.r4 && w.__playground.d1 && w.__playground.r1 &&
          w.__playground.r3,
      );
    },
    undefined,
    { timeout: 60_000 },
  );
  await expect(page.getByTestId("r1-status")).toContainText("loads", {
    timeout: 60_000,
  });
}

export const generation = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as Hooks).__playgroundLifecycle!.generation()
  );

export const r1Loads = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as Hooks).__playground!.r1!.loads()
  );

export const d1Events = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as Hooks).__playground!.d1!.events.length
  );

export const apiCall = (
  page: Page,
  method: string,
  path: string,
  body?: string,
) =>
  page.evaluate(
    ([m, p, b]) =>
      (globalThis as unknown as Hooks).__playground!.r3!.call(m, p, b),
    [method, path, body] as const,
  );
