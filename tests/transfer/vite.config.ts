import { defineConfig } from "vite";
import process from "node:process";

// Mutation transforms operate in memory; reference slices remain read-only.
const mutation = process.env.R8_MUTATION;
export default defineConfig({
  plugins: [{
    name: "r8-mutation",
    enforce: "pre",
    transform(code, id) {
      const rules: Record<string, [string, string, string]> = {
        roundtrip: [
          "/transfer/mod.ts",
          "service.importBytes(image)",
          "Effect.void",
        ],
        recovery: ["/sqlite-service.ts", "bytes: snapshot", "bytes: undefined"],
        checkpoint: [
          "/duckdb-service.ts",
          'const opfs = engine.persistence.actual === "opfs";',
          "const opfs = false;",
        ],
        checkpoint_sql: [
          "/duckdb-service.ts",
          'await c.query("CHECKPOINT");',
          "/* SQL-only CHECKPOINT omission */",
        ],
        reload: [
          "/transfer/duckdb.ts",
          'persistence: "opfs"',
          'persistence: "memory"',
        ],
        reconnect: ["/transfer/mod.ts", "[...interfaces]", "[]"],
      };
      const rule = mutation && rules[mutation];
      if (!rule || !id.endsWith(rule[0])) return;
      if (!code.includes(rule[1])) {
        throw new Error(`Mutation did not match: ${mutation}`);
      }
      console.warn(`R8 mutation applied: ${mutation}`);
      return code.replaceAll(rule[1], rule[2]);
    },
  }],
  worker: { format: "iife" },
  build: {
    outDir: "dist-r8",
    rollupOptions: { input: "tests/transfer/index.html" },
  },
});
