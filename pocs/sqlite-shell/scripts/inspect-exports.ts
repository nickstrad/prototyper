// Usage: deno run --allow-read scripts/inspect-exports.ts vendor/fiddle/fiddle-module.wasm
const path = Deno.args[0] ?? new URL("../vendor/fiddle/fiddle-module.wasm", import.meta.url).pathname;
const mod = await WebAssembly.compile(await Deno.readFile(path));
const exps = WebAssembly.Module.exports(mod);
const imps = WebAssembly.Module.imports(mod);
const names = new Set(exps.map((e) => e.name));
const want = [
  "fiddle_exec", "fiddle_the_db", "fiddle_db_handle", "fiddle_db_filename", "fiddle_db_vfs",
  "fiddle_reset_db", "fiddle_export_db", "fiddle_interrupt", "fiddle_main", "fiddle_get_prompt",
  "sqlite3_prepare_v2", "sqlite3_prepare_v3", "sqlite3_step", "sqlite3_column_count", "sqlite3_column_name",
  "sqlite3_column_text", "sqlite3_column_type", "sqlite3_column_int64", "sqlite3_column_double",
  "sqlite3_column_blob", "sqlite3_column_bytes", "sqlite3_finalize", "sqlite3_exec", "sqlite3_changes",
  "sqlite3_changes64", "sqlite3_errmsg", "sqlite3_interrupt", "sqlite3_serialize", "sqlite3_deserialize",
  "sqlite3_bind_int", "sqlite3_bind_int64", "sqlite3_bind_double", "sqlite3_bind_text", "sqlite3_bind_blob",
  "sqlite3_bind_null", "sqlite3_bind_parameter_count", "sqlite3_bind_parameter_index",
  "sqlite3_update_hook", "sqlite3_commit_hook", "sqlite3_total_changes", "sqlite3_last_insert_rowid",
  "malloc", "free", "sqlite3_malloc", "sqlite3_free",
];
console.log(`file: ${path}`);
console.log(`exports: ${exps.length} (functions: ${exps.filter((e) => e.kind === "function").length})  imports: ${imps.length}`);
for (const w of want) console.log(`${names.has(w) ? "YES" : "no "}  ${w}`);
console.log("\nall fiddle_* exports:", [...names].filter((n) => n.startsWith("fiddle")).join(", "));
const bind = [...names].filter((n) => n.startsWith("sqlite3_bind_"));
console.log("sqlite3_bind_* exports:", bind.join(", "));
console.log("sqlite3_* export count:", [...names].filter((n) => n.startsWith("sqlite3_")).length);
console.log("non-function exports:", exps.filter((e) => e.kind !== "function").map((e) => `${e.name}:${e.kind}`).join(", "));
if (Deno.args.includes("--all")) console.log([...names].sort().join("\n"));
