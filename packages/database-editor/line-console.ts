// Line discipline for an upstream shell that runs in a worker: xterm collects
// a line, Enter hands it to `submit`, the shell's own stdout/stderr lines are
// printed verbatim, and the next prompt event ends the submission. It is
// input plumbing only (plan.md §8): no command is interpreted here. Keys typed
// while a submission is in flight are kept and replayed afterwards. The one
// filter is the duplicate echo of dot commands: fiddle_exec `puts()`s them,
// so the first stdout line equal to the submitted dot command is dropped.
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** The subset of xterm.js `Terminal` the console needs. */
export interface ConsoleTerminal {
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
}

export interface LineConsoleOptions {
  /** Sends one typed line to the shell. */
  readonly submit: (line: string) => void;
  /** Prompt to show first (the engine's main prompt). */
  readonly prompt: string;
  /** Shared history (persists across mounts when the caller keeps it). */
  readonly history?: string[];
}

export interface LineConsole {
  /** One shell output line (stderr is rendered red). */
  output(stream: "stdout" | "stderr", text: string): void;
  /** The shell's next prompt; ends the pending submission. */
  prompt(text: string): void;
  /** Programmatic input: echoed as if typed, then submitted (no queueing;
   * the caller waits for the shell's prompt event). */
  submit(line: string): void;
  readonly busy: boolean;
  readonly history: readonly string[];
  dispose(): void;
}

export function attachLineConsole(
  term: ConsoleTerminal,
  options: LineConsoleOptions,
): LineConsole {
  const history = options.history ?? [];
  let cursor = history.length;
  let buffer = "";
  let busy = false;
  let pendingInput = "";
  let expectEcho: string | null = null;
  let currentPrompt = options.prompt;

  const redrawLine = (text: string) => {
    term.write("\r\x1b[2K" + currentPrompt + text);
    buffer = text;
  };

  const send = (line: string) => {
    busy = true;
    term.write("\r\n");
    if (line.trim()) history.push(line);
    cursor = history.length;
    buffer = "";
    expectEcho = line.startsWith(".") ? line : null;
    options.submit(line);
  };

  const handleData = (data: string) => {
    if (busy) {
      pendingInput += data;
      return;
    }
    if (data === "\r") {
      send(buffer);
      return;
    }
    if (data === "\x7f") {
      if (buffer) {
        buffer = buffer.slice(0, -1);
        term.write("\b \b");
      }
      return;
    }
    if (data === "\x1b[A") {
      if (cursor > 0) redrawLine(history[--cursor]);
      return;
    }
    if (data === "\x1b[B") {
      if (cursor < history.length) {
        cursor++;
        redrawLine(history[cursor] ?? "");
      }
      return;
    }
    if (data.startsWith("\x1b")) return; // ignore other escape sequences
    const printable = [...data].filter((c) => c.charCodeAt(0) >= 0x20).join("");
    buffer += printable;
    term.write(printable);
  };

  // Pasted or fast input arrives as one chunk; feed it key by key so that an
  // embedded "\r" submits like a typed Enter.
  const sub = term.onData((data) => {
    for (const chunk of data.split(/(\r)/)) if (chunk) handleData(chunk);
  });

  return {
    get busy() {
      return busy;
    },
    history,
    output: (stream, text) => {
      if (expectEcho !== null) {
        const echo = expectEcho;
        expectEcho = null;
        if (stream === "stdout" && text === echo) return;
      }
      term.write(
        stream === "stderr" ? RED + text + RESET + "\r\n" : text + "\r\n",
      );
    },
    prompt: (text) => {
      currentPrompt = text;
      expectEcho = null;
      busy = false;
      term.write(text);
      const replay = pendingInput;
      pendingInput = "";
      for (const chunk of replay.split(/(\r)/)) if (chunk) handleData(chunk);
    },
    submit: (line) => {
      term.write(line);
      send(line);
    },
    dispose: () => sub.dispose(),
  };
}
