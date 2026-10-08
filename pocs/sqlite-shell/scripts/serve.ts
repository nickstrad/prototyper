// Tiny static server for the POC. Root = pocs/sqlite-shell.
// PORT=8787 deno run --allow-net --allow-read --allow-env scripts/serve.ts
// Set COI=1 to add COOP/COEP headers (cross-origin isolation), to test both modes.
import { serveDir } from "jsr:@std/http@1/file-server";
const root = new URL("..", import.meta.url).pathname;
const port = Number(Deno.env.get("PORT") ?? 8787);
const coi = Deno.env.get("COI") === "1";
Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  const res = await serveDir(req, { fsRoot: root, quiet: true });
  if (coi) {
    res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
  return res;
});
console.log(`serving ${root} on http://127.0.0.1:${port} coi=${coi}`);
