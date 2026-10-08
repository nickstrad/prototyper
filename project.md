# Project: Browser-Based Prototyping Toolkit

## 1. Objective

Build a reusable, Deno-first TypeScript toolkit for rapidly creating, running,
testing, and sharing prototypes of:

1. Web applications
2. HTTP APIs
3. Command-line applications (CLIs)
4. Applications combining all three interfaces

Every prototype must use SQLite or DuckDB as its database.

Every prototype must reuse one first-class `DatabaseEditor` component for its
selected engine, including CLI-only and API-only prototypes. Implement SQLite
support first, then add DuckDB through an adapter to the same component.

Use Effect 4.0 as the foundation for application effects, typed errors,
dependency injection, and resource lifecycle management. Pair it with fast-check
for reproducible property-based tests.

The primary goal is to make it easy for AI coding agents to generate prototypes
that run entirely in a browser, with no application backend required.

A prototype should be shareable as a static website where someone can interact
with its web UI, execute CLI commands, explore API endpoints, and inspect its
database.

The toolkit should minimize repeated infrastructure work so that new prototypes
primarily require domain-specific application logic.

Deno is the primary development runtime, but browser compatibility is a
fundamental architectural requirement.

## 2. Core Architectural Principles

### A. One application, multiple interfaces

Web, API, and CLI interfaces should be adapters around the same application
core.

Do not implement separate business logic for each interface.

```text
                 Browser
                    |
   +----------------+----------------+
   |                |                |
   v                v                v
React UI        API Explorer      xterm.js
   |                |                |
   |          Fetch Handler       just-bash
   |                |                |
   |                |          Custom Commands
   |                |                |
   +----------------+----------------+
                    |
                    v
             Application Core
                    |
                    v
              Database Layer
                    |
             +------+------+
             |             |
             v             v
         SQLite WASM   DuckDB WASM
```

A mutation performed through one interface must become visible through the
others.

### B. Browser-first, Deno-developed

Use Deno for:

- Dependency management
- Development scripts
- Testing
- Running native application prototypes
- Local development servers
- Building distributable browser applications

However, shared application code should use portable TypeScript and standard Web
APIs wherever practical.

Avoid importing Deno-specific functionality into code that must execute in
browsers.

Do not attempt to compile the Deno runtime into WebAssembly.

### C. No backend required for shared prototypes

The initial implementation must support fully static deployment.

All application logic, database execution, and CLI execution should happen
inside the browser.

Backend-hosted execution can be considered later but is not part of the initial
scope.

### D. AI-agent-friendly conventions

The toolkit is intended to be used heavily by AI coding agents.

Prioritize:

- Predictable directory structures
- Explicit interfaces
- Minimal boilerplate
- Clear extension points
- Deterministic initialization
- Automated verification
- Simple commands for creating, testing, and building prototypes

Avoid unnecessary abstractions and framework development.

### E. Effect-based application logic

Express domain operations as Effect values with explicit success, error, and
dependency types. Keep pure domain transformations as ordinary TypeScript.

Use Effect services and Layers to compose dependencies. Run effects at interface
boundaries through one shared runtime per prototype instance. Keep React,
just-bash, and Fetch-compatible adapters small.

Effect must work in both Deno and the browser; isolate runtime-specific platform
integrations in adapters.

---

## 3. Technology Stack

Use the following as the starting point.

| Component              | Technology                      |
| ---------------------- | ------------------------------- |
| Primary runtime        | Deno                            |
| Language               | TypeScript                      |
| Application effects    | Effect 4.0                      |
| Validation             | Effect Schema                   |
| Frontend               | React                           |
| Build tooling          | Vite                            |
| Browser terminal       | xterm.js (@xterm/xterm)         |
| Shell interpreter      | just-bash                       |
| Transactional database | SQLite WASM                     |
| Analytical database    | DuckDB WASM                     |
| Browser persistence    | OPFS where supported            |
| API implementation     | Standard Fetch Request/Response |
| Unit/integration tests | Deno test                       |
| Property-based testing | fast-check                      |
| Browser testing        | Playwright                      |

Relevant projects:

- just-bash: https://github.com/vercel-labs/just-bash
- xterm.js: https://xtermjs.org/
- SQLite WASM: https://sqlite.org/wasm/doc/trunk/index.md
- DuckDB WASM: https://duckdb.org/docs/stable/clients/wasm/overview
- Deno: https://docs.deno.com/
- Effect: https://effect.website/
- Effect v4 API reference: https://effect.website/docs/v4/api/
- fast-check: https://fast-check.dev/

Before implementing integrations, inspect current package APIs and browser
compatibility.

Prefer established libraries over implementing functionality already available
in maintained packages.

Pin a verified Effect 4.0.x version and commit the dependency lockfile. Align
any additional `@effect/*` packages with that release. Check the v4 API
reference and stability annotations before choosing integrations; do not copy v3
imports or APIs without verification.

---

## 4. Proposed Repository Structure

Start with the following conceptual structure. Adjust if a simpler organization
is justified.

```text
prototype-kit/
│
├── packages/
│   │
│   ├── core/
│   │   ├── types.ts
│   │   ├── application.ts
│   │   └── events.ts
│   │
│   ├── database/
│   │   ├── types.ts
│   │   ├── sqlite.ts
│   │   └── duckdb.ts
│   │
│   ├── terminal/
│   │   ├── terminal.ts
│   │   ├── shell.ts
│   │   └── commands.ts
│   │
│   ├── api/
│   │   ├── handler.ts
│   │   └── explorer.ts
│   │
│   ├── database-editor/
│   │   ├── DatabaseEditor.tsx
│   │   └── types.ts
│   │
│   └── playground/
│       ├── components/
│       └── App.tsx
│
├── prototypes/
│   │
│   └── task-manager/
│       ├── prototype.ts
│       ├── application.ts
│       ├── commands.ts
│       ├── api.ts
│       ├── schema.sql
│       ├── seed.sql
│       └── App.tsx
│
├── templates/
│   ├── cli/
│   ├── api/
│   ├── web/
│   └── fullstack/
│
├── demos/
│   ├── cli/
│   ├── api/
│   ├── web/
│   ├── combined/
│   └── analytics/
│
├── agent-work/           # Shared progress, briefs, evidence, and handoffs
├── plan.md              # Vertical slices and orchestration protocol
├── tests/
│
├── deno.json
└── README.md
```

Do not create unnecessary packages simply to match this structure.

The repository should remain understandable and easy to modify.

---

## 5. Application Core

Define a small contract for applications.

Each prototype should expose its domain operations independently of the
interface invoking them.

For example, a task-management application might expose:

```ts
import type { Effect } from "effect";

type ValidationError = {
  readonly _tag: "ValidationError";
  readonly message: string;
};
type TaskNotFound = { readonly _tag: "TaskNotFound"; readonly id: number };
type DatabaseError = {
  readonly _tag: "DatabaseError";
  readonly cause: unknown;
};

interface TaskApplication {
  listTasks(): Effect.Effect<Task[], DatabaseError>;
  createTask(
    title: string,
  ): Effect.Effect<Task, ValidationError | DatabaseError>;
  completeTask(id: number): Effect.Effect<void, TaskNotFound | DatabaseError>;
  deleteTask(id: number): Effect.Effect<void, TaskNotFound | DatabaseError>;
}
```

This conceptual service contract assumes dependencies are supplied when the
service is constructed. Effects that access services directly should declare
those requirements in the third `Effect.Effect` type parameter.

These operations should be callable from:

- React components
- CLI commands
- HTTP request handlers
- Automated tests

Provide database access, time, and change notifications through Effect services
and Layers. Tests should be able to substitute deterministic implementations.

Avoid global database singletons that complicate testing.

The application should support initialization, reset, and disposal.

Use a `ManagedRuntime` built from the prototype's Layers to share acquired
services across all interfaces. Dispose it when the prototype is closed or
replaced. See the
[v4 runtime reference](https://effect.website/docs/v4/api/effect/ManagedRuntime).

### Error handling and validation

Represent expected failures with tagged errors in the Effect error channel. Use
Effect Schema to validate external input and keep domain validation in the
application core so every interface enforces the same rules.

Translate failures at adapter boundaries into UI messages, CLI stderr and exit
codes, or HTTP responses. For example, invalid input maps to HTTP 400 and a
missing task to 404. Keep unexpected defects distinguishable from expected
failures and present a safe diagnostic for internal errors.

---

## 6. Database Layer

Implement two database adapters:

1. SQLite WASM
2. DuckDB WASM

Each prototype selects one engine.

Do not attempt to make SQLite and DuckDB interchangeable at the SQL dialect
level.

A small common lifecycle/query interface is acceptable, but engine-specific
capabilities must remain accessible.

### Initial requirements

- Initialize database
- Execute SQL
- Query rows
- Apply schema
- Seed deterministic sample data
- Reset database
- Clean up resources

Wrap database initialization and operations in effects. Map exceptions and
Promise rejections from database libraries into typed database errors. Use
scoped acquisition and finalizers for database handles and workers.

Keep database reset inside the shared service so existing adapters continue to
use the same instance. Serialize mutations and reset where the engine requires
it; Effect resource management does not replace database transactions.

### Persistence

Start with an in-memory database if that simplifies initial development.

Then add browser persistence using OPFS where supported.

Persistence must be explicitly configurable.

Provide an in-memory fallback when OPFS is unavailable.

Do not assume SQLite and DuckDB have identical persistence, concurrency, or
import/export behavior.

Document limitations.

### First-class database editors

Every prototype must provide a Database view for its selected engine with:

- Table listing
- Schema inspection
- Interactive database console accepting SQL and dot commands
- Editable SQL scripts with execution and visible errors
- Readable query results and affected-row counts where supported
- Table browsing and sample queries
- Query history for the current session
- Database reset
- Database export/import where supported

The browser console must run the actual upstream `sqlite3`/DuckDB shell via WASM
or an upstream browser-shell distribution, with its real prompt, command
handling and output. Users execute SQL and upstream commands such as `.mode` and
`.schema`. Inspect upstream `.help` for exact names; do not implement dot
commands, mode formatting, or a replacement database CLI in toolkit code. In
particular, do not fabricate `.schemas` as an alias.

Verify shared live database access and command coverage before selecting a
shell. If an upstream integration cannot satisfy these requirements, record the
blocker rather than replacing it with a custom shell. The dedicated editor plan
includes upstream targets, integration gates and browser verification.

The editor must use the application's existing database service, not a second
database. SQL writes and reset must notify the other interfaces after success.
Raw SQL may bypass domain validation; failures must remain visible without
breaking the editor or application.

Build the common `DatabaseEditor` and its SQLite integration as a dedicated
slice before the first SQLite application. Add the real upstream DuckDB shell in
a second dedicated slice through a binding to that same component. See
`docs/database-editor-plan.md` for ownership and acceptance criteria. Prototypes
only load their selected engine.

Keep engine-specific SQL, result types, cancellation, and import/export
capabilities explicit. The common component hosts the actual upstream console
and shared navigation, reset and capability controls; any auxiliary result grid
must not replace or change upstream console output. Upstream shells handle SQL
and dot commands; engine bindings handle embedding and live data access; do not
create separate SQLite/DuckDB editor UIs or copy the editor into prototypes.

---

## 7. CLI Architecture

Use:

- xterm.js for terminal rendering
- just-bash for shell parsing and execution
- Custom just-bash commands for application-specific operations

xterm.js is the terminal display/input layer; just-bash supplies the application
shell interpreter for pipelines, redirects and custom application commands.
Database consoles execute the upstream sqlite3/DuckDB shell directly and do not
need just-bash to interpret their SQL or dot commands.

The browser must not require a real Bash process.

The CLI should be able to execute commands such as:

```sh
tasks list
tasks create "Build API"
tasks complete 1
tasks list --json
tasks list --json | jq '.[]'
```

### Command execution

Custom commands must delegate to the application core.

Do not duplicate business logic inside CLI handlers.

Execute application effects through the shared prototype runtime and map their
results into the command contract. just-bash remains responsible for shell
parsing and execution.

Support structured command results:

- stdout
- stderr
- exit code

Use just-bash’s existing shell capabilities for pipelines, redirects, and common
utilities.

Avoid implementing a second shell parser.

### Terminal integration

Implement an interactive terminal adapter that:

1. Accepts user input through xterm.js.
2. Sends complete commands to just-bash.
3. Displays stdout/stderr.
4. Maintains command history.
5. Supports basic terminal interaction.

Start with line-oriented commands.

Do not implement full PTY semantics, raw terminal mode, or interactive
subprocess execution in the initial version.

### Standard commands

Consider a small set of reusable toolkit commands:

```sh
help
db tables
db schema
db query "SELECT * FROM tasks"
db reset
db seed
api routes
```

Application-specific commands should be registered separately.

### Important integration constraint

The CLI must use the same underlying application/database state as the web UI.

Do not initialize a separate database for the terminal.

---

## 8. HTTP API Architecture

Use standard Fetch-compatible request handlers.

Example conceptual interface:

```ts
type ApiHandler = (
  request: Request,
) => Promise<Response>;
```

Preserve this standard Fetch boundary. Inside the handler, validate requests,
execute application effects through the shared runtime, and map typed errors to
status codes and structured response bodies.

A prototype should be able to expose endpoints such as:

```text
GET /tasks
POST /tasks
PATCH /tasks/:id
DELETE /tasks/:id
```

The handler must be executable in two environments.

### Deno execution

Expose the handler through Deno.serve().

### Browser execution

Invoke the handler directly using standard Request and Response objects.

The browser API explorer should allow users to:

- Select an endpoint
- Choose HTTP method
- Provide request body
- Execute the request
- Inspect status, headers, and response body

Do not require a network server for browser API exploration.

Be explicit that direct browser invocation simulates the application-level HTTP
boundary rather than actual network transport.

---

## 9. Prototype Playground

Build a reusable React application that hosts individual prototypes.

The playground supports up to four views according to the prototype's
interfaces. The Database view is required for every prototype.

### Application

Render the prototype’s React interface.

### Terminal

Provide an interactive xterm.js terminal powered by just-bash.

### API

Provide an HTTP API explorer.

### Database

Mount the shared `DatabaseEditor` described in §6 with the selected engine
adapter, using the same runtime and database as the other views.

The first implementation can use tabs rather than a complex multi-panel layout.

Prefer a clean, functional interface over extensive visual customization.

### Shared state

All views must interact with the same application instance.

A mutation through the terminal must be observable in the React interface.

A mutation through the API explorer must be observable through subsequent
CLI/database queries.

Use an explicit change-notification mechanism to keep views synchronized.

Provide notifications through the shared Effect service graph and publish them
after successful mutations and reset. React subscriptions must release their
resources on unmount; tab changes must not create another database or runtime.

Do not rely on React components independently polling the database.

---

## 10. Prototype Configuration

Each prototype should have a small configuration file.

Conceptually:

```ts
export default {
  name: "task-manager",
  database: "sqlite",
  persistence: "memory",
  interfaces: ["web", "cli", "api"],
};
```

The configuration should determine which interfaces appear in the playground.

The `interfaces` list selects the web, CLI, and API adapters. The Database
editor is always included and is selected automatically by `database`; it is not
an optional interface toggle.

Keep the configuration minimal.

Avoid building a large plugin system initially.

---

## 11. Initial Example Prototype

Implement a simple task manager as the reference application.

This should demonstrate the entire architecture without introducing unnecessary
domain complexity.

### Database

Use SQLite.

### Schema:

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

Seed several deterministic tasks.

### Application operations

Implement:

- List tasks
- Create task
- Complete task
- Delete task

### CLI

Support:

```sh
tasks list
tasks list --json
tasks create "Example task"
tasks complete 1
tasks delete 1
```

### API

Support:

```text
GET /tasks
POST /tasks
PATCH /tasks/:id
DELETE /tasks/:id
```

### React UI

Provide:

- Task list
- Create task input
- Complete task action
- Delete task action

The UI should update when state changes through the CLI or API explorer.

---

## 12. Testing and Verification

Testing is a major architectural requirement.

The goal is to establish evidence that AI-generated prototypes behave correctly
across execution environments and interfaces.

### A. Unit tests

Test application operations independently of React, xterm.js, and HTTP.

Verify database mutations and query results.

Run Effect programs from `Deno.test` with isolated test Layers and guaranteed
cleanup. Assert both success values and typed failure outcomes, including
invalid input, missing tasks, and database failures. Inject deterministic time
for task timestamps; use controllable clock services for any timed behavior.

### B. Cross-interface integration tests

Verify that the same application behavior is available through CLI and API
adapters.

Example:

1. Create a task through CLI.
2. Retrieve it through API.
3. Complete it through API.
4. Retrieve it through CLI.
5. Verify the completed state.

All interfaces must share the same application instance.

### C. Property-based testing

Use fast-check to generate sequences of task operations.

Maintain a simple reference model.

Compare actual database state against the model after each operation.

Important invariants:

- Task IDs are unique.
- Completing a task does not create additional tasks.
- Deleting a task removes it from subsequent queries.
- Listing tasks does not mutate state.
- Equivalent CLI and API operations produce equivalent application state.

Use explicit seeds and preserve fast-check replay paths for failures.

A failing randomized test must be reproducible.

Depend on fast-check directly: Effect v4 no longer re-exports it, and the older
`Schema.toArbitrary` and `effect/testing/FastCheck` APIs were removed. See the
[v4 compatibility notes](https://effect.website/blog/effect-v4-rc-august-recap).

Use `fc.asyncProperty` or asynchronous model commands to run generated
operations through a test runtime. Give each generated case a fresh database and
scoped resources, and dispose them even when an assertion fails. Preserve the
fast-check seed and replay path together with the operation trace.

Generate invalid operations too. Verify expected failures leave state unchanged
and produce consistent UI, CLI, and API outcomes. Keep fast-check's randomness
separate from application randomness, which should be injected for replay.

### D. Browser integration tests

Use Playwright to verify:

- Playground loads.
- SQLite WASM initializes.
- Terminal accepts commands.
- CLI output appears.
- API explorer executes handlers.
- React UI reflects mutations made through other interfaces.
- Database reset restores deterministic seed data.
- Every prototype exposes its selected engine's database editor.
- SQL writes in the editor become visible through enabled application
  interfaces.
- SQL failures leave the editor usable and do not publish successful mutations.

### E. Native Deno compatibility

Where applicable, verify that portable application logic behaves consistently
under Deno and in the browser.

Do not require identical database implementations when runtime-specific adapters
are necessary.

Focus on equivalent observable behavior.

### F. Static deployment verification

Build the playground and serve the generated static assets without an
application backend.

Verify that the example prototype remains functional.

A local static file server is acceptable for serving assets.

The application must not require a remotely hosted API or database.

---

## 13. Implementation Milestones

Work incrementally.

### Milestone 1 — Minimal browser CLI

Build a working browser terminal using xterm.js and just-bash.

Register one custom TypeScript command.

Introduce the pinned Effect 4.0 dependency and a minimal runtime. Execute the
custom command as an effect and verify typed failure mapping to stderr and a
nonzero exit code.

Verify:

- Commands execute.
- Output renders.
- Shell pipelines work.
- Custom commands receive arguments.

No database required yet.

### Milestone 2 — SQLite application core

Add SQLite WASM.

Implement the task-manager application.

Compose database and application Layers, define tagged domain errors, and add
deterministic Effect-based tests and fast-check operation sequences.

Verify:

- Database initialization
- Schema creation
- Seed data
- CRUD operations
- Database reset

Include the SQLite editor and verify browsing, SQL execution, visible errors,
and propagation of editor writes to application queries.

### Milestone 3 — Shared CLI and React UI

Connect the terminal and React UI to the same application instance.

Share the Effect runtime and notification service across both adapters.

Verify mutations are visible across both interfaces.

### Milestone 4 — API adapter and explorer

Add Fetch-compatible handlers and an API explorer.

Verify CLI/API/UI state consistency.

### Milestone 5 — Reusable prototype conventions

Extract the example-specific infrastructure into reusable toolkit components.

Create a minimal template for additional prototypes.

Document how an AI coding agent should add a new prototype.

### Milestone 6 — DuckDB WASM

Add DuckDB support.

Create a small analytical prototype demonstrating SQL queries over seeded event
data.

Validate browser initialization, query execution, and lifecycle management.

Reuse the common editor with the DuckDB adapter and validate it against the
analytical prototype's shared database instance.

### Milestone 7 — Persistence and sharing

Add browser persistence where supported.

Support database reset and export/import where feasible.

Verify static deployment.

### Final demos

Complete `demos/` with small CLI-only, API-only, web-only, and combined
prototypes, plus a DuckDB analytical example. Each must use reusable toolkit
components, deterministic seed data, its selected engine's database editor, and
a short README with a repeatable walkthrough. Verify every demo in the final
static build. See `plan.md` for slices, dependencies, and acceptance criteria.

---

## 14. Non-Goals

Do not implement the following initially:

- Authentication
- Multi-user collaboration
- Hosted databases
- Remote terminal execution
- Docker/container orchestration
- Full Linux emulation
- A general-purpose IDE
- Arbitrary subprocess execution
- A universal ORM
- A complex plugin framework
- Real network simulation for browser APIs
- Automatic synchronization between SQLite and DuckDB

Keep the system small.

---

## 15. Deliverables

Produce:

1. A working Deno/TypeScript repository.
2. A browser playground using React.
3. An embedded xterm.js terminal powered by just-bash.
4. A SQLite WASM-backed task-manager prototype.
5. Shared application logic across CLI, API, and React. Use Effect 4.0 services,
   typed errors, and scoped resource management.
6. Automated unit, integration, property-based, and browser tests.
7. A static production build.
8. Documentation explaining how to create additional prototypes.
9. One reusable first-class `DatabaseEditor` with SQLite and DuckDB adapters,
   included in every prototype.
10. A `demos/` gallery covering CLI, API, web, combined, and DuckDB analytics.
11. A shared `agent-work/` location with durable progress and handoff records,
    governed by the orchestration protocol in `plan.md`.

Include a README with commands for:

- Installing dependencies
- Starting development
- Running tests
- Building the static application
- Creating another prototype

Also provide a short architecture document explaining the key boundaries and
decisions.

Document Effect runtime ownership, Layer composition, error mapping, and how to
replay a failing fast-check test.

---

## 16. Instructions for Codex

Before implementation:

1. Inspect the current APIs and browser compatibility of just-bash, xterm.js,
   SQLite WASM, DuckDB WASM, Effect 4.0, fast-check, and Deno/Vite integration.
   Verify Effect v4 imports, package versions, stability annotations, and test
   execution under Deno before relying on an integration.
2. Identify integration risks and unsupported assumptions.
3. Propose any necessary adjustments to the architecture.
4. Write a concise implementation plan.

Then begin implementation.

Prioritize delivering a functioning vertical slice over scaffolding the entire
repository.

Start with Milestone 1 and progress incrementally.

Run the relevant tests after each milestone.

Do not claim functionality is working without executing verification.

If browser compatibility or library limitations require architectural changes,
document the evidence and explain the tradeoff.

Make reasonable implementation decisions independently. Ask for clarification
only when a decision would materially change the intended architecture or
project scope.

The guiding principle is:

A prototype should be ordinary TypeScript application logic with SQLite or
DuckDB storage, composed with Effect 4.0 for explicit dependencies and typed
errors, exposed through interchangeable web, API, and CLI interfaces, and
executable as a self-contained browser experience.
