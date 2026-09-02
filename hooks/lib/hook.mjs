/**
 * The shared main() of the hooks in this directory: parse the harness payload
 * from stdin, hand it to the hook's evaluate function, print its JSON output
 * if any. Fail-open is the contract — a hook must never hold a turn hostage —
 * so any error goes to stderr (visible under `claude --debug`) and the
 * process still exits 0. `NAME=off` (etc.) disables the hook for the session.
 */
import { readFileSync } from "node:fs";
import { isDisabled } from "./transcript.mjs";

export function runHook(envName, tag, handler) {
  try {
    if (isDisabled(envName)) return;
    const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
    const output = handler(payload);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (err) {
    process.stderr.write(`${tag}: ${err?.message ?? err}\n`);
  }
}
