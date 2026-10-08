import { assertEquals } from "@std/assert";
import { attachLineConsole, type ConsoleTerminal } from "./line-console.ts";

const fakeTerminal = () => {
  const written: string[] = [];
  let listener: ((data: string) => void) | undefined;
  const term: ConsoleTerminal = {
    write: (data) => written.push(data),
    onData: (l) => {
      listener = l;
      return { dispose: () => (listener = undefined) };
    },
  };
  return {
    term,
    written,
    type: (data: string) => listener?.(data),
    text: () => written.join(""),
  };
};

Deno.test("Enter submits the typed line and the prompt event ends the submission", () => {
  const t = fakeTerminal();
  const submitted: string[] = [];
  const c = attachLineConsole(t.term, {
    prompt: "sqlite> ",
    submit: (line) => submitted.push(line),
  });
  t.type("s");
  t.type("elect 1;");
  t.type("\r");
  assertEquals(submitted, ["select 1;"]);
  assertEquals(c.busy, true);
  c.output("stdout", "1");
  c.prompt("sqlite> ");
  assertEquals(c.busy, false);
  assertEquals(t.text(), "select 1;\r\n1\r\nsqlite> ");
  assertEquals(c.history, ["select 1;"]);
});

Deno.test("the shell's own echo of a dot command is shown once", () => {
  const t = fakeTerminal();
  const c = attachLineConsole(t.term, { prompt: "> ", submit: () => {} });
  t.type(".tables\r");
  c.output("stdout", ".tables"); // fiddle_exec puts(zSql)
  c.output("stdout", "notes  tasks");
  c.prompt("> ");
  assertEquals(t.text(), ".tables\r\nnotes  tasks\r\n> ");
  // Only the first line is a candidate; a later identical line is kept.
  t.type(".x\r");
  c.output("stderr", "Error: unknown command");
  c.output("stdout", ".x");
  c.prompt("> ");
  assertEquals(
    t.text().endsWith("\x1b[31mError: unknown command\x1b[0m\r\n.x\r\n> "),
    true,
  );
});

Deno.test("keys typed while busy are replayed after the prompt; stderr is red", () => {
  const t = fakeTerminal();
  const submitted: string[] = [];
  const c = attachLineConsole(t.term, {
    prompt: "> ",
    submit: (line) => submitted.push(line),
  });
  t.type("a\r");
  t.type("b\r"); // typed while busy
  assertEquals(submitted, ["a"]);
  c.output("stderr", "oops");
  c.prompt("   ...> ");
  assertEquals(submitted, ["a", "b"]);
  assertEquals(t.text(), "a\r\n\x1b[31moops\x1b[0m\r\n   ...> b\r\n");
});

Deno.test("Up/Down recall history; backspace edits; programmatic submit echoes", () => {
  const t = fakeTerminal();
  const submitted: string[] = [];
  const c = attachLineConsole(t.term, {
    prompt: "> ",
    submit: (line) => submitted.push(line),
  });
  t.type("one\r");
  c.prompt("> ");
  t.type("two\r");
  c.prompt("> ");
  t.type("\x1b[A");
  t.type("\x1b[A");
  t.type("\x1b[B");
  t.type("\x7f");
  t.type("o\r");
  assertEquals(submitted, ["one", "two", "two"]);
  c.prompt("> ");
  c.submit("three");
  assertEquals(submitted, ["one", "two", "two", "three"]);
  assertEquals(c.busy, true);
  c.prompt("> ");
  assertEquals(c.busy, false);
  assertEquals(t.written.includes("three"), true);
  assertEquals(c.history, ["one", "two", "two", "three"]);
  c.dispose();
  t.type("x\r");
  assertEquals(submitted.length, 4);
});
