// Playground shell (main-owned). The whole prototype instance lives in
// PlaygroundInstance; closing and reopening it remounts that subtree with a
// new key, so every runtime, worker and subscription is released and
// re-acquired together (project.md §9: dispose the runtime when the prototype
// is closed or replaced). Lifecycle controls are published outside the
// instance as `window.__playgroundLifecycle` so tests can drive them while
// no instance exists.
import { useEffect, useState } from "react";
import { PlaygroundInstance } from "./instance/PlaygroundInstance.tsx";

export type { PlaygroundHooks } from "./instance/PlaygroundInstance.tsx";

export interface PlaygroundLifecycle {
  generation(): number;
  isOpen(): boolean;
  close(): void;
  reopen(): void;
}

declare global {
  interface Window {
    __playgroundLifecycle?: PlaygroundLifecycle;
  }
}

export function App() {
  const [generation, setGeneration] = useState(1);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    globalThis.window.__playgroundLifecycle = {
      generation: () => generation,
      isOpen: () => open,
      close: () => setOpen(false),
      reopen: () => {
        setGeneration((g) => g + 1);
        setOpen(true);
      },
    };
    return () => {
      delete globalThis.window.__playgroundLifecycle;
    };
  }, [generation, open]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>Prototyper playground (R0)</h1>
      <p data-testid="instance-controls" style={{ fontSize: 12 }}>
        instance generation {generation} · {open ? "open" : "closed"}{" "}
        <button
          type="button"
          data-testid="instance-close"
          onClick={() => setOpen(false)}
          disabled={!open}
        >
          Close instance
        </button>{" "}
        <button
          type="button"
          data-testid="instance-reopen"
          onClick={() => {
            setGeneration((g) => g + 1);
            setOpen(true);
          }}
          disabled={open}
        >
          Reopen instance
        </button>
      </p>
      {open && <PlaygroundInstance key={generation} generation={generation} />}
    </main>
  );
}
