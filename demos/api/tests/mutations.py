"""From repo root: python3 demos/api/tests/mutations.py EVIDENCE_DIRECTORY.

Sequential real-browser mutations. Every case must fail an assertion, then source
is restored. Uses the demo's exclusive static build, port 4300 and one worker.
"""
import os
from pathlib import Path
import subprocess
import sys

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
deno = "/root/.deno/bin/deno"
api = Path("demos/api/api.ts")
host = Path("demos/api/host.ts")
app = Path("demos/api/App.tsx")
originals = {p: p.read_text() for p in [api, host, app]}
post_sql = """`INSERT INTO bookmarks(title, url) VALUES (${
              quote(title.trim())
            }, ${quote(parsed.href)}) RETURNING id, title, url`"""
cases = [
    ("get-empty", api, "return ok(bookmarks(result));", "return ok([]);", "GET through explorer"),
    ("post-no-write", api, post_sql, "`SELECT 3 AS id, ${quote(title.trim())} AS title, ${quote(parsed.href)} AS url`", "POST through explorer"),
    ("delete-no-write", api, "DELETE FROM bookmarks WHERE id = ${id} RETURNING id, title, url", "SELECT id, title, url FROM bookmarks WHERE id = ${id}", "DELETE through explorer"),
    ("invalid-success-status", api, 'failure(400, "InvalidInput", message)', 'failure(200, "InvalidInput", message)', "invalid request preset"),
    ("split-shell-database", host, "handler: createApi(runtime)", 'handler: createApi(ManagedRuntime.make(browserSqliteLayer({ schema, seed, persistence: "memory" }).pipe(Layer.orDie)))', "shell changes appear"),
    ("extra-view", app, '["API", "Database"].map', '["API", "Database", "CLI"].map', "only API and Database"),
]
summary = []
try:
    for name, path, old, new, test in cases:
        assert originals[path].count(old) == 1, (name, "mutation anchor changed")
        path.write_text(originals[path].replace(old, new))
        try:
            with (out / f"{name}-build.log").open("w") as log:
                build = subprocess.run([deno, "run", "-A", "npm:vite@8.3.3", "build", "--config", "demos/api/vite.config.ts"], stdout=log, stderr=subprocess.STDOUT)
            assert build.returncode == 0, (name, "build failed, mutation not tested")
            env = dict(os.environ, PW_TARGET="static", PW_DIST="dist-r11", PW_OUT=str(out / name))
            with (out / f"{name}.log").open("w") as log:
                run = subprocess.run([deno, "run", "-A", "npm:@playwright/test@1.62.0", "test", "-c", "demos/api/playwright.config.ts", "--grep", test], env=env, stdout=log, stderr=subprocess.STDOUT)
            text = (out / f"{name}.log").read_text()
            killed = run.returncode == 1 and "1 failed" in text and "expect(" in text
            summary.append(f"{name}: exit={run.returncode}, assertion killed={killed}, test={test}")
            print(summary[-1], flush=True)
            assert killed, (name, "mutation survived or infrastructure failure")
        finally:
            path.write_text(originals[path])
finally:
    for path, text in originals.items():
        path.write_text(text)
    (out / "summary.txt").write_text("\n".join(summary) + "\n")
    # Always restore the served build as well as source.
    with (out / "restored-build.log").open("w") as log:
        restored = subprocess.run([deno, "run", "-A", "npm:vite@8.3.3", "build", "--config", "demos/api/vite.config.ts"], stdout=log, stderr=subprocess.STDOUT)
    assert restored.returncode == 0
