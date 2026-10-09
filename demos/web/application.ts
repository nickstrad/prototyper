import { Effect, PubSub } from "effect";
import type { DatabaseService } from "../../packages/core/types.ts";
import { sqlString } from "../../packages/database/sqlite-service.ts";

export const schema =
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)";
export const seed =
  "INSERT INTO notes(id, body) VALUES (1, 'Welcome to your notes.'), (2, 'Try editing a note from the Database shell.')";
export interface Note {
  id: number;
  body: string;
}

export function notesApplication(db: DatabaseService) {
  const list = () =>
    db.execute("SELECT id, body FROM notes ORDER BY id").pipe(
      Effect.map((result) => {
        if (result.truncated) throw new Error("Too many notes to display.");
        return result.rows.map(([id, body]): Note => {
          if (
            typeof id !== "number" || !Number.isSafeInteger(id) ||
            typeof body !== "string"
          ) {
            throw new Error(
              "Unreadable notes; repair them in Database or reset.",
            );
          }
          return { id, body };
        });
      }),
    );
  const bodySql = (body: string) => {
    if (!body.trim() || body.includes("\0")) {
      throw new Error("Enter a non-empty note without NUL characters.");
    }
    return sqlString(body);
  };
  const idSql = (id: number) => {
    if (!Number.isSafeInteger(id)) throw new Error("Invalid note ID.");
    return String(id);
  };
  return {
    list,
    create: (body: string) =>
      Effect.suspend(() =>
        db.execute(`INSERT INTO notes(body) VALUES (${bodySql(body)})`, {
          source: "app",
        })
      ),
    edit: (id: number, body: string) =>
      Effect.suspend(() =>
        db.execute(
          `UPDATE notes SET body = ${bodySql(body)} WHERE id = ${idSql(id)}`,
          { source: "app" },
        )
      ),
    remove: (id: number) =>
      Effect.suspend(() =>
        db.execute(`DELETE FROM notes WHERE id = ${idSql(id)}`, {
          source: "app",
        })
      ),
    reset: () => db.reset(),
    watch: (
      receive: (notes: Note[]) => void,
      failed: (error: unknown) => void,
    ) =>
      Effect.scoped(Effect.gen(function* () {
        const subscription = yield* db.subscribe;
        const reload = Effect.promise(() =>
          Effect.runPromise(list()).then(receive, failed)
        );
        yield* reload;
        yield* Effect.forever(
          PubSub.take(subscription).pipe(Effect.flatMap(() => reload)),
        );
      })),
  };
}
