# Shared agent workspace

This is the repository-global progress location for the orchestration protocol
in `plan.md` §§4 and 10c. It lives in the primary checkout. All workers,
including workers in other worktrees, use the same absolute location supplied as
`PROTOTYPER_PROGRESS_ROOT`.

Start by reading `index.md`, the assigned `items/<id>/brief.md`, and previous
attempts and reviews for that item. The orchestrator owns the index, claims,
briefs, contracts, and plan log. Each builder owns only its assigned source
paths and `items/<id>/attempts/<run-id>/` records. Other agents may read these
records and reference them; they must not overwrite them.

## Claims and run ownership

The orchestrator creates a claim directory exclusively before dispatch, for
example `mkdir "$PROTOTYPER_PROGRESS_ROOT/claims/R1"`. An existing directory
means investigate ownership; do not remove it merely because it is old. Add
owner metadata with item ID, run ID, generation, agent ID, checkout, paths and
start time. One orchestrator controls dispatch; multiple orchestrators must
agree on a single controller before assigning work.

Claims prevent duplicate assignments for an item; they do not prove source paths
are disjoint. Check file ownership in every active brief before dispatch. Claims
are ignored local state. Durable assignment and handoff records remain tracked.

Before replacing a worker, request its handoff, verify it has stopped, release
the claim, increment the ownership generation and dispatch a new run. If the
worker died before checkpointing, inspect its changed files and record the
missing evidence. Never reclaim automatically based on stale timestamps.

## Checkpoint rules

Copy `templates/run.md` into the assigned run's `progress.md`. Update it after
each meaningful chunk or check and before blockers/stops. Append timestamped
events to `events.md`; retain older outcomes when a later result changes them.
Use timestamps with an offset.

On stop, save `handoff.md`. On finish, save `report.md`. Include exact commands,
exit status and evidence paths, not just “tests passed.” Identify checks not run
and why. Reports should be concise enough for a replacement agent to resume
without a transcript. Do not store secrets or full environment dumps.

For reusable findings, reference another item's reviewed report or your own
lesson with its path and revision. In-flight observations are provisional.
Reviewers remain read-only on source and return verdicts to the orchestrator,
who saves them under `items/<id>/reviews/`.

## Implementation task checks

The role files mention `deno task build`, `deno task check`, and
`deno task test`. These are planned tasks established by R0, not commands
available in the current Hello World repository. Proof-of-concept code under
`pocs/` has its own per-directory configuration and is reference material, not
part of the toolkit task surface. For R0, use the commands in its brief while
bootstrapping them. For later items, execute applicable checks plus their
acceptance commands. Do not run shared output or lockfile mutations
concurrently.
