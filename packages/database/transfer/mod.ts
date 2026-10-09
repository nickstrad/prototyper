import { Effect } from "effect";
import type { Capability, DatabaseService } from "../../core/types.ts";

export interface TransferFile {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly mediaType: string;
}

/** An import may have succeeded even if an interface failed to reconnect. */
export class TransferImportError extends AggregateError {
  constructor(
    readonly imported: boolean,
    errors: readonly unknown[],
  ) {
    super(
      errors,
      imported
        ? "Database imported, but an interface failed to reconnect"
        : "Import failed; inspect errors for recovery or reconnect failures",
    );
    this.name = "TransferImportError";
  }
}

const requireCapability = (capability: Capability, operation: string) => {
  if (!capability.available) {
    throw new Error(`${operation} unavailable: ${capability.reason}`);
  }
};

/**
 * One controller per DatabaseService. Transfers are serialized. Hosts must
 * pause their other writers/transactions during transfers. The service owns
 * atomic snapshot recovery; this wrapper must not restore a stale second copy.
 */
export function createTransferTools(service: DatabaseService) {
  const interfaces = new Set<{ reconnect: () => void | Promise<void> }>();
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => {});
    return next;
  };
  return {
    capabilities: {
      export: service.capabilities.export,
      import: service.capabilities.import,
      parquet: service.engine === "duckdb" ? service.capabilities.export : {
        available: false,
        reason: "Parquet COPY requires DuckDB",
      } as Capability,
      persistence: service.capabilities.persistence,
    },
    persistence: service.persistence,
    /** Register refresh/rebind work; unregister on interface disposal. */
    registerInterface(reconnect: () => void | Promise<void>): () => void {
      const registration = { reconnect };
      interfaces.add(registration);
      return () => {
        interfaces.delete(registration);
      };
    },
    exportDatabase(): Promise<TransferFile> {
      return serialized(async () => {
        requireCapability(service.capabilities.export, "Export");
        return {
          bytes: await Effect.runPromise(service.exportBytes()),
          name: service.engine === "sqlite"
            ? "database.sqlite3"
            : "database.duckdb-export",
          mediaType: "application/octet-stream",
        };
      });
    },
    importDatabase(bytes: Uint8Array): Promise<void> {
      // Own the input before queuing: FileReader/caller buffers may be reused.
      const image = new Uint8Array(bytes);
      return serialized(async () => {
        requireCapability(service.capabilities.import, "Import");
        let imported = false;
        const errors: unknown[] = [];
        try {
          await Effect.runPromise(service.importBytes(image));
          imported = true;
        } catch (error) {
          errors.push(error);
        }
        // Recovery also replaces SQLite's connection, without an import event.
        // Await every interface even when another reconnect throws.
        for (const registration of [...interfaces]) {
          if (!interfaces.has(registration)) continue;
          try {
            await registration.reconnect();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new TransferImportError(imported, errors);
      });
    },
    /** Qualified names are explicit parts, never parsed as SQL or split on dots. */
    exportParquet(
      table: { name: string; schema?: string },
    ): Promise<TransferFile> {
      const selected = { ...table };
      return serialized(async () => {
        requireCapability(service.capabilities.export, "Export");
        if (service.engine !== "duckdb") {
          throw new Error("Parquet COPY requires DuckDB");
        }
        const { exportParquet } = await import("./duckdb.ts");
        return exportParquet(service, selected);
      });
    },
  };
}
