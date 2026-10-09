import { Schema } from "effect";

const inventoryText = (field: string) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.trim().length > 0, {
      message: `${field} must be nonblank text`,
    }),
    Schema.isMaxLength(1000, {
      message: `${field} must be at most 1000 characters`,
    }),
    Schema.makeFilter((value) => !value.includes("\0"), {
      message: `${field} must not contain NUL`,
    }),
    Schema.makeFilter((value) => value.isWellFormed(), {
      message: `${field} must not contain lone surrogates`,
    }),
  );

export const InventorySku = inventoryText("sku");
export const InventoryItemInput = Schema.Struct({
  sku: InventorySku,
  name: inventoryText("name"),
  quantity: Schema.Number.check(
    Schema.isInt({ message: "quantity must be a nonnegative safe integer" }),
    Schema.isGreaterThanOrEqualTo(0, {
      message: "quantity must be a nonnegative safe integer",
    }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, {
      message: "quantity must be a nonnegative safe integer",
    }),
  ),
});

export const schema = `CREATE TABLE inventory (
  sku TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0 AND quantity <= 9007199254740991)
)`;
export const seed = `INSERT INTO inventory VALUES ('bolt', 'Steel bolt', 12)`;
