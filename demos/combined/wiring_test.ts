import { assertStringIncludes } from "@std/assert";

Deno.test("combined demo imports R1 domain and adapters rather than a demo fork", async () => {
  const app = await Deno.readTextFile(new URL("./App.tsx", import.meta.url));
  const session = await Deno.readTextFile(
    new URL("./session.ts", import.meta.url),
  );
  const api = await Deno.readTextFile(
    new URL("../../playground/api/ApiExplorer.tsx", import.meta.url),
  );
  assertStringIncludes(app, 'from "../../prototypes/task-manager/App.tsx"');
  assertStringIncludes(app, 'from "../../prototypes/task-manager/commands.ts"');
  assertStringIncludes(
    session,
    'from "../../prototypes/task-manager/application.ts"',
  );
  assertStringIncludes(api, 'from "../../prototypes/task-manager/api.ts"');
  assertStringIncludes(session, "taskManagerLayerFromService(service)");
});
