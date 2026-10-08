// Populates public/vendor/duckdb/ for the DuckDB DatabaseService (D2):
//
// - the `eh` engine bundle (wasm + classic worker), copied from the locked
//   @duckdb/duckdb-wasm@1.32.0 package in node_modules;
// - the `json` and `parquet` extensions for engine v1.4.3 / wasm_eh,
//   downloaded once from the official extension repository.
//
// Every file is checked against the size and sha256 pinned below (recorded in
// public/vendor/duckdb/PROVENANCE.md). Files already present with the right
// hash are left alone, so a second run needs no network. Nothing is loaded
// from a CDN at runtime: the service points `custom_extension_repository` at
// `<base>vendor/duckdb/extensions`.
//
//   deno run -A scripts/fetch-duckdb-extensions.ts          # populate + verify
//   deno run -A scripts/fetch-duckdb-extensions.ts --check  # verify only
// Stdlib only (URL paths), so running it never touches deno.lock.
const OUT = new URL("../public/vendor/duckdb/", import.meta.url);
const PKG = new URL(
  "../node_modules/@duckdb/duckdb-wasm/dist/",
  import.meta.url,
);
const ENGINE = "v1.4.3";
const PLATFORM = "wasm_eh";
const REPO = "https://extensions.duckdb.org";

type Pinned = {
  /** Path under public/vendor/duckdb/. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** Local file in the locked npm package, or a download URL. */
  readonly from: { readonly file: URL } | { readonly url: string };
};

const extension = (name: string, size: number, sha256: string): Pinned => ({
  path: `extensions/${ENGINE}/${PLATFORM}/${name}.duckdb_extension.wasm`,
  size,
  sha256,
  from: { url: `${REPO}/${ENGINE}/${PLATFORM}/${name}.duckdb_extension.wasm` },
});

export const PINNED: readonly Pinned[] = [
  {
    path: "duckdb-eh.wasm",
    size: 34242586,
    sha256: "4c221bfa59c11f24dbd750e70c90b9252eca6eec5633936e6a2ec766e55fd879",
    from: { file: new URL("duckdb-eh.wasm", PKG) },
  },
  {
    path: "duckdb-browser-eh.worker.js",
    size: 772759,
    sha256: "f8ab72b6b90b3ad83077d47426d4a99d5d9a4c7e07cba1a2be37d655adc7c1ab",
    from: { file: new URL("duckdb-browser-eh.worker.js", PKG) },
  },
  extension(
    "json",
    820646,
    "b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9",
  ),
  extension(
    "parquet",
    3045039,
    "22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55",
  ),
];

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const readIfExists = async (path: URL): Promise<Uint8Array | null> => {
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
};

const matches = async (pin: Pinned, bytes: Uint8Array | null) =>
  bytes !== null && bytes.length === pin.size &&
  (await sha256(bytes)) === pin.sha256;

const source = async (pin: Pinned): Promise<Uint8Array> => {
  if ("file" in pin.from) return await Deno.readFile(pin.from.file);
  const res = await fetch(pin.from.url);
  if (!res.ok) throw new Error(`${pin.from.url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

const main = async (checkOnly: boolean): Promise<number> => {
  let failures = 0;
  for (const pin of PINNED) {
    const target = new URL(pin.path, OUT);
    if (await matches(pin, await readIfExists(target))) {
      console.log(`ok       ${pin.path} (${pin.size} B)`);
      continue;
    }
    if (checkOnly) {
      console.error(`MISSING  ${pin.path} (missing or hash mismatch)`);
      failures++;
      continue;
    }
    const bytes = await source(pin);
    if (!(await matches(pin, bytes))) {
      console.error(
        `MISMATCH ${pin.path}: got ${bytes.length} B sha256 ${await sha256(
          bytes,
        )}, pinned ${pin.size} B ${pin.sha256}`,
      );
      failures++;
      continue;
    }
    await Deno.mkdir(new URL(".", target), { recursive: true });
    await Deno.writeFile(target, bytes);
    const from = "file" in pin.from ? "node_modules" : pin.from.url;
    console.log(`wrote    ${pin.path} (${pin.size} B) from ${from}`);
  }
  return failures;
};

if (import.meta.main) {
  const failures = await main(Deno.args.includes("--check"));
  if (failures > 0) {
    console.error(`${failures} file(s) failed verification`);
    Deno.exit(1);
  }
}
