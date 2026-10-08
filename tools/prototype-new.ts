import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrototypeConfig } from "../packages/core/types.ts";

export type GeneratorConfig = PrototypeConfig;
const interfaceOrder = ["cli", "api", "web"] as const;

/** Strict runtime validation; normalize interface order for reproducible output. */
export function parseConfig(value: unknown): GeneratorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  const c = value as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!["name", "database", "persistence", "interfaces"].includes(key)) {
      throw new Error(`unknown config key: ${key}`);
    }
  }
  if (typeof c.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(c.name)) {
    throw new Error("name must be a lowercase slug (1–64 characters)");
  }
  if (c.database !== "sqlite" && c.database !== "duckdb") {
    throw new Error("database must be sqlite or duckdb");
  }
  if (
    c.persistence !== "memory" &&
    c.persistence !== (c.database === "sqlite" ? "opfs-sahpool" : "opfs")
  ) {
    throw new Error("persistence is not supported by the selected database");
  }
  if (
    !Array.isArray(c.interfaces) ||
    c.interfaces.some((i) => !interfaceOrder.includes(i)) ||
    new Set(c.interfaces).size !== c.interfaces.length
  ) {
    throw new Error(
      "interfaces must be a unique array containing cli, api, and/or web",
    );
  }
  return {
    name: c.name,
    database: c.database,
    persistence: c.persistence as GeneratorConfig["persistence"],
    interfaces: interfaceOrder.filter((i) =>
      (c.interfaces as unknown[]).includes(i)
    ),
  };
}

/** Emits source modules for this checkout; never registers or modifies the host. */
export async function generatePrototype(
  config: unknown,
  destination: string,
): Promise<string[]> {
  const c = parseConfig(config);
  const output = resolve(destination);
  const root = fileURLToPath(new URL("../", import.meta.url));
  let packages = relative(output, resolve(root, "packages")).split(sep).join(
    "/",
  );
  if (!packages.startsWith(".")) packages = `./${packages}`;
  const values: Record<string, string> = {
    PACKAGES: packages,
    NAME: c.name,
    CONFIG: JSON.stringify(c, null, 2),
    PERSISTENCE: JSON.stringify(c.persistence),
  };
  const entries: [string, string][] = [
    ["config.ts", "config.ts"],
    ["schema.ts", "schema.ts"],
    ["application.ts", "application.ts"],
    ["database.ts", `database-${c.database}.ts`],
    ["README.md", "README.md"],
  ];
  if (c.database === "sqlite") {
    entries.push(["native.ts", "native.ts"], ["proof.ts", "proof.ts"]);
  }
  for (const iface of c.interfaces) {
    const file = { cli: "commands.ts", api: "api.ts", web: "App.tsx" }[iface];
    entries.push([file, file]);
  }
  // Read/render before claiming the destination, so template failures leave no output.
  const rendered = await Promise.all(entries.map(async ([name, template]) => {
    const source = await Deno.readTextFile(
      new URL(`../templates/prototype/${template}.tmpl`, import.meta.url),
    );
    return [
      name,
      source.replace(/\{\{([A-Z]+)\}\}/g, (_, key: string) => {
        if (!(key in values)) throw new Error(`unknown template token: ${key}`);
        // Escape path characters inside TypeScript string literals.
        return key === "PACKAGES"
          ? JSON.stringify(values[key]).slice(1, -1)
          : values[key];
      }),
    ] as const;
  }));
  // mkdir without recursive is the atomic no-overwrite gate (including symlinks).
  await Deno.mkdir(output);
  try {
    for (const [name, source] of rendered) {
      await Deno.writeTextFile(resolve(output, name), source, {
        createNew: true,
      });
    }
  } catch (error) {
    await Deno.remove(output, { recursive: true });
    throw error;
  }
  return rendered.map(([name]) => name).sort();
}

if (import.meta.main) {
  try {
    if (Deno.args.length !== 2) {
      throw new Error(
        "usage: prototype-new.ts CONFIG.json DESTINATION (parent must exist)",
      );
    }
    const files = await generatePrototype(
      JSON.parse(await Deno.readTextFile(Deno.args[0])),
      Deno.args[1],
    );
    console.log(files.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
