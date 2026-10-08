// R4 (main-owned): DB0's common DatabaseEditor mounted on the SAME engine the
// UI, the terminal and the API explorer use (Q2: one engine per prototype
// instance). The D1 workbench owns the engine; once its hooks expose the
// worker client and engine facts, the upstream sqlite3 shell is bound to that
// client and the D1 DatabaseService. A "Database view" toggle unmounts and
// remounts the host the way a prototype's tabs would, without touching the
// engine. Nothing here interprets shell input or output.
import { useEffect, useRef, useState } from "react";
import { Effect, Exit, Scope } from "effect";
import type { EngineInfo } from "../../packages/core/types.ts";
import type { EngineWorkerClient } from "../../packages/database/worker-client.ts";
import type { SqliteWorkbenchHooks } from "../../packages/database/sqlite-workbench.tsx";
import { DatabaseEditor } from "../../packages/database-editor/DatabaseEditor.tsx";
import { makeSqliteShellBinding } from "../../packages/database-editor/sqlite-shell.ts";
import type { MountedShellBinding } from "../../packages/database-editor/types.ts";

/** What the editor needs from the workbench hooks (D1 exposes these). */
type EngineOwner = SqliteWorkbenchHooks & {
  readonly client?: EngineWorkerClient;
  readonly info?: EngineInfo;
};

/** Test hooks published as `window.__playground.r4.editor`. */
export interface SharedEditorHooks {
  readonly binding: MountedShellBinding;
  submit(line: string): Promise<void>;
  screen(): string;
  idle(): Promise<void>;
  visible(): boolean;
  toggle(): void;
}

type State =
  | { phase: "waiting" }
  | { phase: "unavailable"; reason: string }
  | { phase: "ready"; binding: MountedShellBinding }
  | { phase: "failed"; message: string };

export function SharedEditor(
  { d1, onHooks }: {
    readonly d1: EngineOwner | undefined;
    readonly onHooks?: (hooks: SharedEditorHooks | undefined) => void;
  },
) {
  const [state, setState] = useState<State>({ phase: "waiting" });
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!d1) return;
    if (!d1.client || !d1.info) {
      setState({
        phase: "unavailable",
        reason: "the D1 workbench exposes no engine client (claim pending)",
      });
      return;
    }
    const scope = Effect.runSync(Scope.make());
    let live = true;
    Effect.runPromise(
      Scope.provide(scope)(
        makeSqliteShellBinding({
          client: d1.client,
          info: d1.info,
          service: d1.service,
        }),
      ),
    ).then(
      (binding) => {
        if (!live) return;
        setState({ phase: "ready", binding });
        onHooks?.({
          binding,
          submit: (line) => Effect.runPromise(binding.submit(line)),
          screen: () => binding.screen(),
          idle: () => binding.idle(),
          visible: () => visibleRef.current,
          toggle: () => setVisible((v) => !v),
        });
      },
      (e: unknown) => live && setState({ phase: "failed", message: String(e) }),
    );
    return () => {
      live = false;
      onHooks?.(undefined);
      void Effect.runPromise(Scope.close(scope, Exit.void));
    };
  }, [d1, onHooks]);

  return (
    <section data-testid="r4-editor" style={{ marginTop: 16 }}>
      <h2 style={{ fontSize: 16 }}>
        Database editor on the shared engine (R4){" "}
        <button
          type="button"
          data-testid="r4-editor-toggle"
          onClick={() => setVisible((v) => !v)}
          disabled={state.phase !== "ready"}
        >
          {visible ? "Hide database view" : "Show database view"}
        </button>
      </h2>
      <p
        data-testid="r4-editor-status"
        style={{ fontSize: 12, margin: "4px 0" }}
      >
        {state.phase === "waiting" && "waiting for the workbench engine…"}
        {state.phase === "unavailable" &&
          `shared editor unavailable: ${state.reason}`}
        {state.phase === "failed" && `shared editor failed: ${state.message}`}
        {state.phase === "ready" &&
          `bound to the workbench engine · SQLite ${state.binding.engineInfo.libversion}`}
      </p>
      {state.phase === "ready" && visible && (
        <DatabaseEditor
          binding={state.binding}
          title="Prototype database (shared engine)"
        />
      )}
    </section>
  );
}
