// Main-thread host: mounts xterm, forwards keystrokes (line-buffered) to the upstream shell
// running in shell-worker.js, prints the shell's own stdout/stderr verbatim, and exposes a
// promise API on window.poc for Playwright.
(() => {
  const qs = new URLSearchParams(location.search);
  const term = new Terminal({ convertEol: true, cols: 120, rows: 40, fontSize: 13 });
  term.open(document.getElementById("term"));
  // sqlite3.dir tells the bundled sqlite3 JS where its sibling files (e.g. the OPFS async proxy) live.
  const wq = new URLSearchParams(location.search); wq.set("sqlite3.dir", "../vendor/fiddle");
  const worker = new Worker("shell-worker.js?" + wq.toString());
  let nextId = 1; const pending = new Map();
  const transcript = []; // {stream, text}
  const changes = []; const handleEvents = [];
  let capture = null; let currentPrompt = "sqlite> ";
  let loadedResolve; const loaded = new Promise((r) => (loadedResolve = r));
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "out") {
      transcript.push({ stream: m.stream, text: m.text });
      capture?.push(m.stream === "stderr" ? "[stderr] " + m.text : m.text);
      term.write(m.text + "\n");
    } else if (m.type === "reply") {
      const p = pending.get(m.id); pending.delete(m.id);
      m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
    } else if (m.type === "change") changes.push(m);
    else if (m.type === "handle-changed") handleEvents.push(m);
    else if (m.type === "loaded") loadedResolve();
  };
  const call = (type, extra = {}, transfer) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...extra }, transfer || []);
  });
  // Serialize shell input so output capture is attributable.
  let chain = Promise.resolve();
  const exec = (text, { echo = true } = {}) => (chain = chain.then(async () => {
    if (cancelFlag) Atomics.store(cancelFlag, 0, 0);
    // fiddle_exec itself echoes input lines that start with '.', so only echo SQL here.
    if (echo && !text.startsWith(".")) term.write(text.replace(/\n(?!$)/g, "\n" + " ".repeat(Math.max(0, currentPrompt.length - 5)) + "...> ") + (text.endsWith("\n") ? "" : "\n"));
    capture = [];
    try { const r = await call("exec", { text }); currentPrompt = r.prompt; return { ...r, output: capture }; }
    finally { capture = null; term.write(currentPrompt); }
  }));
  // Minimal terminal line discipline (not a shell): echo, backspace, Enter submits the line.
  // linebuf=complete (default): mirror shell.c process_input()'s submit rule, using the
  // upstream sqlite3_complete() from the same WASM: dot/# lines go straight through when no
  // SQL is pending; SQL lines accumulate until a line contains ';' and sqlite3_complete() is true
  // (or a lone "/" or "go" terminator). linebuf=raw sends every line immediately.
  const lineMode = qs.get("linebuf") || "complete";
  let line = "", pendingSql = "";
  const CONT = "   ...> "; // fiddle_get_prompt() only exposes the MAIN prompt; see README gotchas
  async function submitLine(l) {
    if (lineMode === "raw") return exec(l + "\n", { echo: false });
    const t = l.trim();
    if (!pendingSql && (t === "" || t.startsWith(".") || t.startsWith("#"))) return exec(l + "\n", { echo: false });
    const term_ = /^\s*(\/|go)\s*$/i.test(l);
    pendingSql += (pendingSql ? "\n" : "") + (term_ ? ";" : l);
    if ((pendingSql.includes(";")) && (await call("complete", { text: pendingSql }))) {
      const sql = pendingSql; pendingSql = ""; return exec(sql + "\n", { echo: false });
    }
    term.write(CONT);
  }
  let keyChain = Promise.resolve();
  term.onData((d) => {
    for (const ch of d) {
      if (ch === "\r") { term.write("\r\n"); const l = line; line = ""; keyChain = keyChain.then(() => submitLine(l)); }
      else if (ch === "\x7f") { if (line) { line = line.slice(0, -1); term.write("\b \b"); } }
      else if (ch >= " " || ch === "\t") { line += ch; term.write(ch); }
    }
  });
  const args = qs.get("args") ? qs.get("args").split(",") : undefined;
  const ready = loaded.then(() => call("init", { args })).then((info) => {
    currentPrompt = info.prompt || currentPrompt;
    document.getElementById("status").textContent =
      `SQLite ${info.libversion} | ${info.filename} | vfs=${info.vfs} | ptr=${info.pointerSize} | COI=${info.crossOriginIsolated}`;
    term.write(currentPrompt); term.focus();
    return info;
  });
  let cancelFlag = null;
  const enableCancel = async () => {
    if (!self.crossOriginIsolated) throw new Error("cancellation needs crossOriginIsolated (COOP/COEP)");
    const sab = new SharedArrayBuffer(4); cancelFlag = new Int32Array(sab);
    return call("cancelBuffer", { sab });
  };
  window.poc = {
    enableCancel, cancel: () => { if (cancelFlag) Atomics.store(cancelFlag, 0, 1); },
    cexec: (sql) => call("cexec", { sql }),
    ready, exec, transcript, changes, handleEvents, term,
    query: (sql, params, via) => call("query", { sql, params, via }),
    reset: () => call("reset"), keysIdle: () => keyChain.then(() => chain), probeBindText: () => call("probeBindText"), info: () => call("info"), hook: (on) => call("hook", { on }),
    export: () => call("export"),
    import: (bytes, mode = "deserialize") => call("import", { bytes, mode }),
    screen: () => { const b = term.buffer.active; const out = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
      return out.join("\n").replace(/\n+$/, ""); },
    dispose: () => { worker.terminate(); term.dispose(); },
  };
})();
