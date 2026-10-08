// Compact one-line-per-call view of evidence/browser-probe.json
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2] ?? "evidence/browser-probe.json", "utf8"));
console.log("browser", r.browserVersion);
const short = (x) =>
  x && x.op
    ? `${x.op}: ` + (x.ok ? "ok " + JSON.stringify(x.result?.rows ?? x.result ?? { bytes: x.bytes, header: x.header }).slice(0, 220) : `ERR ${x.error.name}: ${x.error.message.slice(0, 260)}`)
    : JSON.stringify(x).slice(0, 400);
for (const [k, v] of Object.entries(r.steps)) {
  if (k.endsWith("probe")) {
    const p = v.worker[0].result;
    console.log("##", k, "pageCOI", v.pageCrossOriginIsolated, JSON.stringify({ vfsList: p.vfsList, vfsFind: p.vfsFind, oo1: p.oo1Keys, opfsNs: p.hasOpfsNamespace, SAB: p.sharedArrayBuffer, logs: p.logs }));
    continue;
  }
  console.log("##", k);
  if (Array.isArray(v)) v.forEach((x) => console.log("   ", short(x)));
  else if (v.harnessError) console.log("   HARNESS", v.harnessError);
  else for (const [kk, vv] of Object.entries(v)) {
    if (Array.isArray(vv) && vv[0]?.op) { console.log("  ", kk); vv.forEach((x) => console.log("      ", short(x))); }
    else console.log("  ", kk, JSON.stringify(vv).slice(0, 700));
  }
}
console.log("## console (filtered)");
for (const l of r.console) if (!/vite|DevTools/.test(l)) console.log("  ", l.slice(0, 300));
