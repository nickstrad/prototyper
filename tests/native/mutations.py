"""R9 scoped mutation pass; restores each owned file even on failure.

Run from repo root after baseline tests, with the assigned ports idle.
"""
import datetime
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "agent-work/items/R9/attempts/run-20261008-r9-01/evidence"
DENO = "/root/.deno/bin/deno"
HOST = ROOT / "adapters/deno/mod.ts"
BROWSER = ROOT / "tests/native/browser.ts"
UNIT = [DENO, "test", "--allow-read", "tests/native/host_test.ts"]
IMPORTS = [DENO, "test", "--allow-read", "tests/native/imports_test.ts"]
PW = [DENO, "run", "-A", "npm:@playwright/test@1.62.0", "test",
      "tests/native/equivalence.spec.ts", "--workers", "1"]

mutations = [
    ("shared-instance", HOST,
     "const fetch = createTaskApiHandler(runtime, options);",
     "const fetch = createTaskApiHandler(ManagedRuntime.make(taskManagerLayer({"
     "backend: nativeSqliteBackend(), clock: options.clock }).pipe(Layer.orDie)), options);",
     UNIT, "single shared instance"),
    ("outcome-equivalence", HOST,
     "return runTasks(runtime, args);",
     'return runTasks(runtime, args).then(r => ({ ...r, stdout: r.stdout.replace("SQL API", "MUTATED") }));',
     PW, "toEqual"),
    ("error-equivalence", HOST,
     "      fetch,",
     "      fetch: async (request: Request) => { const r = await fetch(request); "
     "return new Response(r.body, { status: r.status === 404 ? 200 : r.status, headers: r.headers }); },",
     PW, "toEqual"),
    ("browser-import-isolation", BROWSER,
     'import { Effect, Layer, ManagedRuntime } from "effect";',
     'import "../../adapters/deno/mod.ts";\nimport { Effect, Layer, ManagedRuntime } from "effect";',
     IMPORTS, "browser cannot reach native SQLite"),
    ("native-import-isolation", HOST,
     'import { Effect, Layer, ManagedRuntime } from "effect";',
     'import "../../packages/database/sqlite-browser.ts";\nimport { Effect, Layer, ManagedRuntime } from "effect";',
     IMPORTS, "native cannot reach browser engine"),
]

records = []
for name, path, old, new, command, expected in mutations:
    original = path.read_text()
    assert original.count(old) == 1, name
    env = dict(os.environ, PATH="/root/.deno/bin:" + os.environ["PATH"],
               PW_PORT="5197", PW_DIST="dist-r9",
               PW_OUT=str(EVIDENCE / ("mutation-" + name + "-playwright")))
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        path.write_text(original.replace(old, new))
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True,
                                text=True, timeout=110)
        log = result.stdout + result.stderr
        (EVIDENCE / ("mutation-" + name + ".log")).write_text(
            f"UTC {started}\nCommand: {' '.join(command)}\n"
            f"Mutation in {path.relative_to(ROOT)}:\n- {old}\n+ {new}\n"
            f"Exit: {result.returncode}\n\n{log}")
        killed = result.returncode == 1 and expected in log and "Check failed" not in log
        records.append(dict(name=name, exit=result.returncode, killed=killed))
        print(name, records[-1], flush=True)
        assert killed, f"Mutation {name} not killed by intended test"
    finally:
        path.write_text(original)
        assert path.read_text() == original
        (EVIDENCE / "mutations.json").write_text(json.dumps(records, indent=2) + "\n")
