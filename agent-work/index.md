# Agent work index

Controller: unassigned for implementation. Canonical root:
`/Users/nick/Software/prototyper/agent-work`. No implementation agents or claims
are active. Planned dependencies and acceptance criteria are in `plan.md`.

Baseline: initial root commit, resolved with
`git rev-list --max-parents=0 HEAD`. The baseline includes the verified Hello
World app and reviewed planning files. Record its SHA in the dispatch brief
before creating source worktrees.

Only the orchestrator edits this file. Replace dashes with actual dispatch
metadata; keep records in `items/<id>/attempts/<run-id>/` durable across
restarts. Use `ready` only when dependency commits are verified.

| Item | Dependencies               | State  | Owner / run / generation | Checkout / assigned paths | Last checkpoint / evidence      | Next action                                    |
| ---- | -------------------------- | ------ | ------------------------ | ------------------------- | ------------------------------- | ---------------------------------------------- |
| R0   | none                       | ready  | —                        | —                         | Initial baseline; checks passed | Create brief when implementation is requested. |
| DB0  | R0                         | queued | —                        | —                         | —                               | Upstream sqlite3 shell in common host.         |
| R1   | DB0                        | queued | —                        | —                         | —                               | Task app mounts common editor.                 |
| DB1  | DB0                        | queued | —                        | —                         | —                               | Upstream DuckDB shell, same host.              |
| R2   | R1                         | queued | —                        | —                         | —                               | CLI slice.                                     |
| R3   | R1                         | queued | —                        | —                         | —                               | API slice.                                     |
| R4   | R2, R3                     | queued | —                        | —                         | —                               | Cross-interface integration.                   |
| R5   | R4                         | queued | —                        | —                         | —                               | Generator and templates.                       |
| R6   | DB1                        | queued | —                        | —                         | —                               | Analytics reuses editor.                       |
| R7   | R4                         | queued | —                        | —                         | —                               | SQLite persistence.                            |
| R8   | R6, R7                     | queued | —                        | —                         | —                               | Transfer and capabilities.                     |
| R9   | R4                         | queued | —                        | —                         | —                               | Native adapters.                               |
| R10  | R5                         | queued | —                        | —                         | —                               | CLI demo.                                      |
| R11  | R5                         | queued | —                        | —                         | —                               | API demo.                                      |
| R12  | R5                         | queued | —                        | —                         | —                               | Web demo.                                      |
| R13  | R5                         | queued | —                        | —                         | —                               | Combined demo.                                 |
| R14  | R8, R9, R10, R11, R12, R13 | queued | —                        | —                         | —                               | Analytics demo, gallery, release verification. |
