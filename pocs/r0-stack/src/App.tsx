import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { makeAppRuntime } from "./core/runtime.ts";
import { createShell } from "./terminal/shell.ts";
import { attachShell } from "./terminal/xterm-adapter.ts";

declare global {
  interface Window {
    __term?: Terminal;
  }
}

export function App() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const runtime = makeAppRuntime();
    const term = new Terminal({ cols: 100, rows: 30, convertEol: false });
    term.open(host.current!);
    const session = attachShell(term, createShell(runtime));
    term.focus();
    globalThis.window.__term = term;
    return () => {
      session.dispose();
      term.dispose();
      void runtime.dispose();
    };
  }, []);
  return (
    <main>
      <h1>R0 stack POC</h1>
      <div ref={host} data-testid="terminal" />
    </main>
  );
}
