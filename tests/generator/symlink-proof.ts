// Separate from the task test: Deno 2.9.5 requires unscoped write to create links.
import { assertEquals, assertRejects } from "@std/assert";
import { generatePrototype } from "../../tools/prototype-new.ts";
if (import.meta.main) {
  const root = await Deno.makeTempDir({ prefix: "r5-symlink-" });
  try {
    const config = {
      name: "links",
      database: "sqlite",
      persistence: "memory",
      interfaces: [],
    };
    await Deno.mkdir(`${root}/existing`);
    await Deno.writeTextFile(`${root}/existing/sentinel`, "untouched");
    for (const target of ["existing", "missing"]) {
      const link = `${root}/${target}-link`;
      await Deno.symlink(`${root}/${target}`, link);
      await assertRejects(
        () => generatePrototype(config, link),
        Deno.errors.AlreadyExists,
      );
      assertEquals(await Deno.readLink(link), `${root}/${target}`);
    }
    assertEquals(
      await Deno.readTextFile(`${root}/existing/sentinel`),
      "untouched",
    );
    console.log("Existing and dangling symlinks refused; target preserved.");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
