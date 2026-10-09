import { assertEquals, assertMatch, assertObjectMatch } from "@std/assert";
import { createInventory } from "./native.ts";

Deno.test("SQLite inventory list/add/remove through the CLI", async () => {
  const host = createInventory();
  try {
    const run = async (line: string) => {
      const r = await host.shell.exec(line);
      assertEquals(r.exitCode, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    assertEquals(await run("inventory list"), [{
      sku: "bolt",
      name: "Steel bolt",
      quantity: 12,
    }]);
    assertEquals(await run(`inventory add washer 'Wide washer' 4`), {
      sku: "washer",
      name: "Wide washer",
      quantity: 4,
    });
    assertEquals(await run("inventory list"), [{
      sku: "bolt",
      name: "Steel bolt",
      quantity: 12,
    }, { sku: "washer", name: "Wide washer", quantity: 4 }]);
    assertEquals(await run("inventory remove washer"), { removed: "washer" });
    assertEquals(await run("inventory list"), [{
      sku: "bolt",
      name: "Steel bolt",
      quantity: 12,
    }]);
  } finally {
    await host.dispose();
  }
});
Deno.test("JSON pipeline between shell and demo preserves Unicode and quotes", async () => {
  const host = createInventory();
  try {
    const r = await host.shell.exec(
      `echo '{"sku":"café","name":"日本語 bolt","quantity":3}' | inventory add --json | jq -r '.name'`,
    );
    assertObjectMatch(r, { stdout: "日本語 bolt\n", stderr: "", exitCode: 0 });
    assertEquals(
      (await host.shell.exec(
        `inventory list --json | jq -c '.[] | select(.sku == "café")'`,
      )).stdout,
      '{"sku":"café","name":"日本語 bolt","quantity":3}\n',
    );
    assertEquals(
      (await host.shell.exec(`inventory add "quote'key" "O'Brien" 0`)).exitCode,
      0,
    );
    assertEquals(
      (await host.shell.exec(`inventory remove "quote'key"`)).exitCode,
      0,
    );
  } finally {
    await host.dispose();
  }
});
Deno.test("shell SQL write is verified through inventory CLI", async () => {
  const host = createInventory();
  try {
    assertEquals(
      (await host.shell.exec(
        `db sql "INSERT INTO inventory VALUES ('shell', 'Shell stock', 9)"`,
      )).exitCode,
      0,
    );
    assertObjectMatch(
      await host.shell.exec(
        `inventory list | jq -c '.[] | select(.sku == "shell")'`,
      ),
      {
        stdout: '{"sku":"shell","name":"Shell stock","quantity":9}\n',
        stderr: "",
        exitCode: 0,
      },
    );
  } finally {
    await host.dispose();
  }
});
Deno.test("invalid writes fail without modifying SQLite", async () => {
  const host = createInventory();
  try {
    for (
      const line of [
        "inventory add x X -1",
        "inventory add x X 1.5",
        "inventory add x X 9007199254740992",
        "inventory add '' X 1",
        "inventory add bolt Duplicate 1",
        "inventory remove missing",
        `echo '{"sku":"x","name":"X","quantity":"1"}' | inventory add --json`,
        `echo '{"sku":"x","name":"X","quantity":1,"extra":true}' | inventory add --json`,
        `echo '[]' | inventory add --json`,
        `echo nope | inventory add --json`,
        "inventory wat",
      ]
    ) {
      const r = await host.shell.exec(line);
      assertEquals(r.exitCode > 0, true, line);
      assertEquals(r.stdout, "");
      assertMatch(r.stderr, /inventory|usage/);
    }
    assertEquals(JSON.parse((await host.shell.exec("inventory list")).stdout), [
      { sku: "bolt", name: "Steel bolt", quantity: 12 },
    ]);
  } finally {
    await host.dispose();
  }
});
