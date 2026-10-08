// A portable transcript executed unchanged on native and real browser hosts.
import type { CommandResult } from "../../packages/core/types.ts";

export interface ScenarioHost {
  command(argv: readonly string[], stdin?: string): Promise<CommandResult>;
  fetch(request: Request): Promise<Response>;
}

export async function transcript(host: ScenarioHost) {
  const results: unknown[] = [];
  const cli = async (...argv: string[]) => {
    const result = await host.command(argv);
    results.push({ argv, ...result });
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await host.fetch(
      new Request(`http://localhost${path}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    );
    results.push({
      method,
      path,
      status: response.status,
      body: await response.json(),
    });
  };
  await cli("tasks", "list", "--json");
  await cli("tasks", "create", "--json", "From CLI ' ☃");
  await api("GET", "/tasks/4");
  await api("PATCH", "/tasks/4", { title: "API update", completed: true });
  await cli("tasks", "get", "4", "--json");
  await api("POST", "/tasks", { title: "From API" });
  await cli("tasks", "complete", "5", "--json");
  await api("GET", "/tasks/5");
  await cli("db", "sql", "INSERT INTO tasks VALUES (9, 'SQL', 0, 'fixed')");
  await api("POST", "/sql", {
    sql: "UPDATE tasks SET title = 'SQL API' WHERE id = 9",
  });
  await cli("tasks", "get", "9", "--json");
  await api("POST", "/sql", {
    sql: "SELECT 9007199254740993 AS big, x'00ff' AS blob, NULL AS n, 1.5 AS f",
  });
  await cli("db", "sql", "--json", "SELECT id, title FROM tasks ORDER BY id");
  await api("POST", "/tasks", { title: " " });
  await cli("tasks", "create", " ");
  await api("GET", "/tasks/404");
  await cli("tasks", "get", "404");
  await api("PATCH", "/tasks/4", { completed: "true" });
  await cli("tasks", "update", "4", "--completed", "bad");
  await api("POST", "/sql", {
    sql: "INSERT INTO tasks VALUES (10, 'no', 0, 'x'); SELECT 1",
  });
  await api("POST", "/sql", { sql: "SELECT 1", maxRows: 0 });
  await cli("tasks", "unknown");
  await cli("db", "sql", "UPDATE tasks SET completed = 7 WHERE id = 9");
  await api("GET", "/tasks/9");
  await cli("tasks", "get", "9");
  await api("DELETE", "/tasks/4");
  await cli("tasks", "get", "4");
  await api("POST", "/reset");
  await cli("tasks", "list", "--json");
  return results;
}

/** Engine failure semantics; raw diagnostics are retained for review. */
export async function sqlFailures(host: ScenarioHost) {
  const operations = [
    "SELECT * FROM missing_r9",
    "SELEC 1",
    "INSERT INTO tasks VALUES (1, 'duplicate', 0, 'fixed')",
    "INSERT INTO tasks VALUES (8, 'partial', 0, 'fixed'); SELECT * FROM missing_r9",
    "SELECT id, title FROM tasks WHERE id = 8",
  ];
  const results = [];
  for (const sql of operations) {
    results.push(await host.command(["db", "sql", "--json", sql]));
  }
  const response = await host.fetch(
    new Request("http://local/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT * FROM missing_r9" }),
      headers: { "content-type": "application/json" },
    }),
  );
  return {
    commands: results,
    api: { status: response.status, body: await response.json() },
  };
}
