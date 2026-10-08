// Deterministic tasks schema and seed (project.md §11) used by the playground
// workbench and the conformance suite.
export const TASKS_SCHEMA = `CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`;

export const TASKS_SEED =
  `INSERT INTO tasks (id, title, completed, created_at) VALUES
  (1, 'Write the project plan', 1, '2026-01-01T09:00:00.000Z'),
  (2, 'Probe SQLite WASM', 0, '2026-01-02T09:00:00.000Z'),
  (3, 'Wire the terminal', 0, '2026-01-03T09:00:00.000Z')`;

/** `SELECT * FROM tasks ORDER BY id` right after seeding. */
export const TASKS_SEED_ROWS = [
  [1, "Write the project plan", 1, "2026-01-01T09:00:00.000Z"],
  [2, "Probe SQLite WASM", 0, "2026-01-02T09:00:00.000Z"],
  [3, "Wire the terminal", 0, "2026-01-03T09:00:00.000Z"],
] as const;
