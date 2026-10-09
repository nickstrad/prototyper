import { Data, Effect, Schema } from "effect";
import { Database, sqlString } from "../../packages/database/sqlite-service.ts";
import { encodeCell } from "../../packages/core/types.ts";
import { InventoryItemInput, InventorySku } from "./schema.ts";

export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  readonly message: string;
}> {}
const decodeInput =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (input: unknown): Effect.Effect<S["Type"], InvalidInput> =>
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input)
      .pipe(
        Effect.mapError((error) =>
          new InvalidInput({ message: error.message.split("\n")[0] })
        ),
      );
const decodeSku = decodeInput(InventorySku);
const decodeItem = decodeInput(InventoryItemInput);
const execute = (sql: string) =>
  Effect.flatMap(Database, (db) => db.execute(sql));
export const listInventory = () =>
  execute("SELECT sku, name, quantity FROM inventory ORDER BY sku").pipe(
    Effect.flatMap((r) =>
      r.truncated
        ? Effect.fail(
          new InvalidInput({
            message:
              "inventory exceeds the row limit; query a subset in Database",
          }),
        )
        : Effect.succeed(
          r.rows.map(([sku, name, quantity]) => ({
            sku: encodeCell(sku),
            name: encodeCell(name),
            quantity: encodeCell(quantity),
          })),
        )
    ),
  );
export const addInventory = (input: unknown) =>
  Effect.gen(function* () {
    const { sku, name, quantity } = yield* decodeItem(input);
    yield* execute(
      `INSERT INTO inventory (sku, name, quantity) VALUES (${sqlString(sku)}, ${
        sqlString(name)
      }, ${quantity})`,
    );
    return { sku, name, quantity };
  });
export const removeInventory = (input: unknown) =>
  Effect.gen(function* () {
    const sku = yield* decodeSku(input);
    const result = yield* execute(
      `DELETE FROM inventory WHERE sku = ${sqlString(sku)}`,
    );
    if (result.changes === 0) {
      return yield* Effect.fail(
        new InvalidInput({ message: `inventory item not found: ${sku}` }),
      );
    }
    return { removed: sku };
  });
