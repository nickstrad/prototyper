/// <reference lib="webworker" />
// Own worker using the OO1 API (Worker1/Promiser1 are deprecated upstream as of 2026-04-15).
import sqlite3InitModule, { type Database, type SAHPoolUtil, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { wasmDeserializeInto, wasmExecute } from "./wasm-exec.ts";

export type Vfs = "memory" | "opfs" | "opfs-sahpool" | "opfs-wl";
export type Request = { id: number; op: string; args?: any };

const logs: string[] = [];
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...a: unknown[]) => {
    logs.push(`${level}: ${a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(" ")}`);
    orig(...a);
  };
}

let sqlite3: Sqlite3Static | undefined;
let pool: SAHPoolUtil | undefined;
let db: Database | undefined;
let current: { vfs: Vfs; filename: string } | undefined;

const errInfo = (e: unknown) =>
  e instanceof Error
    ? { name: e.name, message: e.message, resultCode: (e as { resultCode?: number }).resultCode }
    : { name: "Unknown", message: String(e) };

const init = async () => (sqlite3 ??= await sqlite3InitModule());

const removeOpfsEntry = async (name: string) => {
  const root = await navigator.storage.getDirectory();
  for (const n of [name, `${name}-journal`, `${name}-wal`]) {
    try {
      await root.removeEntry(n.replace(/^\//, ""));
    } catch { /* absent */ }
  }
};

const ops: Record<string, (args: any) => unknown> = {
  async probe() {
    const s = await init();
    const find = (n: string) => !!s.capi.sqlite3_vfs_find(n);
    return {
      libVersion: s.version.libVersion,
      vfsList: s.capi.sqlite3_js_vfs_list(),
      vfsFind: { opfs: find("opfs"), "opfs-wl": find("opfs-wl"), "opfs-sahpool": find("opfs-sahpool"), kvvfs: find("kvvfs") },
      hasOpfsNamespace: "opfs" in s,
      oo1Keys: Object.keys(s.oo1),
      installOpfsSAHPoolVfs: typeof s.installOpfsSAHPoolVfs,
      crossOriginIsolated: self.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      atomicsWaitAsync: typeof (Atomics as { waitAsync?: unknown }).waitAsync,
      opfsGetDirectory: typeof navigator.storage?.getDirectory,
      createSyncAccessHandle: typeof (globalThis as any).FileSystemFileHandle?.prototype?.createSyncAccessHandle,
      bigIntEnabled: (s.wasm as { bigIntEnabled?: boolean }).bigIntEnabled, // not in the .d.ts, present at runtime
      openWithVfsOpfs: (() => {
        try {
          const d = new s.oo1.DB({ filename: "/probe-opfs.sqlite3", flags: "c", vfs: "opfs" });
          const name = d.dbVfsName();
          d.close();
          return { ok: true, dbVfsName: name };
        } catch (e) {
          return { ok: false, error: errInfo(e) };
        }
      })(),
      logs: logs.splice(0),
    };
  },
  async installSahpool(args: { name?: string; clearOnInit?: boolean } = {}) {
    const s = await init();
    pool = await s.installOpfsSAHPoolVfs({ name: args.name, clearOnInit: args.clearOnInit });
    return {
      vfsName: pool.vfsName,
      vfsFindAfter: !!s.capi.sqlite3_vfs_find(pool.vfsName),
      poolHasOpfsSAHPoolDb: typeof pool.OpfsSAHPoolDb,
      oo1HasOpfsSAHPoolDb: "OpfsSAHPoolDb" in s.oo1,
      capacity: pool.getCapacity(),
      files: pool.getFileNames(),
    };
  },
  async open(args: { vfs: Vfs; filename?: string; fresh?: boolean; bytes?: Uint8Array }) {
    const s = await init();
    db?.close();
    db = undefined;
    const filename = args.filename ?? "/tasks.sqlite3";
    switch (args.vfs) {
      case "memory":
        db = new s.oo1.DB(":memory:", "c");
        if (args.bytes) wasmDeserializeInto(s, db, args.bytes);
        break;
      case "opfs-sahpool":
        if (!pool) pool = await s.installOpfsSAHPoolVfs({});
        if (args.fresh) pool.unlink(filename);
        if (args.bytes) await pool.importDb(filename, args.bytes);
        db = new pool.OpfsSAHPoolDb(filename);
        break;
      case "opfs":
      case "opfs-wl": {
        const Ctor = args.vfs === "opfs" ? s.oo1.OpfsDb : s.oo1.OpfsWlDb;
        if (!Ctor) throw new Error(`sqlite3.oo1.${args.vfs === "opfs" ? "OpfsDb" : "OpfsWlDb"} is not available (VFS not installed)`);
        if (args.fresh) await removeOpfsEntry(filename);
        if (args.bytes) await Ctor.importDb(filename, args.bytes);
        db = new Ctor(filename, "c");
        break;
      }
    }
    current = { vfs: args.vfs, filename };
    return { vfs: args.vfs, filename: db!.filename, dbVfsName: db!.dbVfsName?.() };
  },
  exec(args: { sql: string; maxRows?: number }) {
    if (!db) throw new Error("no open database");
    return wasmExecute(db, args.sql, args.maxRows);
  },
  export() {
    if (!db) throw new Error("no open database");
    return sqlite3!.capi.sqlite3_js_db_export(db);
  },
  // Probe: can importDb replace a file while a handle is open on it?
  async importLive(args: { bytes: Uint8Array }) {
    if (!db || !current) throw new Error("no open database");
    const s = sqlite3!;
    let importResult: unknown;
    try {
      if (current.vfs === "opfs-sahpool") importResult = await pool!.importDb(current.filename, args.bytes);
      else if (current.vfs === "memory") {
        wasmDeserializeInto(s, db, args.bytes);
        importResult = "sqlite3_deserialize on live handle";
      } else importResult = await s.oo1.OpfsDb.importDb(current.filename, args.bytes);
    } catch (e) {
      importResult = { error: errInfo(e) };
    }
    let sameHandleRead: unknown;
    try {
      sameHandleRead = wasmExecute(db, "SELECT count(*) FROM tasks");
    } catch (e) {
      sameHandleRead = { error: errInfo(e) };
    }
    return { importResult, sameHandleRead };
  },
  close() {
    db?.close();
    db = undefined;
    return true;
  },
  pauseSahpool() {
    db?.close();
    db = undefined;
    pool!.pauseVfs();
    return { isPaused: pool!.isPaused(), vfsFind: !!sqlite3!.capi.sqlite3_vfs_find(pool!.vfsName) };
  },
  async unpauseSahpool() {
    await pool!.unpauseVfs();
    return { isPaused: pool!.isPaused() };
  },
  logs: () => logs.splice(0),
};

self.onmessage = async (ev: MessageEvent<Request>) => {
  const { id, op, args } = ev.data;
  try {
    const result = await ops[op](args);
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: errInfo(e) });
  }
};
self.postMessage({ ready: true });
