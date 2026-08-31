// Run: node --test plugin/scripts/coldrun.test.mjs   (or ./test.sh for everything)
// coldrun.sh runs the shipped artifact where it has never run. Two things are
// worth testing, and both were live defects:
//
//   * the two halves of angle X disagreeing about what the product is —
//     tier.mjs refuses to plan a Cold-run finder against a corpus fixture and
//     this scan offered the same fixture as something to go and install;
//   * containment, which is the whole reason this script executes at all. If
//     the sandbox does not actually deny the network and confine writes, the
//     design is back to asking an agent to guess what is safe to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLDRUN = path.join(HERE, "coldrun.sh");

const script = (repo, rel, body) => {
  mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), body, { mode: 0o755 });
};

// A real git repository, because the copy predicate is
// `git ls-files -co --exclude-standard` and a bare directory would silently
// exercise the not-a-git-repo fallback instead — a path no real run takes,
// since round.sh's root always comes from scope.sh.
const repoWith = (files, { gitignore = "" } = {}) => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "coldrun-")), "repo");
  for (const [rel, body] of Object.entries(files)) script(repo, rel, body);
  if (gitignore) writeFileSync(path.join(repo, ".gitignore"), gitignore);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  return repo;
};

/** The sandbox lives outside the repo and its path holds a space, as in real use. */
const run = (repo, env = {}) => {
  const out = mkdtempSync(path.join(tmpdir(), "cold out "));
  const result = spawnSync("bash", [COLDRUN, "--root", repo, "--out", out], {
    encoding: "utf8",
    // The same isolation tier.test.mjs uses: the shipped defaults are the
    // fixture, and a user's own config must not decide whether this passes.
    env: { ...process.env, SELF_REVIEW_CONFIG: path.join(tmpdir(), "coldrun-test-no-such-config.json"), ...env },
  });
  return { ...result, out, transcript: readFileSync(path.join(out, "transcript.md"), "utf8") };
};

const HELLO = "#!/usr/bin/env bash\necho hi\n";

/**
 * Run, and skip the test unless the run actually reached full containment.
 *
 * The guard used to be `command -v sandbox-exec || command -v bwrap`, which
 * asks which binaries are installed — the same question coldrun.sh itself got
 * wrong. A GitHub runner has bubblewrap AND cannot use it, so the guard said
 * "contained", coldrun refused to execute, and every assertion about what ran
 * failed for a reason that was not a defect. What a test that needs execution
 * depends on is the tier the run REACHED, and the transcript states it.
 */
const runContained = (t, repo, env = {}) => {
  const result = run(repo, env);
  if (!/containment: \*\*contained\*\*/.test(result.transcript)) {
    t.skip("this host cannot enforce full containment");
    return null;
  }
  return result;
};

/**
 * A temporary directory in the reviewer's REAL home — the only place a test can
 * prove the real home is unreachable from inside the sandbox.
 *
 * Creating it can fail: an unset, absent or read-only HOME. That is a host this
 * property cannot be tested on, not a defect, so it skips the way a host
 * without containment skips — the creation used to run before `runContained`
 * had decided anything, so such a host errored instead.
 *
 * Cleanup is layered, and the layers are chosen by what was measured to work,
 * not by what sounds thorough. The caller's `finally` covers the normal and
 * failed-assertion paths. The `exit` hook covers the early `return` after a
 * skip, when a decoy made earlier in the same test already exists.
 *
 * NOTHING in this process covers an interruption: `node --test` runs this file
 * in a CHILD process and kills it, so neither an `exit` hook nor a `SIGINT`
 * handler registered here runs — both measured, not assumed. A SIGINT handler
 * was written and then removed for exactly that reason; a cleanup that does
 * not run is worse than none, because it is claimed in a comment. What covers
 * an interrupted run is the sweep below, on the next run.
 */
const HOME_DECOY_PREFIX = ".coldrun-test-";
// The pid is in the name so the sweep can tell a dead run's litter from a LIVE
// run's working directory. Without it the sweep deleted a concurrent suite's
// decoy — which makes that suite's `HOME_HAS_DECOY: 0` pass because the decoy
// was gone rather than because the sandbox held — and could delete its live
// `--out` mid-run. Two concurrent suites then both report green, which is the
// same vacuity this file has already been bitten by once.
const homeDecoyName = (kind) => `${HOME_DECOY_PREFIX}${process.pid}-${kind}-`;
const DEAD_DECOY = new RegExp(`^\\${HOME_DECOY_PREFIX}(\\d+)-`);

const homeDecoys = new Set();
process.on("exit", () => {
  for (const dir of homeDecoys) rmSync(dir, { recursive: true, force: true });
});

const ownerIsGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;            // running
  } catch (err) {
    return err.code === "ESRCH";   // EPERM means alive and someone else's
  }
};

// Anything a killed run left behind: `node --test` runs this file in a child
// process and kills it, so no in-process hook survives an interruption (both
// `exit` and `SIGINT` measured). This is the layer that does.
let entries = [];
try {
  entries = readdirSync(homedir());
} catch { /* an unreadable home has nothing of ours in it */ }
for (const name of entries) {
  const owner = DEAD_DECOY.exec(name);
  if (!owner || !ownerIsGone(Number(owner[1]))) continue;
  // Per entry, so one undeletable leftover does not strand all the others.
  try {
    rmSync(path.join(homedir(), name), { recursive: true, force: true });
  } catch { /* someone else's to clean up */ }
}

const homeTempDir = (t, prefix) => {
  let dir;
  try {
    dir = mkdtempSync(path.join(homedir(), prefix));
  } catch (err) {
    t.skip(`no writable home to plant a decoy in (${err.code})`);
    return null;
  }
  homeDecoys.add(dir);
  return dir;
};

test("a fixture that declares itself runnable is still not the product", (t) => {
  const repo = repoWith({
    "scripts/ship.sh": HELLO,
    "evals/corpora/demo/base/bin/publish.sh": HELLO,
    "test/helpers/seed.sh": HELLO,
  });
  const { status, stderr, transcript } = run(repo);

  // Which files are the product is decided before anything runs, so these hold
  // on every host — including one that cannot contain and therefore executes
  // nothing. Only the "was it exercised" assertion needs a real run.
  assert.equal(status, 0, stderr);
  assert.doesNotMatch(transcript, /corpora/, "an executableExclude tree is not the product");
  assert.doesNotMatch(transcript, /seed\.sh/, "nor is a test path");
  assert.match(stderr, /2 fixture\(s\) skipped/, "what was dropped is said, not silently swallowed");
  assert.match(transcript, /scripts\/ship\.sh/, "and the one real entry point is named");

  if (!/containment: \*\*contained\*\*/.test(transcript)) return t.skip("this host cannot enforce full containment");
  assert.match(transcript, /^## scripts\/ship\.sh$/m, "the shipped entry point is exercised");
});

test("a capture the transcript had to cut says so where it cut it", (t) => {
  // The byte count was the whole capture and the fence held the first 2000 of
  // it, with nothing in between — so angle X's grader read a `--help` that
  // stopped mid-word and could not tell a truncated command from a broken one.
  const repo = repoWith({ "scripts/ship.sh": "#!/usr/bin/env bash\nfor i in $(seq 1 400); do echo \"line $i: padding to overflow the transcript cap\"; done\n" });
  const { status, stderr, transcript } = run(repo);
  assert.equal(status, 0, stderr);
  if (!/containment: \*\*contained\*\*/.test(transcript)) return t.skip("this host cannot enforce full containment");

  assert.match(transcript, /- stdout \(\d{4,} bytes, showing first 2000\):/, "the header says the fence is not the whole capture");
  assert.match(transcript, /^# TRUNCATED: \d+ bytes total, showing 2000 — the rest was not kept\./m);
  assert.match(transcript, /- stderr \(0 bytes\):/, "and a capture that fits keeps the plain header");
});

test("the sandbox tree survives wherever the OS puts temporary directories", (t) => {
  // bwrap applies its mount arguments in sequence and a later mount buries an
  // earlier one. `--tmpfs /tmp` used to come last, so on Linux — where a
  // temporary directory IS under /tmp — the empty tmpfs covered the copied
  // install, and every entry point exited 127 with no stdout. That is exactly
  // what the grader is told to read as a defect in the artifact, so a broken
  // sandbox would have manufactured findings against working code. Pinning
  // /tmp explicitly rather than trusting `tmpdir()` keeps the collision in the
  // test even if TMPDIR is set to somewhere else.
  const out = mkdtempSync("/tmp/cold out ");
  const repo = repoWith({ "scripts/ship.sh": HELLO });
  const result = spawnSync("bash", [COLDRUN, "--root", repo, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, SELF_REVIEW_CONFIG: path.join(tmpdir(), "coldrun-test-no-such-config.json") },
  });
  const transcript = readFileSync(path.join(out, "transcript.md"), "utf8");
  if (!/containment: \*\*contained\*\*/.test(transcript)) return t.skip("this host cannot enforce full containment");

  assert.equal(result.status, 0, result.stderr);
  assert.match(transcript, /- exit: 0\n/, "the entry point ran; it did not vanish under a later mount");
  assert.match(transcript, /^hi$/m, "and its stdout reached the transcript");
});

test("what runs cannot reach the network, escape the sandbox, or read a credential", (t) => {
  // Skipped rather than failed where the host offers no containment: on such a
  // host the script's answer is to run nothing, which the next test covers.
  const escape = path.join(mkdtempSync(path.join(tmpdir(), "coldrun-escape-")), "PWNED");
  const repo = repoWith({
    "scripts/hostile.sh": [
      "#!/usr/bin/env bash",
      'echo "TOKEN=[${COLDRUN_TEST_SECRET:-unset}]"',
      'curl -s -m 4 -I https://example.com >/dev/null 2>&1 && echo "NETWORK: reached" || echo "NETWORK: denied"',
      `echo pwned > "${escape}" 2>/dev/null && echo "WRITE: escaped" || echo "WRITE: denied"`,
      "sleep 60",
      "",
    ].join("\n"),
  });
  const contained = runContained(t, repo, { COLDRUN_TEST_SECRET: "verysecret", COLDRUN_TIMEOUT: "2" });
  if (!contained) return;
  const { transcript } = contained;

  assert.match(transcript, /TOKEN=\[unset\]/, "env -i drops the inherited environment");
  assert.match(transcript, /NETWORK: denied/, "network denial is the load-bearing control");
  assert.match(transcript, /WRITE: denied/, "writes are confined to the sandbox");
  assert.equal(existsSync(escape), false, "and the file outside it was never created");
  assert.match(transcript, /KILLED at the 2s timeout/, "a hang is bounded and recorded");
  assert.doesNotMatch(transcript, /verysecret/, "the secret never reaches the transcript either");
});

test("one predicate decides what an entry point is, and it does not follow symlinks", () => {
  // The scan used to ask `[ -x "$file" ]` while tier.mjs asked whether any
  // execute bit is set. Two divergences: `[ -x ]` follows a symlink, so a link
  // in the tree pointed execution at a binary that never shipped; and it asks
  // whether THIS uid may execute, so an entry point tier.mjs planned against
  // could be silently missing from the transcript the grader reads.
  const repo = repoWith({ "scripts/ship.sh": HELLO });
  symlinkSync("/bin/echo", path.join(repo, "scripts/link"));
  const { transcript } = run(repo);

  assert.match(transcript, /scripts\/ship\.sh/, "the real entry point still runs");
  assert.doesNotMatch(transcript, /scripts\/link/, "the symlink is not an entry point — its target is not what ships");
});

test("an unrecognised forced tier is refused, not run bare", () => {
  // It used to flow straight through: `run_contained`'s `case` matched no
  // branch, left the wrapper array empty, and executed every entry point with
  // no sandbox — while `tier != "uncontained"` also skipped the refusal. So
  // `COLDRUN_FORCE_TIER=none` was a complete bypass of every control here,
  // reachable by anything that can set an environment variable.
  const repo = repoWith({ "scripts/ship.sh": HELLO });
  const out = mkdtempSync(path.join(tmpdir(), "cold out "));
  const result = spawnSync("bash", [COLDRUN, "--root", repo, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, SELF_REVIEW_CONFIG: path.join(tmpdir(), "coldrun-test-no-such-config.json"), COLDRUN_FORCE_TIER: "none" },
  });

  assert.equal(result.status, 2, "a usage error, not a silent bare run");
  assert.match(result.stderr, /COLDRUN_FORCE_TIER must be/);
  assert.equal(existsSync(path.join(out, "transcript.md")), false, "and nothing was executed to write one");
});

test("what runs cannot read a credential outside the sandbox", (t) => {
  // Denying only the network and writes was not enough: run_contained copies
  // the first bytes of stdout into the transcript and the grader reads the
  // transcript, so `cat ~/.aws/credentials` exfiltrated a real key into the
  // review's own context at the STRONGEST tier, with no network involved.
  const secretDir = mkdtempSync(path.join(tmpdir(), "coldrun-cred-"));
  const secret = path.join(secretDir, "credentials");
  writeFileSync(secret, "sk-live-DEADBEEF\n");

  // A second decoy inside the reviewer's REAL home, because that is the file
  // the sandbox exists to keep out and only a real file proves it is out.
  //
  // This assertion used to be `ls $HOME` must error. That conflated two
  // different properties, and the weaker one is not even true: when a PATH
  // directory lives under $HOME — `/home/runner/.local/bin` on every GitHub
  // runner — bwrap creates the skeleton that leads to it, so $HOME exists,
  // holds exactly that one dotted entry, and `ls` prints nothing and exits 0.
  // Nothing leaked; the test was asserting the wrong thing. The invariant is
  // not "home is absent", it is "nothing in home is reachable".
  const homeDecoyDir = homeTempDir(t, homeDecoyName("decoy"));
  if (!homeDecoyDir) return;
  const homeDecoy = path.join(homeDecoyDir, "credentials");
  // Deliberately not shaped like a key. If cleanup is ever defeated this file
  // sits in a real home directory, and a marker that reads as a live token is
  // one a secret scanner will flag and a person will have to chase down.
  writeFileSync(homeDecoy, "COLDRUN-TEST-DECOY-NOT-A-SECRET\n");
  // A second decoy the probe never NAMES, so the only way its basename can
  // reach the transcript is by being listed. The first decoy cannot serve:
  // `cat`'s own refusal message quotes the path it was given.
  const homeListDecoyDir = homeTempDir(t, homeDecoyName("unnamed"));
  if (!homeListDecoyDir) return;

  try {
    const repo = repoWith({
      "scripts/probe.sh": [
        "#!/usr/bin/env bash",
        `echo "CRED: $(cat "${secret}" 2>&1 | head -1)"`,
        `echo "HOME_CRED: $(cat "${homeDecoy}" 2>&1 | head -1)"`,
        // A membership count, not a listing. Asserting over `ls | head -20` was
        // very nearly vacuous: this home holds 87 entries and a
        // `.coldrun-test-` decoy sorts at rank ~18, so one new dotfile ahead of
        // it would have pushed it past the cutoff and quietly retired the only
        // assertion pinning the seatbelt fix. A count is independent of home
        // size, of locale collation, and of how much output is kept.
        // A positive control, because `HOME_HAS_DECOY: 0` is one-sided: a missing
        // `ls`, an `ls` that errors, or any other left-side failure prints 0
        // too. This line fails if the pipeline itself is not working, so the 0
        // above is earned rather than merely produced.
        `echo "LS_WORKS: $(ls -A / 2>/dev/null | grep -cFx 'usr')"`,
        `echo "HOME_HAS_DECOY: $(ls -A "${homedir()}" 2>/dev/null | grep -cF '${path.basename(homeListDecoyDir)}')"`,
        `echo "HOME_LS: $(ls -A "${homedir()}" 2>&1 | head -1)"`,
        'echo "NODE: $(node -e \'console.log("works")\' 2>&1 | head -1)"',
        "",
      ].join("\n"),
    });
    const contained = runContained(t, repo);
    if (!contained) return;
    const { transcript } = contained;

    assert.doesNotMatch(transcript, /sk-live-DEADBEEF/, "the credential never reaches the transcript");
    assert.match(transcript, /CRED: .*(not permitted|No such file)/, "and the read was refused, loudly");
    assert.doesNotMatch(transcript, /COLDRUN-TEST-DECOY-NOT-A-SECRET/, "nor does one that sits in the reviewer's real home");
    assert.match(transcript, /HOME_CRED: .*(not permitted|No such file)/, "that read is refused too");
    // Enumeration, not just content. The assertion this replaced (`ls $HOME`
    // must error) did cover this and the first replacement did not, which a
    // reviewer caught: naming a real entry of the home directory is itself a
    // leak — .aws, .ssh, an employer's directory — and the transcript goes
    // into the grader's context. Matching on the decoy's own random basename
    // is immune to the PATH-skeleton false positive that killed `ls`.
    // Two premises, both checked, because `HOME_HAS_DECOY: 0` is silent about
    // either being false. LS_WORKS rules out a broken pipeline; this rules out
    // the decoy having been deleted before the probe listed the home — which is
    // not hypothetical, it is exactly what a concurrent run used to do.
    assert.ok(existsSync(homeListDecoyDir), "the decoy still existed to be found");
    assert.match(transcript, /LS_WORKS: 1$/m, "the listing pipeline works, so the next assertion means something");
    assert.match(transcript, /HOME_HAS_DECOY: 0$/m,
      "nor is a real entry of the reviewer's home even nameable");
    // The allowlist has to leave an interpreter reachable, or every node entry
    // point fails on the reviewer's own machine and the angle is useless.
    assert.match(transcript, /NODE: works/, "an interpreter on PATH still resolves");
  } finally {
    rmSync(homeDecoyDir, { recursive: true, force: true });
    rmSync(homeListDecoyDir, { recursive: true, force: true });
  }
});

test("a sandbox that lives under the reviewer's home does not open the home", (t) => {
  // Seatbelt grants every ancestor of $out so that path resolution can stat
  // its way down — but they were granted `file-read*`, and on a directory
  // literal that also grants readdir. `--work ~/reviews` is one flag away
  // (round.sh takes that directory from its caller), and then $HOME is an
  // ancestor: an executed entry point could `ls -A $HOME` and the filenames
  // landed in the transcript the grader reads. Ancestors now get
  // `file-read-metadata` only. `/` is the exception and must keep the full
  // read: as metadata-only, every process dies SIGABRT with no diagnostic.
  const outUnderHome = homeTempDir(t, homeDecoyName("out"));
  if (!outUnderHome) return;
  const decoyDir = homeTempDir(t, homeDecoyName("unlisted"));
  if (!decoyDir) return;
  try {
    const repo = repoWith({
      "scripts/probe.sh": [
        "#!/usr/bin/env bash",
        `echo "LS_WORKS: $(ls -A / 2>/dev/null | grep -cFx 'usr')"`,
        `echo "HOME_HAS_DECOY: $(ls -A "${homedir()}" 2>/dev/null | grep -cF '${path.basename(decoyDir)}')"`,
        `echo "HOME_LS: $(ls -A "${homedir()}" 2>&1 | head -1)"`,
        'echo "NODE: $(node -e \'console.log("works")\' 2>&1 | head -1)"',
        "",
      ].join("\n"),
    });
    const result = spawnSync("bash", [COLDRUN, "--root", repo, "--out", outUnderHome], {
      encoding: "utf8",
      env: { ...process.env, SELF_REVIEW_CONFIG: path.join(tmpdir(), "coldrun-test-no-such-config.json") },
    });
    const transcript = readFileSync(path.join(outUnderHome, "transcript.md"), "utf8");
    if (!/containment: \*\*contained\*\*/.test(transcript)) return t.skip("this host cannot enforce full containment");

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(decoyDir), "the decoy still existed to be found");
    assert.match(transcript, /LS_WORKS: 1$/m, "the listing pipeline works, so the next assertion means something");
    assert.match(transcript, /HOME_HAS_DECOY: 0$/m,
      "the home is not listable just because the sandbox sits inside it");
    // The ancestors still have to be traversable, or nothing runs at all.
    assert.match(transcript, /NODE: works/, "and resolution still works through those same ancestors");
  } finally {
    rmSync(outUnderHome, { recursive: true, force: true });
    rmSync(decoyDir, { recursive: true, force: true });
  }
});

test("an interpreter that lives only on PATH is reachable inside the sandbox", (t) => {
  // A real nvm/pyenv/rbenv/cargo interpreter lives under $HOME, which neither
  // wrapper binds. macOS walked $PATH to allow those directories; the bwrap
  // branch bound a fixed list of system roots and nothing else, so on Linux
  // every such entry point died with "command not found" — and the grader is
  // told to report exactly that as a defect in the artifact. A stand-in on
  // PATH is the smallest thing that fails the same way on both tiers.
  const binDir = mkdtempSync(path.join(tmpdir(), "coldrun-bin-"));
  writeFileSync(path.join(binDir, "coldrun-probe"), "#!/bin/sh\necho reachable\n", { mode: 0o755 });
  const repo = repoWith({ "scripts/probe.sh": '#!/usr/bin/env bash\necho "PROBE: $(coldrun-probe 2>&1)"\n' });
  const contained = runContained(t, repo, { PATH: `${binDir}:${process.env.PATH}` });
  if (!contained) return;
  const { transcript } = contained;

  assert.match(transcript, /PROBE: reachable/, "the PATH directory was granted, not just the system roots");
});

test("a gitignored secret never enters the sandbox, and an uncommitted entry point still runs", () => {
  // The copy was everything-minus-a-blocklist naming `.env*` and a few build
  // dirs, so an `id_rsa`, an `.npmrc` token or a service-account JSON rode in
  // — and the first 2000 bytes of any invocation's stdout go verbatim into the
  // transcript, into two reviewers' briefs, and into findings.mjs as `proof`.
  // Nothing here is committed, which is the normal shape of a review: the
  // predicate has to keep untracked work while dropping ignored files.
  const repo = repoWith({
    "scripts/probe.sh": '#!/usr/bin/env bash\necho "SECRET: $(cat secrets.json 2>&1 | head -1)"\n',
    "secrets.json": '{"token":"sk-live-COPIED"}\n',
  }, { gitignore: "secrets.json\n" });
  const { transcript, out } = run(repo);

  assert.doesNotMatch(transcript, /sk-live-COPIED/, "the ignored file never reached the transcript");
  assert.equal(existsSync(path.join(out, "install", "secrets.json")), false, "nor the sandbox at all");
  assert.match(transcript, /scripts\/probe\.sh/, "the untracked entry point under review still ran");
  assert.match(transcript, /copy: tracked and unignored files/, "and the transcript names the predicate it used");
});

test("a host that can deny the network but not confine writes still refuses to run", () => {
  // This was the inverted gate: `uncontained`, which executes NOTHING, needed
  // a person's config key, while `network-denied` — this user's uid against
  // the real filesystem, with the read allowlist and write confinement both
  // inert — was unlocked by bubblewrap merely being absent.
  const repo = repoWith({ "scripts/ship.sh": HELLO });
  const { transcript } = run(repo, { COLDRUN_FORCE_TIER: "network-denied" });

  assert.match(transcript, /## Nothing was executed/);
  assert.doesNotMatch(transcript, /### no arguments/, "no invocation was attempted");
  assert.match(transcript, /Install bubblewrap/, "and the message says the one thing that fixes this host");
  assert.match(transcript, /`scripts\/ship\.sh` \(not executed\)/);
});

test("a sandbox that is installed but does not work is not containment", () => {
  // The tier used to be decided by `command -v`. On a GitHub runner bwrap is
  // installed and then dies with `loopback: Failed RTM_NEWADDR: Operation not
  // permitted`, so every entry point exited 1 with empty stdout while the
  // header still read `containment: **contained**` — and empty stdout at a
  // non-zero exit is precisely what the grader is told to report as a defect
  // in the artifact. A broken control does not fail closed by itself.
  const stubs = mkdtempSync(path.join(tmpdir(), "coldrun-stub-"));
  for (const name of ["sandbox-exec", "bwrap"]) {
    writeFileSync(path.join(stubs, name), "#!/bin/sh\necho 'stub: broken' >&2\nexit 1\n", { mode: 0o755 });
  }
  const repo = repoWith({ "scripts/ship.sh": HELLO });
  const { transcript } = run(repo, { PATH: `${stubs}:${process.env.PATH}` });

  assert.doesNotMatch(transcript, /containment: \*\*contained\*\*/, "a wrapper that cannot run is not a tier");
  assert.match(transcript, /## Nothing was executed/, "so it refuses instead of running bare");
  assert.match(transcript, /does not work here/, "and says the sandbox is present but broken");
});

test("with no containment nothing is executed, and the entry points are called unverified", () => {
  // Forced rather than detected: the interesting path is the one this machine
  // does not take, and "we ran nothing" must never read as "we found nothing".
  const repo = repoWith({ "scripts/ship.sh": HELLO });
  const { transcript, stdout } = run(repo, { COLDRUN_FORCE_TIER: "uncontained" });

  assert.match(transcript, /## Nothing was executed/);
  assert.match(transcript, /UNVERIFIED, not verified-clean/);
  assert.match(transcript, /`scripts\/ship\.sh` \(not executed\)/);
  assert.doesNotMatch(transcript, /### no arguments/, "no invocation was attempted");
  assert.match(stdout, /NOTHING EXECUTED/, "and the caller is told without opening the file");
});

test("--stage-only copies the tree and runs nothing, with the dependency trees an install has", () => {
  // The mode F8 added: round.sh stages the copy BEFORE pre-flight and runs the
  // project's own checks from it, so a root computed from `import.meta.url` is
  // exercised somewhere other than the developer's checkout for the first time.
  const repo = repoWith({
    "ship.sh": "#!/usr/bin/env bash\necho hi\n",
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
  }, { gitignore: "node_modules/\n" });
  const out = realpathSync(mkdtempSync(path.join(tmpdir(), "cold stage ")));
  const done = spawnSync("bash", [COLDRUN, "--root", repo, "--out", out, "--stage-only"], { encoding: "utf8" });

  assert.equal(done.status, 0, done.stderr);
  const ship = done.stdout.trim();
  assert.equal(ship, path.join(out, "install"), "the install path is what the caller needs back");
  assert.equal(readFileSync(path.join(ship, "ship.sh"), "utf8"), "#!/usr/bin/env bash\necho hi\n");
  assert.ok(!existsSync(path.join(out, "transcript.md")), "nothing was run, so there is nothing to grade");

  // An ignored dependency tree is exactly what the copy predicate drops and
  // what an install has: without it the project's own suite fails to resolve a
  // single import, which is a permanent false FAIL in every round-1 report.
  // Linked, not copied — it is not the code under review, and it is the most
  // expensive thing here to duplicate.
  assert.equal(readFileSync(path.join(ship, "node_modules/left-pad/index.js"), "utf8"), "module.exports = 1;\n");
  assert.ok(lstatSync(path.join(ship, "node_modules")).isSymbolicLink(), "linked, not copied");
  // The home the caller hands to the checks: present, empty, and not the
  // developer's.
  assert.deepEqual(readdirSync(path.join(out, "home")), []);
});
