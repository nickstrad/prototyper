// Main-thread RPC client for src/worker.ts and a browser DriverFactory for the Effect service.
import type { QueryResult } from "./protocol.ts";
import type { DriverFactory } from "./service.ts";
import type { Vfs } from "./worker.ts";

export class WorkerRpcError extends Error {
  constructor(public readonly info: { name: string; message: string; resultCode?: number }) {
    super(info.message);
    this.name = info.name;
  }
}

export type Rpc = {
  call<T = unknown>(op: string, args?: unknown): Promise<T>;
  terminate(): void;
};

export const spawnWorker = async (): Promise<Rpc> => {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let next = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  await new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(`worker failed to load: ${e.message}`));
    worker.onmessage = (ev) => {
      if (ev.data?.ready) return resolve();
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      ev.data.ok ? p.resolve(ev.data.result) : p.reject(new WorkerRpcError(ev.data.error));
    };
  });
  return {
    call: (op, args) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, args });
      }),
    terminate: () => worker.terminate(),
  };
};

/** One worker per open handle; close() closes the db and terminates the worker. */
export const workerFactory = (vfs: Vfs, filename = "/tasks.sqlite3", hooks: { onClose?: () => void } = {}): DriverFactory => ({
  label: `sqlite-wasm ${vfs} (worker)`,
  capabilities: {
    persistence: vfs === "memory" ? "memory" : vfs === "opfs-sahpool" ? "opfs-sahpool" : "opfs",
    export: true,
    import: true,
    cancellation: false,
  },
  open: async ({ fresh, bytes }) => {
    const rpc = await spawnWorker();
    try {
      await rpc.call("open", { vfs, filename, fresh, bytes });
    } catch (e) {
      rpc.terminate();
      throw e;
    }
    return {
      execute: (sql) => rpc.call<QueryResult>("exec", { sql }),
      exportBytes: () => rpc.call<Uint8Array>("export"),
      close: async () => {
        await rpc.call("close").catch(() => undefined);
        rpc.terminate();
        hooks.onClose?.();
      },
    };
  },
});
