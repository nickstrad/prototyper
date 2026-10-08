// Shared cell normalizer: raw driver values -> contract Cells -> JSON.
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  cellText,
  decodeResult,
  encodeResult,
  normalizeCell,
  normalizeResult,
} from "../../packages/database/sqlite-cells.ts";

Deno.test("normalizeCell keeps safe integers as numbers, unsafe as bigint", () => {
  assertStrictEquals(normalizeCell(42n), 42);
  assertStrictEquals(normalizeCell(9007199254740991n), 9007199254740991);
  assertStrictEquals(normalizeCell(-9007199254740991n), -9007199254740991);
  assertStrictEquals(normalizeCell(9007199254740992n), 9007199254740992n);
  assertStrictEquals(
    normalizeCell(-9223372036854775808n),
    -9223372036854775808n,
  );
  assertStrictEquals(normalizeCell(1.5), 1.5);
  assertStrictEquals(normalizeCell("t"), "t");
  assertStrictEquals(normalizeCell(null), null);
  assertStrictEquals(normalizeCell(undefined), null);
  assertStrictEquals(normalizeCell(true), 1);
  assertStrictEquals(normalizeCell(false), 0);
});

Deno.test("normalizeCell copies any byte view into a Uint8Array", () => {
  const buf = new Uint8Array([9, 0, 255, 16, 9]);
  assertEquals(normalizeCell(buf.buffer), new Uint8Array([9, 0, 255, 16, 9]));
  assertEquals(
    normalizeCell(new DataView(buf.buffer, 1, 3)),
    new Uint8Array([0, 255, 16]),
  );
  const same = new Uint8Array([1]);
  assertStrictEquals(normalizeCell(same), same);
});

Deno.test("encodeResult/decodeResult round-trip through JSON", () => {
  const result = normalizeResult({
    columns: ["i", "big", "b", "n"],
    rows: [[1n, 2n ** 60n, new Uint8Array([0, 255, 16]), null]],
    changes: 0,
    schemaChanged: false,
    truncated: false,
  });
  const json = JSON.stringify(encodeResult(result));
  assertEquals(
    json,
    '{"columns":["i","big","b","n"],"rows":[[1,{"$type":"bigint","value":"1152921504606846976"},{"$type":"blob","base64":"AP8Q"},null]],"changes":0,"schemaChanged":false,"truncated":false}',
  );
  assertEquals(decodeResult(JSON.parse(json)), result);
  assertEquals(result.rows[0].map(cellText), [
    "1",
    "1152921504606846976",
    "x'00ff10'",
    "NULL",
  ]);
});
