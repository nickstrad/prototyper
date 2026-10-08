// Common DatabaseEditor host (plan.md §8, docs/database-editor-plan.md): one
// React component that mounts an engine's real upstream shell through its
// ShellBinding and puts auxiliary host controls beside it, all on the same
// DatabaseService (`binding.sharesDatabaseWith`). The console shows the
// shell's own banner-less prompt, command handling and output; the host never
// re-renders or replaces that output. Host controls: engine facts, table
// list, schema view, a bounded row preview, reset, and capability-gated
// export/import. A successful shell or host write invalidates the table list.
import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, Fiber, Scope, Stream } from "effect";
import "@xterm/xterm/css/xterm.css";
import {
  type Cell,
  type DatabaseChange,
  type DatabaseError,
  encodeCell,
  type QueryResult,
} from "../core/types.ts";
import { openScope } from "./sqlite-shell.ts";
import type { DatabaseEditorProps, ShellError } from "./types.ts";

const styles = {
  root: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    alignItems: "flex-start",
    fontFamily: "system-ui, sans-serif",
    fontSize: 14,
  },
  console: { flex: "1 1 640px", minWidth: 0 },
  terminal: {
    background: "#000",
    padding: 4,
    borderRadius: 4,
    overflow: "hidden",
  },
  panel: {
    flex: "0 1 360px",
    minWidth: 280,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  h3: { fontSize: 14, margin: "0 0 4px" },
  status: { fontFamily: "ui-monospace, monospace", fontSize: 12, margin: 0 },
  list: { listStyle: "none", margin: 0, padding: 0 },
  tableButton: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "2px 6px",
    border: "1px solid #ccc",
    borderRadius: 3,
    background: "#fafafa",
    cursor: "pointer",
    fontFamily: "ui-monospace, monospace",
  },
  selected: { background: "#e2ecff", borderColor: "#6b8fd8" },
  pre: {
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    background: "#f4f4f4",
    padding: 6,
    borderRadius: 3,
    maxHeight: 160,
    overflow: "auto",
  },
  gridWrap: { maxHeight: 220, overflow: "auto" },
  grid: {
    borderCollapse: "collapse",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    width: "100%",
  },
  cell: {
    border: "1px solid #ddd",
    padding: "2px 6px",
    textAlign: "left",
    whiteSpace: "nowrap",
    maxWidth: 240,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  nullCell: { color: "#888", fontStyle: "italic" },
  controls: { display: "flex", flexWrap: "wrap", gap: 8 },
  message: { margin: 0, fontSize: 12 },
  error: { color: "#b00020" },
  note: { color: "#555" },
} as const;

const describeError = (e: DatabaseError | ShellError): string =>
  `${e._tag}/${e.operation}: ${e.message}`;

/** Lossless text for a cell (bigint, blob, NULL all survive). */
const renderCell = (cell: Cell) => {
  const encoded = encodeCell(cell);
  if (encoded === null) return <span style={styles.nullCell}>NULL</span>;
  if (typeof encoded === "object") {
    return encoded.$type === "bigint"
      ? <span title="integer outside the safe range">{encoded.value}</span>
      : (
        <span title={encoded.base64}>
          {`blob(${(cell as Uint8Array).length} B)`}
        </span>
      );
  }
  return String(encoded);
};

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export function DatabaseEditor(
  { binding, title = "Database", previewRows = 50 }: DatabaseEditorProps,
) {
  const service = binding.sharesDatabaseWith;
  const consoleHost = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mountError, setMountError] = useState<string | null>(null);
  const [tables, setTables] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [schema, setSchema] = useState<string>("");
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [message, setMessage] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);
  const [lastChange, setLastChange] = useState<DatabaseChange | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    <A,>(
      effect: Effect.Effect<A, DatabaseError | ShellError>,
      onSuccess?: (a: A) => void,
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.map((a) => {
            onSuccess?.(a);
          }),
          Effect.catch((e) =>
            Effect.sync(() =>
              setMessage({ kind: "error", text: describeError(e) })
            )
          ),
        ),
      ).catch((e: unknown) => setMessage({ kind: "error", text: String(e) })),
    [],
  );

  const refreshTables = useCallback(
    () =>
      run(service.tables(), (names) => {
        setTables(names);
        setSelected((current) =>
          current !== null && names.includes(current)
            ? current
            : (names[0] ?? null)
        );
      }),
    [run, service],
  );

  // Mount the upstream shell once; the scope closes on unmount.
  useEffect(() => {
    const host = consoleHost.current;
    if (!host) return;
    const { scope, close } = openScope();
    let closed = false;
    Effect.runPromise(
      Scope.provide(scope)(
        binding.ready.pipe(
          Effect.flatMap(() => binding.mount(host)),
          Effect.catch((e) =>
            Effect.sync(() => setMountError(describeError(e)))
          ),
        ),
      ),
    ).catch((e: unknown) => setMountError(String(e))).finally(() => {
      if (closed) void close();
    });
    return () => {
      closed = true;
      void close();
    };
  }, [binding]);

  // Refresh dependent views after any successful write/reset/import.
  useEffect(() => {
    void refreshTables();
    const fiber = Effect.runFork(
      Stream.runForEach((change: DatabaseChange) =>
        Effect.sync(() => {
          setLastChange(change);
          void refreshTables();
        })
      )(service.changes),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [service, refreshTables]);

  // Schema and preview follow the selected table and the latest change.
  useEffect(() => {
    if (selected === null) {
      setSchema("");
      setPreview(null);
      return;
    }
    void run(service.schema(selected), setSchema);
    void run(
      service.execute(`SELECT * FROM ${quote(selected)}`, {
        maxRows: previewRows,
        source: "host",
      }),
      setPreview,
    );
  }, [selected, lastChange, previewRows, run, service]);

  const withBusy = (
    effect: Effect.Effect<unknown, DatabaseError>,
    done: string,
  ) => {
    setBusy(true);
    setMessage(null);
    void run(effect, () => setMessage({ kind: "info", text: done })).finally(
      () => setBusy(false),
    );
  };

  const onReset = () => withBusy(service.reset(), "database reset to its seed");

  const onExport = () =>
    withBusy(
      service.exportBytes().pipe(
        Effect.tap((bytes) =>
          Effect.sync(() => {
            const blob = new Blob([bytes as BlobPart], {
              type: "application/vnd.sqlite3",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "prototype.sqlite3";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })
        ),
      ),
      "exported prototype.sqlite3",
    );

  const onImportFile = (file: File | undefined) => {
    if (!file) return;
    withBusy(
      Effect.tryPromise(() => file.arrayBuffer()).pipe(
        Effect.mapError((e): DatabaseError => ({
          _tag: "DatabaseError",
          operation: "import",
          message: String(e.cause),
          cause: e.cause,
        })),
        Effect.andThen((buffer) => service.importBytes(new Uint8Array(buffer))),
      ),
      `imported ${file.name}`,
    );
  };

  const { capabilities, persistence } = service;
  const persistenceText = persistence.actual +
    (persistence.reason ? ` (${persistence.reason})` : "");

  return (
    <section data-testid="db-editor" style={styles.root}>
      <div style={styles.console}>
        <h3 style={styles.h3}>
          {title} console (upstream {service.engine} shell)
        </h3>
        <div
          data-testid="db-console"
          ref={consoleHost}
          style={styles.terminal}
        />
        {mountError && (
          <p
            data-testid="db-mount-error"
            style={{ ...styles.message, ...styles.error }}
          >
            {mountError}
          </p>
        )}
      </div>
      <aside style={styles.panel}>
        <div>
          <h3 style={styles.h3}>Engine</h3>
          <p data-testid="db-status" style={styles.status}>
            {`${service.engine} ${service.version} · persistence: ${persistenceText}`}
          </p>
        </div>
        <div>
          <h3 style={styles.h3}>Tables ({tables.length})</h3>
          <ul data-testid="db-tables" style={styles.list}>
            {tables.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  style={{
                    ...styles.tableButton,
                    ...(name === selected ? styles.selected : {}),
                  }}
                  onClick={() => setSelected(name)}
                >
                  {name}
                </button>
              </li>
            ))}
            {tables.length === 0 && <li style={styles.note}>no tables</li>}
          </ul>
        </div>
        {selected !== null && (
          <div>
            <h3 style={styles.h3}>Schema: {selected}</h3>
            <pre data-testid="db-schema" style={styles.pre}>{schema}</pre>
          </div>
        )}
        {preview && (
          <div>
            <h3 style={styles.h3}>
              Rows: {selected}
              {preview.truncated && (
                <span style={styles.note}>
                  {` (first ${previewRows} shown; result truncated)`}
                </span>
              )}
            </h3>
            <div style={styles.gridWrap}>
              <table data-testid="db-preview" style={styles.grid}>
                <thead>
                  <tr>
                    {preview.columns.map((c, i) => (
                      <th key={`${c}-${i}`} style={styles.cell}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c} style={styles.cell}>{renderCell(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div>
          <h3 style={styles.h3}>Controls</h3>
          <div style={styles.controls}>
            <button
              type="button"
              data-testid="db-reset"
              onClick={onReset}
              disabled={busy}
            >
              Reset
            </button>
            <button
              type="button"
              data-testid="db-export"
              onClick={onExport}
              disabled={busy || !capabilities.export.available}
              title={capabilities.export.available
                ? ""
                : capabilities.export.reason}
            >
              Export
            </button>
            <button
              type="button"
              data-testid="db-import"
              onClick={() => fileInput.current?.click()}
              disabled={busy || !capabilities.import.available}
              title={capabilities.import.available
                ? ""
                : capabilities.import.reason}
            >
              Import…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".sqlite3,.sqlite,.db"
              hidden
              onChange={(e) => {
                onImportFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {capabilities.cancellation.available && (
              <button type="button" data-testid="db-cancel" disabled>
                Cancel
              </button>
            )}
          </div>
          <p
            data-testid="db-capabilities"
            style={{ ...styles.message, ...styles.note }}
          >
            {`export: ${capabilityText(capabilities.export)} · import: ${
              capabilityText(capabilities.import)
            } · cancel: ${capabilityText(capabilities.cancellation)}`}
          </p>
          {message && (
            <p
              data-testid="db-message"
              style={{
                ...styles.message,
                ...(message.kind === "error" ? styles.error : {}),
              }}
            >
              {message.text}
            </p>
          )}
          {lastChange && (
            <p
              data-testid="db-last-change"
              style={{ ...styles.message, ...styles.note }}
            >
              {`last change: ${lastChange.kind} from ${lastChange.source} (${lastChange.changes} rows${
                lastChange.schemaChanged ? ", schema changed" : ""
              })`}
            </p>
          )}
        </div>
      </aside>
    </section>
  );
}

const capabilityText = (
  c: { available: true } | { available: false; reason: string },
) => c.available ? "available" : `unavailable (${c.reason})`;
