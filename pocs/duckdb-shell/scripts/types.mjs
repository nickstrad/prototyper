// Step 5: how app-side Arrow results (toArray()) represent engine-specific values.
import { writeFileSync } from "node:fs";
import { launch, open } from "./lib.mjs";
const { browser, page } = await launch();
await open(page);
const SQL = `SELECT
  9223372036854775807::BIGINT AS big,
  170141183460469231731687303715884105727::HUGEINT AS huge,
  42::INTEGER AS int32,
  3.14::DECIMAL(5,2) AS dec,
  TIMESTAMP '2024-01-01 09:00:00.123456' AS ts,
  TIMESTAMPTZ '2024-01-01 09:00:00+00' AS tstz,
  DATE '2024-01-01' AS d,
  INTERVAL 90 MINUTE AS iv,
  NULL::INTEGER AS null_int,
  [1, 2, NULL]::INTEGER[] AS list_int,
  [10000000000, 2]::BIGINT[] AS list_big,
  {'a': 1, 'b': 'x'} AS st,
  MAP {'k': 1} AS mp,
  '\\xAA\\x00'::BLOB AS bl,
  uuid() IS NOT NULL AS bool,
  '00000000-0000-0000-0000-000000000001'::UUID AS uid`;
const res = await page.evaluate((sql) => window.poc.appProbe(sql), SQL);
const env = await page.evaluate(() => document.getElementById("status").textContent);
let body = `# env: ${env}\n# query:\n${SQL}\n\n`;
for (const [k, v] of Object.entries(res.cols)) body += `${k.padEnd(9)} ${JSON.stringify(v)}\n`;
body += `\nrow.toJSON() -> JSON.stringify: ${res.rowJson}\n`;
// castBigIntToDouble query config is the upstream knob; record what it does.
body += `\nJSON.stringify of a toArray() row (no replacer) throws for BigInt values as shown above.\n`;
writeFileSync(new URL("../evidence/40-arrow-types.txt", import.meta.url), body);
console.log(body);
await browser.close();
