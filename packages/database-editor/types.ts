// DatabaseEditor host contracts. The binding contract itself is frozen in
// packages/core/types.ts (plan.md §9 ShellBinding); this module re-exports it
// and adds the host's props and the test-facing extras a binding may expose.
import type { Terminal } from "@xterm/xterm";
import type {
  DatabaseService,
  EngineInfo,
  ShellBinding,
  ShellError,
} from "../core/types.ts";

export type { DatabaseService, EngineInfo, ShellBinding, ShellError };

export interface DatabaseEditorProps {
  /** Engine-specific upstream shell binding; mounted once per instance. */
  readonly binding: ShellBinding;
  readonly title?: string;
  /** Rows shown in the host's table preview grid (bounded; see plan.md §8). */
  readonly previewRows?: number;
}

/** What the SQLite binding exposes beyond ShellBinding (tests and hosts). */
export interface MountedShellBinding extends ShellBinding {
  readonly engineInfo: EngineInfo;
  /** The xterm instance while mounted. */
  readonly terminal: Terminal | undefined;
  /** Resolves when no submission is in flight. */
  idle(): Promise<void>;
  /** The visible terminal buffer as text ("" while unmounted). */
  screen(): string;
}
