// Shared, runtime-neutral result types and JSON-safe value encoding.
// Used by the browser worker (sqlite-wasm), Deno wasm driver and node:sqlite driver.

/** JSON-safe cell value. BigInt outside the safe range and BLOBs are tagged. */
export type Cell =
  | null
  | number
  | string
  | { readonly $type: "bigint"; readonly value: string }
  | { readonly $type: "blob"; readonly base64: string };

export type QueryResult = {
  /** Column names of the first statement that has result columns ([] if none). */
  readonly columns: readonly string[];
  /** Rows of that statement, JSON-safe (see Cell). */
  readonly rows: readonly (readonly Cell[])[];
  /** sqlite3_total_changes() delta across the whole SQL text (0 for reads/DDL). */
  readonly changes: number;
  /** True when PRAGMA schema_version moved (DDL ran). */
  readonly schemaChanged: boolean;
  /** True when rows were cut at maxRows. */
  readonly truncated: boolean;
};

export const DEFAULT_MAX_ROWS = 1000;

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

/** Encode one raw driver value into a JSON-safe Cell. */
export const encodeCell = (v: unknown): Cell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") {
    return Number.isSafeInteger(Number(v)) && BigInt(Number(v)) === v
      ? Number(v)
      : { $type: "bigint", value: v.toString() };
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return { $type: "blob", base64: toBase64(v) };
  if (v instanceof ArrayBuffer) return { $type: "blob", base64: toBase64(new Uint8Array(v)) };
  return String(v);
};

export const TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`;

export const TASKS_SEED = `
INSERT INTO tasks (id, title, completed, created_at) VALUES
  (1, 'Write the project plan', 1, '2026-01-01T09:00:00.000Z'),
  (2, 'Probe SQLite WASM', 0, '2026-01-02T09:00:00.000Z'),
  (3, 'Wire the terminal', 0, '2026-01-03T09:00:00.000Z');`;
