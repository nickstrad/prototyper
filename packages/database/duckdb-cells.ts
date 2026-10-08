// Arrow → `Cell` conversion for the DuckDB DatabaseService (D2). Values are
// read from the Arrow buffers by type, never through `toArray()`/`toJSON()`,
// which lose LIST NULLs (→ 0), DECIMAL scale and INTERVAL values (plan.md §9,
// pocs/duckdb-shell evidence/40-arrow-types.txt):
//
// | DuckDB type                 | Cell                                          |
// | --------------------------- | --------------------------------------------- |
// | NULL (any type)             | null                                          |
// | TINYINT … BIGINT, UBIGINT   | number when safe, bigint when unsafe          |
// | HUGEINT (Arrow Decimal 38,0)| number when safe, bigint when unsafe          |
// | DECIMAL(p,s), s > 0         | exact decimal string, e.g. "3.14", "-0.05"    |
// | DOUBLE / FLOAT              | number (FLOAT as its shortest float32 digits) |
// | BOOLEAN                     | 1 / 0 (as the SQLite normalizer)              |
// | VARCHAR, UUID, ENUM         | string                                        |
// | BLOB                        | Uint8Array                                    |
// | DATE, TIME, TIMESTAMP[_S/MS/NS/TZ], INTERVAL | DuckDB's own text, e.g. "01:30:00" |
// | LIST, STRUCT, MAP, ARRAY, UNION | DuckDB's own VARCHAR text, e.g. "[1, NULL]" |
//
// "DuckDB's own text" is byte-for-byte what `CAST(x AS VARCHAR)` prints (the
// browser suite checks this), so writing the cell back as
// `CAST('<text>' AS <type>)` restores the exact value. TIMESTAMPTZ renders in
// UTC with "+00" (the instant is exact; the wasm build has no ICU time zones).
// Known lossy exports from DuckDB itself: UHUGEINT, BIT and VARINT arrive as
// bytes, TIMETZ without its offset — cast them to VARCHAR in SQL.
import type { Cell } from "../core/types.ts";
import { normalizeCell } from "./sqlite-cells.ts";
import type { ArrowTable } from "./duckdb-wasm.d.ts";

export type { ArrowTable };

/** The parts of an Arrow `Data` chunk this module reads. */
type Col = {
  readonly type: ArrowType;
  readonly offset: number;
  readonly length: number;
  readonly values: unknown;
  readonly valueOffsets?: Int32Array | BigInt64Array;
  readonly typeIds?: Int8Array;
  readonly children: readonly Col[];
  readonly dictionary?: { get(index: number): unknown };
  getValid(index: number): boolean;
};

type ArrowType = {
  readonly typeId: number;
  readonly bitWidth?: number;
  readonly isSigned?: boolean;
  readonly precision?: number;
  readonly scale?: number;
  readonly unit?: number;
  readonly timezone?: string | null;
  readonly byteWidth?: number;
  readonly listSize?: number;
  readonly mode?: number;
  readonly typeIds?: readonly number[];
  readonly children?: readonly { readonly name: string }[];
};

// apache-arrow 17 `Type` and unit enums (numeric values, no runtime import).
const T = {
  Null: 1,
  Int: 2,
  Float: 3,
  Binary: 4,
  Utf8: 5,
  Bool: 6,
  Decimal: 7,
  Date: 8,
  Time: 9,
  Timestamp: 10,
  Interval: 11,
  List: 12,
  Struct: 13,
  Union: 14,
  FixedSizeBinary: 15,
  FixedSizeList: 16,
  Map: 17,
  Duration: 18,
  LargeBinary: 19,
  LargeUtf8: 20,
  Dictionary: -1,
} as const;
const DATE_DAY = 0;
const INTERVAL_YEAR_MONTH = 0;
const INTERVAL_DAY_TIME = 1;
const UNION_DENSE = 1;
/** Arrow TimeUnit SECOND..NANOSECOND → fractional digits. */
const UNIT_DIGITS = [0, 3, 6, 9] as const;

const utf8 = new TextDecoder();

// ---- scalar text in DuckDB's format ------------------------------------------

const pad = (n: number | bigint, width: number): string =>
  String(n).padStart(width, "0");

/** Days since 1970-01-01 → [year, month, day] (proleptic Gregorian). */
const civil = (days: number): [number, number, number] => {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
};

const DATE_INFINITY = 2147483647;

/** `DATE` text; year 0 and below print as "(BC)" like DuckDB. */
export const formatDate = (days: number): string => {
  if (days === DATE_INFINITY) return "infinity";
  if (days === -DATE_INFINITY) return "-infinity";
  const [y, m, d] = civil(days);
  return `${pad(y > 0 ? y : 1 - y, 4)}-${pad(m, 2)}-${pad(d, 2)}${
    y > 0 ? "" : " (BC)"
  }`;
};

/** Fraction digits without trailing zeros (DuckDB prints ".5", not ".500000"). */
const fraction = (value: bigint, digits: number): string => {
  if (value === 0n) return "";
  return "." + pad(value, digits).replace(/0+$/, "");
};

/** Time of day from a count of `digits`-precision ticks. */
const formatClock = (ticks: bigint, digits: number): string => {
  const scale = 10n ** BigInt(digits);
  const seconds = ticks / scale;
  return `${pad(seconds / 3600n, 2)}:${pad((seconds / 60n) % 60n, 2)}:${
    pad(seconds % 60n, 2)
  }${fraction(ticks % scale, digits)}`;
};

/** `TIME` text from ticks since midnight. */
export const formatTime = (ticks: bigint, digits: number): string =>
  formatClock(ticks, digits);

const INT64_MAX = 9223372036854775807n;

/** `TIMESTAMP*` text from ticks since the epoch; `tz` appends "+00". */
export const formatTimestamp = (
  ticks: bigint,
  digits: number,
  tz = false,
): string => {
  if (ticks === INT64_MAX) return "infinity";
  if (ticks === -INT64_MAX) return "-infinity";
  const perDay = 86400n * 10n ** BigInt(digits);
  let day = ticks / perDay;
  let rest = ticks % perDay;
  if (rest < 0n) {
    rest += perDay;
    day -= 1n;
  }
  const date = formatDate(Number(day));
  const bc = date.endsWith(" (BC)");
  return `${bc ? date.slice(0, -5) : date} ${formatClock(rest, digits)}${
    tz ? "+00" : ""
  }${bc ? " (BC)" : ""}`;
};

const plural = (n: number | bigint, unit: string): string =>
  `${n} ${unit}${n === 1 || n === -1 || n === 1n || n === -1n ? "" : "s"}`;

/** `INTERVAL` text, as DuckDB's IntervalToStringCast. */
export const formatInterval = (
  months: number,
  days: number,
  micros: bigint,
): string => {
  const parts: string[] = [];
  if (months !== 0) {
    const years = Math.trunc(months / 12);
    const rest = months - years * 12;
    if (years !== 0) parts.push(plural(years, "year"));
    if (rest !== 0) parts.push(plural(rest, "month"));
  }
  if (days !== 0) parts.push(plural(days, "day"));
  if (micros !== 0n) {
    const negative = micros < 0n;
    parts.push(
      (negative ? "-" : "") + formatClock(negative ? -micros : micros, 6),
    );
  }
  return parts.length === 0 ? "00:00:00" : parts.join(" ");
};

/** Exact decimal text of an unscaled integer: (-5n, 2) → "-0.05". */
export const formatDecimal = (unscaled: bigint, scale: number): string => {
  if (scale === 0) return String(unscaled);
  const negative = unscaled < 0n;
  const digits = pad(negative ? -unscaled : unscaled, scale + 1);
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${
    digits.slice(-scale)
  }`;
};

/** Shortest decimal digits that read back as the same float32. */
export const shortestFloat32 = (v: number): number => {
  if (!Number.isFinite(v) || v === 0) return v;
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(v.toPrecision(p));
    if (Math.fround(candidate) === v) return candidate;
  }
  return v;
};

/** DOUBLE/FLOAT text inside nested values ("2.0", "1e+20", "1e-05"). */
export const formatDouble = (v: number): string => {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const [mantissa, e] = v.toExponential().split("e");
  const exp = Number(e);
  if (exp < -4 || exp >= 16) {
    return `${mantissa}e${exp < 0 ? "-" : "+"}${pad(Math.abs(exp), 2)}`;
  }
  const fixed = String(v);
  return fixed.includes(".") ? fixed : `${fixed}.0`;
};

/** BLOB text: printable ASCII as is, everything else as \xHH. */
export const formatBlob = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) {
    out += b >= 32 && b <= 126 && b !== 0x5c && b !== 0x27 && b !== 0x22
      ? String.fromCharCode(b)
      : `\\x${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

/**
 * Quoting DuckDB applies to text inside LIST/STRUCT/MAP values. Leading and
 * trailing whitespace means ASCII whitespace only (DuckDB does not quote a
 * leading NBSP).
 */
export const quoteNested = (text: string): string =>
  text === "" || /^[ \t\n\r\v\f]|[ \t\n\r\v\f]$/.test(text) ||
    /[,'"[\]{}()=:]/.test(text) ||
    text.toLowerCase() === "null"
    ? `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
    : text;

// ---- reading buffers ----------------------------------------------------------

const offsetsOf = (col: Col, i: number): [number, number] => {
  const o = col.valueOffsets!;
  return [Number(o[i]), Number(o[i + 1])];
};

const bytesOf = (col: Col, i: number): Uint8Array => {
  const values = col.values as Uint8Array;
  if (col.type.typeId === T.FixedSizeBinary) {
    const w = col.type.byteWidth!;
    return values.slice(i * w, (i + 1) * w);
  }
  const [start, end] = offsetsOf(col, i);
  return values.slice(start, end);
};

/** Two's-complement integer from `words` little-endian uint32 words. */
const wideInt = (values: Uint32Array, start: number, words: number): bigint => {
  let v = 0n;
  for (let k = words - 1; k >= 0; k--) {
    v = (v << 32n) | BigInt(values[start + k]);
  }
  const bits = BigInt(words * 32);
  return v >= 1n << (bits - 1n) ? v - (1n << bits) : v;
};

const intervalParts = (
  col: Col,
  i: number,
): [months: number, days: number, micros: bigint] => {
  const v = col.values as Int32Array;
  switch (col.type.unit) {
    case INTERVAL_YEAR_MONTH:
      return [v[i], 0, 0n];
    case INTERVAL_DAY_TIME:
      return [0, v[2 * i], BigInt(v[2 * i + 1]) * 1000n];
    default: { // MONTH_DAY_NANO: int32 months, int32 days, int64 nanos
      const b = 4 * i;
      const nanos = (BigInt(v[b + 3]) << 32n) | BigInt(v[b + 2] >>> 0);
      return [v[b], v[b + 1], nanos / 1000n];
    }
  }
};

const ticks = (col: Col, i: number): bigint =>
  BigInt((col.values as BigInt64Array | Int32Array)[i]);

/** Scalar text of a temporal value (DATE/TIME/TIMESTAMP/INTERVAL). */
const temporalText = (col: Col, i: number): string => {
  const { type } = col;
  switch (type.typeId) {
    case T.Date:
      return type.unit === DATE_DAY
        ? formatDate((col.values as Int32Array)[i])
        : formatDate(Math.floor(Number(ticks(col, i)) / 86400000));
    case T.Time:
      return formatTime(ticks(col, i), UNIT_DIGITS[type.unit ?? 2]);
    case T.Timestamp:
      return formatTimestamp(
        ticks(col, i),
        UNIT_DIGITS[type.unit ?? 2],
        type.timezone !== null && type.timezone !== undefined,
      );
    default:
      return formatInterval(...intervalParts(col, i));
  }
};

/** Child index of a union row, and that child. */
const unionChild = (col: Col, i: number): [Col, number] => {
  const typeId = col.typeIds![i];
  const child = col.children[col.type.typeIds!.indexOf(typeId)];
  return [
    child,
    col.type.mode === UNION_DENSE ? Number(col.valueOffsets![i]) : i,
  ];
};

/** DuckDB's VARCHAR text of any value; `nested` applies nested quoting. */
const text = (col: Col, i: number, nested: boolean): string => {
  if (col.type.typeId === T.Null || !col.getValid(i)) return "NULL";
  const { type } = col;
  const leaf = (s: string) => nested ? quoteNested(s) : s;
  switch (type.typeId) {
    case T.Int:
      return String((col.values as ArrayLike<number | bigint>)[i]);
    case T.Float: {
      const v = (col.values as Float32Array | Float64Array)[i];
      return formatDouble(type.precision === 1 ? shortestFloat32(v) : v);
    }
    case T.Decimal:
      return formatDecimal(decimal(col, i), type.scale ?? 0);
    case T.Bool:
      return bit(col, i) ? "true" : "false";
    case T.Utf8:
    case T.LargeUtf8:
      return leaf(utf8.decode(bytesOf(col, i)));
    case T.Binary:
    case T.LargeBinary:
    case T.FixedSizeBinary:
      return leaf(formatBlob(bytesOf(col, i)));
    case T.Date:
    case T.Time:
    case T.Timestamp:
    case T.Interval:
      return leaf(temporalText(col, i));
    case T.Dictionary:
      return leaf(String(col.dictionary!.get(Number(dictIndex(col, i)))));
    case T.List:
    case T.FixedSizeList: {
      const [start, end] = type.typeId === T.List
        ? offsetsOf(col, i)
        : [i * type.listSize!, (i + 1) * type.listSize!];
      const child = col.children[0];
      const items: string[] = [];
      for (let k = start; k < end; k++) items.push(text(child, k, true));
      return `[${items.join(", ")}]`;
    }
    case T.Struct: {
      const names = type.children ?? [];
      return `{${
        col.children.map((child, k) =>
          `${quoteKey(names[k]?.name ?? String(k))}: ${text(child, i, true)}`
        ).join(", ")
      }}`;
    }
    case T.Map: {
      const [start, end] = offsetsOf(col, i);
      const [keys, values] = col.children[0].children;
      const items: string[] = [];
      for (let k = start; k < end; k++) {
        items.push(`${text(keys, k, true)}=${text(values, k, true)}`);
      }
      return `{${items.join(", ")}}`;
    }
    case T.Union: {
      const [child, k] = unionChild(col, i);
      return text(child, k, nested);
    }
    default:
      return leaf(`<unsupported Arrow type ${type.typeId}>`);
  }
};

/** STRUCT keys are always single-quoted. */
const quoteKey = (key: string): string =>
  `'${key.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const bit = (col: Col, i: number): boolean => {
  const pos = col.offset + i;
  return ((col.values as Uint8Array)[pos >> 3] & (1 << (pos % 8))) !== 0;
};

const decimal = (col: Col, i: number): bigint => {
  const words = (col.type.bitWidth ?? 128) / 32;
  return wideInt(col.values as Uint32Array, i * words, words);
};

const dictIndex = (col: Col, i: number) =>
  (col.values as ArrayLike<number | bigint>)[i];

/** One value of an Arrow column chunk as a contract `Cell`. */
export const readCell = (col: Col, i: number): Cell => {
  if (col.type.typeId === T.Null || !col.getValid(i)) return null;
  const { type } = col;
  switch (type.typeId) {
    case T.Int:
      return normalizeCell((col.values as ArrayLike<number | bigint>)[i]);
    case T.Float: {
      const v = (col.values as Float32Array | Float64Array)[i];
      return type.precision === 1 ? shortestFloat32(v) : v;
    }
    case T.Decimal: {
      const unscaled = decimal(col, i);
      return type.scale === 0
        ? normalizeCell(unscaled)
        : formatDecimal(unscaled, type.scale ?? 0);
    }
    case T.Bool:
      return bit(col, i) ? 1 : 0;
    case T.Utf8:
    case T.LargeUtf8:
      return utf8.decode(bytesOf(col, i));
    case T.Binary:
    case T.LargeBinary:
    case T.FixedSizeBinary:
      return bytesOf(col, i);
    case T.Dictionary: {
      const v = col.dictionary!.get(Number(dictIndex(col, i)));
      return typeof v === "string" ? v : normalizeCell(v);
    }
    case T.Union: {
      const [child, k] = unionChild(col, i);
      return readCell(child, k);
    }
    default:
      return text(col, i, false);
  }
};

/** Converted first `maxRows` rows of a query result. */
export const tableRows = (
  table: ArrowTable,
  maxRows: number,
): { rows: Cell[][]; truncated: boolean } => {
  const rows: Cell[][] = [];
  const width = table.schema.fields.length;
  outer: for (const batch of table.batches) {
    const cols = batch.data.children as unknown as readonly Col[];
    for (let r = 0; r < batch.numRows; r++) {
      if (rows.length >= maxRows) break outer;
      const row: Cell[] = new Array(width);
      for (let c = 0; c < width; c++) row[c] = readCell(cols[c], r);
      rows.push(row);
    }
  }
  return { rows, truncated: table.numRows > rows.length };
};
