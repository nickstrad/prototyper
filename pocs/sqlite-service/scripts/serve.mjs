// Tiny static server for dist/. Usage: node scripts/serve.mjs <dir> <port> [--coi]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const [dir = "dist", port = "4173", flag] = process.argv.slice(2);
const coi = flag === "--coi";
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css" };
createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(dir, path.endsWith("/") ? path + "index.html" : path);
  try {
    const body = await readFile(file);
    const headers = { "content-type": types[extname(file)] ?? "application/octet-stream" };
    if (coi) Object.assign(headers, { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
    res.writeHead(200, headers).end(body);
    console.log(200, req.url);
  } catch {
    res.writeHead(404).end("not found");
    console.log(404, req.url);
  }
}).listen(Number(port), "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port} coi=${coi}`));
