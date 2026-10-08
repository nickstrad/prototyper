// Bridge between just-bash custom commands and Effect programs. A command
// handler returns a CommandResult; typed failures become stderr + a nonzero
// exit code, so the shell sees `||`, `&&` and `$?` behave normally.
import { Effect, type ManagedRuntime } from "effect";
import { type ByteString, type CustomCommand, defineCommand } from "just-bash";
import type { CommandResult } from "../core/types.ts";

export type { CommandResult };

export const ok = (stdout: string): CommandResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

export const fail = (stderr: string, exitCode = 1): CommandResult => ({
  stdout: "",
  stderr,
  exitCode,
});

/**
 * Run `program` through the shared runtime. Success text goes to stdout with
 * exit 0; an expected failure is formatted by `formatError` and goes to stderr
 * with `exitCode` (default 1). Defects are not caught: they surface as rejected
 * promises so they stay distinguishable from expected errors.
 */
export const runEffectCommand = <E, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  program: Effect.Effect<string, E, R>,
  formatError: (error: E) => string,
  exitCode = 1,
): Promise<CommandResult> =>
  runtime.runPromise(
    program.pipe(
      Effect.map(ok),
      Effect.catch((error) =>
        Effect.succeed(fail(formatError(error), exitCode))
      ),
    ),
  );

/** Convenience wrapper so command modules do not import just-bash directly. */
export const command = (
  name: string,
  handler: (args: readonly string[], stdin: string) => Promise<CommandResult>,
): CustomCommand =>
  defineCommand(name, (args, ctx) => handler(args, decodeStdin(ctx.stdin)));

// just-bash hands stdin to custom commands as a byte string (one char per
// byte). Its `decodeBytesToUtf8` helper is exported by the Node bundle only,
// not by dist/bundle/browser.js, so decode locally (docs/integrations.md).
const decodeStdin = (stdin: ByteString | undefined): string => {
  if (!stdin) return "";
  const bytes = Uint8Array.from(
    stdin as unknown as string,
    (c) => c.charCodeAt(0) & 0xff,
  );
  return new TextDecoder().decode(bytes);
};
