import { Effect } from "effect";
import type { DatabaseService } from "../../core/types.ts";
import {
  duckDbHandle,
  type DuckDbServiceOptions,
  make,
} from "../duckdb-service.ts";
import type { TransferFile } from "./mod.ts";

/** OPFS with the existing service's transaction-aware CHECKPOINT after writes. */
export const duckDbPersistence = (
  options: Omit<DuckDbServiceOptions, "persistence">,
) => make({ ...options, persistence: "opfs" });

const identifier = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** Use createTransferTools for capability checking and transfer serialization. */
export async function exportParquet(
  service: DatabaseService,
  table: { name: string; schema?: string },
): Promise<TransferFile> {
  if (!service.capabilities.export.available) {
    throw new Error("Export unavailable");
  }
  const handle = duckDbHandle(service);
  if (!handle) throw new Error("Parquet COPY requires a DuckDB service handle");
  if (
    !table.name || table.name.includes("\0") || table.schema?.includes("\0")
  ) {
    throw new Error("Invalid table identifier");
  }
  const path = `transfer-${crypto.randomUUID()}.parquet`;
  const relation = [table.schema ?? "main", table.name].map(identifier).join(
    ".",
  );
  try {
    await Effect.runPromise(service.execute(
      `COPY ${relation} TO '${path}' (FORMAT PARQUET)`,
      { source: "host" },
    ));
    return {
      bytes: await handle.db.copyFileToBuffer(path),
      name: "table.parquet",
      mediaType: "application/vnd.apache.parquet",
    };
  } finally {
    await handle.db.dropFiles([path]);
  }
}
