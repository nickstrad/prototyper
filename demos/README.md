# Prototype demos

Planned final examples; runnable demo applications have not been built yet. The
implementation slices and executed acceptance checks will be recorded in
`plan.md` and `agent-work/`.

| Directory    | Example                                      | Engine | Views                                | Slice                       |
| ------------ | -------------------------------------------- | ------ | ------------------------------------ | --------------------------- |
| `cli/`       | Inventory commands and JSON pipelines        | SQLite | Terminal, Database                   | R10                         |
| `api/`       | Bookmark endpoints exercised in the explorer | SQLite | API, Database                        | R11                         |
| `web/`       | Notes CRUD in React                          | SQLite | Application, Database                | R12                         |
| `combined/`  | Task manager across all interfaces           | SQLite | Application, Terminal, API, Database | R13                         |
| `analytics/` | Queries over seeded event data               | DuckDB | Application, Database                | R6 foundation, R14 delivery |

Every demo will have deterministic seed data, the selected engine's first-class
shared `DatabaseEditor`, a short README walkthrough, and automated browser
verification. It embeds the actual upstream SQLite/DuckDB shell against that
demo's live database: real `.mode`/`.schema` handling for SQLite, and the DuckDB
web shell's own command set plus `SHOW TABLES`/`DESCRIBE` for DuckDB (plan.md
Q12). Reuse the same host component with the selected upstream shell binding.
Editor mutations must be visible through enabled application interfaces. Use
reusable toolkit components instead of copying terminal/API/editor plumbing.

R14 builds and verifies a gallery containing all five demos on static hosting.
Keep actual run/build instructions synchronized with the implemented task
surface.
