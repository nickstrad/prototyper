// Line-oriented xterm.js adapter: no PTY, no raw mode. Collects a line,
// hands it to just-bash, prints stdout/stderr, keeps history (Up/Down).
import type { Terminal } from "@xterm/xterm";
import type { Bash } from "just-bash";

const PROMPT = "$ ";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

export interface TerminalSession {
  readonly history: readonly string[];
  dispose(): void;
}

export function attachShell(term: Terminal, bash: Bash): TerminalSession {
  const history: string[] = [];
  let cursor = 0;
  let buffer = "";
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
      const r = await bash.exec(line);
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
    if (data === "\r") return void run(buffer);
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

  term.write(
    "just-bash + Effect " + 'terminal. Try: tasks create "Build API"\r\n',
  );
  term.write(PROMPT);
  return { history, dispose: () => sub.dispose() };
}
