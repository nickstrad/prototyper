import type { PrototypeConfig } from "../../packages/core/types.ts";
export const config = {
  name: "inventory",
  database: "sqlite",
  persistence: "memory",
  interfaces: ["cli"],
} as const satisfies PrototypeConfig;
export const panels = ["terminal", "database"] as const;
