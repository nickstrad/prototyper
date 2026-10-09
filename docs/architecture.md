# Architecture

Prototyper hosts small applications entirely in a browser. Each instance owns
one scoped DatabaseService. Application operations, CLI commands, API handlers,
and the Database editor share that service; enabling another interface does not
create a second database.

## Layers and interfaces

`packages/core/types.ts` defines the database and prototype contracts.
`packages/core/events.ts` provides snapshots and coherence helpers. Effect
layers acquire the selected engine and application service. Hosts own their
runtime and scope, interrupt subscriptions on close, dispose shell bindings,
then release engine workers.

SQLite uses a browser worker with the upstream SQLite WASM engine and Fiddle
shell. DuckDB uses AsyncDuckDB and the upstream DuckDB web shell. The common
DatabaseEditor mounts the engine-specific shell binding plus table/schema
inspection and database transfer controls. See
[database capabilities](database-capabilities.md) for persistence, statement
classification, transaction, export, and import limits.

React views subscribe to database changes. Writes through the app, CLI, API, and
shell publish source-tagged events. Reads and rejected statements do not publish
writes. Reset restores schema and seed and publishes a reset event. Subscribers
reread their own projections; no polling is required.

The terminal combines xterm with just-bash commands over application Effects.
The API explorer calls a local fetch-style router; it does not open a server
socket. Native SQLite and transport adapters are described in
[native adapters](native.md). Browser hosts and native adapters have different
resource and persistence responsibilities.

## Gallery and production hosting

`demos/registry.ts` selects the five gallery links and production HTML entries.
The root Vite build includes the playground, gallery, inventory CLI, bookmark
API, notes web app, combined task manager, and DuckDB analytics. Each demo is a
separate page with an in-memory database. SQLite demos share their database
across enabled interfaces; analytics shares aggregates and the DuckDB shell.

Vite emits workers and JavaScript chunks. Public SQLite assets and the
hash-pinned DuckDB engine, shell WASM, and JSON/Parquet extensions are copied
into the output. Build/setup needs downloads; runtime needs only the complete
output served at the origin root. Plain asset hosting requires no application
API, COOP/COEP headers, or internet connection. It is not a service-worker
cache.

The analytics entry reuses `prototypes/event-analytics/` rather than maintaining
a second set of aggregate queries or subscriptions. Its Database view creates
the actual DuckDB shell on demand. Hiding that view keeps the binding; closing
the owning instance disposes it before terminating the worker.

## Setup, generation, and verification

Follow [the root walkthrough](../README.md) for dependency installation, asset
preparation, dev hosting, static builds, and an executable generator proof.
[The generator guide](new-prototype.md) specifies validation and output modules.
Generation creates application modules against this checkout; the host must
supply its own entry point, runtime, selected interfaces, and Database editor.
The generator refuses existing destinations and changes no registry or
dependency files.

`deno task check` checks formatting, lint, and types. `deno task test` covers
native operations, contracts, generators, and properties. Browser tests cover
engines, real shells, coherence, and lifecycle. `tests/static/` additionally
checks each demo entry through a plain file server with external requests
blocked, including writes through the interfaces and analytics reset. Use
`deno task test:static --workers 1` to build and run the full browser suite on
asset-only hosting.
