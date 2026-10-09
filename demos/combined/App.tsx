import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { TaskManagerApp } from "../../prototypes/task-manager/App.tsx";
import { taskManagerTerminal } from "../../prototypes/task-manager/commands.ts";
import { createShell } from "../../packages/terminal/shell.ts";
import { attachShell } from "../../packages/terminal/xterm-adapter.ts";
import { ApiExplorer } from "../../playground/api/ApiExplorer.tsx";
import { DatabaseEditor } from "../../packages/database-editor/DatabaseEditor.tsx";
import { type CombinedSession, openCombinedSession } from "./session.ts";
import "./style.css";

function TaskTerminal({ session }: { session: CombinedSession }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const commands = taskManagerTerminal(session.layer);
    const terminal = new Terminal({ cols: 80, rows: 12, fontSize: 14 });
    terminal.open(host.current!);
    const attached = attachShell(terminal, createShell(commands.commands), {
      banner: 'Task CLI · try: tasks create "Ship combined demo"\n',
    });
    return () => {
      attached.dispose();
      terminal.dispose();
      void commands.dispose();
    };
  }, [session]);
  return (
    <div
      className="terminal-scroll"
      data-testid="combined-terminal"
      ref={host}
    />
  );
}

export function CombinedApp() {
  const [session, setSession] = useState<CombinedSession>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    let owned: CombinedSession | undefined;
    openCombinedSession().then((opened) => {
      owned = opened;
      if (live) setSession(opened);
      else void opened.dispose();
    }, (e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
      void owned?.dispose();
    };
  }, []);

  return (
    <main>
      <header>
        <p className="eyebrow">Prototyper / Combined demo</p>
        <h1>One task. Four views.</h1>
        <p>
          Terminal, API, Application and Database share one live SQLite
          database.
        </p>
        <p>
          Data stays in this tab until reload. Reset restores the three seed
          tasks.
        </p>
      </header>
      <aside aria-label="Walkthrough">
        <h2>Try the round trip</h2>
        <ol>
          <li>
            In Terminal, run{" "}
            <code>tasks create "Ship combined demo"</code>. Note the returned ID
            (4 on a fresh page).
          </li>
          <li>
            In API, choose POST, enter <code>/tasks/4/complete</code>{" "}
            (use your ID), then Send.
          </li>
          <li>In Application, find the task with its checkbox checked.</li>
          <li>
            In the Database shell, run <code>.mode table</code>, then{" "}
            <code>SELECT id, title, completed FROM tasks WHERE id = 4;</code>.
            Expect completed = 1.
          </li>
        </ol>
        <p>
          Try a SQL update next: the Application reacts immediately. Run{" "}
          <code>tasks list --json</code> or GET <code>/tasks</code>{" "}
          to inspect the same rows.
        </p>
      </aside>
      {error && <p role="alert">Could not open the demo: {error}</p>}
      {!session && !error && <p role="status">Opening SQLite…</p>}
      {session && (
        <>
          <section aria-label="Terminal">
            <h2>Terminal</h2>
            <TaskTerminal session={session} />
          </section>
          <section aria-label="API">
            <h2>API</h2>
            <p>Requests run in this browser; no HTTP server is required.</p>
            <ApiExplorer layer={session.layer} />
          </section>
          <section aria-label="Application">
            <h2>Application</h2>
            <TaskManagerApp layer={session.layer} />
          </section>
          <section aria-label="Database">
            <h2>Database</h2>
            <div className="database-scroll">
              <DatabaseEditor
                binding={session.binding}
                title="Shared task database"
              />
            </div>
          </section>
        </>
      )}
    </main>
  );
}
