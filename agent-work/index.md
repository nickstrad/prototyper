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

| Item | Wave | Dependencies               | State      | Build model (Claude / Codex) | Owner / run / generation                         | Checkout / assigned paths | Last checkpoint / evidence          | Next action                                              |
| ---- | ---- | -------------------------- | ---------- | ---------------------------- | ------------------------------------------------ | ------------------------- | ----------------------------------- | -------------------------------------------------------- |
| R0   | 0    | none                       | landed     | Fable 5.1 (main) / sol high  | Twin (orchestrator) / run-20261007-r0-01 / gen 1 | /root/Software/prototyper | 327d7c6 (nits-only review) | D1, DB0 unblocked. |
| D1   | 1    | R0                         | landed     | Opus 5.5 / sol medium        | Twin (orchestrator) / run-20261008-d1-01 / gen 1 | /root/Software/prototyper | 44f4227 (PASS review, M1/M2 resolved) | D2, R1 unblocked. |
| DB0  | 1–3  | R0                         | landed     | Fable 5.1 / sol high         | Twin (orchestrator) / run-20261008-db0-01 / gen 1 | /root/Software/prototyper | 9580fc7 (nits-only review)          | DB1 unblocked.                                           |
| R1   | 2    | D1                         | landed     | Opus 5.5 / sol medium        | Twin (orchestrator) / run-20261008-r1-01 / gen 1 | /root/Software/prototyper | 1d1a5b7 (nits-only review)          | R2, R3 unblocked.                                        |
| D2   | 2–3  | D1                         | landed     | Opus 5.5 / sol medium        | Twin (orchestrator) / run-20261008-d2-01 / gen 1 | /root/Software/prototyper | fbd95c0 (nits-only review)          | DB1 unblocked.                                           |
| R2   | 3    | R1                         | landed     | Opus 5.5 / sol medium        | Twin (orchestrator) / run-20261008-r2-01 / gen 1 | /root/Software/prototyper | 1b38527 (clean review-03)           | R4 unblocked.                                                        |
| R3   | 3    | R1                         | landed     | Sonnet 5.5 high / luna high  | Twin (orchestrator) / run-20261008-r3-01 / gen 1 | /root/Software/prototyper | cbf34e0 (nits-only review-02)       | R4 dependency R3 satisfied; R4 needs R2 + DB0 still.            |
| R4   | 4    | R2, R3, DB0                | ready      | Fable 5.1 (main) / sol high  | Twin (orchestrator) / run-20261008-r4-01 / gen 1 | /root/Software/prototyper | R2 1b38527 + R3 cbf34e0 + DB0 9580fc7 | Build via main TUI (Fable 5.1, per plan.md 10a). DB1 67aa90b landed 13:21 CDT; F2 (DB1 import) unblocked -- main's fix round.                      |
| DB1  | 4    | DB0, D2                    | landed      | Opus 5.5 / sol high          | Twin (orchestrator) / run-20261008-db1-03 / gen 3 | /root/Software/prototyper | 67aa90b (nits-only review-01 Opus high) | Landed 13:21 CDT with main's playground restructure (circular compile dependency, per reviewer). R6 unblocked. |
| R5   | 5    | R4                         | queued     | Sonnet 5.5 high / luna high  | —                                                | —                         | —                                   | Generator and templates.                                 |
| R6   | 5    | DB1                        | queued     | Opus 5.5 / sol medium        | —                                                | —                         | —                                   | Analytics reuses editor. DB1 67aa90b landed; dependencies met -- brief/dispatch per main (R4 still in-flight).                                 |
| R7   | 5    | R4                         | queued     | Opus 5.5 / sol medium        | —                                                | —                         | `pocs/sqlite-service`               | SQLite persistence.                                      |
| R9   | 5    | R4                         | queued     | Opus 5.5 / sol medium        | —                                                | —                         | `pocs/sqlite-service`               | Native adapters.                                         |
| R8   | 6    | R6, R7                     | queued     | Opus 5.5 / sol medium        | —                                                | —                         | —                                   | Transfer and capabilities.                               |
| R10  | 6    | R5                         | queued     | Sonnet 5.5 high / luna high  | —                                                | —                         | —                                   | CLI demo.                                                |
| R11  | 6    | R5                         | queued     | Sonnet 5.5 high / luna high  | —                                                | —                         | —                                   | API demo.                                                |
| R12  | 6    | R5                         | queued     | Sonnet 5.5 high / luna high  | —                                                | —                         | —                                   | Web demo.                                                |
| R13  | 6    | R5                         | queued     | Sonnet 5.5 high / luna high  | —                                                | —                         | —                                   | Combined demo.                                           |
| R14  | 7    | R8, R9, R10, R11, R12, R13 | queued     | Opus 5.5 (main) / sol high   | —                                                | —                         | —                                   | Analytics demo, gallery, release verification.           |
