# Browser-Based Prototyping Toolkit — implementation plan

Status: **planning revised (second pass, 2026-10-07); toolkit implementation has
not started.** The repository contains a verified Deno Hello World app, the
project brief, and four executed proof-of-concept probes under `pocs/` that
settle the riskiest integrations. `project.md` defines product scope; this file
owns execution decisions, model assignments, concurrency, and the integration
log. Agents publish detailed progress in `agent-work/`, not here. The dedicated
database-editor design is in `docs/database-editor-plan.md`.

## 0. Work log

Append-only; newest last. Only the orchestrator writes this table. Record
starts, dispatches, decision changes, review verdicts, blockers, handoffs, and
commits. Each entry states the next action. Use America/Chicago timestamps with
an offset when time matters.

| When       | Entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-07 | Plan written from `project.md`; database editors made mandatory and final demo coverage specified. Progress workspace and role definitions created. **Next: R0 when implementation is requested.**                                                                                                                                                                                                                                                                                                                                    |
| 2026-10-07 | Shared editor clarified: DB0/DB1 are dedicated common-component and DuckDB-adapter slices; all prototypes reuse it. **Next: R0 when implementation is requested.**                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-10-07 | Database editor clarified as an interactive browser SQL/dot-command console; upstream shell sharing must be probed and `.schemas` is an explicit alias. **Next: R0 when implementation is requested.**                                                                                                                                                                                                                                                                                                                                |
| 2026-10-07 | Supersedes prior command-adapter/alias proposal: user requires actual upstream shells, no recreated dot commands or invented aliases. DB0/DB1 must prove upstream execution and shared live data. **Next: R0 when implementation is requested.**                                                                                                                                                                                                                                                                                      |
| 2026-10-07 | Planning review corrections applied: explicit DuckDB binding ownership, cross-worktree patch integration, role coverage and reviewed baseline prerequisite. All 17 assignments match the progress index; dependency graph and Markdown checks passed. **Next: reviewed baseline commit when implementation is requested, then dispatch R0.**                                                                                                                                                                                          |
| 2026-10-07 | Initial baseline prepared for the user-requested commit: Hello World run, type check, lint and repository formatting checks passed; planning review clean. Baseline reference: root commit (`git rev-list --max-parents=0 HEAD`). **Next: R0 when implementation is requested.**                                                                                                                                                                                                                                                      |
| 2026-10-07 | Second planning pass. Upstream facts verified: Effect 4.0.2 stable (2026-10-01); DuckDB web shell has no `.mode/.tables/.schema/.headers`; sqlite3 shell exists only as the Fiddle build; duckdb-wasm `latest` has an OPFS regression. User decision: upstream web shells with a smaller command set are acceptable, nothing ad hoc (Q12). `DatabaseService` split from the shell slice (D1/D2, Q11). Model roster and waves set (§5, §10). Four Opus POC agents dispatched.                                                          |
| 2026-10-07 | POC verdicts folded in (`pocs/README.md`). sqlite3 shell: **feasible with the prebuilt Fiddle**; the same WASM instance exports the full C API, so the browser SQLite service runs on the shell's engine (bridge proven both ways). DuckDB shell: embeds on the shared `AsyncDuckDB`, sharing proven both ways, command set as Q12; `.open` must be blocked; one shell per page; listeners leak per mount. R0 stack and SQLite service: all green; Playwright runs under Deno. **Next: user confirms Q11/Q17/Q18; then dispatch R0.** |
| 2026-10-07 | User: ship-first tradeoffs are acceptable. Q11, Q15, Q17, Q18 decided on the simplest option (bridge on the Fiddle engine; `opfs-sahpool` with memory fallback, headered mode deferred; vendored snapshot without `-safe -bail`; one DuckDB shell per page, `eh` only, self-hosted extensions). Planning pass and `pocs/` committed and pushed. **Next: dispatch R0.**                                                                                                                                                                |

| 2026-10-07 | R0 dispatched by Twin (orchestrator): brief at
`agent-work/items/R0/brief.md`, run run-20261007-r0-01, base 48db2128, builder
Claude Fable 5.1 TUI in tmux session work. **Next: R0 build completes, then
independent review (Opus high).** |

| 2026-10-07 | R0 landed: commit 327d7c6 (30 files). Review verdict nits only; all acceptance criteria verified. Claim released. **Next: D1 and DB0 dispatch (Wave 1, parallel on R0 worker skeleton).** |
| 2026-10-08 | D1 + DB0 dispatched by Twin (orchestrator) for Wave 1 parallel build: briefs at `agent-work/items/D1/brief.md` and `agent-work/items/DB0/brief.md`, runs run-20261008-d1-01 / run-20261008-db0-01, base R0 327d7c6. Main TUI agent to dispatch both as subagents. **Next: builds complete, then independent reviews.** |
| 2026-10-08 | D1 landed: commit 44f4227 (20 files). Review verdict PASS (Opus 5.5 high, all acceptance criteria independently reproduced); M1/M2 coordination items resolved by orchestrator. Claim released. **Next: R1 and D2 dispatch (Wave 2, parallel on D1).** |
| 2026-10-08 | DB0 landed: commit 9580fc7 (19 files). Review verdict nits only (Fable 5.1, 4 rounds; all acceptance criteria independently reproduced). Claim released. **Next: DB1 dispatch (Wave 4, once D2 lands).** |
| 2026-10-08 | R1 landed: commit 1d1a5b7 (11 files). Review verdict nits only (Opus 5.5 high, 3 rounds; all acceptance criteria independently reproduced). Claim released. **Next: R2, R3 dispatch (Wave 3, on R1).** |
| 2026-10-08 | D2 landed: commit fbd95c0 (16 files). Review verdict nits only (Opus 5.5 high, 3 rounds; all acceptance criteria independently reproduced). Claim released. **Next: DB1 dispatch (Wave 4, on DB0 + D2).** |
| 2026-10-08 | R3 landed: commit cbf34e0 (fetch handler, task API routes, in-browser API explorer). Review verdict nits only (Opus 5.5 high, review-02; Unicode-whitespace mutant fixed and verified; all acceptance criteria independently reproduced). Claim released. **Next: R2 verdict, then R4 (needs R2 + DB0).** |
| 2026-10-08 | R2 landed: commit 1b38527 (task commands and standard db commands in the terminal). Review verdict clean, one cosmetic nit (Opus 5.5 high, review-03; 122 native tests + 10 browser specs on dev and static; all acceptance criteria independently reproduced). Claim released. **Next: R4 dispatch (needs R2 + R3 + DB0, all landed).** |
| 2026-10-08 | R2 + R3 dispatched by main (Fable 5.1 session) for Wave 3 parallel build on R1 1d1a5b7, base d568ca4: briefs at `agent-work/items/R2/brief.md` (prototype-builder-strong, Opus 5.5 medium, run-20261008-r2-01, ports 5186/4186) and `agent-work/items/R3/brief.md` (prototype-builder-fast, Sonnet 5.5 high, run-20261008-r3-01, ports 5187/4187); single Playwright worker each; R3's `packages/playground/api/` read as `playground/api/` (the playground lives at `playground/`). DB1 (run-20261008-db1-01, dispatched 07:21 CDT) was stopped by the orchestrator before completion; its partial files remain uncommitted in the tree. **Next: R2/R3 builds complete, then independent reviews; DB1 resume or re-dispatch at the orchestrator's call.** |
| 2026-10-08 | DB1 relaunched by main at the orchestrator's request: the stopped agent could not be resumed (harness treats a user-stopped agent as cancelled), so a fresh prototype-builder-strong (Opus 5.5 high) continues as run-20261008-db1-02, generation 2, predecessor run-20261008-db1-01 (no verified chunks; inherited duckdb-shell.ts, two probe specs and an App.tsx block to be audited). Ports 5185/4185, concurrent with R2/R3. **Next: orchestrator updates the DB1 claim and index row to generation 2; builds complete, then reviews.** |
| 2026-10-08 | DB1 landed: commit 67aa90b (8 files: duckdb-shell.ts + 4 specs + main's playground restructure App.tsx/instance/PlaygroundInstance.tsx/instance/SharedEditor.tsx, required in one commit by the reviewer landability note -- DB1's lifecycle.spec.ts drives the restructure's instance-close/reopen and PlaygroundInstance.tsx imports duckdb-shell.ts; R4's paused slice excluded). Review verdict nits only (Opus 5.5 high, review-01; 139/0 deno task test, 10/10 dev + 10/10 static, 19/19 SQLite regressions, 16/16 D2, mutants m3/m8/m9 fail as expected; all done-when criteria independently reproduced). Claim released. Orchestrator-actionable findings: none (S1/S2/N1-N5 recorded for main; S2 amends docs/database-editor-plan.md item 4). **Next: R4 fix round F2 unblocked (main), then re-review; R6 dependencies met.** |
| 2026-10-08 | R4 fix round done by main after DB1 67aa90b (F1 unused import fixed, F2 DB1 import confirmed; native 139 passed; coherence/lifecycle/browser suites 8 passed + 1 skipped on dev and static); R4 independent review dispatched (Opus 5.5 high, ports 5193/4193). R6 brief written at `agent-work/items/R6/brief.md`, claim recorded, dispatched as prototype-builder-strong (Opus 5.5 medium, run-20261008-r6-01, ports 5194/4194) with the Q18 one-shell-per-page handling spelled out. **Next: R4 verdict → land R4; R6 build → review → land.** |

| 2026-10-08 | R4 landed: commit 9199cfe (landed 14:15 CDT by main; 10 files: packages/core/events.ts + tests/coherence/ + tests/lifecycle/ + tests/property/, R4 slice only; R6 in-flight hunks excluded; pushed to origin/main with this record). Review verdict nits only (Opus 5.5 high, review-03; review-02 must-fix resolved via mutation D1; review-03 shoulds closed in fix round 3). Reuse of the §5 escape hatch (plan.md:170-173): editor-console checks land as recorded open items -- "shell write visible elsewhere (upstream console)" and "editor tab changes" stay open; R14 remains the final gate. Build claim released; post-landing sqlite-workbench follow-up grant active (agent-work/claims/sqlite-workbench-followup/). **Next: R4 worktree verification results; R6 build -> review -> land; R5/R7/R9 briefs per main.** |
| 2026-10-08 | R6 landed: commit 7de16eb (landed 16:58 CDT by main; 12 files: prototypes/event-analytics/ + tests/duckdb/ + 4-line delimited block in playground/instance/PlaygroundInstance.tsx, R6 slice only; pushed to origin/main with this record). Review verdict nits only (Opus 5.5 high, review-02; review-01 must-fix DuckDB worker leak fixed + pinned by close-during-startup spec; all done-when criteria independently reproduced). Build claim released. **Next: R6 completes the Codex pivot trigger -- R5/R7/R9 builders dispatch via codex exec (gpt-6-astra).** |
| 2026-10-08 | R5/R7/R9 dispatched by orchestrator via codex exec --model gpt-6-astra (headless, logs /tmp/r5-codex.log, /tmp/r7-codex.log, /tmp/r9-codex.log) -- the Codex pivot trigger (R6 7de16eb landed). Runs run-20261008-r5/r7/r9-01 gen 1, claims held, disjoint paths and ports per briefs (5195/4195, 5196/4196, 5197/4197). Probe verified the model works under the ChatGPT login; --approve-for-me with workspace-write sandbox; stdin must be </dev/null or codex hangs reading it. **Next: builds complete, then independent reviews (Codex per pivot).** |
| 2026-10-08 | R7 landed: commit 40b6ba7 (6 files: packages/database/sqlite-persistence.{tsx,md} + tests/persistence/sqlite/, R7 slice only; landed 17:40 CDT by orchestrator). Review verdict clean (Codex gpt-6-astra, review-01; all acceptance criteria independently reproduced on dev + static without COOP/COEP; 3/3 mutations caught; scope closure releases workers/pool locks). Accepted deviations: no `?sqlite3.dir=` query param (pinned loader verified without it, documented in sqlite-persistence.md); isolated fixture instead of playground mount (brief allowance). Claim released. **Next: R8 (R6+R7 landed) -- brief + dispatch.** |
| 2026-10-08 | R8 brief written by orchestrator at `agent-work/items/R8/brief.md`, claim at `agent-work/claims/R8/claim.md`, run run-20261008-r8-01 gen 1: per plan.md section 10b (transfer tools + DuckDB persistence; own packages/database/transfer/, tests/transfer/, docs/database-capabilities.md; ports 5198/4198). Build via codex exec --model gpt-6-astra headless per pivot plan (R6 7de16eb + R7 40b6ba7 landed). **Next: R8 build completes, then independent review (Codex sol high).** |
## 1. Goal

Deliver a static browser playground in which portable TypeScript application
logic, composed with Effect 4, can be exercised through web, CLI, API, and a
database editor against one SQLite or DuckDB instance. Finish with runnable
demos for each interface type and DuckDB analytics. Every accepted slice must
produce an observable behavior with executed verification; directories and stubs
alone do not complete a slice.

Authentication, remote execution, multi-user state, an ORM, and a plugin
framework remain outside scope. R0 is an infrastructure demonstration; from D1
onward every product prototype reuses the common database service and, once DB0
lands, the common database editor.

## 2. Decisions

| ID  | Question                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                              | Status                    |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Q1  | Runtime and effects         | Deno development; portable Effect 4 application core; browser-specific and Deno-specific adapters stay separate. Versions pinned per Q13 and locked in R0.                                                                                                                                                                                                                                                                            | Required                  |
| Q2  | Shared state                | One managed runtime and one database service per opened prototype. Adapters and editor receive that instance.                                                                                                                                                                                                                                                                                                                         | Required                  |
| Q3  | Editor visibility and reuse | One common `DatabaseEditor` host runs real upstream shells: the sqlite3 CLI WASM build (Fiddle) and `@duckdb/duckdb-wasm-shell`. No toolkit-authored shell, dot commands or output formatting. Every prototype mounts the host against live data.                                                                                                                                                                                     | Required                  |
| Q4  | Editor behavior             | Host controls (table list, schema view, reset, capability-gated import/export) sit beside the upstream console and operate on the same service. Successful console submissions invalidate dependent views.                                                                                                                                                                                                                            | Required                  |
| Q5  | Delivery order              | After R0: D1 (SQLite service) and DB0 (host + sqlite3 shell) in parallel on R0's worker skeleton. R1 depends on D1 only. DB1 after DB0 and D2. See §5 waves.                                                                                                                                                                                                                                                                          | Revised this pass         |
| Q6  | Agent state                 | Repository-global `agent-work/` in the primary checkout, shared by every agent and worktree. Per-run files avoid concurrent writes.                                                                                                                                                                                                                                                                                                   | Established               |
| Q7  | Dependency changes          | Orchestrator alone edits shared dependency/build files and public contract changes. Builders request additions through their progress record.                                                                                                                                                                                                                                                                                         | Established               |
| Q8  | Final examples              | `demos/cli`, `api`, `web`, `combined`, and `analytics`; small domain examples that use toolkit components without duplicating infrastructure.                                                                                                                                                                                                                                                                                         | Required                  |
| Q9  | Parallelism                 | Default: orchestrator + two builders + one reviewer. The demo wave (R10–R13) may run four builder-fast agents because directories are disjoint. File ownership overrides graph eligibility.                                                                                                                                                                                                                                           | Planned                   |
| Q10 | Persistence                 | Memory is the baseline. OPFS is configurable and capability-dependent; report requested vs actual mode with a reason and verify memory fallback. No promise of identical engine behavior.                                                                                                                                                                                                                                             | Required                  |
| Q11 | Service/shell split         | The `DatabaseService` contract and conformance suite are shell-independent. **SQLite in the browser:** the service runs on the Fiddle engine (same WASM instance as the shell) through a structured worker protocol; a separate sqlite-wasm instance cannot share the live db. **DuckDB:** the service owns the `AsyncDuckDB`; the shell gets it via `resolveDatabase` and opens its own connection. The app never parses shell text. | Decided 2026-10-07        |
| Q12 | Shell command scope         | Upstream web shells with a smaller command set than the native CLI are acceptable; nothing hand-rolled. SQLite required commands: `.help .tables .schema .mode table/csv/json .headers`. DuckDB required commands: the pinned shell's `.help` list plus `SHOW TABLES` and `DESCRIBE`.                                                                                                                                                 | Decided 2026-10-07 (user) |
| Q13 | Pinned versions             | `effect@4.0.2`; `@duckdb/duckdb-wasm@1.32.0` + `@duckdb/duckdb-wasm-shell@1.32.0` (engine 1.4.3; not `latest`); `just-bash@3.6.0`; `@xterm/xterm@6.0.0`; `vite@8.3.3`; `react@19.3.0`; `@playwright/test@1.62.0` (matches cached chromium-1234); sqlite3 shell = vendored Fiddle, SQLite 3.54.0 trunk snapshot `4bfc6e53a9` built with emsdk 5.0.1; `@sqlite.org/sqlite-wasm@3.53.4-build2` only for Deno-side conformance runs.      | Proposed; R0 locks        |
| Q14 | Browser test runner         | `deno task test:browser` runs `deno run -A npm:@playwright/test@1.62.0 test` (verified under Deno, no Node needed); `npx playwright test` is the documented fallback. Chromium only.                                                                                                                                                                                                                                                  | Proven by POC             |
| Q15 | Persistence VFS             | SQLite: `opfs-sahpool` is the default persistent mode (no COOP/COEP, single tab); a second tab falls back to memory with a visible "open in another tab" reason; `opfs`/`opfs-wl` (multi-tab, shell cancellation) are **deferred**: not built unless a prototype needs them. DuckDB: `opfs://` with the pinned build, single handle per file, `CHECKPOINT` after writes.                                                              | Decided 2026-10-07        |
| Q16 | Model roster                | Claude: Fable 5.1 for the hardest slices, Opus 5.5 for multi-part slices and reviews, Sonnet 5.5 high for bounded slices. Codex: sol 6.1 (high for hard slices and reviews, medium otherwise) and luna high for bounded slices. Per-item assignments in §10.                                                                                                                                                                          | Established               |
| Q17 | Fiddle build and flags      | Vendor the 3.54.0 trunk snapshot now with provenance; rebuild script deferred; re-pin when 3.54.0 releases. Start the shell **without** upstream's `-safe` (it makes `.open` read-only and blocks OPFS) and **without** `-bail` (native interactive behavior continues after an error). Host blocks `.open`.                                                                                                                          | Decided 2026-10-07        |
| Q18 | DuckDB shell lifecycle      | One shell per page: the host embeds the shell once per prototype instance and moves its container between tabs; it wraps `AsyncDuckDB.open` to block `.open`; `db.terminate()` on dispose. Ship only the `eh` bundle and self-host the `json`/`parquet` extensions so static builds work offline.                                                                                                                                     | Decided 2026-10-07        |

## 3. Vocabulary

- **Slice**: one backlog item with a user-visible outcome and independent
  evidence.
- **Wave**: a set of slices whose dependencies are satisfied at the same time
  and whose files are disjoint, so they may run concurrently.
- **Prototype instance**: application, database, runtime, and notifications with
  one lifecycle.
- **Database service**: the Effect service through which every adapter,
  including the editor's auxiliary controls, reads and writes the engine.
- **Engine worker**: the Web Worker that owns the engine for one prototype
  instance (Fiddle module for SQLite; `AsyncDuckDB` worker for DuckDB) and
  speaks R0's message protocol.
- **Shell binding**: engine-specific code that mounts the upstream console and
  ties it to the engine worker.
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
baseline exists. The POC commit that follows it is reference material, not an
implementation slice. No implementation slice has started.

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
before requesting a decision, and before stopping. The orchestrator inspects the
index and active progress records at dispatch, completion, and whenever a
builder reports. A stale timestamp triggers investigation, never automatic
takeover. Agents may read other agents' briefs, progress, reports, and lessons;
they must reference paths and distinguish reviewed facts from in-flight claims.

## 5. Concurrency and dependency graph

```text
R0  -> D1, DB0                 (R0 freezes §9 and the engine-worker protocol; D1 and DB0 run in parallel)
D1  -> R1, D2
R1  -> R2, R3
DB0 + D2 -> DB1
R2 + R3 + DB0 -> R4
DB1 -> R6
R4  -> R5, R7, R9
R6 + R7 -> R8
R5  -> R10, R11, R12, R13
R8 + R9 + R10 + R11 + R12 + R13 -> R14
```

**Critical path:** R0 → D1 → R1 → (R2 ∥ R3) → R4 → R5 → R13 → R14. DB0 (the
upstream sqlite3 shell host) is off the critical path until R4; its slack is the
combined duration of D1, R1 and R2/R3. If DB0 is still blocked when R4 is ready,
R4 lands its non-editor checks and records the editor checks as open; R14
remains the final gate.

### Waves

| Wave | Runs concurrently                                                       | Why these are safe together                                                                                                        | Gate to the next wave                      |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0    | POCs (done, `pocs/`), then **R0** alone                                 | R0 owns root tooling, `deno.json`, `deno.lock`, vendored shell assets and the engine-worker skeleton; nothing else may touch them. | R0 landed; §9 signatures frozen in briefs. |
| 1    | **D1** ∥ **DB0**                                                        | Both build on R0's worker. D1 owns the structured `exec` family + service; DB0 owns the `shell` family + host. Disjoint files.     | D1 landed (DB0 keeps running).             |
| 2    | **R1** ∥ **DB0** (continuing); **D2** when a builder frees              | `prototypes/task-manager/` + `tests/sqlite/` vs editor files vs `packages/database/duckdb*` + `tests/database-duckdb/`.            | R1 landed.                                 |
| 3    | **R2** ∥ **R3**; DB0 / D2 continue if unlanded                          | CLI files vs API files; both consume R1's application contract read-only.                                                          | R2, R3 and DB0 landed.                     |
| 4    | **R4** (main) ∥ **DB1**                                                 | `packages/core/events.ts` + coherence/property/lifecycle tests vs `duckdb-shell.ts` + its tests.                                   | R4 landed.                                 |
| 5    | **R5** ∥ **R7**, then **R9**; **R6** as soon as DB1 lands               | Generator/templates vs persistence vs native adapters vs analytics prototype: four disjoint directories.                           | R5 landed (R7/R9/R6 may still run).        |
| 6    | **R10** ∥ **R11** ∥ **R12** ∥ **R13** (up to four builder-fast); **R8** | Each demo owns one `demos/<name>/` directory; R8 owns `packages/database/transfer/`.                                               | R8, R9 and all demos landed.               |
| 7    | **R14** alone (main)                                                    | Owns registry, gallery, docs, release checks.                                                                                      | Release verification passes.               |

Within a wave, two builders is the default cap (Q9). When a wave has more
eligible items than builders, dispatch in the listed order; the critical-path
item goes first.

File overlap overrides graph eligibility. One writer owns each source path;
shared entry points, barrel exports, `deno.json`, `deno.lock`, Vite/Playwright
configuration, demo registry, and `plan.md` belong to the orchestrator. Builders
provide patches or integration requests for these files. Do not concurrently run
commands that rewrite lockfiles or the same build directory. Give isolated tests
their own databases, temporary directories, and browser-server ports (assign a
port range per item in its brief).

### Source integration across worktrees

Global progress is shared, but source checkouts are not. Each brief names the
source checkout and integration base SHA. Prefer disjoint edits in one checkout
for this initial repository. If a builder uses a separate worktree, it never
commits: its final report identifies an exact source patch (including new files)
and a manifest of assigned paths, all saved under its canonical run directory.
The orchestrator verifies the patch against the recorded base, applies only that
slice in the integration checkout, resolves overlap under exclusive ownership,
and reruns acceptance checks there before independent review. Review the exact
integrated tree that will be committed.

### Terminal display and application shell

xterm.js renders a terminal and supplies input events. It does not execute
commands. just-bash interprets application-shell commands, including registered
TypeScript commands, pipelines and utilities. Its core shell, in-memory
filesystem and `jq` run in browsers (verified); its `sqlite3`, `python` and
`js-exec` commands report "not available in browser" and exit 127. It is not
required by and must not interpret the database console. That console passes
input to the real upstream sqlite3/DuckDB shell embedded in the shared host. Do
not route the console through just-bash's bundled `sqlite3` command.

## 6. Verification contract

The following tasks are **planned, not currently installed**. R0 creates the
shared task surface, lifting `pocs/r0-stack` (`nodeModulesDir: "auto"`,
committed `deno.lock`, exact versions in `imports`, no `@deno/vite-plugin`):

- `deno task check`: `deno fmt --check && deno lint && deno check` over source
  and tests, excluding `dist`, `node_modules`, `test-results`,
  `playwright-report`, `pocs`.
- `deno task test`: native unit/integration/property tests with minimal
  `--allow-env` names; no silent exclusion of new slices.
- `deno task test:browser`: `deno run -A npm:@playwright/test@1.62.0 test`
  against the dev server, isolated browser state, Chromium only.
- `deno task build`: `vite build` producing static assets including WASM, worker
  files, vendored shell assets and self-hosted DuckDB extensions.
- `deno task test:static`: build, serve `dist/` with
  `jsr:@std/http@1/file-server` (no special headers), run the browser suite.
- `deno task test:static:coi` (deferred with Q15): same with COOP/COEP headers,
  only if headered `opfs` mode is ever built.
- `deno task dev`: open the development playground; replaces the Hello World
  watcher.
- `deno task prototype:new <name> --type <cli|api|web|combined> --database <sqlite|duckdb>`:
  added in R5.

Browser tests assert observable outcomes, not only load success. Property tests
use a fixed seed, `verbose: 1`, an env-driven replay path, and a fresh
`ManagedRuntime` per case disposed in `finally`. Reviewers rerun relevant checks
independently. Evidence includes command, revision or dirty-tree description,
exit status, and key outcome; screenshots supplement assertions. Do not label
future acceptance commands as passing today.

## 7. Status and backlog

This is a flat backlog. Dependency readiness, not a phase number, governs work.

| Status           | Item            | Deliverable                                                                                          |
| ---------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| built, baseline  | Initial app     | Hello World, `start`/`dev`, README, Git and `.gitignore`; verified in initial baseline.              |
| reference        | POCs            | `pocs/` probes with executed evidence for the sqlite3 shell, DuckDB shell, R0 stack and the service. |
| next             | R0              | Vite/React/xterm/just-bash/Effect bootstrap, vendored Fiddle, engine-worker skeleton, test tasks.    |
| when R0 lands    | D1              | SQLite `DatabaseService` (browser on Fiddle engine, native on `node:sqlite`), conformance suite.     |
| when R0 lands    | DB0             | Common `DatabaseEditor` host running the upstream sqlite3 shell on the same engine worker.           |
| when D1 lands    | R1              | SQLite task manager with React CRUD on the shared service.                                           |
| when D1 lands    | D2              | DuckDB `DatabaseService` passing the same conformance suite.                                         |
| when R1 lands    | R2              | CLI task operations and reusable database commands against the shared instance.                      |
| when R1 lands    | R3              | Fetch API and browser explorer against the shared instance.                                          |
| when R2/R3/DB0   | R4              | Verified coherence, failures, reset, resource lifecycle, editor visibility, property tests.          |
| when DB0/D2 land | DB1             | Upstream DuckDB shell integrated with the same `DatabaseEditor`.                                     |
| when R4 lands    | R5              | Prototype generator demonstrating a second small working prototype.                                  |
| when DB1 lands   | R6              | DuckDB analytical prototype reusing the common editor.                                               |
| when R4 lands    | R7              | SQLite persistence modes and visible fallback behavior.                                              |
| when R6/R7 land  | R8              | Capability-aware database export/import and DuckDB persistence.                                      |
| when R4 lands    | R9              | Deno CLI/server adapters with equivalent observable application behavior.                            |
| when R5 lands    | R10–R13         | CLI, API, web and combined demos.                                                                    |
| when R8–R13 land | R14             | Complete gallery, DuckDB analytical demo, documentation, production verification.                    |
| deferred         | Backend hosting | Reconsider only on an explicit scope change.                                                         |

## 8. Database-editor acceptance

There is one `packages/database-editor/DatabaseEditor.tsx` component. DB0
implements the common host and the upstream sqlite3 shell binding; DB1 supplies
the DuckDB binding without forking the UI. The dedicated plan is
`docs/database-editor-plan.md`. An engine is supported only when this component
is usable with it in a running prototype against that prototype's live database.

The host embeds real upstream shells with their own prompt, SQL/dot-command
handling and output. Required command coverage (Q12), verified against the
recorded `.help` output of the pinned build:

- **SQLite (Fiddle 3.54.0):** `.help`, `.tables`, `.schema`, `.mode table`,
  `.mode csv`, `.mode json`, `.headers on|off`. Fiddle's `.help` lists 47
  commands; file/host commands
  (`.save .backup .restore .read .output .once
  .import .shell .system .load .cd .quit .exit`)
  are compiled out and answer "unknown command" upstream.
- **DuckDB (shell 1.32.0):**
  `.clear .help .examples .features .output on|off
  .timer on|off .files ...`,
  plus SQL `SHOW TABLES` and `DESCRIBE <table>`.
  `.tables .schema .mode .headers` print `Unknown command`; `.reset` prints
  `Not implemented yet`. One fixed box-table output format.

Commands the upstream shell does not implement are shown with the shell's own
response. The host **blocks `.open`** on both engines: on SQLite it replaces the
shell's connection (detectable via `fiddle_db_handle`); on DuckDB it calls
`AsyncDuckDB.open` on the shared instance and destroys the app's tables. Reset
is a host control that calls the shared service and republishes notifications.

Host input handling for SQLite: Fiddle treats each `fiddle_exec` as a complete
submission, so the binding buffers typed lines until the exported
`sqlite3_complete` says the statement is complete, shows a fixed continuation
prompt (Fiddle only exposes the main prompt), and suppresses the duplicate echo
of dot commands. This is input plumbing, not command interpretation. For DuckDB
the upstream shell owns input entirely; keys typed while a statement runs are
dropped upstream.

The host also lists tables, shows schema, resets to deterministic seeds, and
exposes capability-gated import/export, all through the shared service. These
auxiliary controls never re-render or replace console output. Display actual
engine, version and `persistence.actual` with its reason. Render big integers,
nulls, blobs, timestamps, decimals and lists without losing data or crashing
React.

Database operations go through the same service and serialization rules as
application operations. A successful shell or host write becomes visible in
enabled UI/CLI/API adapters: SQLite uses `sqlite3_update_hook` plus
`total_changes`/`schema_version` deltas; DuckDB conservatively invalidates after
any console submission that did not error. Failed execution does not publish a
success event. Handle partial changes according to the engine's transaction
behavior; do not promise automatic rollback for arbitrary batches. Schema edits
can invalidate domain assumptions: show the resulting typed errors and retain a
working reset path.

Bound displayed rows in host grids and indicate truncation. Expose cancellation
only when the adapter actually supports it (SQLite: only under COOP/COEP via a
`SharedArrayBuffer` flag and `sqlite3_progress_handler`). Imports, exports, and
persistence advertise capabilities with reasons when unavailable. SQLite-only
prototypes do not load DuckDB assets, and vice versa.

## 9. APIs and contracts

**As built:** only `main.ts` and Hello World tasks. The following contracts are
**planned R0/D1/DB0**, shaped by `pocs/sqlite-service/README.md` and
`pocs/sqlite-shell/README.md`. R0 freezes them in the D1 and DB0 briefs. Effect
4.0.2 names: `Context.Service<Self, Shape>()("key")` (there is no `ServiceMap`),
curried `Layer.effect(Tag)(eff)`, `Effect.catch`, `Schema.TaggedError` /
`Data.TaggedError`, `PubSub` + `Stream.fromPubSub`,
`ManagedRuntime.make(layer)`; everything imports from the root `"effect"`.

```ts
import type { Effect, PubSub, Scope, Stream } from "effect";

type Engine = "sqlite" | "duckdb";
type Interface = "web" | "cli" | "api";
type Persistence = "memory" | "opfs-sahpool" | "opfs"; // DuckDB: "memory" | "opfs"
type PrototypeConfig = {
  name: string;
  database: Engine;
  persistence: Persistence;
  interfaces: readonly Interface[]; // Database editor always present.
};

// In-process cell values, normalized: integers are number when safe, bigint
// only when unsafe (both engines); blobs are Uint8Array. CLI/API/editor JSON
// output uses encodeCell(): bigint -> {$type:"bigint",value}, blob -> {$type:"blob",base64}.
type Cell = null | number | string | bigint | Uint8Array;

type DatabaseError = {
  readonly _tag: "DatabaseError";
  readonly operation:
    | "open"
    | "execute"
    | "tables"
    | "schema"
    | "reset"
    | "import"
    | "export"
    | "recover";
  readonly message: string;
  readonly cause: unknown;
};
type QueryResult = {
  columns: readonly string[]; // first result-set; duplicates allowed
  rows: readonly (readonly Cell[])[];
  changes: number; // total_changes() delta, never sticky
  schemaChanged: boolean; // PRAGMA schema_version moved (SQLite); catalog diff (DuckDB)
  truncated: boolean;
};
type Capability = { available: true } | { available: false; reason: string };
type DatabaseChange = {
  kind: "write" | "reset" | "import";
  source: "app" | "shell" | "host";
  changes: number;
  schemaChanged: boolean;
};

// Engine-specific implementation remains accessible; no common SQL dialect.
interface DatabaseService {
  readonly engine: Engine;
  readonly version: string;
  readonly persistence: {
    requested: Persistence;
    actual: Persistence;
    reason?: string;
  };
  readonly capabilities: {
    persistence: Capability;
    multiTab: Capability;
    export: Capability;
    import: Capability;
    cancellation: Capability;
  };
  execute(
    sql: string,
    options?: { maxRows?: number; source?: DatabaseChange["source"] },
  ): Effect.Effect<QueryResult, DatabaseError>;
  tables(): Effect.Effect<readonly string[], DatabaseError>;
  schema(table: string): Effect.Effect<string, DatabaseError>;
  reset(): Effect.Effect<void, DatabaseError>;
  exportBytes(): Effect.Effect<Uint8Array, DatabaseError>;
  importBytes(bytes: Uint8Array): Effect.Effect<void, DatabaseError>; // header check + quick_check; restores snapshot on failure
  readonly subscribe: Effect.Effect<
    PubSub.Subscription<DatabaseChange>,
    never,
    Scope.Scope
  >;
  readonly changes: Stream.Stream<DatabaseChange>; // published only after success
}

// Engine worker protocol (R0): one worker per prototype instance, two message
// families on one port. D1 implements `exec`; DB0 implements `shell`.
type WorkerRequest =
  | { family: "exec"; id: number; sql: string; maxRows?: number }
  | {
    family: "exec";
    id: number;
    op: "tables" | "schema" | "reset" | "export" | "import";
    arg?: unknown;
  }
  | { family: "shell"; op: "submit"; text: string } // complete statement or dot command
  | { family: "shell"; op: "interrupt" };
type WorkerEvent =
  | { family: "exec"; id: number; ok: true; result: QueryResult }
  | { family: "exec"; id: number; ok: false; error: DatabaseError }
  | { family: "shell"; op: "output"; stream: "stdout" | "stderr"; text: string }
  | { family: "shell"; op: "prompt"; text: string }
  | { family: "change"; change: DatabaseChange }; // from update_hook or post-submit diff

// Shell binding: what the common host needs from an engine's upstream console.
interface ShellBinding {
  mount(container: HTMLElement): Effect.Effect<void, ShellError, Scope.Scope>; // once per prototype instance
  ready: Effect.Effect<void, ShellError>;
  submit(line: string): Effect.Effect<void, ShellError>; // SQLite: buffers until sqlite3_complete; DuckDB: shell owns input
  readonly output: Stream.Stream<string>; // upstream text, untouched
  readonly sharesDatabaseWith: DatabaseService; // same engine instance, proven by tests
}

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type ApiHandler = (request: Request) => Promise<Response>;
```

Rules settled by the POCs and binding on D1/D2/DB0/DB1:

- A **write** means `changes > 0 || schemaChanged`; a no-op UPDATE publishes
  nothing. Multi-statement scripts that fail partway publish a `write` if any
  earlier statement changed something (open item from the POC; decided here).
- `execute` is serialized behind a one-permit semaphore; reset and import close
  before they open and swap the handle in a `Ref` under that same lock, so the
  service object identity never changes.
- Never detect OPFS with `'opfs' in sqlite3`; use
  `capi.sqlite3_vfs_find("opfs")`. `OpfsSAHPoolDb` lives on the object returned
  by `installOpfsSAHPoolVfs()`.
- SQLite text/blob binding goes through `wasm.exports.sqlite3_bind_*` until the
  upstream `capi.sqlite3_bind_text` bug is fixed.
- DuckDB result conversion reads Arrow vectors by type; never `toArray()` on
  LIST (NULL becomes 0), DECIMAL (scale lost) or INTERVAL (value lost). BIGINT
  is `bigint`; HUGEINT via `String()`.
- Native tests use Deno's `node:sqlite` with `setReadBigInts(true)`, one
  statement per `prepare()`, and never read `.sourceSQL` on an empty statement.
- Parameter binding and per-statement result sets are deferred until a slice
  needs them; `schema()` quotes identifiers.

Use the task application Effect contract in `project.md` §5. Validate input with
Effect Schema (v4 API), map expected errors at boundaries, and keep defects
distinguishable. A conformance test suite (D1) runs against every
`DatabaseService` implementation: Fiddle-engine browser service, `node:sqlite`
native service, sqlite-wasm under Deno (memory only), and the DuckDB service.

## 10. Work breakdown

Model shorthand used below (Q16): **Fable** = Claude Fable 5.1 (Claude Code
`model: fable`); **Opus** = Claude Opus 5.5 (medium effort to build, high to
review); **Sonnet** = Claude Sonnet 5.5 at high effort; **sol** = Codex
gpt-6.1-sol at the stated effort; **luna** = Codex gpt-6-luna at high effort.
Each cell reads `Claude / Codex`. Every reviewer is independent and read-only
with respect to application sources. `main` is the controlling session.

### 10a. Next dispatch block

| ID  | Wave | Task and allowed files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Build (Claude / Codex)      | Review (Claude / Codex)              | Done when                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0  | 0    | Bootstrap from `pocs/r0-stack`: Vite + React + Deno tasks (§6), xterm.js + just-bash terminal, one Effect command with argument/pipeline/error examples, Playwright-under-Deno harness, static build smoke. Vendor the Fiddle artifacts with `PROVENANCE.md` and lift the engine-worker skeleton (§9 protocol, both families stubbed) from `pocs/sqlite-shell`. Pin Q13, commit `deno.lock`, freeze §9, write `docs/integrations.md`. Own root tooling, `packages/core/types.ts`, `packages/terminal/`, `packages/database/worker*`, vendored assets, initial playground, `tests/browser/smoke*`. | **Fable** (main) / sol high | Opus high / sol high                 | `check`, `test`, `test:browser`, `build`, `test:static` exist and pass; custom command receives quoted args; `\| jq` pipeline renders; typed failure renders stderr + nonzero exit; worker loads the vendored Fiddle module from the static build; `docs/integrations.md` records versions, header needs, bundle contents and unsupported assumptions.                                 |
| D1  | 1    | SQLite `DatabaseService` per §9 on R0's worker (`exec` family over the Fiddle engine's `sqlite3.capi`/`oo1.DB.wrapHandle`), `node:sqlite` native implementation, shared cell normalizer, Effect layer with scoped acquisition, serialized execute, atomic reset/import, `update_hook` change events; conformance suite; seeded playground workbench panel (table list + SQL box, no shell). Own `packages/database/sqlite*`, `packages/database/native*`, `packages/database/conformance*`, `tests/database/`.                                                                                    | Opus / sol medium           | Opus high / sol high                 | Conformance suite passes on the Fiddle engine (browser), `node:sqlite` (Deno) and sqlite-wasm memory (Deno); bad SQL yields `DatabaseError`; finalizer closes the worker; reset restores exact seeds with the same service identity; exactly one change event per successful write, none on failure; bigint/null/blob round-trip; `opfs-sahpool` works from the plain static server.   |
| DB0 | 1–3  | Common `DatabaseEditor` host + upstream sqlite3 shell binding per `docs/database-editor-plan.md`, from `pocs/sqlite-shell`: `shell` family in R0's worker (`fiddle_exec`, prompt, `sqlite3_complete` buffering, continuation prompt, echo de-dup, `.open` block, Q17 flags), xterm mount, host controls. Own `packages/database-editor/`, `packages/database/sqlite-shell*`, `tests/database-editor/`. Main approves the binding contract and mounts the workbench.                                                                                                                               | **Fable** / sol high        | **Fable** / sol high (critical gate) | Real sqlite3 banner/prompt; Q12 SQLite commands and SQL run in browser with recorded output; app write visible in shell and shell write visible to the service, proven by test; multiline input, `;` in strings, error-then-valid pass; `.open` blocked with a visible message; errors/history/reset/cleanup pass; no custom parser or formatter; assets served from the static build. |
| R1  | 2    | SQLite task application, React CRUD, playground mount. Own `prototypes/task-manager/{application,schema,seed,App}*`, `tests/sqlite/`. Reuses D1; editor mount is added by main once DB0 lands (verified in R4).                                                                                                                                                                                                                                                                                                                                                                                   | Opus / sol medium           | Opus high / sol high                 | CRUD, seeds, reset and typed errors pass native and browser checks; invalid title and missing id map to tagged errors; UI re-renders from the `changes` stream, not polling.                                                                                                                                                                                                           |
| D2  | 2–3  | DuckDB `DatabaseService` from `pocs/duckdb-shell`: `AsyncDuckDB` worker with local `eh` bundle only, self-hosted `json`/`parquet` extensions, typed Arrow → `Cell` conversion, catalog-diff `schemaChanged`, `opfs://` + `CHECKPOINT`. Own `packages/database/duckdb*`, `tests/database-duckdb/`, `scripts/fetch-duckdb-extensions*`.                                                                                                                                                                                                                                                             | Opus / sol medium           | Opus high / sol high                 | D1 conformance suite passes in browser; BIGINT/HUGEINT/DECIMAL/INTERVAL/TIMESTAMP/LIST/NULL round-trip exactly; worker terminates on scope close; static build works offline without COOP/COEP; asset size recorded.                                                                                                                                                                   |
| R2  | 3    | Task commands and standard database commands in the terminal. Own `prototypes/task-manager/commands.ts`, `packages/terminal/commands.ts`, `tests/cli/`; no root dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                     | Opus / sol medium           | Opus high / sol high                 | Browser terminal creates/completes/deletes tasks visible in UI; `tasks list --json \| jq` works; invalid input and missing task produce stderr + nonzero exit; `db reset` restores seeds.                                                                                                                                                                                              |
| R3  | 3    | Fetch handler and explorer. Own `packages/api/`, `prototypes/task-manager/api.ts`, `packages/playground/api/`, `tests/api/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Sonnet / luna               | Opus high / sol high                 | Explorer invokes GET/POST/PATCH/DELETE without network transport; 400/404/500 mappings pass; created tasks appear in UI; API tests share one runtime.                                                                                                                                                                                                                                  |
| R4  | 4    | Coherence, lifecycle, reset/error experience across all interfaces including the editor. Own `packages/core/events.ts`, `tests/coherence/`, `tests/property/`, `tests/lifecycle/`; main integrates core/UI contract fixes sequentially.                                                                                                                                                                                                                                                                                                                                                           | **Fable** (main) / sol high | Opus high / sol high                 | CLI create → API complete → UI/shell query agree; shell write visible elsewhere; reset restores exact seeds; seeded fast-check model tests reproduce failures with printed seed/path; close/reopen and tab changes leak no workers or listeners and duplicate no notifications.                                                                                                        |
| R5  | 5    | Minimal generator/templates plus a second prototype generated into a temporary directory as proof. Own `tools/prototype-new.ts`, `templates/`, `tests/generator/`, `docs/new-prototype.md`; main adds task and registry support.                                                                                                                                                                                                                                                                                                                                                                  | Sonnet / luna               | Opus high / sol high                 | Generated CLI/API/web/combined configs select the right interfaces and always include Database; generated SQLite example builds and runs CRUD plus SQL; generator refuses to overwrite; DuckDB generation enabled only once D2 and DB1 have landed.                                                                                                                                    |

### 10b. Remaining slices and history

| ID  | Wave | Task and allowed files                                                                                                                                                                                                                                                                                                                                                                                                    | Build (Claude / Codex) | Review (Claude / Codex)      | Done when                                                                                                                                                                                                                                                                                                      |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB1 | 4    | Upstream DuckDB shell binding in the common host from `pocs/duckdb-shell`: `shell.embed` once per prototype instance with `resolveDatabase` returning D2's instance, container moved between tabs, `AsyncDuckDB.open` wrapped to block `.open`, listener cleanup on dispose, `db.terminate()`. Own `packages/database-editor/duckdb-shell.ts`, `tests/database-editor-duckdb/`; common-host edits need a dedicated claim. | Opus / sol high        | Opus high / sol high         | Real upstream shell runs the Q12 DuckDB command set and SQL against the same instance as the app, both directions proven; recorded `.help` matches the pinned shell; `.open` blocked; six mount/unmount cycles leak no listeners; SQLite regressions pass. Escalate to Fable if the host contract must change. |
| R6  | 5    | Analytical prototype. Own `prototypes/event-analytics/`, `tests/duckdb/`. Reuse D2 and the common editor.                                                                                                                                                                                                                                                                                                                 | Opus / sol medium      | Opus high / sol high         | Event aggregates render in app and shell; shell INSERT changes aggregates; deterministic reset and resource disposal pass browser checks; works offline from the static build.                                                                                                                                 |
| R7  | 5    | SQLite persistence (`opfs-sahpool` only; headered modes deferred per Q15) and fallback UI, on the Fiddle engine (requires Q17 flags and `?sqlite3.dir=`). Own `packages/database/sqlite-persistence*`, `tests/persistence/sqlite/`; sqlite adapter edits only under a dedicated claim.                                                                                                                                    | Opus / sol medium      | Opus high / sol high         | Reload retains data in `opfs-sahpool` without special headers; second tab falls back to memory with a visible reason; reset stays deterministic; `persistence.actual` is displayed.                                                                                                                            |
| R8  | 6    | Transfer tools and DuckDB persistence. Own `packages/database/transfer/`, `tests/transfer/`, `docs/database-capabilities.md`; main integrates capability controls.                                                                                                                                                                                                                                                        | Opus / sol medium      | Opus high / sol high         | SQLite export/import round-trip preserves data; corrupt import restores the snapshot; DuckDB `opfs://` + `CHECKPOINT` survives reload, Parquet `COPY` export works; active interfaces reconnect after import.                                                                                                  |
| R9  | 5    | Native Deno CLI and `Deno.serve` API on D1's `node:sqlite` service. Own `adapters/deno/`, `tests/native/`, `docs/native.md`.                                                                                                                                                                                                                                                                                              | Opus / sol medium      | Opus high / sol high         | Task CLI and API share one native instance; equivalent operation sequences match browser outcomes and error semantics; native and browser paths remain separately importable.                                                                                                                                  |
| R10 | 6    | CLI inventory demo. Own `demos/cli/` and its tests.                                                                                                                                                                                                                                                                                                                                                                       | Sonnet / luna          | Sonnet / luna                | SQLite `inventory list/add/remove` with JSON pipeline; only Terminal and Database views; walkthrough verifies a shell write through the CLI.                                                                                                                                                                   |
| R11 | 6    | API bookmarks demo. Own `demos/api/` and its tests.                                                                                                                                                                                                                                                                                                                                                                       | Sonnet / luna          | Sonnet / luna                | SQLite GET/POST/DELETE bookmarks through the explorer; only API and Database views; invalid request demonstrated; shell changes appear in GET.                                                                                                                                                                 |
| R12 | 6    | Web notes demo. Own `demos/web/` and its tests.                                                                                                                                                                                                                                                                                                                                                                           | Sonnet / luna          | Sonnet / luna                | SQLite create/edit/delete notes; only Application and Database views; shell UPDATE refreshes UI without polling; reset restores notes.                                                                                                                                                                         |
| R13 | 6    | Combined task-manager demo. Own `demos/combined/` and its tests.                                                                                                                                                                                                                                                                                                                                                          | Sonnet / luna          | Sonnet / luna                | All four views share data; walkthrough creates via CLI, completes via API, inspects UI and shell; reuses task-manager domain logic.                                                                                                                                                                            |
| R14 | 7    | Gallery including DuckDB analytics. Own `demos/analytics/`, `demos/README.md`, `docs/architecture.md`, README, shared registry/build integration, `tests/static/`.                                                                                                                                                                                                                                                        | Opus (main) / sol high | **Fable** / sol high (final) | `check`, `test`, `test:browser`, `build`, `test:static` pass; all five demos run from asset-only hosting offline; analytics uses the DuckDB shell; clean setup and generator walkthrough executed.                                                                                                             |

No implementation slices have landed yet. Move completed rows into a history
subsection with command evidence and commit SHA; retain their IDs.

### 10c. Working protocol

| Role             | Claude Code definition                                        | Codex preference | Responsibility                                                                           |
| ---------------- | ------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| main             | Controlling session (Fable 5.1)                               | sol 6.1 high     | Design, shared contracts/files, claims, dispatch, index, plan log, integration, commits. |
| builder-critical | `.claude/agents/prototype-builder-critical.md`, Fable 5.1     | sol 6.1 high     | Slices where the integration itself is the unknown (DB0; DB1 if escalated).              |
| builder-strong   | `.claude/agents/prototype-builder-strong.md`, Opus 5.5 medium | sol 6.1 medium   | Multi-part slice; own assigned files and per-run progress.                               |
| builder-fast     | `.claude/agents/prototype-builder-fast.md`, Sonnet 5.5 high   | luna high        | Bounded slice with fixed observable checks.                                              |
| reviewer         | `.claude/agents/prototype-reviewer.md`, Opus 5.5 high         | sol 6.1 high     | Independently verify; report findings without changing source.                           |
| reviewer-final   | same file with `model: fable` override                        | sol 6.1 high     | DB0 and R14 gates.                                                                       |

Codex model names: `sol 6.1` is gpt-6.1-sol; `luna` is gpt-6-luna. Only these
two are used.

1. **Brief and claim.** Main ensures the reviewed baseline exists, verifies
   dependencies have landed, settles §9, records an exclusive claim, and creates
   `items/<id>/brief.md`. Copy the full assignment row, relevant signatures,
   allowed and forbidden files, dependency commits, checkout, run ID/generation,
   progress root, commands, port range, acceptance examples, and the relevant
   `pocs/*/README.md` paths. Log dispatch in §0.
2. **Build and checkpoint.** Builder creates its per-run records from the
   template. Work only in assigned paths; never commit or edit `plan.md` or the
   shared index. Report dependency requests or contract deviations before making
   dependent edits. Checkpoint after each verified chunk and before stopping.
3. **Integrate and review.** For another source worktree, main imports the slice
   patch using §5 before review. Main dispatches an independent reviewer with
   the brief, builder report, diff/untracked file list, and evidence paths.
   Findings are `must-fix`, `should`, or `nit`, with `file:line` and a concrete
   failure case. Main saves the verdict under `reviews/`.
4. **Land.** Only `clean` or `nits only` verdicts are eligible. Main stages only
   the slice's files, integrates approved shared changes, and creates one commit
   with its item ID. Update contracts, index, evidence and §0 with the SHA.
   Release the claim and ready dependents.
5. **Stop.** Request a checkpoint before interrupting. Builder writes
   `handoff.md`. Main confirms the old agent has stopped, records `paused` or
   `blocked`, and releases its claim.
6. **Resume or replace.** Main reads the brief, all attempt checkpoints, latest
   review, Git status and recent commits. Confirm no old writer remains,
   increment generation and assign a fresh run ID.
7. **Recover after context loss.** Read §0, §7, the index, active handoffs, Git
   log and status. Check actual agent state; reconcile discrepancies in a new
   log entry.

Builder final reports contain: files changed; commands and outcomes; deviations;
open questions; reusable lessons. Reviewer reports contain: verdict; commands
and outcomes; ranked findings; deviations. Progress reports are evidence
pointers, not substitutes for independent verification.

## 11. Risks, gaps and completion gate

Verified on 2026-10-07 against upstream sources and the executed probes in
`pocs/` (details and evidence paths in each POC README):

| #  | Gap / blocker                                                                                                                                                                                                                                              | Severity | Status / mitigation                                                                                                                                                                                       |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | **The sqlite3 shell is an unofficial artifact.** Fiddle is "not an officially-supported deliverable"; the live build is a trunk snapshot (3.54.0, 2026-10-05); no download zip includes it; rebuilding needs a full source tree and emsdk (not installed). | High     | Was a blocker; now **resolved by POC**: vendored with provenance, full C API exported, bridge proven. Q17 pins the snapshot and adds a best-effort rebuild script. Never load from sqlite.org at runtime. |
| 2  | **Live sharing between shell and app** (two sqlite WASM instances cannot share a memory db).                                                                                                                                                               | High     | **Resolved by POC**: one WASM instance; app queries run on `fiddle_db_handle()`; one connection, no isolation (an app read sees the shell's uncommitted `BEGIN`). Q11 makes this the design.              |
| 3  | **Fiddle input semantics.** Each `fiddle_exec` is a full submission; no continuation state; dot commands echo twice; upstream flags `-bail -safe`.                                                                                                         | Medium   | DB0 buffers with `sqlite3_complete`, fixed continuation prompt, echo de-dup; Q17 flags. These are plumbing, not command interpretation.                                                                   |
| 4  | **DuckDB web shell command set** lacks `.tables .schema .mode .headers`; `.reset` unimplemented; one output format.                                                                                                                                        | Decided  | Q12 (user): accepted. SQL equivalents verified: `SHOW TABLES`, `DESCRIBE`, `SUMMARIZE`, `duckdb_tables()`, `to_json`, `COPY ... (FORMAT csv)`.                                                            |
| 5  | **DuckDB shell `.open` destroys the app's tables** and leaves the app connection unusable (`Max expression depth limit of 0 exceeded`, then `memory access out of bounds`).                                                                                | High     | Q18: host wraps `AsyncDuckDB.open`; DB1 done-when requires the block. SQLite `.open` is blocked too (it replaces the connection).                                                                         |
| 6  | **DuckDB shell is a page singleton with no dispose**; each mount leaks ~30 listeners and 2 `resize` handlers; a second `embed` hijacks the first terminal.                                                                                                 | Medium   | Q18: embed once per prototype instance, move the container between tabs, clean listeners on dispose; R4/DB1 assert no leak over six cycles.                                                               |
| 7  | **DuckDB extensions autoload from the internet**; offline the json/parquet functions fail with WASM errors. Default `dist` is 81 MB because both `mvp` and `eh` ship.                                                                                      | Medium   | Q18: self-host extensions (`scripts/fetch-duckdb-extensions`, `SET custom_extension_repository`); ship `eh` only (~34 MB raw, ~8 MB gzip). R14 verifies offline from static hosting.                      |
| 8  | **DuckDB-wasm `latest` (1.33.1-dev57) never writes OPFS files**; OPFS also loses writes without `CHECKPOINT` (3/3 runs); single handle per file.                                                                                                           | Medium   | Pin 1.32.0 (Q13); D2 checkpoints after writes; second tab gets a visible reason.                                                                                                                          |
| 9  | **Arrow → JS conversions lose data** via `toArray()`: LIST NULL → 0, DECIMAL scale dropped, INTERVAL emptied; BIGINT breaks `JSON.stringify`.                                                                                                              | Medium   | §9 rule: typed vector conversion in D2; shared `encodeCell` for JSON. Conformance suite covers each type.                                                                                                 |
| 10 | **SQLite multi-tab under `opfs-sahpool`**: second tab fails (`NoModificationAllowedError`); `pauseVfs` hand-off only works from a fresh Worker. Multi-tab needs COOP/COEP (`opfs`/`opfs-wl`), which GitHub Pages-style hosts cannot set.                   | Medium   | Q15: memory fallback with visible reason by default; headered mode opt-in via `test:static:coi`. A Web Locks leader hand-off is **not built** and stays deferred.                                         |
| 11 | **Effect 4.0.2 is one week old**; names differ from RC docs (`Context` not `ServiceMap`, curried layers, `Effect.catch`).                                                                                                                                  | Low      | Verified names recorded in §9 and `pocs/r0-stack`; briefs copy exact signatures; no v3 idioms.                                                                                                            |
| 12 | **Upstream sqlite-wasm JS bug**: `capi.sqlite3_bind_text` with a JS string throws `pMem is not defined` (present in 3.53.4 and the 3.54 snapshot).                                                                                                         | Low      | Bind via `wasm.exports`; report upstream; re-test on re-pin.                                                                                                                                              |
| 13 | **Deno `node:sqlite` hazards**: `RangeError` above 2^53 without `setReadBigInts(true)`; `prepare()` keeps only the first statement; `.sourceSQL` on an empty statement segfaults Deno (exit 139).                                                          | Medium   | §9 rules; D1 native implementation guards all three; native tests never pass comment-only scripts to `prepare()`.                                                                                         |
| 14 | **Playwright version is coupled to the cached browser** (1.62.0 ↔ chromium-1234; 1.64 wants chromium-1248). Fresh machines need a browser install step.                                                                                                    | Low      | Q13 pins 1.62.0; README documents `playwright install chromium` or `channel: "chrome"` for other machines.                                                                                                |
| 15 | **just-bash under Deno prints `[DefenseInDepthBox]` warnings** (16 lines per test run); harmless.                                                                                                                                                          | Low      | Set `defenseInDepth: false` in Deno tests only; keep the default in the browser.                                                                                                                          |
| 16 | **SQLite shell cancellation** needs COOP/COEP (`SharedArrayBuffer` flag + progress handler); DuckDB exposes none.                                                                                                                                          | Low      | `capabilities.cancellation` reports the reason; cancel button only under headered mode.                                                                                                                   |
| 17 | **Coordination overhead** for a three-agent project.                                                                                                                                                                                                       | Low      | Per-chunk checkpoints instead of a timed cadence (done this pass); briefs cite POCs so builders do not re-probe.                                                                                          |

R0/D1/DB0 must still confirm in the real toolkit: `opfs-sahpool` on the Fiddle
engine (the POC tested it on npm sqlite-wasm), the `coi` DuckDB bundle (not
tested), and the shell `change` events under the worker protocol. If an
assumption fails, main updates §2/§9 with the evidence before dispatching
dependent work. Do not silently swap shells, engines, or the static
architecture.

R14 completes the project only when all applicable slices have landed, every
demo has its database editor, cross-interface behavior is verified, property
failures can be replayed, and the production assets run through static hosting
offline. Document unavailable engine capabilities with observed reasons. The
planning deliverable itself does not assert that any toolkit or demo currently
runs.
| 2026-10-08 | R9 landed: commit 6533c35 (adapters/deno/ + tests/native/ + docs/native.md, R9 slice only; landed ~17:55 CDT by orchestrator). Review verdict nits only (Codex gpt-6-astra, review-01; 29 application operations exactly equal, SQL error-semantic equality, separate importability; accepted deviations: SQL diagnostic-prefix difference, conditional D1 request). Nit 1 docs disposal guard fixed pre-landing; nit 2 transport.ts cleanup left as post-landing debt (reviewer non-blocking). Claim released. **Next: R8 review (Codex); R5 fix round (main/Nick call).** |
