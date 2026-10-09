import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Effect, Fiber, Scope, Stream } from "effect";
import type { DatabaseChange } from "../../packages/core/types.ts";
import { DatabaseEditor } from "../../packages/database-editor/DatabaseEditor.tsx";
import { openScope } from "../../packages/database-editor/sqlite-shell.ts";
import { type Note, notesApplication } from "./application.ts";
import { openNotes } from "./runtime.ts";
import "./style.css";

type Session = Effect.Success<typeof openNotes>;
function App() {
  const [session, setSession] = useState<Session>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [tab, setTab] = useState("Application");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<number>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    const scope = openScope();
    let live = true;
    let watcher: Fiber.Fiber<unknown, unknown> | undefined;
    let resetWatcher: Fiber.Fiber<unknown, unknown> | undefined;
    void Effect.runPromise(Scope.provide(scope.scope)(openNotes)).then(
      (value) => {
        if (!live) return;
        setSession(value);
        watcher = Effect.runFork(
          notesApplication(value.service).watch((rows) => {
            if (live) {
              setNotes(rows);
              setLoads((n) => n + 1);
              setError("");
            }
          }, (e) => {
            if (live) setError(String(e));
          }),
        );
        resetWatcher = Effect.runFork(
          Stream.runForEach((change: DatabaseChange) =>
            Effect.sync(() => {
              if (live && change.kind === "reset") {
                setEditing(undefined);
                setBody("");
              }
            })
          )(value.service.changes),
        );
      },
      (e) => {
        if (live) setError(String(e));
      },
    );
    return () => {
      live = false;
      void (async () => {
        if (watcher) await Effect.runPromise(Fiber.interrupt(watcher));
        if (resetWatcher) {
          await Effect.runPromise(Fiber.interrupt(resetWatcher));
        }
        await scope.close();
      })();
    };
  }, []);
  const app = session && notesApplication(session.service);
  const act = async (
    operation: Effect.Effect<unknown, unknown>,
    done?: () => void,
  ) => {
    setBusy(true);
    try {
      await Effect.runPromise(operation);
      setError("");
      done?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main>
      <header>
        <p className="eyebrow">PROTOTYPER / WEB DEMO</p>
        <h1>Notes</h1>
        <p>A small notebook. One SQLite database.</p>
        <button
          type="button"
          disabled={!app || busy}
          onClick={() =>
            app && void act(app.reset(), () => {
              setEditing(undefined);
              setBody("");
            })}
        >
          Reset notes
        </button>
      </header>
      <nav aria-label="Views">
        {["Application", "Database"].map((view) => (
          <button
            type="button"
            key={view}
            aria-pressed={tab === view}
            onClick={() => setTab(view)}
          >
            {view}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {!session && !error && <p>Opening SQLite…</p>}
      <section hidden={tab !== "Application"} aria-label="Application">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (app) {
              void act(
                editing === undefined
                  ? app.create(body)
                  : app.edit(editing, body),
                () => {
                  setBody("");
                  setEditing(undefined);
                },
              );
            }
          }}
        >
          <label htmlFor="body">
            {editing === undefined ? "New note" : "Edit note"}
          </label>
          <textarea
            id="body"
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="actions">
            <button type="submit" disabled={!app || busy || !body.trim()}>
              {editing === undefined ? "Create note" : "Save note"}
            </button>
            {editing !== undefined && (
              <button
                type="button"
                onClick={() => {
                  setEditing(undefined);
                  setBody("");
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
        <ul>
          {notes.map((note) => (
            <li key={note.id} data-testid={`note-${note.id}`}>
              <small>NOTE {note.id}</small>
              <p>{note.body}</p>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(note.id);
                    setBody(note.body);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    app && void act(app.remove(note.id), () => {
                      if (editing === note.id) {
                        setEditing(undefined);
                        setBody("");
                      }
                    })}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        {session && notes.length === 0 && (
          <p>No notes yet. Write your first one above.</p>
        )}
      </section>
      {session && tab === "Database" && (
        <section aria-label="Database">
          <p>
            Try:{" "}
            <code>UPDATE notes SET body = 'Hello from SQL' WHERE id = 1;</code>
          </p>
          <DatabaseEditor binding={session.binding} title="Notes database" />
        </section>
      )}
      <footer>
        SQLite · in-memory session · Reloading discards changes and starts a new
        session with the two seeded notes. ·{" "}
        <span data-testid="loads">
          {loads}
        </span>{" "}
        snapshots · updates follow database events
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
