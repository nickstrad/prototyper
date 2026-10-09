import { demos } from "./registry.ts";
const list = document.getElementById("demos")!;
for (const demo of demos) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = `/demos/${demo.id}/`;
  link.textContent = demo.title;
  item.append(link, ` — ${demo.engine}: ${demo.views}`);
  list.append(item);
}
