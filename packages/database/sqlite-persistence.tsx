import type { DatabaseService } from "../core/types.ts";
import { browserSqliteBackend } from "./sqlite-browser.ts";
import { make } from "./sqlite-service.ts";

/** Fiddle owns the connection and SAH pool; closing the Effect scope releases it.
 * Keep first-open seeding distinct from reset so reload never erases stored data.
 * No headered VFS, eager shell command, or destructive `fresh` option is exposed.
 */
export const sqlitePersistence = (options: {
  readonly schema: string;
  readonly seed: string;
}) =>
  make({
    ...options,
    backend: browserSqliteBackend({ persistence: "opfs-sahpool" }),
  });

/** Display the service's actual result, including the original failure detail. */
export function SqlitePersistenceStatus(
  { persistence }: { readonly persistence: DatabaseService["persistence"] },
) {
  const fallback = persistence.actual === "memory" &&
    persistence.requested === "opfs-sahpool";
  return (
    <section
      aria-label="SQLite persistence"
      style={{ overflowWrap: "anywhere" }}
    >
      <p role="status" data-testid="persistence-status">
        persistence.actual: {fallback ? "memory-fallback" : persistence.actual}
        {persistence.reason ? ` (${persistence.reason})` : ""}
      </p>
      {fallback && (
        <p>
          Changes in this tab are lost when it closes or reloads. Close other
          tabs using this database, then reload to retry persistent storage.
        </p>
      )}
    </section>
  );
}
