import { useEffect, useState } from "react";
import { DatabaseEditor } from "../../packages/database-editor/DatabaseEditor.tsx";
import { createHost, type Host } from "./host.ts";

const presets = [
  { label: "List bookmarks", method: "GET", path: "/bookmarks", body: "" },
  {
    label: "Create bookmark",
    method: "POST",
    path: "/bookmarks",
    body: JSON.stringify(
      { title: "Example", url: "https://example.com/" },
      null,
      2,
    ),
  },
  {
    label: "Delete bookmark 1",
    method: "DELETE",
    path: "/bookmarks/1",
    body: "",
  },
  {
    label: "Invalid request",
    method: "POST",
    path: "/bookmarks",
    body: JSON.stringify({ title: "Invalid URL", url: "not-a-url" }, null, 2),
  },
];

export function App() {
  const [host, setHost] = useState<Host>();
  const [error, setError] = useState("");
  const [view, setView] = useState("API");
  useEffect(() => {
    let live = true;
    let owned: Host | undefined;
    void createHost().then(async (h) => {
      owned = h;
      if (live) setHost(h);
      else await h.dispose();
    }).catch((e) => live && setError(String(e)));
    return () => {
      live = false;
      void owned?.dispose();
    };
  }, []);
  return (
    <main>
      <header>
        <p className="eyebrow">PROTOTYPER / API DEMO</p>
        <h1>Bookmarks</h1>
        <p>Send a request. Inspect the database. See the same data.</p>
      </header>
      <nav aria-label="Views">
        {["API", "Database"].map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={view === name}
            onClick={() => setView(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      {!host && <p role="status">{error || "Opening SQLite…"}</p>}
      {host && (
        <>
          <p className="note">
            SQLite · in memory (reload resets the seed) · API requests run in
            this page.
          </p>
          <div hidden={view !== "API"}>
            <Explorer host={host} />
          </div>
          {view === "Database" && (
            <section aria-label="Database view">
              <h2>Database</h2>
              <p>
                Enter this in the SQLite console, then switch to API and send
                GET /bookmarks:
              </p>
              <pre>INSERT INTO bookmarks(title, url) VALUES ('From shell', 'https://example.com/shell');</pre>
              <DatabaseEditor binding={host.binding} title="Bookmarks" />
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Explorer({ host }: { host: Host }) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/bookmarks");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<
    { status: string; headers: string; body: string }
  >();
  const [error, setError] = useState("");
  const [calls, setCalls] = useState(0);
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      if (!path.startsWith("/")) throw new Error("Path must start with /");
      const result = await host.handler(
        new Request(`https://api.invalid${path}`, {
          method,
          ...(method === "POST"
            ? { body, headers: { "content-type": "application/json" } }
            : {}),
        }),
      );
      const text = await result.text();
      setResponse({
        status: `${result.status} ${result.statusText}`,
        headers: [...result.headers].map(([k, v]) => `${k}: ${v}`).join("\n"),
        body: text ? JSON.stringify(JSON.parse(text), null, 2) : "",
      });
      setCalls((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="API explorer">
      <h2>API explorer</h2>
      <p>
        Create and delete bookmarks through the form. The invalid request preset
        returns 400 with an explanation and leaves the database unchanged.
      </p>
      <div className="presets">
        {presets.map((p) => (
          <button
            type="button"
            key={p.label}
            disabled={busy}
            onClick={() => {
              setMethod(p.method);
              setPath(p.path);
              setBody(p.body);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="request">
          <label>
            Method<select
              aria-label="Method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {["GET", "POST", "DELETE"].map((m) => <option key={m}>{m}
              </option>)}
            </select>
          </label>
          <label className="path">
            Path<input value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <button disabled={busy} type="submit">
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
        <label>
          JSON body<textarea
            rows={5}
            value={body}
            disabled={method !== "POST"}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
      </form>
      <p data-testid="calls" className="note">Requests sent: {calls}</p>
      {error && <p role="alert">{error}</p>}
      {response && (
        <div aria-live="polite">
          <h3 data-testid="response-status">{response.status}</h3>
          <pre data-testid="response-headers">{response.headers}</pre>
          <pre data-testid="response-body">{response.body}</pre>
        </div>
      )}
    </section>
  );
}
