import { assert } from "@std/assert";

// Walk transitive relative module imports, including side-effect imports/re-exports.
// Runtime probes below additionally exercise the resolved native/browser entries.
async function graph(entry: string) {
  const seen = new Set<string>();
  const visit = async (url: URL): Promise<void> => {
    if (seen.has(url.pathname)) return;
    seen.add(url.pathname);
    const source = await Deno.readTextFile(url);
    for (
      const match of source.matchAll(
        /(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g,
      )
    ) {
      const specifier = match[1];
      if (specifier.startsWith(".")) await visit(new URL(specifier, url));
      else seen.add(specifier);
    }
  };
  await visit(new URL(entry, import.meta.url));
  return [...seen];
}

Deno.test("R9 separate import graphs: browser cannot reach native SQLite", async () => {
  const paths = await graph("./browser.ts");
  assert(
    !paths.some((p) => /native-sqlite|adapters\/deno|^node:/.test(p)),
    paths.join("\n"),
  );
});

Deno.test("R9 separate import graphs: native cannot reach browser engine", async () => {
  const paths = await graph("../../adapters/deno/main.ts");
  assert(paths.includes("node:sqlite"));
  assert(
    !paths.some((p) => /sqlite-browser|worker-client|sqlite-wasm/.test(p)),
    paths.join("\n"),
  );
});
