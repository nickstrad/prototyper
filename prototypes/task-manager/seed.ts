// Deterministic seed for the task manager (project.md §11). The service layer
// applies TASKS_TABLE_SQL + TASKS_SEED_SQL once per database (D1 marks it with
// PRAGMA user_version) and again on every reset, so a reset always returns
// exactly SEED_TASKS. The rows are identical to D1's workbench seed
// (packages/database/sqlite-seed.ts; a native test pins the equality) because
// in the playground the task manager runs on the workbench's database, whose
// layer applies D1's seed, so "reset" must mean the same thing in both.
// Type-only imports: Playwright specs import this module without a bundler.
import type { Task } from "./schema.ts";

const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`;

export const SEED_TASKS: readonly Task[] = [
  {
    id: 1,
    title: "Write the project plan",
    completed: true,
    createdAt: "2026-01-01T09:00:00.000Z",
  },
  {
    id: 2,
    title: "Probe SQLite WASM",
    completed: false,
    createdAt: "2026-01-02T09:00:00.000Z",
  },
  {
    id: 3,
    title: "Wire the terminal",
    completed: false,
    createdAt: "2026-01-03T09:00:00.000Z",
  },
];

/** One INSERT for every seed task, with explicit ids. */
export const TASKS_SEED_SQL =
  "INSERT INTO tasks (id, title, completed, created_at) VALUES\n" +
  SEED_TASKS.map((t) =>
    `  (${t.id}, ${sqlString(t.title)}, ${t.completed ? 1 : 0}, ${
      sqlString(t.createdAt)
    })`
  ).join(",\n");
