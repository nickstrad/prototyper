// Line-oriented xterm.js adapter: no PTY, no raw mode. Collects a line, hands
// it to the shell, prints stdout/stderr and keeps history (Up/Down).
import type { Terminal } from "@xterm/xterm";
import type { Shell } from "./shell.ts";

const PROMPT = "$ ";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

export interface TerminalSession {
  readonly history: readonly string[];
  /** Resolves when no command is running (used by tests). */
  idle(): Promise<void>;
  dispose(): void;
}

export interface AttachOptions {
  readonly banner?: string;
}

export function attachShell(
  term: Terminal,
  shell: Shell,
  options: AttachOptions = {},
): TerminalSession {
  const history: string[] = [];
  let cursor = 0;
  let buffer = "";
  let running: Promise<void> = Promise.resolve();
  let busy = false;

  const redrawLine = (text: string) => {
    term.write("\r\x1b[2K" + PROMPT + text);
    buffer = text;
  };

  const run = async (line: string) => {
    busy = true;
    term.write("\r\n");
    if (line.trim()) {
      history.push(line);
      const r = await shell.exec(line);
      if (r.stdout) term.write(crlf(r.stdout));
      if (r.stderr) term.write(RED + crlf(r.stderr) + RESET);
      if (r.exitCode !== 0) {
        term.write(`${RED}[exit ${r.exitCode}]${RESET}\r\n`);
      }
    }
    cursor = history.length;
    buffer = "";
    term.write(PROMPT);
    busy = false;
  };

  const sub = term.onData((data) => {
    if (busy) return;
    if (data === "\r") {
      running = run(buffer);
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
  });

  if (options.banner) term.write(crlf(options.banner));
  term.write(PROMPT);
  return {
    history,
    idle: () => running,
    dispose: () => sub.dispose(),
  };
}
