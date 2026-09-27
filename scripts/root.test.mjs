// Run: node --test plugin/scripts/root.test.mjs   (or ./test.sh for everything)
// The skill used to resolve an unexpanded ${CLAUDE_PLUGIN_ROOT} with
// `ls -dt …/cache/*/self-review/*/ | head -1`: the newest mtime, not the
// installed version. The cache keeps every version, so touching an old folder
// ran stale scripts. The record Claude Code keeps is the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedRoot } from "./root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function cache(plugins) {
  const cfg = mkdtempSync(path.join(tmpdir(), "root-cfg-"));
  const dir = (version) => {
    const made = path.join(cfg, "plugins", "cache", "m", "self-review", version);
    mkdirSync(made, { recursive: true });
    return made;
  };
  const record = { version: 2, plugins: typeof plugins === "function" ? plugins(dir) : plugins };
  mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  writeFileSync(path.join(cfg, "plugins", "installed_plugins.json"), JSON.stringify(record));
  return { cfg, dir };
}

test("the installed version wins over a newer-touched folder in the cache", () => {
  const { cfg, dir } = cache((d) => ({ "self-review@m": [{ scope: "user", installPath: d("0.8.3") }] }));
  const stale = dir("0.8.0");
  const future = new Date(Date.now() + 3600_000);
  utimesSync(stale, future, future);
  assert.equal(installedRoot({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd: "/" }), path.join(cfg, "plugins/cache/m/self-review/0.8.3"));
});

test("a project install applies inside its project, the user install elsewhere", () => {
  const project = mkdtempSync(path.join(tmpdir(), "root-proj-"));
  const { cfg } = cache((d) => ({ "self-review@m": [
    { scope: "user", installPath: d("0.8.3") },
    { scope: "project", projectPath: project, installPath: d("0.9.0") },
  ] }));
  const env = { CLAUDE_CONFIG_DIR: cfg };
  assert.match(installedRoot({ env, cwd: path.join(project, "src") }), /0\.9\.0$/);
  assert.match(installedRoot({ env, cwd: tmpdir() }), /0\.8\.3$/);
});

test("no record, another plugin's record or a vanished install falls back to this copy", () => {
  const own = "/own/root";
  assert.equal(installedRoot({ env: { CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), "root-none-")) }, ownRoot: own }), own);
  const { cfg } = cache({ "other@m": [{ scope: "user", installPath: tmpdir() }], "self-review@m": [{ scope: "user", installPath: "/gone" }] });
  assert.equal(installedRoot({ env: { CLAUDE_CONFIG_DIR: cfg }, ownRoot: own }), own);
});

test("run as a script, it prints the recorded root and nothing else", () => {
  const { cfg } = cache((d) => ({ "self-review@m": [{ scope: "user", installPath: d("0.8.3") }] }));
  const done = spawnSync(process.execPath, [path.join(HERE, "root.mjs")], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, `${path.join(cfg, "plugins/cache/m/self-review/0.8.3")}\n`);
});

test("an argument it does not take is refused, not ignored", () => {
  const done = spawnSync(process.execPath, [path.join(HERE, "root.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(done.status, 2, done.stderr);
  assert.equal(done.stdout, "");
  assert.match(done.stderr, /takes no arguments \(got --help\)/);
});
