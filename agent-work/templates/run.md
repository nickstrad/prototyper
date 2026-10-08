# Run checkpoint — <item-id> / <run-id>

- State: running | blocked | paused | review | needs-fixes
- Updated: <timestamp with UTC offset>
- Owner: <agent ID and role>
- Ownership generation: <integer>
- Checkout and base commit: <absolute path and SHA; unborn repository if
  applicable>
- Brief: <canonical absolute path>
- Predecessor: <previous handoff path or none>
- Allowed source paths: <exclusive file list>
- Shared contract revision: <commit or recorded draft revision>

## Completed chunks

Describe observable results and changed files. Distinguish verified work from
untested edits. Reference useful other-agent records by path and revision.

## Verification evidence

| Command         | Revision / tree state | Exit status              | Outcome / artifact                                       |
| --------------- | --------------------- | ------------------------ | -------------------------------------------------------- |
| <exact command> | <SHA or dirty files>  | <actual code or not run> | <assertions, log path, seed and replay path if relevant> |

## Remaining work and next action

List unfinished chunks, then the exact first action a replacement should take.
Include reproduction commands for current failures.

## Blockers and decisions

State the blocker, impacted work, independent work that can continue, and the
decision needed from the orchestrator. Record requests for shared-file changes.

## Processes and resources

Record only processes owned by this run: server/session IDs, ports, workers,
temporary directories and how to stop them. Confirm cleanup at handoff.

## Handoff and final report

Before stopping, copy an up-to-date checkpoint to `handoff.md` and state whether
the writer has stopped. On completion, write `report.md`: files changed;
commands/outcomes; deviations; open questions; reusable lessons. The
orchestrator records release/reassignment; this record cannot transfer ownership
by itself.
