import { assertEquals } from "@std/assert";
import { type Cell, decodeCell, encodeCell } from "./types.ts";

Deno.test("encodeCell/decodeCell round-trip every Cell kind", () => {
  const cells: Cell[] = [
    null,
    42,
    -1.5,
    "text ✓",
    9007199254740993n,
    new Uint8Array([0, 255, 16]),
    new Uint8Array(),
  ];
  for (const cell of cells) {
    const encoded = encodeCell(cell);
    assertEquals(JSON.parse(JSON.stringify(encoded)), encoded);
    assertEquals(decodeCell(encoded), cell);
  }
  assertEquals(encodeCell(9007199254740993n), {
    $type: "bigint",
    value: "9007199254740993",
  });
  assertEquals(encodeCell(new Uint8Array([0, 255, 16])), {
    $type: "blob",
    base64: "AP8Q",
  });
});
