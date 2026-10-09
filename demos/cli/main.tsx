import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";
import { browserSqliteLayer } from "../../packages/database/sqlite-browser.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { spawnEngineWorker } from "../../packages/database/worker-client.ts";
import { DatabaseEditor } from "../../packages/database-editor/DatabaseEditor.tsx";
import {
  makeSqliteShellBinding,
  openScope,
} from "../../packages/database-editor/sqlite-shell.ts";
import type { MountedShellBinding } from "../../packages/database-editor/types.ts";
import { createShell } from "../../packages/terminal/shell.ts";
import { attachShell } from "../../packages/terminal/xterm-adapter.ts";
import { commands } from "./commands.ts";
import { schema, seed } from "./schema.ts";
import { config } from "./config.ts";
import "./style.css";

function fitTerminal(term: Terminal) {
  const container = term.element?.parentElement;
  const screen = term.element?.querySelector(".xterm-screen");
  if (!container || !screen) return;
  const cellWidth = screen.getBoundingClientRect().width / term.cols;
  const style = getComputedStyle(container);
  const width = container.clientWidth - parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight) - 16;
  if (cellWidth > 0) {
    term.resize(Math.max(20, Math.floor(width / cellWidth)), term.rows);
  }
}

function App() {
  const host = useRef<HTMLDivElement>(null);
  const [binding, setBinding] = useState<MountedShellBinding>();
  const [status, setStatus] = useState("Opening SQLite…");
  useEffect(() => {
    const client = spawnEngineWorker({ name: "inventory" });
    const runtime = ManagedRuntime.make(
      Layer.orDie(
        browserSqliteLayer({
          client,
          schema,
          seed,
          persistence: config.persistence,
        }),
      ),
    );
    const scope = openScope();
    const term = new Terminal({ cols: 90, rows: 14, fontSize: 14 });
    term.open(host.current!);
    const resize = new ResizeObserver(() => fitTerminal(term));
    resize.observe(host.current!);
    const session = attachShell(term, createShell(commands(runtime)), {
      banner: "Try: inventory list | jq .\n",
    });
    let live = true;
    Promise.all([runtime.runPromise(Effect.service(Database)), client.ready])
      .then(async ([service, info]) => {
        if (!live) return;
        const shellBinding = await Effect.runPromise(
          Scope.provide(scope.scope)(
            makeSqliteShellBinding({
              client,
              info,
              service,
              terminal: { cols: 70, rows: 12 },
            }),
          ),
        );
        if (live) {
          setBinding(shellBinding);
          setStatus(
            `SQLite ${service.version} · memory · reload restores the seed`,
          );
        }
      }).catch((e) => {
        if (live) setStatus(`Unable to open inventory: ${String(e)}`);
      });
    return () => {
      live = false;
      resize.disconnect();
      session.dispose();
      term.dispose();
      void scope.close().then(() => runtime.dispose()).finally(() =>
        client.terminate()
      );
    };
  }, []);
  useEffect(() => {
    if (!binding) return;
    const resize = new ResizeObserver(() => {
      if (binding.terminal) fitTerminal(binding.terminal);
    });
    const frame = requestAnimationFrame(() => {
      const container = binding.terminal?.element?.parentElement;
      if (container) resize.observe(container);
    });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [binding]);
  return (
    <main>
      <header>
        <p className="eyebrow">PROTOTYPER / CLI DEMO</p>
        <h1>Inventory</h1>
        <p>Add stock, pipe JSON, and inspect the same SQLite database.</p>
        <p role="status">{status}</p>
      </header>
      <section aria-label="Terminal">
        <h2>Terminal</h2>
        <p>
          <code>inventory add washer "Wide washer" 4</code>
          <br />
          <code>inventory list | jq '.[].name'</code>
          <br />
          <code>inventory remove washer</code>
        </p>
        <div ref={host} data-testid="inventory-terminal" className="terminal" />
      </section>
      <section aria-label="Database">
        <h2>Database</h2>
        <p>
          Write SQL in the SQLite shell below, then read it with{" "}
          <code>inventory list</code> above.
        </p>
        {binding && (
          <DatabaseEditor binding={binding} title="SQLite inventory" />
        )}
      </section>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
// The browser suite uses this same-document hook to exercise React teardown.
(window as Window & { __r10Unmount?: () => void }).__r10Unmount = () =>
  root.unmount();
