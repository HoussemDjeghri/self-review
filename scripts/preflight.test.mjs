// Run: node --test plugin/scripts/preflight.test.mjs   (or ./test.sh for everything)
// The project runners (npm, pytest, go, …) are stubbed on PATH: this suite is
// about detection, gating, skipping and reporting, not about anyone's toolchain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  assert.match(out, /# 2 run, 0 failed, 0 flaky, 0 could not start, 0 did not finish, 0 skipped/);
});

test("a failing check reports its exit code and the tail of its output", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: 'for i in 1 2 3 4 5 6; do echo "line $i"; done; exit 3' });
  const out = run(p, ["--tail", "2"]);
  assert.match(out, /FAIL {2}test {4}npm test {3}\(exit 3; failed again on re-run\)/);
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
  assert.match(out, /# 1 run, 1 failed, 0 flaky, 0 could not start, 0 did not finish, 1 skipped/);
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

test("a hanging check is stopped and reported as no verdict, not left to block the turn", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { npm: "sleep 30" });
  const out = run(p, [], { SELF_REVIEW_PREFLIGHT_TIMEOUT: "1", SELF_REVIEW_PREFLIGHT_GRACE: "1" });
  assert.match(out, /INFRA test {4}npm test {3}\(did not finish in 1s — no verdict on the code; re-run pre-flight with a longer SELF_REVIEW_PREFLIGHT_TIMEOUT; blocks converged\)/);
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

// A check that could not START is not a check that failed. Measured over three
// days of use: a pre-flight that false-failed in 8 of 8 rounds taught its
// operator to skip the section entirely, so the one round where it was finally
// right was skipped with the rest. 126 and 127 are the SHELL's own answer to
// "did this ever run", which is why they are the whole test — a per-tool error
// string list would catch more and rot silently, and rot is what is being fixed.
test("a check whose command cannot be run is INFRA, not FAIL", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: "exit 127" });
  const out = run(p);
  assert.match(out, /INFRA test {4}npm test {3}\(exit 127 — the command could not be run; the check never started\)/);
  assert.match(out, /# 1 run, 0 failed, 0 flaky, 1 could not start, 0 did not finish, 0 skipped/,
    "an environment that is broken must not be counted as a red suite");
  assert.doesNotMatch(out, /^FAIL/m);
});

test("a check found but not executable is INFRA too", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: "exit 126" });
  assert.match(run(p), /INFRA test .*\(exit 126/);
});

// Campaign 2, szz/1e525716 rep 1: two checks "capped" at 300 s took 1052 s,
// because the cap was one TERM to the check's shell. A runner that handles TERM
// (pnpm waiting on its vitest workers) kept `wait` blocked; a cap that can be
// declined is not a cap.
test("a check that ignores TERM is still killed at its cap, not waited on", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: "trap '' TERM; sleep 30" });
  const started = Date.now();
  const out = run(p, [], { SELF_REVIEW_PREFLIGHT_TIMEOUT: "1", SELF_REVIEW_PREFLIGHT_GRACE: "1" });
  const seconds = (Date.now() - started) / 1000;
  assert.ok(seconds < 10, `preflight took ${seconds}s for a 1s cap`);
  assert.match(out, /INFRA test {4}npm test {3}\(did not finish in 1s/);
});

test("nothing a timed-out check started outlives it", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: '( sleep 3; touch "$MARK" ) & sleep 30' });
  const mark = path.join(p.root, "grandchild-survived");
  run(p, [], { SELF_REVIEW_PREFLIGHT_TIMEOUT: "1", SELF_REVIEW_PREFLIGHT_GRACE: "1", MARK: mark });
  spawnSync("sleep", ["4"]);
  assert.equal(existsSync(mark), false, "a grandchild of the killed check kept running and wrote its file");
});

test("a capped check gets EOF on stdin, not the caller's open pipe", () => {
  const capped = path.join(HERE, "lib", "capped.sh");
  const marker = path.join(mkdtempSync(path.join(tmpdir(), "capped-")), "timed-out");
  const r = spawnSync("bash", ["-c", `sleep 8 | bash -c '. "${capped}"; capped_run 4 1 "${marker}" sh -c "cat >/dev/null; echo done"'`],
    { encoding: "utf8", timeout: 20000 });
  assert.match(r.stdout, /done/);
  assert.equal(existsSync(marker), false, "the check waited out its cap reading the caller's stdin");
});

// Ruled 2026-11-08 (advisor, campaign-2 fixes §1): a stopped suite is no
// verdict. It used to be FAIL — "a hang can be real" — and in 6 of 12
// CopilotKit runs that FAIL sat over a suite whose own tail read 915/915 passed.
test("a stopped check is counted apart from the ones that could not start, and keeps its tail", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) },
    { npm: 'echo "915 passed so far"; sleep 5' });
  const outFile = path.join(p.root, "report.txt");
  const out = run(p, ["--out", outFile], { SELF_REVIEW_PREFLIGHT_TIMEOUT: "1", SELF_REVIEW_PREFLIGHT_GRACE: "1" });
  assert.match(out, /# 1 run, 0 failed, 0 flaky, 0 could not start, 1 did not finish, 0 skipped/);
  assert.doesNotMatch(out, /EVERY check failed to start/, "a slow suite is not a missing tool");
  assert.match(readFileSync(outFile, "utf8"), /--- DID NOT FINISH test[\s\S]*915 passed so far/);
});

test("a suite that exits 143 by itself is a red suite, not a stopped one", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { npm: "exit 143" });
  assert.match(run(p), /FAIL {2}test {4}npm test {3}\(exit 143; failed again on re-run\)/);
});

test("--deadline gives each check what is left of it, and skips by name what cannot start in time", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { lint: "x", test: "x" } }) },
    { npm: 'case "$*" in "run lint") sleep 30 ;; *) exit 0 ;; esac' });
  const started = Date.now();
  const deadline = Math.floor(Date.now() / 1000) + 12;
  const out = run(p, ["--deadline", String(deadline)], { SELF_REVIEW_PREFLIGHT_GRACE: "1" });
  assert.ok((Date.now() - started) / 1000 < 20, "the lint check was held to the deadline, not to the 300 s cap");
  assert.match(out, /INFRA lint {4}npm run lint {3}\(did not finish in 1[0-2]s/);
  assert.match(out, /SKIP {2}test {4}npm test {3}\(pre-flight budget spent — re-run pre-flight with a longer SELF_REVIEW_PREFLIGHT_TIMEOUT; blocks converged\)/);
});

test("a malformed --deadline is a usage error", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }, { npm: okStub });
  const result = spawnSync("bash", [SCRIPT, "--root", p.root, "--deadline", "soon"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--deadline needs an epoch time/);
});

test("every check failing to start says so, and says why: a tool that could not be run", () => {
  const p = project({ "package.json": JSON.stringify({ scripts: { lint: "x", test: "x" } }) },
    { npm: "exit 127" });
  const out = run(p);
  // Not "a defect in the review": 127 is a tool not found, and the field case
  // was a project's own venv missing from PATH, which no review caused.
  assert.match(out, /^# EVERY check failed to start \(exit 126\/127: a tool not found or not executable where they ran\)\./m);
  assert.match(out, /^# Nothing here is a verdict on the code/m);
});

test("one check that could not start alongside a real failure is not the all-INFRA case", () => {
  // The banner is about a broken STAGE. A project whose linter is missing and
  // whose suite is genuinely red is a project with a red suite, and telling the
  // lead to disregard that verdict would hide the finding pre-flight exists for.
  const p = project({ "package.json": JSON.stringify({ scripts: { lint: "x", test: "x" } }) },
    { npm: 'case "$*" in *lint*) exit 127 ;; *) echo boom; exit 1 ;; esac' });
  const out = run(p);
  assert.match(out, /INFRA lint/);
  assert.match(out, /FAIL {2}test/);
  assert.doesNotMatch(out, /EVERY check failed to start/);
});

test("--help prints the whole header, including the last paragraph", () => {
  // The header is printed by a derived range, not a line range, because a fixed
  // one silently dropped the last paragraph when the header grew. Asserting
  // both ends is what makes the next truncation fail here instead of shipping.
  const out = run(project({}), ["--help"]);
  assert.match(out, /run the project's own checks before spending reviewers/);
  assert.match(out, /Exit 0 even when checks fail/);
});

test("B6: the project's own .venv/bin comes first on PATH, ahead of a shim that cannot run", () => {
  // A uv/venv project keeps ruff and pytest in .venv/bin, and a review's shell
  // has no venv activated — so `ruff` was a pyenv shim answering 127 for a
  // Python the project pins and the machine does not have. npm and pnpm put
  // node_modules/.bin on PATH for their scripts; this is the same for a venv.
  const p = project({
    "pyproject.toml": "[project]\nname = \"p\"\n",
    ".venv/bin/ruff": "#!/bin/sh\necho venv ruff\n",
    ".venv/bin/pytest": "#!/bin/sh\necho venv pytest\n",
  }, { ruff: "exit 127", pytest: "exit 127", mypy: "exit 127" });
  for (const tool of ["ruff", "pytest"]) chmodSync(path.join(p.root, ".venv", "bin", tool), 0o755);
  const out = run(p);
  assert.match(out, /^PASS {2}format {2}ruff format --check \./m, out);
  assert.match(out, /^PASS {2}test {4}pytest -q/m, out);
  // A tool the venv does not hold still resolves where it did before.
  assert.match(out, /^INFRA types {3}mypy/m, out);
});

// A runner that fails its first call and passes every later one. The count
// lives outside the project, because the project is the thing being run.
const flakyStub = (counter, { second = "exit 0" } = {}) =>
  `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${counter}"; echo "run $n"; ` +
  `[ $n -ge 2 ] || { echo "Test timed out in 5000ms"; exit 1; }; ${second}`;
const counterFile = () => path.join(mkdtempSync(path.join(tmpdir(), "preflight-count-")), "n");
const testOnly = () => ({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });

test("Q-a: a test check that fails and then passes on its one re-run is FLAKY — not a pass, not a FAIL", () => {
  // CopilotKit's suite, run as nx runs it (14 tasks in parallel), timed out a
  // different package in 4-8 runs of 10 — a FAIL on every review, which the
  // lead learns to skip. nx replays every passed task from cache on the second
  // run, so only the failed ones run again, under far less contention.
  const n = counterFile();
  const p = project(testOnly(), { npm: flakyStub(n) });
  const outFile = path.join(p.root, "report.txt");
  const out = run(p, ["--out", outFile]);
  assert.match(out, /^FLAKY test {4}npm test {3}\(failed \(exit 1\), passed on re-run — the suite is not stable; first run's failure quoted; not a pass\)$/m);
  assert.match(out, /# 1 run, 0 failed, 1 flaky, 0 could not start, 0 did not finish, 0 skipped/);
  assert.doesNotMatch(out, /^PASS/m);
  const report = readFileSync(outFile, "utf8");
  assert.match(report, /--- FLAKY test: last 40 lines of the first run of `npm test` ---\nrun 1\nTest timed out in 5000ms/);
  const log = readFileSync(path.join(p.root, "report-test.log"), "utf8");
  assert.match(log, /run 1[\s\S]*Test timed out[\s\S]*re-run[\s\S]*run 2/, "both runs kept whole, beside the report");
});

test("Q-a: a test check that fails twice is FAIL, and says the re-run failed too", () => {
  const p = project(testOnly(), { npm: 'echo "deterministic red"; exit 1' });
  const out = run(p);
  assert.match(out, /^FAIL {2}test {4}npm test {3}\(exit 1; failed again on re-run\)$/m);
  assert.match(out, /# 1 run, 1 failed, 0 flaky/);
});

test("Q-a: a re-run that does not finish leaves the first FAIL standing", () => {
  const n = counterFile();
  const p = project(testOnly(), { npm: flakyStub(n, { second: "sleep 30" }) });
  const out = run(p, [], { SELF_REVIEW_PREFLIGHT_TIMEOUT: "2", SELF_REVIEW_PREFLIGHT_GRACE: "1" });
  assert.match(out, /^FAIL {2}test {4}npm test {3}\(exit 1; re-run did not finish\)$/m);
});

test("Q-a: with under 10 s of the budget left, a failing test check is not re-run", () => {
  const n = counterFile();
  const p = project(testOnly(), { npm: `sleep 3; ${flakyStub(n)}` });
  const deadline = Math.floor(Date.now() / 1000) + 12;
  const out = run(p, ["--deadline", String(deadline)]);
  assert.match(out, /^FAIL {2}test {4}npm test {3}\(exit 1; not re-run: pre-flight budget spent\)$/m);
  assert.equal(readFileSync(n, "utf8").trim(), "1", "one run, not two");
});

test("Q-a: only the test check is re-run — a failing lint, or a tool that could not start, runs once", () => {
  // Formatters, linters and type-checkers are deterministic: a second run is
  // the same answer at twice the cost. 126/127 is a missing tool.
  const lintN = counterFile(), testN = counterFile();
  const p = project({ "package.json": JSON.stringify({ scripts: { lint: "x", test: "x" } }) },
    { npm: `case "$*" in *lint*) ${flakyStub(lintN)} ;; *) echo $(( $(cat "${testN}" 2>/dev/null || echo 0) + 1 )) > "${testN}"; exit 127 ;; esac` });
  const outFile = path.join(p.root, "report.txt");
  const out = run(p, ["--out", outFile]);
  assert.match(out, /^FAIL {2}lint {4}npm run lint {3}\(exit 1\)$/m);
  assert.match(out, /^INFRA test/m);
  assert.equal(readFileSync(lintN, "utf8").trim(), "1");
  assert.equal(readFileSync(testN, "utf8").trim(), "1");
  assert.match(readFileSync(path.join(p.root, "report-lint.log"), "utf8"), /Test timed out/,
    "a failing check's whole output is kept beside the report — the tail lost react-textarea's error eight times");
  assert.ok(existsSync(path.join(p.root, "report-test.log")), "and an INFRA check's");
});

test("Q-a: a passing check leaves no log behind", () => {
  const p = project(testOnly(), { npm: okStub });
  const outFile = path.join(p.root, "report.txt");
  run(p, ["--out", outFile]);
  assert.ok(!existsSync(path.join(p.root, "report-test.log")));
});

test("Q-a: a passing run removes an earlier run's log beside the report", () => {
  const p = project(testOnly(), { npm: okStub });
  const outFile = path.join(p.root, "report.txt");
  writeFileSync(path.join(p.root, "report-test.log"), "an earlier run's failure\n");
  run(p, ["--out", outFile]);
  assert.ok(!existsSync(path.join(p.root, "report-test.log")));
});
