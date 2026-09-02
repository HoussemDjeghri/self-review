// Run: node --test plugin/scripts/preflight.test.mjs   (or ./test.sh for everything)
// The project runners (npm, pytest, go, …) are stubbed on PATH: this suite is
// about detection, gating, skipping and reporting, not about anyone's toolchain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "preflight.sh");
// A path that cannot exist, not "": config.mjs treats an empty SELF_REVIEW_CONFIG
// as unset and falls back to the developer's own ~/.claude/self-review/config.json.
const NO_CONFIG = path.join(tmpdir(), "preflight-test-no-such-config.json");

function project(files = {}, stubs = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "preflight-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    if (name.endsWith(".sh")) chmodSync(file, 0o755);
  }
  const bin = path.join(root, ".bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(stubs)) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return { root, bin };
}

function run({ root, bin }, args = [], env = {}) {
  const result = spawnSync("bash", [SCRIPT, "--root", root, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SELF_REVIEW_CONFIG: NO_CONFIG, ...env },
  });
  assert.equal(result.status, 0, `preflight exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

const okStub = 'echo "$@ ok"; exit 0';

test("a package.json script becomes a check, named by kind and run through the package manager", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } }) },
    { npm: okStub });
  const out = run(p);
  assert.match(out, /PASS {2}lint {4}npm run lint/);
  assert.match(out, /PASS {2}test {4}npm test/);
  assert.match(out, /# 2 run, 0 failed, 0 skipped/);
});

test("a failing check reports its exit code and the tail of its output", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: 'for i in 1 2 3 4 5 6; do echo "line $i"; done; exit 3' });
  const out = run(p, ["--tail", "2"]);
  assert.match(out, /FAIL {2}test {4}npm test {3}\(exit 3\)/);
  assert.match(out, /--- FAIL test: last 2 lines/);
  assert.match(out, /line 5\nline 6/);
  assert.doesNotMatch(out, /line 4/, "the tail is a tail");
});

test("only the ecosystems the changed paths touch are run", () => {
  const p = project({
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "go.mod": "module example.com/x\n",
  }, { npm: okStub, go: okStub, gofmt: okStub });
  assert.doesNotMatch(run(p, ["main.go"]), /npm/, "a Go-only change does not run npm");
  assert.match(run(p, ["main.go"]), /go test/);
  assert.doesNotMatch(run(p, ["src/a.ts"]), /go test/, "a TypeScript-only change does not run go");
  assert.match(run(p, []), /npm test/, "no paths means no information, so everything detected runs");
});

test("a check named in preflight.skip is reported, not run", () => {
  const p = project({
    "package.json": JSON.stringify({ scripts: { lint: "x", test: "x" } }),
    "config.json": JSON.stringify({ preflight: { skip: ["test"] } }),
  }, { npm: 'echo ran; exit 1' });
  const out = run(p, [], { SELF_REVIEW_CONFIG: path.join(p.root, "config.json") });
  assert.match(out, /SKIP {2}test {4}\(preflight.skip\)/);
  assert.match(out, /# 1 run, 1 failed, 1 skipped/);
  assert.doesNotMatch(out, /FAIL {2}test/, "a skipped check cannot fail");
});

test("the first detector to claim a kind wins, so package scripts beat Makefile targets", () => {
  const p = project({
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "Makefile": "test:\n\techo make\nlint:\n\techo make\n",
  }, { npm: okStub, make: okStub });
  const out = run(p);
  assert.match(out, /PASS {2}test {4}npm test/);
  assert.match(out, /PASS {2}lint {4}make lint/, "a kind nobody claimed still comes from the Makefile");
  assert.doesNotMatch(out, /make test/);
});

test("--out keeps the failure tails out of the caller's context", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: 'echo "the noisy failure"; exit 1' });
  const file = path.join(p.root, "round-1", "preflight.txt");
  const out = run(p, ["--out", file]);
  assert.doesNotMatch(out, /the noisy failure/);
  assert.match(out, new RegExp(`# failures quoted in ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const written = readFileSync(file, "utf8");
  assert.match(written, /the noisy failure/);
  assert.match(written, /FAIL {2}test/);
});

test("a project with nothing to run says so instead of reporting success", () => {
  const out = run(project({ "README.md": "# nothing to run\n" }));
  assert.match(out, /# no checks detected/);
  assert.doesNotMatch(out, /PASS|FAIL/);
});

test("an executable ./test.sh is the test command when the project defines no other", () => {
  const p = project({ "test.sh": "#!/bin/sh\nexit 0\n" });
  assert.match(run(p), /PASS {2}test {4}\.\/test\.sh/);
});

test("a hanging check is killed and reported as a timeout, not left to block the turn", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { npm: "sleep 30" });
  const out = run(p, [], { SELF_REVIEW_PREFLIGHT_TIMEOUT: "1" });
  assert.match(out, /FAIL {2}test {4}npm test {3}\(timeout 1s\)/);
});

test("the config is found however the script was invoked", () => {
  // Called by a relative path, the script used to resolve its config library as
  // a bare specifier, import nothing, and run every check the user had skipped.
  const p = project({
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "config.json": JSON.stringify({ preflight: { skip: ["test"] } }),
  }, { npm: okStub });
  const result = spawnSync("bash", ["scripts/preflight.sh", "--root", p.root], {
    encoding: "utf8", cwd: path.join(HERE, ".."),
    env: { ...process.env, PATH: `${p.bin}:${process.env.PATH}`, SELF_REVIEW_CONFIG: path.join(p.root, "config.json") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIP {2}test/);
});

test("a relative --root still finds the project's checks", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { npm: okStub });
  const result = spawnSync("bash", [SCRIPT, "--root", path.basename(p.root)], {
    encoding: "utf8", cwd: path.dirname(p.root),
    env: { ...process.env, PATH: `${p.bin}:${process.env.PATH}`, SELF_REVIEW_CONFIG: NO_CONFIG },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS {2}test {4}npm test/, "a relative root must not silently detect nothing");
});

test("a nonsense timeout falls back to the default instead of killing every check", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { npm: okStub });
  const result = spawnSync("bash", [SCRIPT, "--root", p.root], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${p.bin}:${process.env.PATH}`, SELF_REVIEW_CONFIG: NO_CONFIG, SELF_REVIEW_PREFLIGHT_TIMEOUT: "5 minutes" },
  });
  assert.match(result.stderr, /must be a positive whole number of seconds/);
  assert.match(result.stdout, /PASS {2}test/, "the check runs on the default timeout");
});

test("with two lockfiles the priority order decides, not the loop order", () => {
  const p = project({
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "yarn.lock": "# yarn lockfile v1\n",
  }, { pnpm: okStub, yarn: okStub, npm: okStub });
  assert.match(run(p), /PASS {2}test {4}pnpm test/);
});

test("usage errors exit 2 and run nothing", () => {
  const { root } = project({});
  for (const args of [["--out"], ["--tail", "many"], ["--nope"]]) {
    const result = spawnSync("bash", [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `expected usage error for ${args.join(" ")}`);
    assert.equal(result.stdout, "");
  }
});
