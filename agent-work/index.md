# Agent work index

Controller: unassigned for implementation. Canonical root:
`/Users/nick/Software/prototyper/agent-work`. No implementation agents or claims
are active. Planned dependencies, waves, model assignments and acceptance
criteria are in `plan.md` §5 and §10. Proof-of-concept evidence is in `pocs/`.

Baseline: initial root commit, resolved with
`git rev-list --max-parents=0 HEAD`. Record its SHA in the dispatch brief before
creating source worktrees.

Only the orchestrator edits this file. Replace dashes with actual dispatch
metadata; keep records in `items/<id>/attempts/<run-id>/` durable across
restarts. Use `ready` only when dependency commits are verified.

| Item | Wave | Dependencies               | State  | Build model (Claude / Codex) | Owner / run / generation | Checkout / assigned paths | Last checkpoint / evidence | Next action                                    |
| ---- | ---- | -------------------------- | ------ | ---------------------------- | ------------------------ | ------------------------- | -------------------------- | ---------------------------------------------- |
| R0   | 0    | none                       | ready  | Fable 5.1 (main) / sol high  | —                        | —                         | Baseline + `pocs/r0-stack` | Create brief when implementation is requested. |
| D1   | 1    | R0                         | queued | Opus 5.5 / sol medium        | —                        | —                         | `pocs/sqlite-service`      | SQLite DatabaseService + conformance suite.    |
| DB0  | 1–3  | R0                         | queued | Fable 5.1 / sol high         | —                        | —                         | `pocs/sqlite-shell`        | Upstream sqlite3 shell in common host; bridge. |
| R1   | 2    | D1                         | queued | Opus 5.5 / sol medium        | —                        | —                         | —                          | Task app on shared service.                    |
| D2   | 2–3  | D1                         | queued | Opus 5.5 / sol medium        | —                        | —                         | `pocs/duckdb-shell`        | DuckDB DatabaseService.                        |
| R2   | 3    | R1                         | queued | Opus 5.5 / sol medium        | —                        | —                         | —                          | CLI slice.                                     |
| R3   | 3    | R1                         | queued | Sonnet 5.5 high / luna high  | —                        | —                         | —                          | API slice.                                     |
| R4   | 4    | R2, R3, DB0                | queued | Fable 5.1 (main) / sol high  | —                        | —                         | —                          | Cross-interface coherence incl. editor.        |
| DB1  | 4    | DB0, D2                    | queued | Opus 5.5 / sol high          | —                        | —                         | `pocs/duckdb-shell`        | Upstream DuckDB shell, same host.              |
| R5   | 5    | R4                         | queued | Sonnet 5.5 high / luna high  | —                        | —                         | —                          | Generator and templates.                       |
| R6   | 5    | DB1                        | queued | Opus 5.5 / sol medium        | —                        | —                         | —                          | Analytics reuses editor.                       |
| R7   | 5    | R4                         | queued | Opus 5.5 / sol medium        | —                        | —                         | `pocs/sqlite-service`      | SQLite persistence.                            |
| R9   | 5    | R4                         | queued | Opus 5.5 / sol medium        | —                        | —                         | `pocs/sqlite-service`      | Native adapters.                               |
| R8   | 6    | R6, R7                     | queued | Opus 5.5 / sol medium        | —                        | —                         | —                          | Transfer and capabilities.                     |
| R10  | 6    | R5                         | queued | Sonnet 5.5 high / luna high  | —                        | —                         | —                          | CLI demo.                                      |
| R11  | 6    | R5                         | queued | Sonnet 5.5 high / luna high  | —                        | —                         | —                          | API demo.                                      |
| R12  | 6    | R5                         | queued | Sonnet 5.5 high / luna high  | —                        | —                         | —                          | Web demo.                                      |
| R13  | 6    | R5                         | queued | Sonnet 5.5 high / luna high  | —                        | —                         | —                          | Combined demo.                                 |
| R14  | 7    | R8, R9, R10, R11, R12, R13 | queued | Opus 5.5 (main) / sol high   | —                        | —                         | —                          | Analytics demo, gallery, release verification. |
