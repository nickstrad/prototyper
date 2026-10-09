import { Effect, type ManagedRuntime, Schema } from "effect";
import { Database } from "../../packages/database/sqlite-service.ts";
import type { DatabaseError, QueryResult } from "../../packages/core/types.ts";
import { encodeCell } from "../../packages/core/types.ts";
import {
  created,
  failure,
  makeApiHandler,
  ok,
  route,
} from "../../packages/api/router.ts";

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const bookmarks = (r: QueryResult) =>
  r.rows.map(([id, title, url]) => ({
    id: encodeCell(id),
    title: encodeCell(title),
    url: encodeCell(url),
  }));
const PostBody = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
});

const Title = Schema.String.check(
  Schema.makeFilter((value) => !!value.trim(), {
    message: "title must contain 1–200 characters",
  }),
  Schema.isMaxLength(200, {
    message: "title must contain 1–200 characters",
  }),
  Schema.makeFilter((value) => !value.includes("\0"), {
    message: "title must contain 1–200 characters",
  }),
);

const BookmarkUrl = Schema.String.check(
  Schema.isMaxLength(2048, {
    message: "url must be an http or https URL (up to 2048 characters)",
  }),
  Schema.makeFilter((value) => !value.includes("\0"), {
    message: "url must be an http or https URL (up to 2048 characters)",
  }),
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return false;
    return ["http:", "https:"].includes(new URL(value).protocol);
  }, { message: "url must be an http or https URL" }),
);

const BookmarkId = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!/^[1-9]\d*$/.test(value)) return false;
    return Number.isSafeInteger(Number(value));
  }, { message: "id must be a positive safe integer" }),
);

const decodeInput = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
  message: string,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => failure(400, "InvalidInput", message)),
  );

/** Standard Request/Response handler, shared by every explorer request. */
export const createApi = (
  runtime: ManagedRuntime.ManagedRuntime<Database, never>,
) =>
  makeApiHandler<Database, DatabaseError>({
    runtime,
    routes: [
      route("GET", "/bookmarks", () =>
        Effect.gen(function* () {
          const db = yield* Database;
          const result = yield* db.execute(
            "SELECT id, title, url FROM bookmarks ORDER BY id",
          );
          if (result.truncated) {
            return yield* Effect.fail(
              failure(
                500,
                "ListTooLarge",
                "Result exceeds the demo row limit; remove bookmarks in Database.",
              ),
            );
          }
          return ok(bookmarks(result));
        })),
      route("POST", "/bookmarks", ({ json }) =>
        Effect.gen(function* () {
          const body = yield* decodeInput(
            PostBody,
            yield* json,
            "body must be a JSON object with title and url strings",
          );
          const title = yield* decodeInput(
            Title,
            body.title,
            "title must contain 1–200 characters",
          );
          const url = yield* decodeInput(
            BookmarkUrl,
            body.url,
            "url must be an http or https URL",
          );
          const parsed = new URL(url);
          const db = yield* Database;
          const result = yield* db.execute(
            `INSERT INTO bookmarks(title, url) VALUES (${
              quote(title.trim())
            }, ${quote(parsed.href)}) RETURNING id, title, url`,
            { source: "app" },
          );
          const bookmark = bookmarks(result)[0];
          return created(bookmark, `/bookmarks/${bookmark.id}`);
        })),
      route("DELETE", "/bookmarks/:id", ({ params }) =>
        Effect.gen(function* () {
          const rawId = yield* decodeInput(
            BookmarkId,
            params.id,
            "id must be a positive safe integer",
          );
          const id = Number(rawId);
          const db = yield* Database;
          const result = yield* db.execute(
            `DELETE FROM bookmarks WHERE id = ${id} RETURNING id, title, url`,
            { source: "app" },
          );
          if (!result.rows.length) {
            return yield* Effect.fail(
              failure(404, "BookmarkNotFound", `Bookmark ${id} not found`),
            );
          }
          return ok(bookmarks(result)[0]);
        })),
    ],
    mapError: (e) => failure(500, e._tag, e.message),
  });
