// The tasks schema and seed (project.md §11, sqlite-seed.ts) in DuckDB's
// dialect: same columns, same rows, same `SELECT * FROM tasks ORDER BY id`
// result (TASKS_SEED_ROWS). DuckDB has no INTEGER PRIMARY KEY rowid alias,
// so ids come from a sequence that starts after the seeded rows.
export { TASKS_SEED_ROWS } from "./sqlite-seed.ts";

export const DUCKDB_TASKS_SCHEMA = `CREATE SEQUENCE tasks_id_seq START 4;
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY DEFAULT nextval('tasks_id_seq'),
  title VARCHAR NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at VARCHAR NOT NULL
)`;

export const DUCKDB_TASKS_SEED =
  `INSERT INTO tasks (id, title, completed, created_at) VALUES
  (1, 'Write the project plan', 1, '2026-01-01T09:00:00.000Z'),
  (2, 'Probe SQLite WASM', 0, '2026-01-02T09:00:00.000Z'),
  (3, 'Wire the terminal', 0, '2026-01-03T09:00:00.000Z')`;
