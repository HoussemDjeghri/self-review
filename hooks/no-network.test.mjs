// Run: node --test plugin/hooks/no-network.test.mjs   (or ./test.sh for everything)
//
// The README claims the plugin's own hooks and scripts never reach the network:
// they read the transcript, the files and git, and nothing else. DESIGN §1 only
// allows a claim with a mechanism that enforces it, so the claim is this test.
// It covers the shipped runtime files only — test files carry the patterns below
// as fixtures, and the reviewer AGENTS are granted WebFetch/WebSearch on purpose
// (they are Claude Code subagents, not code this repo runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT } from "./lib/config.mjs";
import { walkFiles } from "./lib/tree.mjs";

const ROOT = PLUGIN_ROOT;

// One pattern, used both to scan and to prove itself against fixtures below:
// a fetch call, a network core module pulled in by require/import/from in any
// quote style (with or without the node: prefix), a browser networking global,
// or a shell downloader at command position.
const NETWORK = /\bfetch\s*\(|(?:require\s*\(|(?:import|from)\s+)['"](?:node:)?(?:http|https|net|dgram|tls|http2)['"]|\b(?:XMLHttpRequest|WebSocket|EventSource)\b|(?:^|[|&;(]\s*)(?:curl|wget|nc|ssh|scp)\s/m;

// Everything under the plugin root ships, so everything under it is scanned:
// the four directories this used to name missed `scripts/lib` for five
// releases, and would have missed the next directory too. Test files are the
// one exclusion, because they carry the patterns above as fixtures.
const runtimeFiles = () =>
  walkFiles(ROOT).filter((file) => /\.(mjs|js|sh)$/.test(file) && !file.endsWith(".test.mjs"));

test("the pattern trips on real network access", () => {
  for (const line of [
    "const r = await fetch(url);",
    'const http = require("http");',
    "import https from 'https';",
    'import { connect } from "node:net";',
    'export { x } from "node:http2";',
    "const ws = new WebSocket(url);",
    "curl -s https://example.com > out",
    "x=1; wget http://example.com",
  ]) assert.match(line, NETWORK, `should have matched: ${line}`);
});

test("the pattern does not trip on look-alikes", () => {
  for (const line of [
    "prefetch(url);",
    "// docs live at https://example.com/http/guide",
    "const curl_opts = [];",
    'const netmask = require("./netmask.mjs");',
    "// this hook never calls fetch",
    'readFileSync("http-log.txt", "utf8");',
  ]) assert.doesNotMatch(line, NETWORK, `should not have matched: ${line}`);
});

test("no shipped hook or script reaches the network", () => {
  const files = runtimeFiles();
  assert.ok(files.length >= 6, `expected the runtime files to be found, got ${files.length}`);
  const offenders = files.filter((file) => NETWORK.test(readFileSync(path.join(ROOT, file), "utf8")));
  assert.deepEqual(offenders, [], `network access in shipped files: ${offenders.join(", ")}`);
});
