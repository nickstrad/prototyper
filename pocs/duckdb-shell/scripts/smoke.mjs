import { launch, open, run, text } from "./lib.mjs";
const { browser, page, logs } = await launch();
await open(page);
console.log(await text(page));
console.log("----");
console.log(await run(page, "SELECT 42;"));
console.log(logs.join("\n"));
await browser.close();
