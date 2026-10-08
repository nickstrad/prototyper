// Native checks of the DuckDB text formatters and the export-image parser
// (packages/database/duckdb-cells.ts, duckdb-service.ts). The browser suite
// compares the same formatters with DuckDB's own CAST(... AS VARCHAR).
import { assertEquals, assertThrows } from "@std/assert";
import {
  formatBlob,
  formatDate,
  formatDecimal,
  formatDouble,
  formatInterval,
  formatTimestamp,
  quoteNested,
  shortestFloat32,
} from "../../packages/database/duckdb-cells.ts";
import { unpackExport } from "../../packages/database/duckdb-service.ts";

Deno.test("dates and timestamps print like DuckDB", () => {
  assertEquals(formatDate(0), "1970-01-01");
  assertEquals(formatDate(19782), "2024-02-29");
  assertEquals(formatDate(-1), "1969-12-31");
  // DATE '0044-03-15 (BC)' is day -735160 (year 0 = 1 BC).
  assertEquals(formatDate(-735160), "0044-03-15 (BC)");
  assertEquals(formatDate(2147483647), "infinity");
  assertEquals(
    formatTimestamp(1704099600123456n, 6),
    "2024-01-01 09:00:00.123456",
  );
  assertEquals(
    formatTimestamp(1704099600500000n, 6, true),
    "2024-01-01 09:00:00.5+00",
  );
  assertEquals(formatTimestamp(-1n, 6), "1969-12-31 23:59:59.999999");
  assertEquals(
    formatTimestamp(1704099600123456789n, 9),
    "2024-01-01 09:00:00.123456789",
  );
  assertEquals(formatTimestamp(9223372036854775807n, 6), "infinity");
});

Deno.test("intervals print like DuckDB", () => {
  assertEquals(formatInterval(0, 0, 5400000000n), "01:30:00");
  assertEquals(
    formatInterval(14, 3, 14706789000n),
    "1 year 2 months 3 days 04:05:06.789",
  );
  assertEquals(formatInterval(0, -1, 0n), "-1 day");
  assertEquals(formatInterval(0, 0, -5400000000n), "-01:30:00");
  assertEquals(formatInterval(0, 0, 0n), "00:00:00");
  assertEquals(formatInterval(0, 0, 360000000000n), "100:00:00");
  assertEquals(formatInterval(13, -2, 0n), "1 year 1 month -2 days");
});

Deno.test("decimals, doubles and floats", () => {
  assertEquals(formatDecimal(314n, 2), "3.14");
  assertEquals(formatDecimal(-5n, 2), "-0.05");
  assertEquals(formatDecimal(-1n, 10), "-0.0000000001");
  assertEquals(formatDecimal(12n, 0), "12");
  assertEquals(
    [1.5, 2, 1e20, 0.1, 1e15, 1e16, 0.0001, 0.00001, 1e-7].map(formatDouble),
    [
      "1.5",
      "2.0",
      "1e+20",
      "0.1",
      "1000000000000000.0",
      "1e+16",
      "0.0001",
      "1e-05",
      "1e-07",
    ],
  );
  assertEquals(shortestFloat32(Math.fround(0.1)), 0.1);
  assertEquals(shortestFloat32(Math.fround(1.17549435e-38)), 1.1754944e-38);
});

Deno.test("nested quoting and blob text", () => {
  assertEquals(
    [
      "a",
      "b c",
      "",
      "null",
      "x,y",
      "it's",
      " lead",
      "a:b",
      "(x)",
      "x;y",
      "back\\slash",
      "a,b\\c",
    ]
      .map(quoteNested),
    [
      "a",
      "b c",
      "''",
      "'null'",
      "'x,y'",
      "'it\\'s'",
      "' lead'",
      "'a:b'",
      "'(x)'",
      "x;y",
      "back\\slash",
      "'a,b\\\\c'",
    ],
  );
  assertEquals(
    formatBlob(new Uint8Array([0xaa, 0x00, 0x61, 0x62, 0x5c, 0x78, 0x27])),
    "\\xAA\\x00ab\\x5Cx\\x27",
  );
});

Deno.test("export images are validated before anything is touched", () => {
  const enc = new TextEncoder();
  const image = (manifest: unknown, payload: string) =>
    enc.encode(
      `PROTOTYPER-DUCKDB-EXPORT 1\n${JSON.stringify(manifest)}\n${payload}`,
    );
  const ok = {
    engine: "duckdb",
    version: "1.4.3",
    dir: "__prototyper_export_abc_0",
    files: [{ name: "load.sql", size: 2 }, { name: "schema.sql", size: 3 }],
  };
  const { files } = unpackExport(image(ok, "ab" + "cde"));
  assertEquals(files.map((f) => new TextDecoder().decode(f)), ["ab", "cde"]);
  assertThrows(
    () => unpackExport(enc.encode("SQLite format 3\0")),
    Error,
    "bad header",
  );
  assertThrows(() => unpackExport(image(ok, "abcdef")), Error, "size mismatch");
  assertThrows(
    () => unpackExport(image({ ...ok, dir: "../etc" }, "abcde")),
    Error,
    "bad manifest",
  );
  assertThrows(
    () =>
      unpackExport(
        image(
          { ...ok, files: [{ name: "a/b", size: 0 }, ...ok.files] },
          "abcde",
        ),
      ),
    Error,
    "bad manifest",
  );
});
