// Shared cell normalizer for every SQLite DatabaseService implementation
// (Fiddle engine worker, sqlite-wasm, node:sqlite). Drivers hand over raw
// values; this module turns them into the contract's in-process `Cell`
// (packages/core/types.ts) and, for JSON output, into `EncodedCell` through
// the frozen encodeCell()/decodeCell() pair.
import {
  type Cell,
  decodeCell,
  encodeCell,
  type EncodedCell,
  type QueryResult,
} from "../core/types.ts";

export { decodeCell, encodeCell };

/**
 * Raw driver value -> Cell. Integers become `number` when safe and `bigint`
 * only when unsafe (node:sqlite with setReadBigInts returns bigint for every
 * integer; OO1 returns number unless unsafe). Booleans become 0/1, any
 * ArrayBuffer view becomes a Uint8Array copy, undefined becomes null.
 */
export const normalizeCell = (value: unknown): Cell => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  return String(value);
};

/** A driver's result before normalization (rows hold raw values). */
export type RawQueryResult = {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly changes: number;
  readonly schemaChanged: boolean;
  readonly truncated: boolean;
};

export const normalizeResult = (raw: RawQueryResult): QueryResult => ({
  columns: [...raw.columns],
  rows: raw.rows.map((row) => row.map(normalizeCell)),
  changes: Number(raw.changes),
  schemaChanged: raw.schemaChanged,
  truncated: raw.truncated,
});

/** JSON form of a whole result for CLI/API/editor output. */
export type EncodedQueryResult = Omit<QueryResult, "rows"> & {
  readonly rows: readonly (readonly EncodedCell[])[];
};

export const encodeResult = (result: QueryResult): EncodedQueryResult => ({
  ...result,
  rows: result.rows.map((row) => row.map(encodeCell)),
});

export const decodeResult = (encoded: EncodedQueryResult): QueryResult => ({
  ...encoded,
  rows: encoded.rows.map((row) => row.map(decodeCell)),
});

/** Display text for a cell (workbench grid); blobs show as hex. */
export const cellText = (cell: Cell): string => {
  if (cell === null) return "NULL";
  if (cell instanceof Uint8Array) {
    return "x'" +
      Array.from(cell, (b) => b.toString(16).padStart(2, "0")).join("") + "'";
  }
  return String(cell);
};
