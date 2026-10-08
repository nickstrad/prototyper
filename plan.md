# Browser-Based Prototyping Toolkit — implementation plan

Status: **planning complete; toolkit implementation has not started.** The
repository currently contains a verified Deno Hello World app and the project
brief. This plan defines independently verifiable vertical slices and durable
agent coordination. `project.md` defines product scope; this file owns execution
decisions and the integration log. Agents publish detailed progress in
`agent-work/`, not in this file. The dedicated common-editor design and its two
slices are in `docs/database-editor-plan.md`.

## 0. Work log

Append-only; newest last. Only the orchestrator writes this table. Record
starts, dispatches, decision changes, review verdicts, blockers, handoffs, and
commits. Each entry states the next action. Use America/Chicago timestamps with
an offset when time matters.

| When       | Entry                                                                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-07 | Plan written from `project.md`; database editors made mandatory and final demo coverage specified. Progress workspace and role definitions created. **Next: R0 when implementation is requested.**                                                                                                                                           |
| 2026-10-07 | Shared editor clarified: DB0/DB1 are dedicated common-component and DuckDB-adapter slices; all prototypes reuse it. **Next: R0 when implementation is requested.**                                                                                                                                                                           |
| 2026-10-07 | Database editor clarified as an interactive browser SQL/dot-command console; upstream shell sharing must be probed and `.schemas` is an explicit alias. **Next: R0 when implementation is requested.**                                                                                                                                       |
| 2026-10-07 | Supersedes prior command-adapter/alias proposal: user requires actual upstream shells, no recreated dot commands or invented aliases. DB0/DB1 must prove upstream execution and shared live data. **Next: R0 when implementation is requested.**                                                                                             |
| 2026-10-07 | Planning review corrections applied: explicit DuckDB binding ownership, cross-worktree patch integration, role coverage and reviewed baseline prerequisite. All 17 assignments match the progress index; dependency graph and Markdown checks passed. **Next: reviewed baseline commit when implementation is requested, then dispatch R0.** |
| 2026-10-07 | Initial baseline prepared for the user-requested commit: Hello World run, type check, lint and repository formatting checks passed; planning review clean. Baseline reference: root commit (`git rev-list --max-parents=0 HEAD`). **Next: R0 when implementation is requested.**                                                             |

## 1. Goal

Deliver a static browser playground in which portable TypeScript application
logic, composed with Effect 4.0, can be exercised through web, CLI, API, and a
database editor against one SQLite or DuckDB instance. Finish with runnable
demos for each interface type and DuckDB analytics. Every accepted slice must
produce an observable behavior with executed verification; directories and stubs
alone do not complete a slice.

Authentication, remote execution, multi-user state, an ORM, and a plugin
framework remain outside scope. R0 is an infrastructure demonstration; from DB0
onward every product prototype reuses the common database editor.

## 2. Decisions

| ID  | Question                    | Decision                                                                                                                                                                                                                           | Status      |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Q1  | Runtime and effects         | Deno development; portable Effect 4.0 application core; browser-specific and Deno-specific adapters stay separate. Pin verified versions in R0.                                                                                    | Required    |
| Q2  | Shared state                | One managed runtime and one database service per opened prototype. Adapters and editor receive that instance.                                                                                                                      | Required    |
| Q3  | Editor visibility and reuse | One common DatabaseEditor host runs real upstream SQLite/DuckDB shells; no custom CLI or dot-command recreation. Every prototype mounts it against live data.                                                                      | Required    |
| Q4  | Editor behavior             | Browse tables/schema, edit and execute SQL, render results/errors, retain session history, reset seeds; expose supported import/export later. Successful SQL execution must invalidate dependent views when it might change state. | Required    |
| Q5  | Delivery order              | DB0 runs upstream sqlite3 WASM shell; DB1 runs upstream DuckDB shell through same host. Shared-instance access and command coverage are gating requirements.                                                                       | Planned     |
| Q6  | Agent state                 | Repository-global `agent-work/` in the primary checkout, shared by every agent and worktree. Per-run files avoid concurrent writes.                                                                                                | Established |
| Q7  | Dependency changes          | Orchestrator alone edits shared dependency/build files and public contract changes. Builders request additions through their progress record.                                                                                      | Established |
| Q8  | Final examples              | `demos/cli`, `api`, `web`, `combined`, and `analytics`; small domain examples that use toolkit components without duplicating infrastructure.                                                                                      | Required    |
| Q9  | Parallelism                 | Default maximum: orchestrator + two builders + one independent reviewer. Dependencies and file ownership determine eligibility.                                                                                                    | Planned     |
| Q10 | Persistence                 | Memory is the baseline. OPFS is configurable and capability-dependent; report the actual mode and verify memory fallback. No promise of identical engine behavior.                                                                 | Required    |

## 3. Vocabulary

- **Slice**: one backlog item with a user-visible outcome and independent
  evidence.
- **Prototype instance**: application, database, runtime, and notifications with
  one lifecycle.
- **Editor**: SQL workbench attached to that instance, not a separate database.
- **Run**: one agent attempt at a slice; identified by a unique run ID and
  ownership generation.
- **Claim**: orchestrator-controlled exclusive permission to write an item's
  assigned files.
- **Checkpoint**: durable progress, evidence, remaining work, and recovery
  instructions.
- **Landed**: independently reviewed implementation recorded in one
  item-specific commit.

## 4. Global progress location

### Initial baseline before dispatch

The initial baseline commit contains the verified Hello World app, project and
planning documents, ignore rules and coordination scaffolding. Its immutable
reference is the root commit, resolved with `git rev-list --max-parents=0 HEAD`.
Record that SHA in each dispatch brief; create source worktrees only after the
baseline exists. This administrative baseline is separate from the
one-commit-per-implementation-slice rule. No implementation slice has started.

### Canonical coordination root

Use `agent-work/` in the primary checkout as the canonical coordination root.
For this repository it is `/Users/nick/Software/prototyper/agent-work`. Agents
in other worktrees receive its absolute path as `PROTOTYPER_PROGRESS_ROOT`; they
must not create independent coordination copies. Keep durable records in Git;
claims are local execution state and are ignored.

```text
agent-work/
  README.md                     protocol entry point
  index.md                      orchestrator-owned dispatch/status table
  templates/run.md              checkpoint and handoff template
  items/<item-id>/
    brief.md                    orchestrator-owned assignment + copied contracts
    attempts/<run-id>/
      progress.md               current snapshot; assigned builder is sole writer
      events.md                 append-only builder event log
      handoff.md                stop/resume checkpoint
      report.md                 final builder report
    reviews/<review-id>.md       orchestrator saves reviewer verdict and evidence
  claims/<item-id>/              temporary exclusive claim and owner metadata
```

Every index row includes dependencies, state, owner/run, generation, checkout,
assigned paths, last checkpoint, evidence, and next action. States are `queued`,
`ready`, `running`, `blocked`, `paused`, `review`, `needs-fixes`, and `done`.
`done` requires a review verdict and landing SHA. Checkpoints must include exact
commands, outcomes, unfinished changes, and reproducible failures.

Builders update their snapshot at start, after each meaningful chunk or test,
before requesting a decision, and before stopping. During sustained work,
checkpoint at least every ten minutes. The orchestrator inspects the index and
active progress records at dispatch, completion, and roughly every five minutes
while coordinating. A stale timestamp triggers investigation, never automatic
takeover. Agents may read other agents' briefs, progress, reports, and lessons;
they must reference paths and distinguish reviewed facts from in-flight claims.

## 5. Concurrency and dependency graph

```text
R0 -> DB0 (common host + upstream sqlite3 shell)
DB0 -> R1 (task app), DB1 (upstream DuckDB shell + common-host integration)
R1 -> R2 (CLI), R3 (API)
DB1 -> R6 (analytical prototype)
R2 + R3 -> R4 (shared-state, reset, failure verification)
R4 -> R5 (generator), R7 (SQLite persistence), R9 (native adapters)
R6 + R7 -> R8 (database transfer + capability handling)
R5 -> R10 (CLI demo), R11 (API demo), R12 (web demo), R13 (combined demo)
R6 -> analytics demo foundation
R8 + R9 + R10 + R11 + R12 + R13 -> R14 (gallery + static release verification)
```

After DB0, R1 and DB1 can run in parallel on disjoint files. After R1, R2/R3 are
eligible; R6 becomes eligible after DB1. Dispatch at most two builders. R7 and
R9 can run in parallel after R4, while R5 owns generator files. Demo builders
write disjoint directories and may run in parallel after R5. R14 is the final
integration gate.

File overlap overrides graph eligibility. One writer owns each source path;
shared entry points, barrel exports, `deno.json`, `deno.lock`, Vite/Playwright
configuration, demo registry, and `plan.md` belong to the orchestrator. Builders
provide patches or integration requests for these files. Do not concurrently run
commands that rewrite lockfiles or the same build directory. Give isolated tests
their own databases, temporary directories, and browser-server ports.

### Source integration across worktrees

Global progress is shared, but source checkouts are not. Each brief names the
source checkout and integration base SHA. Prefer disjoint edits in one checkout
for this initial repository. If a builder uses a separate worktree, it never
commits: its final report identifies an exact source patch (including new files)
and a manifest of assigned paths, all saved under its canonical run directory.
The orchestrator verifies the patch against the recorded base, applies only that
slice in the integration checkout, resolves overlap under exclusive ownership,
and reruns acceptance checks there before independent review. Review the exact
integrated tree that will be committed. Do not copy a whole dirty checkout or
assume reports in the progress root also transferred source changes.

### Terminal display and application shell

xterm.js renders a terminal and supplies input events. It does not execute
commands. just-bash interprets application-shell commands, including registered
TypeScript commands, pipelines and utilities. Keep it for the application's
planned CLI experience (`tasks list --json | jq '.[]'`). It is not required by
and must not interpret the database console. That console passes input to the
real upstream sqlite3/DuckDB shell embedded in the shared host. Do not route
that console through just-bash's bundled `sqlite3` command as a substitute.

## 6. Verification contract

The following tasks are **planned, not currently installed**. R0 creates the
shared task surface and records exact flags and permissions in its report:

- `deno task check`: formatting, lint, and type checks for intended source/test
  entry points.
- `deno task test`: native unit/integration/property tests; no silent exclusion
  of new slices.
- `deno task test:browser`: Playwright tests with isolated browser state.
- `deno task build`: distributable static assets including WASM and worker
  files.
- `deno task test:static`: test the production build through an asset-only
  server.
- `deno task dev`: open the development playground; replace the Hello World
  watcher.
- `deno task prototype:new <name> --type <cli|api|web|combined> --database <sqlite|duckdb>`:
  added in R5.

Browser tests assert observable outcomes, not only load success. Property tests
use a fixed seed, preserve replay paths, and create a fresh runtime/database per
case. Reviewers rerun relevant checks independently. Evidence includes command,
revision or dirty-tree description, exit status, and key outcome; screenshots
supplement assertions. Do not label future acceptance commands as passing today.

## 7. Status and backlog

This is a flat backlog. Dependency readiness, not a phase number, governs work.

| Status           | Item            | Deliverable                                                                                |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------ |
| built, baseline  | Initial app     | Hello World, `start`/`dev`, README, Git and `.gitignore`; verified in initial baseline.    |
| next             | R0              | Browser terminal and Effect integration probe; settle packages, contracts, and test tasks. |
| when R0 lands    | DB0             | Common DatabaseEditor hosting real sqlite3 WASM shell and a seeded browser workbench.      |
| when DB0 lands   | R1              | SQLite task manager reusing the common editor and database service.                        |
| when DB0 lands   | DB1             | Upstream DuckDB shell integrated with the same DatabaseEditor.                             |
| when R1 lands    | R2              | CLI task operations and reusable database commands against the shared instance.            |
| when R1 lands    | R3              | Fetch API and browser explorer against the shared instance.                                |
| when R2/R3 land  | R4              | Verified coherence, failures, reset, resource lifecycle, and property tests.               |
| when R4 lands    | R5              | Prototype generator demonstrating a second small working prototype.                        |
| when DB1 lands   | R6              | DuckDB analytical prototype reusing the common editor.                                     |
| when R4 lands    | R7              | SQLite persistence and visible fallback behavior.                                          |
| when R6/R7 land  | R8              | Capability-aware database export/import and DuckDB persistence assessment.                 |
| when R4 lands    | R9              | Deno CLI/server adapters with equivalent observable application behavior.                  |
| when R5 lands    | R10             | Simple CLI-only demo.                                                                      |
| when R5 lands    | R11             | Simple API-only demo.                                                                      |
| when R5 lands    | R12             | Simple web-only demo.                                                                      |
| when R5 lands    | R13             | Combined task-manager demo.                                                                |
| when R8–R13 land | R14             | Complete gallery, DuckDB analytical demo, documentation, production verification.          |
| deferred         | Backend hosting | Reconsider only on an explicit scope change.                                               |

## 8. Database-editor acceptance

There is one `packages/database-editor/DatabaseEditor.tsx` component. DB0
implements the common host and upstream sqlite3 binding; DB1 supplies DuckDB
behavior without forking the UI. The dedicated plan is
`docs/database-editor-plan.md`. An engine is supported only when this component
is usable with it in a running prototype. The editor hosts real upstream sqlite3
and DuckDB shells in the browser. Their own prompt, SQL/dot-command handling and
output must be used. Verify `.help`, `.tables`, `.schema`,
`.mode table/csv/json` and `.headers` against the selected upstream build. Do
not remake commands or output formatting; do not fabricate a `.schemas` alias.
The upstream DuckDB web shell must be assessed for actual command coverage,
rather than assumed identical to the native CLI. Missing shell functionality or
live-instance sharing is an integration blocker, not permission to build a
substitute.

The editor must list tables, inspect schema, browse rows, run edited SQL,
display query results and affected-row information where available, show errors,
retain session history, and reset to deterministic seeds. Display actual engine
and persistence mode. Render big integers, nulls, blobs, and other
engine-specific values without losing data or crashing React.

Database operations go through the same service and serialization rules as
application operations. A successful editor write becomes visible in enabled
UI/CLI/API adapters. If mutation detection is unavailable, conservatively
invalidate views after successful execution rather than inventing a SQL parser.
Failed execution does not publish a success event. Handle partial changes
according to the engine's transaction behavior; do not promise automatic
rollback for arbitrary batches. Schema edits can invalidate domain assumptions:
show the resulting typed errors and retain a working reset path.

Bound displayed rows and clearly indicate truncation. Expose cancellation only
when the adapter actually supports it. Imports, exports, and persistence must
advertise capabilities with reasons when unavailable. SQLite-only prototypes do
not load DuckDB assets, and vice versa.

## 9. APIs and contracts

**As built:** only `main.ts` and Hello World tasks. The following contracts are
**planned R0/DB0** and must be verified against actual Effect v4 and engine APIs
before builders receive them as executable signatures.

```ts
import type { Effect } from "effect";

type Engine = "sqlite" | "duckdb";
type Interface = "web" | "cli" | "api";
type PrototypeConfig = {
  name: string;
  database: Engine;
  persistence: "memory" | "opfs";
  interfaces: readonly Interface[]; // Database editor always present.
};

type DatabaseError = {
  readonly _tag: "DatabaseError";
  readonly cause: unknown;
};
type QueryResult = {
  columns: readonly string[];
  rows: readonly (readonly unknown[])[];
  affectedRows?: number;
  truncated: boolean;
};

// Engine-specific implementation remains accessible; no common SQL dialect.
interface DatabaseService {
  readonly engine: Engine;
  readonly capabilities: {
    persistence: boolean;
    export: boolean;
    import: boolean;
    cancellation: boolean;
  };
  execute(sql: string): Effect.Effect<QueryResult, DatabaseError>;
  tables(): Effect.Effect<readonly string[], DatabaseError>;
  schema(table: string): Effect.Effect<string, DatabaseError>;
  reset(): Effect.Effect<void, DatabaseError>;
}

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type ApiHandler = (request: Request) => Promise<Response>;
```

The orchestrator settles parameter binding, query limits, per-statement results,
change-notification shape, and resource acquisition/disposal in R0/DB0. These
are required details, not opportunities for independent incompatible designs.
Use the task application Effect contract in `project.md` §5. Validate input with
Schema, map expected errors at boundaries, and keep defects distinguishable.

Reset preserves the application service identity or atomically swaps its
internal handle so existing adapters remain attached. Publish notifications
after success; subscriptions and workers are scoped. Raw editor SQL shares the
same path. Transfer capabilities are added to the contract in R8 after engine
probes.

## 10. Work breakdown

### 10a. Next dispatch block

The next dispatch block contains seven slices; R0 is ready after the reviewed
baseline commit. Model names are cross-platform role preferences, not a
requirement to change the current orchestrator model. `sol` means `gpt-6-sol`;
`luna` means `gpt-6-luna`. Every reviewer is independent and read-only with
respect to application sources.

| ID  | Task and allowed files                                                                                                                                                                                                                                                                                                          | Owner                                                                                        | Reviewed by                     | Done when                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0  | Build React/Vite browser terminal using xterm.js + just-bash; one Effect command with argument/pipeline/error examples. Probe SQLite, DuckDB, Effect v4, and Deno imports; record risks in `docs/integrations.md`. Own root tooling, `packages/core/types.ts`, `packages/terminal/`, initial playground and browser smoke test. | main (Claude controlling session / Codex current session — contracts and dependency choices) | reviewer (opus high / sol high) | `check`, browser smoke, and static build smoke pass; browser database-shell integration risks are documented; custom command receives quoted args, pipeline renders output, typed failure renders stderr/nonzero exit. Document exact versions and unsupported assumptions.         |
| DB0 | Embed upstream sqlite3 WASM CLI in common DatabaseEditor per `docs/database-editor-plan.md`. Own `packages/database-editor/`, `packages/database/sqlite*`, `tests/database-editor/`; main settles engine/shell contracts and mounts the seeded workbench.                                                                       | builder-strong (opus medium / sol medium — upstream CLI embedding and live-engine access)    | reviewer (opus high / sol high) | Real sqlite3 banner/prompt, `.help`, `.schema`, `.mode table/csv/json`, `.headers` and SQL execute in browser; application and console share live data; errors/history/reset/cleanup pass. No custom command parser or formatter.                                                   |
| R1  | SQLite task app, React CRUD, and mounting the common DatabaseEditor. Own `prototypes/task-manager/application.ts`, schema/seed/UI and `tests/sqlite/`; reuse DB0 services, no editor copy. Main integrates shared files.                                                                                                        | builder-strong (opus medium / sol medium — domain effects and state semantics)               | reviewer (opus high / sol high) | CRUD, seeds, reset and typed errors pass native/browser checks; editor write appears in task UI and vice versa; both use the identical database service.                                                                                                                            |
| R2  | Wire task commands and standard database commands into the terminal. Own `prototypes/task-manager/commands.ts`, `packages/terminal/commands.ts`, `tests/cli/`; no root dependencies.                                                                                                                                            | builder-strong (opus medium / sol medium — shell arguments and shared effects)               | reviewer (opus high / sol high) | Browser terminal creates/completes/deletes tasks visible in UI/editor; JSON pipeline works; invalid input and missing task produce stderr/nonzero exits; `db reset` restores seeds.                                                                                                 |
| R3  | Implement Fetch handler and explorer. Own `packages/api/`, `prototypes/task-manager/api.ts`, `packages/playground/api/`, `tests/api/`.                                                                                                                                                                                          | builder-strong (opus medium / sol medium — request validation and error mapping)             | reviewer (opus high / sol high) | Explorer invokes GET/POST/PATCH/DELETE without network API transport; 400/404/internal error mappings pass; created tasks appear in UI/editor and API tests share one runtime.                                                                                                      |
| R4  | Finish coherence, lifecycle, and reset/error experience across all interfaces. Own `packages/core/events.ts`, `tests/coherence/`, `tests/property/`, `tests/lifecycle/`; main integrates any core/UI contract fixes sequentially.                                                                                               | main (Claude controlling session / Codex current session — cross-interface invariants)       | reviewer (opus high / sol high) | CLI create → API complete → UI/editor query agrees; editor write is visible elsewhere; reset restores exact seeds; seeded fast-check model tests reproduce failures; close/reopen and tab changes do not leak workers or duplicate notifications.                                   |
| R5  | Add minimal generator/templates and create a second prototype in a temporary directory as proof. Own `tools/prototype-new.ts`, `templates/`, `tests/generator/`, `docs/new-prototype.md`; main adds task and registry support.                                                                                                  | builder-fast (sonnet high / luna high — fixed conventions and generation checks)             | reviewer (opus high / sol high) | Generated CLI/API/web/combined configurations select the correct interfaces and always include Database; generated SQLite example builds and runs CRUD plus SQL; generator refuses overwriting an existing prototype. DuckDB generation becomes enabled after both R5 and DB1 land. |

### 10b. Remaining slices and history

These are planned assignments with explicit dependencies in §5/§7, not
unfinished breakdowns. Move completed rows into a history subsection with
command evidence and commit SHA; retain their IDs.

| ID  | Task and allowed files                                                                                                                                                                                                                     | Owner                                                                                          | Reviewed by                     | Done when                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB1 | Embed actual upstream DuckDB shell using the common host per its dedicated plan. Own `packages/database-editor/duckdb-shell.ts`, `packages/database/duckdb*`, `tests/database-editor-duckdb/`; common-host changes need a dedicated claim. | builder-strong (opus medium / sol medium — upstream shell, workers and command coverage)       | reviewer (opus high / sol high) | Real upstream shell runs required SQL and mode/schema command walkthrough against same live database as app; SQLite regressions pass. Missing required commands or shared access keeps DB1 incomplete; do not author substitutes.                                             |
| R6  | Analytical prototype; own `prototypes/event-analytics/` and `tests/duckdb/`. Reuse DB1 service and the common editor.                                                                                                                      | builder-strong (opus medium / sol medium — analytical query semantics)                         | reviewer (opus high / sol high) | Event aggregates render in app and editor; editor INSERT changes aggregates; deterministic reset and resource disposal pass browser checks.                                                                                                                                   |
| R7  | SQLite OPFS mode and fallback UI; own `packages/database/sqlite-persistence*`, `tests/persistence/sqlite/`. SQLite adapter edits occur only under a dedicated claim after R1.                                                              | builder-strong (opus medium / sol medium — browser capability and storage lifecycle)           | reviewer (opus high / sol high) | Reload retains data in supported mode; unavailable OPFS starts in memory with visible mode; reset remains deterministic; browser headers/assets needed by the chosen adapter are documented and tested.                                                                       |
| R8  | Supported transfer tools, DuckDB persistence capability assessment; own `packages/database/transfer/`, `tests/transfer/`, `docs/database-capabilities.md`; main integrates capability controls.                                            | builder-strong (opus medium / sol medium — engine-specific transfer semantics)                 | reviewer (opus high / sol high) | SQLite export/import round-trip preserves data; invalid import leaves a recoverable prototype. DuckDB round-trip/persistence executed where supported, otherwise honest capability reporting and tested memory fallback. Active interfaces reconnect after successful import. |
| R9  | Native Deno CLI and API server, runtime-specific database adapter if needed; own `adapters/deno/`, `tests/native/`, `docs/native.md`.                                                                                                      | builder-strong (opus medium / sol medium — native/browser adapter differences)                 | reviewer (opus high / sol high) | Task CLI and Deno.serve API share one native instance; equivalent operation sequences match browser outcomes and error semantics; native and browser paths remain separately importable.                                                                                      |
| R10 | CLI inventory demo; own `demos/cli/` and its tests.                                                                                                                                                                                        | builder-fast (sonnet high / luna high — narrow CRUD demonstration)                             | reviewer (opus high / sol high) | SQLite-backed `inventory list/add/remove` with JSON pipeline; only Terminal and Database views appear; walkthrough verifies an editor write through CLI.                                                                                                                      |
| R11 | API bookmarks demo; own `demos/api/` and its tests.                                                                                                                                                                                        | builder-fast (sonnet high / luna high — fixed endpoint walkthrough)                            | reviewer (opus high / sol high) | SQLite GET/POST/DELETE bookmarks through explorer; only API and Database views appear; invalid request is demonstrated and editor changes appear in GET.                                                                                                                      |
| R12 | Web notes demo; own `demos/web/` and its tests.                                                                                                                                                                                            | builder-fast (sonnet high / luna high — simple UI behavior)                                    | reviewer (opus high / sol high) | SQLite create/edit/delete notes; only Application and Database views appear; editor UPDATE refreshes UI without polling and reset restores notes.                                                                                                                             |
| R13 | Combined task-manager demo; own `demos/combined/` and its tests.                                                                                                                                                                           | builder-fast (sonnet high / luna high — reuse reference app)                                   | reviewer (opus high / sol high) | All four views share data; walkthrough creates via CLI, completes via API, inspects UI/SQL; reuse task-manager domain logic rather than copy infrastructure.                                                                                                                  |
| R14 | Complete gallery including DuckDB analytics; own `demos/analytics/`, `demos/README.md`, `docs/architecture.md`, README and shared registry/build integration, `tests/static/`.                                                             | main (Claude controlling session / Codex current session — release and cross-demo integration) | reviewer (opus high / sol high) | `check`, `test`, `test:browser`, `build`, `test:static` pass; all five demos run from asset-only hosting without remote application APIs/databases; analytics uses DuckDB editor; clean setup and generator walkthrough are executed.                                         |

No implementation slices have landed yet.

### 10c. Working protocol

| Role           | Claude Code definition                                    | Codex preference            | Responsibility                                                                           |
| -------------- | --------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| main           | Controlling session                                       | Current controlling session | Design, shared contracts/files, claims, dispatch, index, plan log, integration, commits. |
| builder-strong | `.claude/agents/prototype-builder-strong.md`, opus medium | gpt-6-sol medium            | Multi-part slice; own assigned files and per-run progress.                               |
| builder-fast   | `.claude/agents/prototype-builder-fast.md`, sonnet high   | gpt-6-luna high             | Bounded slice with fixed observable checks.                                              |
| reviewer       | `.claude/agents/prototype-reviewer.md`, opus high         | gpt-6-sol high              | Independently verify; report findings without changing source.                           |

1. **Brief and claim.** Main first ensures the reviewed baseline exists,
   verifies dependencies have landed, settles §9, records an exclusive claim,
   and creates `items/<id>/brief.md`. Copy the full assignment row and relevant
   signatures into the brief; include allowed and forbidden files, dependency
   commits, checkout, run ID/generation, progress root, commands, acceptance
   examples, and report format. Log dispatch in §0.
2. **Build and checkpoint.** Builder creates its per-run records from the
   template. Work only in assigned paths; never commit or edit `plan.md` or the
   shared index. Report dependency requests or contract deviations before making
   dependent edits. Capture progress continuously; communicate urgent blockers
   to main as well as recording them. Independent work may continue.
3. **Integrate and review.** For another source worktree, main imports the slice
   patch and new-file manifest using §5 before review. Main dispatches an
   independent reviewer with the brief, builder report, diff/untracked file
   list, and evidence paths. Reviewer reruns relevant commands, checks
   contracts, static execution, resource release, notification timing, and
   engine assumptions. Findings are `must-fix`, `should`, or `nit`, with
   `file:line` and a concrete failure case. Main saves the verdict under
   `reviews/`. Send required fixes to the same builder while it remains
   available.
4. **Land.** Only `clean` or `nits only` verdicts are eligible. Main checks
   status, scope, and one acceptance command; stages only the slice's files,
   integrates approved shared changes, and creates one commit with its item ID.
   Update contracts, index, evidence and §0 with actual SHA. Exclude another
   agent's unfinished files; serialize landing. Release claim and ready
   dependents.
5. **Stop.** Request a checkpoint before interrupting. Builder writes
   `handoff.md` with changed files, executed checks, pending commands/processes,
   risks, and the next exact action. Main confirms the old agent/process has
   stopped, records `paused` or `blocked`, and releases its claim. A pause does
   not imply completion.
6. **Resume or replace.** Main reads the original brief, all attempt
   checkpoints, latest review, Git status and recent commits. Confirm no old
   writer remains, increment generation and assign a fresh run ID. Inspect
   retained changes before editing; use review for completed but unlanded
   changes. The replacement references the predecessor's record and reruns
   necessary checks. Do not rely on chat history or elapsed time as proof of
   ownership or correctness.
7. **Recover after context loss.** Read §0, §7, the index, active handoffs, Git
   log and status. Check actual agent state; context loss alone does not prove
   other agents stopped. Reconcile discrepancies in a new log entry. Review
   unrecorded completed work; reassign partial work using a fresh generation
   only after verifying its old writer is inactive.

Builder final reports contain: files changed; commands and outcomes; deviations;
open questions; reusable lessons. Reviewer reports contain: verdict; commands
and outcomes; ranked findings; deviations. Main may read diffs whenever a design
decision or inconsistency requires it. Progress reports are evidence pointers,
not substitutes for independent verification.

## 11. Risks and completion gate

R0/DB0 must resolve actual package APIs, Effect v4 availability/imports, Deno
test permissions, WASM asset paths, workers, upstream shell embedding and live
engine access, OPFS requirements, and static-host headers. If an assumption
fails, main updates §2/§9 with the evidence before dispatching dependent work.
Do not silently swap shells, engines, or the static architecture.

R14 completes the project only when all applicable slices have landed, every
demo has its database editor, cross-interface behavior is verified, property
failures can be replayed, and the production assets run through static hosting.
Document unavailable engine capabilities with observed reasons. The planning
deliverable itself does not assert that any toolkit or demo currently runs.
