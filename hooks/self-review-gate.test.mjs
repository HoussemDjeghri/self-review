// Contract tests for self-review-gate.mjs. Run: node --test hooks/self-review-gate.test.mjs   (or ./test.sh)
//
// Each test builds a synthetic transcript (the JSONL shapes Claude Code really
// writes — verified against ~/.claude/projects/*), pipes a Stop payload through
// the gate, and checks the decision. Project paths below point at a fake repo
// that need not exist: the gate classifies by path, never by reading files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinition } from "./lib/frontmatter.mjs";

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "self-review-gate.mjs");
const PLUGIN_ROOT = path.resolve(path.dirname(GATE), "..");
const CONVERGED_SH = path.join(PLUGIN_ROOT, "scripts/converged.sh");
const PROJECT = "/repo/fake-project";
const SCRATCH = "/tmp/scratch"; // under a scratch prefix: writes there are never changes
// Quoted the way a caller must quote it, and the way the gate's own message
// prints it: the fixtures share the install path of the gate under test, and
// this suite is run from a copy whose path has a space in it on purpose.
// A leading `~` stays outside the quotes — it is the shell's to expand.
const SH = (word) => {
  const [prefix, rest] = word.startsWith("~") ? ["~", word.slice(1)] : ["", word];
  return /[^\w.\-/]/.test(rest) ? `${prefix}'${rest.replace(/'/g, "'\\''")}'` : word;
};
const CONVERGED_Q = SH(CONVERGED_SH);
// The flag form the model must type now, and the line marker.mjs really prints
// for it. The gate matches the command WORD and the token in the output; it
// never parses the arguments — which is why the prefix-parsing cases further
// down still pass a positional summary and still clear the gate.
const MARKER_CMD = `${CONVERGED_Q} --converged --rounds 1 --fixed 0 --dismissed 0 --open 0`;
const MARKER_OUT = "SELF-REVIEW CONVERGED — outcome=converged rounds=1 fixed=0 dismissed=0 open=0";
const GATE_TAG = "[self-review-gate]";
// The real account home, from the password database rather than from `$HOME`.
// Two things here need a path that is nobody's scratch directory — the
// `~/.claude` classification cases, and the F7 fixtures, which must hold a real
// git repository the gate does not exempt — and every temp directory is a
// scratch prefix to the gate. `$HOME` cannot supply that: round.sh runs
// pre-flight from the cold-run copy with the copy's own empty home, which is
// itself under a scratch prefix, and under it these cases passed or failed for
// the wrong reason. Cases that mean "the gate's idea of ~" also pass HOME
// explicitly, so the gate and the fixture cannot disagree about where it is.
const REAL_HOME = userInfo().homedir;
const atHome = (rel) => path.join(REAL_HOME, rel);
const HOME_ENV = { HOME: REAL_HOME };

let seq = 0;
const stamp = () => new Date(1_700_000_000_000 + ++seq * 1000).toISOString();
const human = (text) => ({ type: "user", uuid: `u${seq}`, timestamp: stamp(), message: { role: "user", content: text } });
const said = (text) => ({ type: "assistant", uuid: `a${seq}`, timestamp: stamp(), message: { role: "assistant", content: [{ type: "text", text }] } });
const toolUse = (name, input, id = `toolu_${seq + 1}`) => ({
  type: "assistant", uuid: `a${seq}`, timestamp: stamp(),
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id, content, toolUseResult = content) => ({
  type: "user", uuid: `r${seq}`, timestamp: stamp(), toolUseResult,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const gateFeedback = () => ({ type: "user", isMeta: true, timestamp: stamp(), message: { role: "user", content: `Stop hook feedback:\n${GATE_TAG} please review` } });
const interrupted = () => ({ type: "user", timestamp: stamp(), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
const compactSummary = () => ({ type: "user", isCompactSummary: true, timestamp: stamp(), message: { role: "user", content: "This session is being continued from a previous conversation…" } });

// Ids are captured before the builders run: stamp() advances `seq`, so reading
// `seq` twice would pair a tool_use with the wrong tool_result.
function call(name, input, output, toolUseResult) { const id = `${name}${++seq}`; return [toolUse(name, input, id), toolResult(id, output, toolUseResult)]; }
function write(file) { return call("Write", { file_path: file, content: "x" }, `File created successfully at: ${file}`); }
function edit(file) { return call("Edit", { file_path: file, old_string: "a", new_string: "b" }, "updated"); }
function bash(command, output = "") { return call("Bash", { command }, output, { stdout: output, stderr: "", interrupted: false }); }
function marker() { return bash(MARKER_CMD, MARKER_OUT); }
// The file marker holds the typed record. `body` is spread, so a test can write
// a malformed one (the legacy {"summary": …} included) to exercise refusal.
const CONVERGED_RECORD = { outcome: "converged", rounds: 1, fixed: 0, dismissed: 0, open: 0 };
function writeMarker(body = CONVERGED_RECORD, dir = SCRATCH) {
  return call("Write", { file_path: `${dir}/self-review/CONVERGED.json`, content: JSON.stringify(body) }, `File created successfully at: ${dir}/self-review/CONVERGED.json`);
}
// A plugin reviewer, launched and completed. `outcome=converged` requires one
// behind it (F10a′ ruling 2), so every fixture that marks converged and expects
// the turn to end carries this BETWEEN the change and the marker — the gate
// wants `lastChange < completion < marker`. Defined here, used from tests that
// run long after `launch`/`notification` below have been evaluated.
let rvSeq = 0;
const reviewed = () => { const id = `rv${++rvSeq}`; return [...launch(id), notification(id)]; };
function agent(toolStats) {
  const id = `ag${++seq}`;
  return [toolUse("Agent", { prompt: "do things", subagent_type: "general-purpose" }, id),
    toolResult(id, "done", { agentId: "a1", agentType: "general-purpose", status: "completed", toolStats })];
}

function run(entries, { env = {}, payload = {}, gate = GATE } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "srg-"));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, entries.flat().map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  // Every run gets its own log dir. The gate APPENDS its marker log there, so
  // the default one is the developer's real `~/.claude/self-review/log.jsonl`
  // and a shared one lets cases read each other's lines.
  const childEnv = { ...process.env, SELF_REVIEW_LOG_DIR: path.join(dir, "log") };
  delete childEnv.SELF_REVIEW_GATE; // the suite must not inherit a disabled gate
  Object.assign(childEnv, env);
  const res = spawnSync(process.execPath, [gate], {
    input: JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: PROJECT, hook_event_name: "Stop", stop_hook_active: false, ...payload }),
    env: childEnv, encoding: "utf8",
  });
  assert.equal(res.status, 0, `gate must exit 0, stderr: ${res.stderr}`);
  return { stdout: res.stdout.trim(), json: res.stdout.trim() ? JSON.parse(res.stdout) : null, stderr: res.stderr };
}

const turn = (...body) => [human("do the thing"), ...body, said("done")];
const blocks = (r) => r.json?.decision === "block";

test("a turn with no file changes passes silently", () => {
  const r = run(turn(bash("ls -la", "a b c"), bash("git status", "clean")));
  assert.equal(r.stdout, "");
});

test("Write without a converged marker blocks, naming the file", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`)));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /\[self-review-gate\]/);
  assert.match(r.json.reason, /src\/a\.ts/);
  assert.match(r.json.reason, /skill "self-review(:self-review)?"/);
  assert.match(r.json.reason, /converged\.sh/);
});

test("prose, config and data files are not gated: .md, .json, .yaml, .toml, .txt, .csv, .png", () => {
  for (const file of ["README.md", "settings.json", "ci.yaml", "pyproject.toml", "notes.txt", "data.csv", "logo.png"]) {
    assert.equal(run(turn(...write(`${PROJECT}/${file}`))).stdout, "", file);
    assert.equal(run(turn(...edit(`${PROJECT}/docs/${file}`))).stdout, "", file);
  }
});

test("code files of any extension, and files without one, are gated", () => {
  for (const file of ["hook.mjs", "app.py", "index.html", "style.css", "build.sh", "Makefile", "bin/deploy"]) {
    assert.ok(blocks(run(turn(...write(`${PROJECT}/${file}`)))), file);
  }
});

test("dotfile config names are matched by basename: .env and .gitignore pass; .zshrc and .env.local (unknown) are gated", () => {
  assert.equal(run(turn(...write(`${PROJECT}/.env`))).stdout, "");
  assert.equal(run(turn(...write(`${PROJECT}/.gitignore`))).stdout, "");
  assert.ok(blocks(run(turn(...write(`${PROJECT}/.zshrc`)))));
  assert.ok(blocks(run(turn(...write(`${PROJECT}/.env.local`)))));
});

test("cp/mv/ln/install/rsync count every operand, source included: over-inclusive fails toward a review", () => {
  assert.equal(run(turn(bash(`mv ${PROJECT}/a.md ${PROJECT}/b.md`))).stdout, "");
  assert.match(run(turn(bash(`cp ${PROJECT}/a.mjs ${PROJECT}/docs/a.md`))).json.reason, /Changed: a\.mjs ·/);
  assert.match(run(turn(bash(`cp ${PROJECT}/a.md ${PROJECT}/lib/a.mjs`))).json.reason, /Changed: lib\/a\.mjs ·/);
  assert.match(run(turn(bash(`rm ${PROJECT}/a.mjs ${PROJECT}/b.md`))).json.reason, /Changed: a\.mjs ·/);
  assert.ok(blocks(run(turn(bash(`mv -t ${PROJECT}/dir ${PROJECT}/a.mjs ${PROJECT}/b.md`)))));
  assert.match(run(turn(bash(`ln -s ${PROJECT}/a.mjs ${PROJECT}/b.md`))).json.reason, /Changed: a\.mjs ·/);
  assert.match(run(turn(bash(`install -m 0644 ${PROJECT}/a.mjs ${PROJECT}/b.md`))).json.reason, /Changed: a\.mjs ·/);
  assert.match(run(turn(bash(`rsync -t ${PROJECT}/a.mjs ${PROJECT}/b.md`))).json.reason, /Changed: a\.mjs ·/);
});

test("a directory operand is never exempt by its name; an unknowable write blocks without naming an exempt file", () => {
  assert.ok(blocks(run(turn(bash(`cp -r ${PROJECT}/a ${PROJECT}/site.json/`)))));
  // The unknowable write still blocks — that has never been in question. What
  // changed 2026-09-02 is what it is allowed to call the change: this used to
  // name `b.md`, and a name is what the refusal reports as the reason. Naming a
  // file the gate exempts everywhere else made prose-only turns read as code
  // turns, which is the defect F7 closed for the resolve-nothing case and this
  // closes for the resolve-something-exempt case. With no repository to ask,
  // "could not determine which files" is the honest answer; with one, the git
  // evidence names the real artifact (see the F7 block).
  const r = run(turn(bash(`cp ${PROJECT}/a.md ${PROJECT}/b.md && python3 -c "import shutil; shutil.copy('x','y')"`)));
  assert.ok(blocks(r));
  assert.doesNotMatch(r.json.reason, /b\.md/);
  assert.match(r.json.reason, /could not determine which files/);
});

test("a Bash write to a prose file passes; the same write to a script blocks; a mixed write names only the code", () => {
  assert.equal(run(turn(bash(`cat > ${PROJECT}/CHANGELOG.md <<'EOF'\n- x\nEOF`))).stdout, "");
  assert.ok(blocks(run(turn(bash(`cat > ${PROJECT}/run.sh <<'EOF'\necho\nEOF`)))));
  const mixed = run(turn(bash(`cp a.mjs ${PROJECT}/lib/a.mjs && cp a.md ${PROJECT}/docs/a.md`)));
  assert.ok(blocks(mixed));
  assert.match(mixed.json.reason, /lib\/a\.mjs/);
  assert.doesNotMatch(mixed.json.reason, /docs\/a\.md/);
});

test("Edit, MultiEdit and NotebookEdit all count as changes", () => {
  for (const [name, input] of [
    ["Edit", { file_path: `${PROJECT}/a.py` }],
    ["MultiEdit", { file_path: `${PROJECT}/b.py`, edits: [] }],
    ["NotebookEdit", { notebook_path: `${PROJECT}/c.ipynb` }],
  ]) {
    const id = `t${++seq}`;
    assert.ok(blocks(run(turn(toolUse(name, input, id), toolResult(id, "ok")))), name);
  }
});

test("a converged marker after the last change releases the turn", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...marker()));
  assert.equal(r.stdout, "");
});

test("an edit after the marker re-arms the gate", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...marker(), ...edit(`${PROJECT}/src/b.ts`)));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /src\/b\.ts/);
});

test("printing the marker script is not a marker (a mention is not an invocation)", () => {
  // Uses the real script source: it must keep assembling the token at runtime.
  const source = readFileSync(CONVERGED_SH, "utf8");
  assert.doesNotMatch(source, /SELF-REVIEW CONVERGED/);
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(`cat ${CONVERGED_Q}`, source)));
  assert.ok(blocks(r));
});

test("mentioning the marker script is not a marker: it must be invoked at command position", () => {
  const token = "SELF-REVIEW CONVERGED — rounds=1";
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(`echo 'run self-review/scripts/converged.sh next'; echo '${token}'`, `run self-review/scripts/converged.sh next\n${token}`)))));
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash("grep -rn self-review/scripts/converged.sh ~/.claude/skills", `SKILL.md:12: ${token}`)))));
  const invoked = run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(`cd ~/.claude && ${CONVERGED_Q} "rounds=1"`, token)));
  assert.equal(invoked.json, null);
});

test("a marker is found after a data heredoc whose prose holds an apostrophe", () => {
  const ledgerThenMarker = `cat >> /tmp/scratch/ledger.md <<'EOF'\n- r3-1 · the variable's final value\nEOF\n${MARKER_CMD}`;
  assert.ok(!blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...bash(ledgerThenMarker, MARKER_OUT)))));
});

test("a quoted sed expression is not a path operand; a quoted target with spaces is one", () => {
  const scratch = run(turn(bash(`sed -i '' 's/by default (Opus for tier L)/at every tier (Opus for the G\\/H finders)/; s/all 39 pass/all 52 pass/' "/tmp/scratch/intent.md"`, "")));
  assert.ok(!blocks(scratch));
  const real = run(turn(bash(`sed -i '' 's/a b/c d/' "${PROJECT}/src/a b.ts"`, "")));
  assert.ok(blocks(real));
  assert.match(real.json.reason, /a b\.ts/);
  assert.doesNotMatch(real.json.reason, /c d/);
});

test("the marker is recognised behind an assignment, time, sudo, or bash -c", () => {
  const ABS = CONVERGED_Q;
  const forms = [
    `SUMMARY="rounds=1 fixed=0" ${ABS} "$SUMMARY"`,
    `time ${ABS} "rounds=1"`,
    `sudo ${ABS} "rounds=1"`,
    `sudo -u root ${ABS} "rounds=1"`,
    `env FOO=1 ${ABS} "rounds=1"`,
    `(${ABS} "rounds=1")`,
    `bash -c "${ABS} 'rounds=1'"`,
    `cat >> /tmp/scratch/ledger.md <<'EOF'\r\n- the variable's final value\r\nEOF\r\n${ABS} "rounds=1"`, // CRLF heredoc
  ];
  for (const form of forms) assert.ok(!blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...bash(form, MARKER_OUT)))), form);
});

test("a marker beside a change in the same message does not clear the gate, and the reason says so", () => {
  const id = `m${++seq}`;
  const both = {
    type: "assistant", uuid: `a${seq}`, timestamp: stamp(),
    message: { role: "assistant", content: [
      { type: "tool_use", id: `w${seq}`, name: "Write", input: { file_path: `${PROJECT}/src/a.ts`, content: "x" } },
      { type: "tool_use", id, name: "Bash", input: { command: MARKER_CMD } },
    ] },
  };
  const r = run([human("go"), both, toolResult(`w${seq}`, "ok"), toolResult(id, MARKER_OUT, { stdout: MARKER_OUT, stderr: "" }), said("done")]);
  assert.ok(blocks(r));
  assert.match(r.json.reason, /same message/);
});

test("redirect and tee targets keep their spaces; a substitution's redirect is listed once", () => {
  const spaced = run(turn(bash(`echo hi > "${PROJECT}/my notes.sh" && echo x | tee "${PROJECT}/log file.sh"`, "")));
  assert.match(spaced.json.reason, /my notes\.sh, .*log file\.sh/);
  const nested = run(turn(bash(`x=$(cat a > ${PROJECT}/b)`, "")));
  assert.match(nested.json.reason, /Changed: b ·/);
});

test("sed's script is skipped positionally whatever its shape", () => {
  const cases = [`sed -i '' '/^#/d' ${PROJECT}/notes.sh`, `sed -i -e '1,3d' -e 's/a/b/' ${PROJECT}/notes.sh`, `sed --in-place=.bak '10q' ${PROJECT}/notes.sh`];
  for (const c of cases) {
    const r = run(turn(bash(c, "")));
    assert.match(r.json.reason, /Changed: notes\.sh ·/, c);
  }
});

test("a 100k-character quoted command is classified in well under a second", () => {
  const long = `sed -i '' 's/a/b/' "${PROJECT}/${"x".repeat(100_000)}.sh"`;
  const started = Date.now();
  assert.ok(blocks(run(turn(bash(long, "")))));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test("writes hidden in shell wrappers are seen: bash -c, a leading assignment, backticks, $'…', heredoc in $( … )", () => {
  const cases = [
    `bash -c "rm ${PROJECT}/important.sh"`,
    `sh -c "echo x > ${PROJECT}/f.sh"`,
    `X=1 rm ${PROJECT}/important.sh`,
    `FORCE=1 cp ${PROJECT}/a ${PROJECT}/b`,
    "echo `cp " + PROJECT + "/a " + PROJECT + "/b`",
    `echo $'it\\'s fine' ; rm ${PROJECT}/important.sh`,
    `X=$(python3 - <<'EOF'\nopen('${PROJECT}/x.py','w').write('a')\nEOF\n)`,
    `X=$(bash <<'EOF'\nrm ${PROJECT}/important.sh\nEOF\n)`,
  ];
  for (const c of cases) assert.ok(blocks(run(turn(bash(c, "")))), c);
  assert.ok(!blocks(run(turn(bash(`echo $'it\\'s fine' ; ls ${PROJECT}`, "")))));
  assert.ok(!blocks(run(turn(bash("echo `date` > /tmp/scratch/now.txt", "")))));
});

test("a redirect target ending in a parenthesis keeps it; a subshell's closer is not part of the target", () => {
  const named = run(turn(bash(`echo x > "${PROJECT}/notes (copy)"`, "")));
  assert.match(named.json.reason, /notes \(copy\)/);
  const sub = run(turn(bash(`(echo x > ${PROJECT}/out.sh)`, "")));
  assert.match(sub.json.reason, /Changed: out\.sh ·/);
});

test("writes behind a wrapper flag that takes a value, env, a subshell paren, or an apostrophe inside double quotes are seen", () => {
  const cases = [
    `sudo -u www-data rm ${PROJECT}/important.sh`,
    `sudo -Eu root rm ${PROJECT}/important.sh`,
    `env X=1 rm ${PROJECT}/important.sh`,
    `find ${PROJECT} -name '*.tmp' | xargs -I {} rm {}`,
    `sudo -u root bash -c "rm ${PROJECT}/important.sh"`,
    `(rm ${PROJECT}/important.sh)`,
    `{ rm ${PROJECT}/important.sh; }`,
    `echo "it's $(rm ${PROJECT}/important.sh)"`,
    `echo "say \\"it's\\" $(rm ${PROJECT}/important.sh)"`,
    `sudo -u root python3 - <<'EOF'\nopen('${PROJECT}/x.py','w').write('a')\nEOF`,
  ];
  for (const c of cases) assert.ok(blocks(run(turn(bash(c, "")))), c);
  const reads = [`sudo -u www-data ls ${PROJECT}`, `echo "it's $(ls ${PROJECT})"`, `xargs -I {} ls {} < /dev/null`];
  for (const c of reads) assert.ok(!blocks(run(turn(bash(c, "")))), c);
});

test("a cd inside a subshell resolves the write's relative path against that directory", () => {
  const r = run(turn(bash(`(cd ${PROJECT}/sub && rm real.sh)`, "")));
  assert.match(r.json.reason, /Changed: sub\/real\.sh ·/);
  assert.ok(!blocks(run(turn(bash(`(cd /tmp/scratch && echo x > notes.sh)`, "")))));
});

test("a failed marker run (no token) does not release", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(MARKER_CMD, "usage: converged.sh <summary>")));
  assert.ok(blocks(r));
});

test("writes confined to scratch/tmp/runtime-state paths are ignored", () => {
  const r = run(turn(
    ...write("/private/tmp/claude-501/abc/scratchpad/notes.md"),
    ...write(path.join(tmpdir(), "x.txt")),
    ...write(atHome(".claude/plans/plan.md")),
    ...write(atHome(".claude/projects/x/y.jsonl")),
    ...bash("mkdir -p /tmp/work && ls > /tmp/work/out.sh", ""),
  ), { env: HOME_ENV });
  assert.equal(r.stdout, "");
});

test("scratch writes through a same-command variable or a cd into scratch are recognised as scratch", () => {
  assert.equal(run(turn(bash(`S=/private/tmp/claude-501/x/scratchpad; mkdir -p "$S"; strings /usr/bin/true > "$S/out.sh"`, ""))).stdout, "");
  assert.equal(run(turn(bash(`cd /tmp/scopetest && git init -q && printf 'a\\n' > tracked.txt`, ""))).stdout, "");
});

test("quoted text with a nested $( … ) substitution is not read as a redirect", () => {
  const nested = `echo "n: $(jq -r 'select(.a=="u") | select(startswith("<task-notification>"))' f | grep -c x)"`;
  assert.equal(run(turn(bash(nested, "n: 1"))).stdout, "");
  const probe = `S=/private/tmp/claude-501/x/scratchpad; printf '%s\\n' "{\\"cmd\\":$(jq -Rs . <<<"$1")}" > "$S/probe.jsonl"; rm -f "$S/probe.jsonl"`;
  assert.equal(run(turn(bash(probe, ""))).stdout, "");
  assert.ok(blocks(run(turn(bash(`x=$(cat a > ${PROJECT}/b)`, "")))));
});

test("relative targets resolve against the session cwd", () => {
  const r = run(turn(bash(`printf 'x' > notes.py`, "")));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /notes\.py/);
  assert.equal(run(turn(bash(`printf 'x' > notes.py`, "")), { payload: { cwd: "/tmp/elsewhere" } }).stdout, "");
});

test("the block reason names the files a shell write targets", () => {
  const r = run(turn(bash(`cat > ${PROJECT}/src/guide.py <<'EOF'\n# hi\nEOF`, "")));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /src\/guide\.py/);
  assert.match(r.json.reason, /1 shell command/);
  const sed = run(turn(bash(`sed -i '' '12,14d' src/gate.mjs && cp src/a.ts src/b.ts`, "")));
  assert.match(sed.json.reason, /src\/gate\.mjs, src\/a\.ts, src\/b\.ts/); // every cp operand counts
});

test("code under ~/.claude (hooks, skill scripts) counts; its prose (SKILL.md, CLAUDE.md) does not", () => {
  assert.ok(blocks(run(turn(...write(atHome(".claude/hooks/gate.mjs"))), { env: HOME_ENV })));
  assert.ok(blocks(run(turn(...write(atHome(".claude/skills/foo/scripts/run.sh"))), { env: HOME_ENV })));
  assert.equal(run(turn(...write(atHome(".claude/skills/foo/SKILL.md"))), { env: HOME_ENV }).stdout, "");
  assert.equal(run(turn(...write(atHome(".claude/CLAUDE.md"))), { env: HOME_ENV }).stdout, "");
});

test("shell commands that write files block: heredoc, sed -i, tee, cp/mv/rm, python open(w)", () => {
  const cases = [
    `cat > ${PROJECT}/setup.sh <<'EOF'\n# hi\nEOF`,
    `sed -i '' 's/a/b/' ${PROJECT}/src/a.ts`,
    `sed -e 's/x/y/' -i ${PROJECT}/src/a.ts`,
    `echo hi | tee ${PROJECT}/out.js`,
    `cp ${PROJECT}/a ${PROJECT}/b`,
    `cd ${PROJECT} && mv a b`,
    `rm ${PROJECT}/old.ts`,
    `git rm ${PROJECT}/old.ts`,
    `python3 -c "open('${PROJECT}/x.py','w').write('a')"`,
    `node -e "require('fs').writeFileSync('${PROJECT}/x.json','{}')"`,
    `echo 'x=1' >> ${PROJECT}/env.sh`,
    `cd ${PROJECT} && npm install left-pad`,
    `cd ${PROJECT} && cargo add serde`,
    `python3 - <<'EOF'\nopen('${PROJECT}/gen.py','w').write('x')\nEOF`, // code body fed to an interpreter
    `bash <<'EOF'\ncd ${PROJECT}\nprintf 'x' > generated.sh\nEOF`, // shell body is analysed as shell
    `printf "a\\nb\\n" > ${PROJECT}/x.sh`, // a backslash inside double quotes must not shift the quote scan
    `echo "he said \\"hi\\"" > ${PROJECT}/note.sh`,
  ];
  for (const c of cases) assert.ok(blocks(run(turn(bash(c, "")))), c);
});

test("read-only shell commands do not block", () => {
  const cases = [
    `grep -rn ">" ${PROJECT}/src`,
    `python3 -c "print(\\"a > b\\")"`, // an escaped quote does not end the string
    `jq '.count > 1' ${PROJECT}/data.json`,
    `npm test 2>&1 | tail -20`,
    `make build >/dev/null 2>&1; echo $?`,
    `git diff HEAD; git log --oneline -5`,
    `docker run --rm node:22 node -v`,
    `awk '$3 > 100' ${PROJECT}/stats.txt`,
    `sed -n '1,40p' ${PROJECT}/src/a.ts`,
    `echo "done" >&2`,
    `cd ${PROJECT} && npm install`,
    `python3 -c "print(open('${PROJECT}/x.txt').read())"`,
    `cat <<'EOF'\nif a > b: open('f','w')\nEOF`,
    `cat > /tmp/scratch/run.sh <<'EOF'\nsed -i 's/a/b/' ${PROJECT}/x\nEOF`, // data body mentioning sed -i, scratch target
    `for c in "python3 -c \\"open('${PROJECT}/x','w')\\"" "mv a b"; do echo "$c"; done`, // quoted test data, not executed code
    `python3 - <<'EOF'\nimport tempfile\nf = tempfile.NamedTemporaryFile("w"); f.write("x")\nEOF`, // tempfile is not a project write
  ];
  for (const c of cases) assert.equal(run(turn(bash(c, ""))).stdout, "", c);
});

test("a subagent that edited files counts; a read-only subagent does not", () => {
  assert.ok(blocks(run(turn(...agent({ readCount: 3, editFileCount: 2, linesAdded: 10, linesRemoved: 1 })))));
  assert.equal(run(turn(...agent({ readCount: 9, editFileCount: 0, linesAdded: 0, linesRemoved: 0 }))).stdout, "");
});

test("changes from an earlier turn do not count against the current one", () => {
  const r = run([human("first"), ...write(`${PROJECT}/a.ts`), said("ok"), human("now just explain it"), said("explanation")]);
  assert.equal(r.stdout, "");
});

test("a compaction summary is not a turn boundary", () => {
  const r = run([human("do it"), ...write(`${PROJECT}/a.ts`), compactSummary(), said("continuing… done")]);
  assert.ok(blocks(r));
});

test("sidechain (subagent) entries in the file are ignored", () => {
  const side = write(`${PROJECT}/a.ts`).map((e) => ({ ...e, isSidechain: true }));
  assert.equal(run(turn(...side)).stdout, "");
});

test("an interrupted turn is not gated", () => {
  const r = run([human("do it"), ...write(`${PROJECT}/a.ts`), interrupted()]);
  assert.equal(r.stdout, "");
});

test("second reminder is labelled; after the cap the gate releases with a notice", () => {
  const second = run(turn(...write(`${PROJECT}/a.ts`), gateFeedback(), said("forgot")));
  assert.ok(blocks(second));
  assert.match(second.json.reason, /Second reminder/);
  const released = run(turn(...write(`${PROJECT}/a.ts`), gateFeedback(), said("x"), gateFeedback(), said("y")));
  assert.equal(released.json?.decision, undefined);
  assert.match(released.json.systemMessage, /released/);
});

test("reminders before a marker do not count toward the cap", () => {
  const r = run(turn(...write(`${PROJECT}/a.ts`), gateFeedback(), gateFeedback(), ...marker(), ...edit(`${PROJECT}/b.ts`)));
  assert.ok(blocks(r));
  assert.doesNotMatch(r.json.reason, /Second reminder/);
});

test("SELF_REVIEW_GATE=off disables the gate", () => {
  const r = run(turn(...write(`${PROJECT}/a.ts`)), { env: { SELF_REVIEW_GATE: "off" } });
  assert.equal(r.stdout, "");
});

test("malformed lines are skipped; a missing transcript is tolerated", () => {
  const r = run([human("go"), "{not json", ...write(`${PROJECT}/a.ts`), said("done")]);
  assert.ok(blocks(r));
  const missing = run([], { payload: { transcript_path: "/nonexistent/t.jsonl" } });
  assert.equal(missing.stdout, "");
});

test("a block also carries a short systemMessage for the terminal", () => {
  const r = run(turn(...write(`${PROJECT}/a.ts`)));
  assert.match(r.json.systemMessage, /self-review gate/);
});

// ---------- in-flight agents ----------

const LAUNCHED = (agentId) =>
  `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background.`;
function launch(agentId, subagent_type = "self-review-finder") {
  return call("Agent", { prompt: "review this", subagent_type, description: "finder" }, LAUNCHED(agentId));
}
const notification = (agentId, status = "completed") => ({
  type: "user", userType: "external", promptId: `p${++seq}`, timestamp: stamp(),
  message: { role: "user", content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Agent "finder" finished</summary>\n<result>[]</result>\n</task-notification>` },
});
const taskStop = (agentId) => call("TaskStop", { task_id: agentId }, `{"message":"Successfully stopped task: ${agentId}"}`);

test("a launched subagent that has not reported releases the stop with a notice", () => {
  const r = run(turn(write(`${PROJECT}/a.js`), launch("ag1"), launch("ag2")));
  assert.ok(!blocks(r));
  assert.match(r.json.systemMessage, /2 subagent\(s\) still running/);
});

test("once every launched subagent has notified, the gate blocks again", () => {
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...launch("ag1"), ...launch("ag2"), said("waiting"),
    notification("ag1"), said("one more"), notification("ag2", "failed"), said("done")]);
  assert.ok(blocks(r));
});

test("a TaskStop'd subagent is not pending", () => {
  const r = run(turn(write(`${PROJECT}/a.js`), launch("ag1"), taskStop("ag1")));
  assert.ok(blocks(r));
});

test("a task notification is not a turn boundary: changes before it still gate", () => {
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...launch("ag1"), said("waiting"), notification("ag1"), said("done, nothing to fix")]);
  assert.ok(blocks(r));
  assert.match(r.json.reason, /a\.js/);
});

test("a review launched before a human interjection is still pending, not hidden by the boundary", () => {
  // Finders launched last turn; the user interjects mid-review and the interjection
  // turn makes its own change. The finders are still running, so the gate must
  // release (wait), not block on the interjection's change.
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...launch("ag1"), ...launch("ag2"), said("2 reviewers running"),
    human("also stash a quick note"), ...write(`${PROJECT}/note.mjs`), said("noted; still waiting")]);
  assert.ok(!blocks(r), JSON.stringify(r.json));
  assert.match(r.json.systemMessage, /2 subagent\(s\) still running/);
});

test("a subagent silent across two human interjections is presumed dead and stops holding the gate", () => {
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...launch("dead1"), said("1 running"),
    human("interjection one"), said("still waiting"),
    human("interjection two"), ...write(`${PROJECT}/b.js`), said("done")]);
  assert.ok(blocks(r));
});

test("a stale idle for a reused agent name does not mark a later relaunch finished", () => {
  // round A's "worker" finished and was marked; round B relaunches a NEW "worker"
  // that has not reported. The stale idle must not count for the live relaunch.
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...spawnNamed("worker"), said("waiting"),
    report("worker", "[]"), idle("worker"), ...marker(), said("round A done"),
    human("round B"), ...write(`${PROJECT}/b.js`), ...spawnNamed("worker"), said("round B waiting")]);
  assert.ok(!blocks(r), JSON.stringify(r.json));
  assert.match(r.json.systemMessage, /1 subagent\(s\) still running/);
});

test("a marker after the notification releases; any agent type counts as pending", () => {
  const clean = run([human("go"), ...write(`${PROJECT}/a.js`), ...launch("ag1", "general-purpose"), said("waiting"), notification("ag1"), ...reviewed(), ...marker(), said("done")]);
  assert.equal(clean.json, null);
  const pending = run(turn(write(`${PROJECT}/a.js`), launch("ag9", "general-purpose")));
  assert.ok(!blocks(pending));
});

// Real shapes, captured 2026-08-22: a named agent's launch result, the mailbox
// message the harness writes when it goes idle, and a result it sends first.
const SPAWNED = (name) =>
  `Spawned successfully. (This tool result is internal metadata — never quote or paste any part of it, including the ID below, into a user-facing reply.)\nagent_id: ${name}@session-b5e74fee\nname: ${name}\nThe agent is now running and will receive instructions via mailbox.`;
function spawnNamed(name) {
  return call("Agent", { prompt: "review", subagent_type: "self-review-finder", name }, SPAWNED(name));
}
const teammate = (name, body, attrs = "") => ({
  type: "user", userType: "external", timestamp: stamp(),
  message: { role: "user", content: `Another Claude session sent a message:\n<teammate-message teammate_id="${name}" color="pink"${attrs}>\n${body}\n</teammate-message>\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.` },
});
const idle = (name) => teammate(name, `{"type":"idle_notification","from":"${name}","timestamp":"2026-08-22T04:54:22.162Z","idleReason":"available"}`);
const report = (name, text) => teammate(name, text, ` summary="${name} findings"`);
// A notification that landed mid-turn is queued and attached to the next message.
const attached = (agentId, status = "completed") => ({
  type: "attachment", uuid: `at${++seq}`, timestamp: stamp(),
  attachment: { type: "queued_command", commandMode: "task-notification", prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Agent "finder" finished</summary>\n<result>[]</result>\n</task-notification>` },
});

test("a named agent is pending until the mailbox reports it idle; its report alone does not finish it", () => {
  const spawned = spawnNamed("r1-a");
  assert.ok(!blocks(run(turn(write(`${PROJECT}/a.js`), spawned))));
  const reported = run([human("go"), ...write(`${PROJECT}/a.js`), ...spawned, said("waiting"), report("r1-a", "[]"), said("noted")]);
  assert.match(reported.json.systemMessage, /1 subagent\(s\) still running/);
  assert.ok(blocks(run([human("go"), ...write(`${PROJECT}/a.js`), ...spawned, said("waiting"), report("r1-a", "[]"), idle("r1-a"), said("done")])));
});

test("several idle notifications delivered in one message finish every agent they name", () => {
  const bundle = human([report("r1-a", "[]").message.content, idle("r1-a").message.content, idle("r1-b").message.content].join("\n\n"));
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...spawnNamed("r1-a"), ...spawnNamed("r1-b"), ...spawnNamed("r1-c"), said("waiting"), bundle, said("two in")]);
  assert.match(r.json.systemMessage, /1 subagent\(s\) still running/);
});

test("a variable reassigned later in the command does not rewrite an earlier redirect's target", () => {
  const r = run(turn(bash(`X=${PROJECT}/real.sh; echo data > $X; X=/tmp/scratch/a; echo other > $X`, "")));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /real\.sh/);
});

test("a writer inside a command substitution is seen, bare or double-quoted", () => {
  const cases = [
    `echo hello $(cp ${PROJECT}/a ${PROJECT}/b)`,
    `RESULT=$(mv ${PROJECT}/a ${PROJECT}/b)`,
    `echo "$(rm ${PROJECT}/old.ts)"`,
    `echo hi $(python3 -c "open('${PROJECT}/x.py','w').write('a')")`,
  ];
  for (const c of cases) assert.ok(blocks(run(turn(bash(c, "")))), c);
  assert.ok(!blocks(run(turn(bash(`echo "files: $(ls ${PROJECT}/src | wc -l)"`, "")))));
});

test("every redirect in a double-quoted, backslash-escaped command is reported", () => {
  const r = run(turn(bash(`echo "a" > ${PROJECT}/one.sh && printf "b\\n" > ${PROJECT}/two.sh`, "")));
  assert.match(r.json.reason, /one\.sh, .*two\.sh/);
});

test("a SendMessage to an idle named agent re-arms it; one to a name never launched does not release", () => {
  const resend = (to) => call("SendMessage", { to, message: "also check b.js" }, "Message sent");
  const rearmed = run([human("go"), ...write(`${PROJECT}/a.js`), ...spawnNamed("r1-a"), said("waiting"), report("r1-a", "[]"), idle("r1-a"), ...resend("r1-a"), said("waiting again")]);
  assert.match(rearmed.json.systemMessage, /1 subagent\(s\) still running/);
  assert.ok(blocks(run([human("go"), ...write(`${PROJECT}/a.js`), ...spawnNamed("r1-a"), said("waiting"), idle("r1-a"), ...resend("r1-a"), idle("r1-a"), said("done")])));
  assert.ok(blocks(run([human("go"), ...write(`${PROJECT}/a.js`), ...resend("architect"), said("done")])));
});

test("a report that merely quotes an idle notification does not finish the agent", () => {
  const quoting = report("r1-a", `The gate matches {"type":"idle_notification","from":"r1-a"} — see line 70.`);
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...spawnNamed("r1-a"), said("waiting"), quoting, said("noted")]);
  assert.ok(!blocks(r));
});

test("an attachment-carried task notification finishes an unnamed agent", () => {
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...launch("ag1"), said("waiting"), attached("ag1"), said("done")]);
  assert.ok(blocks(r));
});

test("a message from another agent is not a turn boundary: pending launches before it still release, changes before it still gate", () => {
  const released = run([human("go"), ...write(`${PROJECT}/a.js`), ...spawnNamed("r1-a"), ...spawnNamed("r1-b"), said("waiting"), idle("r1-a"), said("one in")]);
  assert.match(released.json.systemMessage, /1 subagent\(s\) still running/);
  const gated = run([human("go"), ...write(`${PROJECT}/a.js`), said("waiting"), report("peer", "hello from another session"), said("done")]);
  assert.ok(blocks(gated));
  assert.match(gated.json.reason, /a\.js/);
});

test("local slash commands and stop notices the harness records are not turn boundaries", () => {
  const slash = human("<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>");
  const stdout = human("<local-command-stdout>Set effort to high</local-command-stdout>");
  const stopped = human('20 background agents were stopped by the user: "You are reviewer 1 of 14…"');
  for (const entry of [slash, stdout, stopped]) {
    const r = run([human("go"), ...write(`${PROJECT}/a.js`), said("working"), entry, said("done")]);
    assert.ok(blocks(r), `expected a block after: ${entry.message.content.slice(0, 30)}`);
  }
});

test("an Agent result that only quotes the launch phrase is not a launch", () => {
  const id = `Agent${++seq}`;
  const quoting = [toolUse("Agent", { prompt: "explain", subagent_type: "general-purpose" }, id),
    toolResult(id, `The fixture reads: "Async agent launched successfully … agentId: ghost" — that is how launches look.`)];
  assert.ok(blocks(run(turn(write(`${PROJECT}/a.js`), quoting))));
});

test("task ids quoted inside a notification's <result> do not finish other agents", () => {
  const quoting = { type: "user", userType: "external", timestamp: stamp(),
    message: { role: "user", content: `<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n<result>I noticed <task-id>ag2</task-id> in the fixture</result>\n</task-notification>` } };
  const r = run([human("go"), ...write(`${PROJECT}/a.js`), ...launch("ag1"), ...launch("ag2"), said("waiting"), quoting, said("one in")]);
  assert.match(r.json.systemMessage, /1 subagent\(s\) still running/);
});

test("a synchronous Agent result (no launch text) is not pending", () => {
  const r = run(turn(write(`${PROJECT}/a.js`), agent({ editFileCount: 0 })));
  assert.ok(blocks(r));
});

test("the block reason names the allow-listed absolute marker command and says how to wait", () => {
  const r = run(turn(write(`${PROJECT}/a.js`)));
  assert.match(r.json.reason, new RegExp(CONVERGED_SH));
  assert.match(r.json.reason, /scripts\/wait\.mjs/);
  assert.doesNotMatch(r.json.reason, /END YOUR TURN/,
    "the gate must not still teach the wait the skill retired");
});

test("the unreviewed reason's spawn advice says how to wait, like the block reason does", () => {
  // Round 1 rewrote blockReason() and pinned it; this second copy of the same
  // advice went on telling the model to end the turn for another whole release.
  // One assertion per message, because one assertion covered one message.
  const r = run(turn(...write(`${PROJECT}/a.js`), ...marker()));
  assert.match(r.json.reason, /outcome=converged claims a review ran/,
    "the fixture must reach unreviewedReason(), or the assertion below passes vacuously");
  assert.doesNotMatch(r.json.reason, /END YOUR TURN/,
    "every wait instruction in this hook must point at wait.mjs");
});

// ---------- converged claims a reviewer ran (F10a-prime ruling 2) ----------
//
// `outcome=converged` says an independent reader looked at the final state, so
// the gate refuses it unless a plugin reviewer COMPLETED after the last change
// and before the marker. Both bounds are tested: no completion at all, and a
// completion the model then edited behind.

// Feedback carrying the refusal's own sentence — this branch is bounded by its
// own count, because a model refused here has marked, and re-marking would
// reset a since-the-marker counter forever.
const unreviewedFeedback = () => ({
  type: "user", isMeta: true, timestamp: stamp(),
  message: { role: "user", content: `Stop hook feedback:\n${GATE_TAG} The converged marker was refused: outcome=converged claims a review ran, but no plugin reviewer completed.` },
});

test("converged with no reviewer at all is refused, and the reason says what to launch", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...marker()));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /outcome=converged claims a review ran/);
  assert.match(r.json.reason, /No reviewer agent ran in this window/);
  assert.match(r.json.reason, /self-review-finder/);
  assert.match(r.json.systemMessage, /no reviewer completion after the last change/);
});

test("a verifier alone does not satisfy converged — it presupposes findings the author generated", () => {
  const r = run([human("go"), ...write(`${PROJECT}/src/a.ts`),
    ...launch("v1", "self-review:self-review-verifier"), notification("v1"), ...marker(), said("done")]);
  assert.ok(blocks(r));
  assert.match(r.json.reason, /No reviewer agent ran in this window/);
});

test("a general-purpose agent's completion does not satisfy converged, though it still counts as pending", () => {
  const r = run([human("go"), ...write(`${PROJECT}/src/a.ts`),
    ...launch("g1", "general-purpose"), notification("g1"), ...marker(), said("done")]);
  assert.ok(blocks(r));
});

test("a finder that completed BEFORE the last change is stale: the edit behind it was read by nobody", () => {
  const r = run([human("go"), ...reviewed(), ...write(`${PROJECT}/src/a.ts`), ...marker(), said("done")]);
  assert.ok(blocks(r));
  assert.match(r.json.reason, /landed after it finished: .*a\.ts/);
});

test("a finder completing between the last change and the marker releases the turn", () => {
  const r = run([human("go"), ...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...marker(), said("done")]);
  assert.equal(r.stdout, "");
});

test("the cold-run grader counts as a reviewer too", () => {
  const r = run([human("go"), ...write(`${PROJECT}/src/a.ts`),
    ...launch("x1", "self-review:self-review-cold-grader"), notification("x1"), ...marker(), said("done")]);
  assert.equal(r.stdout, "");
});

test("the plugin prefix is tolerated: a bare self-review-finder type qualifies", () => {
  const r = run([human("go"), ...write(`${PROJECT}/src/a.ts`),
    ...launch("f1", "self-review-finder"), notification("f1"), ...marker(), said("done")]);
  assert.equal(r.stdout, "");
});

test("only converged is gated — not-converged and not-applicable end the turn with no reviewer", () => {
  for (const body of [{ outcome: "not-converged", rounds: 1, fixed: 0, dismissed: 0, open: 2 },
    { outcome: "not-applicable", reason: "user-declined" }]) {
    assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...writeMarker(body))).stdout, "", JSON.stringify(body));
  }
});

test("a reviewer launched before a human interjection still counts — the window is not the turn", () => {
  // The 2026-08-22 false block, in the shape ruling 2's literal wording would
  // have reintroduced: the finder is launched, the user interjects, the change
  // and the completion land after it, and the marker follows.
  const r = run([human("start the review"), ...launch("rvX"), said("running"),
    human("any progress?"), ...write(`${PROJECT}/src/a.ts`), notification("rvX"), ...marker(), said("done")]);
  assert.equal(r.stdout, "");
});

test("a script marker whose output carries no outcome= is not gated — a block is never bought with a guess", () => {
  const legacy = "SELF-REVIEW CONVERGED — rounds=1 fixed=0 dismissed=0 open=0";
  assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(MARKER_CMD, legacy))).stdout, "");
});

test("two markers in one Bash call are read by the LAST one — the first outcome does not stand in for it", () => {
  // `converged.sh --not-applicable …; converged.sh --converged …` is ONE tool
  // result holding two token lines. Reading the first `outcome=` in the
  // combined text scored the effective `converged` as `not-applicable` and
  // released the turn with no reviewer behind it.
  const both = `SELF-REVIEW CONVERGED — outcome=not-applicable reason=user-declined\nSELF-REVIEW CONVERGED — outcome=converged rounds=1 fixed=0 dismissed=0 open=0`;
  const cmd = `${CONVERGED_Q} --not-applicable user-declined; ${CONVERGED_Q} --converged --rounds 1 --fixed 0 --dismissed 0 --open 0`;
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(cmd, both)))), "the later converged is the claim");
  // And the other order is honest: converged first, superseded by not-applicable.
  const flipped = `SELF-REVIEW CONVERGED — outcome=converged rounds=1 fixed=0 dismissed=0 open=0\nSELF-REVIEW CONVERGED — outcome=not-applicable reason=user-declined`;
  assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(cmd, flipped))).stdout, "");
});

test("an Agent call that failed to launch is not a reviewer, and does not excuse one", () => {
  // A failed dispatch (bad subagent_type, a rate limit) leaves an Agent call
  // whose result never matches LAUNCHED_RE — the same shape as a reworded
  // success. It must not release the turn: nobody reviewed.
  const id = `err${++seq}`;
  const failed = [toolUse("Agent", { prompt: "review", subagent_type: "self-review-finder" }, id),
    toolResult(id, "Error: agent type not available in this session")];
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...failed, ...marker()));
  assert.ok(blocks(r), "a failed launch is not a review");
  assert.match(r.json.reason, /No reviewer agent ran in this window/);
});

test("a reviewer that is still running releases the turn instead of asking for a second one", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...launch("rvPending"), ...marker()));
  assert.ok(!blocks(r), "ending the turn is how this loop waits");
  assert.match(r.json.systemMessage, /still running/);
});

test("a reviewer that completed AFTER the marker asks only for a re-mark, not for another finder", () => {
  const r = run([human("go"), ...write(`${PROJECT}/src/a.ts`), ...launch("rvLate"), ...marker(),
    notification("rvLate"), said("done")]);
  assert.ok(blocks(r));
  assert.match(r.json.reason, /only AFTER the marker was written/);
  assert.match(r.json.reason, /Do not launch another one/);
  assert.doesNotMatch(r.json.reason, /launch one self-review-finder/);
});

test("an unrelated agent that parses does not hide a reviewer, and does not stand in for one", () => {
  // The deleted `blind` bypass turned on whether EVERY launch failed to parse,
  // so one ordinary helper agent flipped its answer. Neither direction may
  // depend on an unrelated agent.
  const withHelper = run([human("go"), ...write(`${PROJECT}/src/a.ts`),
    ...launch("help1", "general-purpose"), notification("help1"),
    ...reviewed(), ...marker(), said("done")]);
  assert.equal(withHelper.stdout, "", "a real reviewer still counts beside a helper");
  const helperOnly = run([human("go"), ...write(`${PROJECT}/src/a.ts`),
    ...launch("help2", "general-purpose"), notification("help2"), ...marker(), said("done")]);
  assert.ok(blocks(helperOnly), "a helper is not a reviewer");
});

// ---------- the applier arms the gate (F10b) ----------
//
// An async Agent result carries no toolStats, so an applier subagent's edits
// are invisible to the main chain. The LAUNCH is the evidence: harness-written,
// in the main chain, and it cannot be silently absent. These fixtures never
// write a file — that is the whole point.

const APPLIER = "self-review:self-review-applier";
const applier = (id, type = APPLIER) => launch(id, type);

test("launching an applier arms the gate although the turn changed no file itself", () => {
  const r = run(turn(...applier("ap1"), notification("ap1")));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /applier subagent/);
});

test("an applier that is still running releases the turn, like any other subagent", () => {
  const r = run(turn(...applier("ap1")));
  assert.ok(!blocks(r));
  assert.match(r.json.systemMessage, /still running/);
});

test("a marker after the applier completed clears it", () => {
  const r = run(turn(...applier("ap1"), notification("ap1"), ...reviewed(), ...marker()));
  assert.equal(r.stdout, "", "an applier that completed, was reviewed, and was marked is done");
});

test("converged needs a reviewer that finished after the APPLIER, not after the lead's last edit", () => {
  // The anchor is completion, not launch: a finder that finished while the
  // applier was still writing read a tree that was still moving under it.
  const r = run(turn(
    ...write(`${PROJECT}/a.ts`),
    ...applier("ap1"),
    ...reviewed(),              // completes BEFORE the applier does
    notification("ap1"),
    ...marker(),
  ));
  assert.ok(blocks(r), "the finder completed before the applier's edits were a fixed set");
  assert.match(r.json.reason, /converged/i);
});

test("a reviewer that finished after the applier completed satisfies converged", () => {
  const r = run(turn(
    ...write(`${PROJECT}/a.ts`),
    ...applier("ap1"),
    notification("ap1"),
    ...reviewed(),              // completes AFTER the applier
    ...marker(),
  ));
  assert.equal(r.stdout, "");
});

test("a converged marker written while the applier is still running releases rather than passing", () => {
  // It must not read as "ok": nothing stable has been reviewed yet. It must not
  // block either — this loop waits by ending turns.
  const r = run(turn(...write(`${PROJECT}/a.ts`), ...reviewed(), ...applier("ap1"), ...marker()));
  assert.ok(!blocks(r));
  assert.match(r.json.systemMessage, /editing subagent is still running/);
});

test("the applier's arm survives a human interjection — the turn is the wrong frame for it", () => {
  // The gate releases a turn while a subagent runs so the user can type. The
  // applier's edits then land in a turn whose main chain holds nothing at all.
  const r = run([
    human("go"), ...applier("ap1"), said("dispatched, waiting"),
    human("something else"), notification("ap1"), said("it finished"),
  ]);
  assert.ok(blocks(r), "a turn-scoped scan would see no applier and no change here");
  assert.match(r.json.reason, /applier subagent/);
});

test("a marker in an EARLIER turn still clears the applier — the discharge is window-scoped too", () => {
  // The mirror of the case above, and the one a naive turn-scoped marker lookup
  // turns into a permanent false block: applied and marked in one turn, the
  // user types, and the next turn has the applier record but no local marker.
  const r = run([
    human("go"), ...applier("ap1"), notification("ap1"), ...reviewed(), ...marker(), said("done"),
    human("now something else"), said("answered, nothing written"),
  ]);
  assert.equal(r.stdout, "", "the marker is behind the applier, just in a previous turn");
});

test("an applier that never reported stays armed on its launch, and not-converged discharges it honestly", () => {
  const crashed = [human("go"), ...applier("ap1"), said("x"), human("i"), said("y"), human("ii"), said("z")];
  assert.ok(blocks(run(crashed)), "aged out of pending, but its launch still demands an answer");
  const NOT_CONV = `${CONVERGED_Q} --not-converged --rounds 1 --fixed 0 --dismissed 0 --open 1`;
  // The banner is the same for every outcome — the gate reads `outcome=` out of
  // it, not the headline — so a fixture that invents "SELF-REVIEW NOT
  // CONVERGED" tests a marker the script never prints.
  const honest = run([...crashed, ...bash(NOT_CONV, "SELF-REVIEW CONVERGED — outcome=not-converged rounds=1 fixed=0 dismissed=0 open=1")]);
  assert.equal(honest.stdout, "", "not-converged needs no reviewer behind it, so a dead applier is not a deadlock");
});

test("only the applier's own type arms: a research subagent that wrote nothing does not", () => {
  // Arming on any agent would turn every read-only spawn into a demanded
  // marker, and the read-only universe cannot be enumerated.
  for (const type of ["general-purpose", "Explore", "self-review:self-review-finder", "db-applier"]) {
    const r = run(turn(...launch(`x-${type}`, type), notification(`x-${type}`)));
    assert.equal(r.stdout, "", `${type} must not arm the gate`);
  }
});

test("the applier arms even when it reports having changed nothing", () => {
  // Deliberate: knowing what it touched would mean reading its self-report,
  // which is the manifest shape this gate does not accept. The cost is one
  // marker, which the loop was going to write anyway.
  const r = run(turn(...applier("ap1"), notification("ap1", "completed")));
  assert.ok(blocks(r));
});

test("the applier block is bounded like every other, and says what it is waiting on", () => {
  // One turn: `turn()` opens with a human prompt, so repeating it would move
  // the boundary and reset the count it is supposed to be accumulating.
  const r = run([
    human("go"), ...applier("ap1"), notification("ap1"), said("dispatched"),
    gateFeedback(), said("still nothing"), gateFeedback(), said("still nothing"),
  ]);
  assert.ok(!blocks(r));
  assert.match(r.json.systemMessage, /released/);
});

test("the refusal is bounded: after MAX_REMINDERS refusals the gate releases with a notice", () => {
  const r = run([human("go"), ...write(`${PROJECT}/src/a.ts`),
    unreviewedFeedback(), unreviewedFeedback(), ...marker(), said("done")]);
  assert.ok(!blocks(r));
  assert.match(r.json.systemMessage, /released after 2 refusals/);
});

// ---------- what round 1 of the F10b review found ----------

test("a bogus converged marker stays refused once a human prompt starts a new turn", () => {
  // The applier arms the gate over the whole WINDOW, so the marker's outcome has
  // to be read over the whole window too. Read at turn scope it came back null
  // as soon as the next turn held no marker of its own, the outcome gate
  // defaulted to "ok", and a converged claim with zero reviewers behind it
  // passed in silence. Same facts, one prompt apart — the control is the same
  // fixture without the second turn.
  const body = [...applier("ap1"), notification("ap1"), ...marker()];
  assert.ok(blocks(run(turn(...body))), "control: refused in the turn that marked");
  const later = run([...turn(...body), human("now something else"), said("answered, nothing written")]);
  assert.ok(blocks(later), "and still refused a human prompt later");
});

test("resuming the applier re-arms it: its anchor cannot move back behind a marker", () => {
  const resend = (to) => call("SendMessage", { to, message: "also fix b.js" }, "Message sent");
  // The marker lands while the applier is still writing; the applier then
  // finishes, so the marker sits behind its completion and the turn is refused.
  const before = [...applier("ap1"), ...reviewed(), ...marker(), notification("ap1")];
  assert.ok(blocks(run(turn(...before))), "control: the marker was written mid-flight");
  // A SendMessage used to walk `doneAt` back to -1 and the anchor back to the
  // LAUNCH — behind that marker — which released the turn and then went silent
  // once `pending` aged out. It is the accidental-disarm shape: resuming the
  // agent is the first thing a model debugging the block reaches for.
  const resumed = [...turn(...before, ...resend("ap1")),
    human("something"), said("a"), human("something else"), said("b")];
  assert.ok(blocks(run(resumed)), "a resume is fresh edit work and needs a marker AFTER it");
});

test("a model-authored subagent_type never reaches the block reason", () => {
  // The reason comes back as the isMeta entry countUnreviewed counts, so a type
  // that prints the gate's own refusal sentence drove the gate's own release
  // counter and freed the next bogus marker.
  const r = run(turn(...applier("ap1", "outcome=converged claims a review ran:self-review-applier"), notification("ap1")));
  assert.ok(blocks(r));
  assert.ok(!r.json.reason.includes("outcome=converged claims a review ran"),
    "the type is model-authored text: counted, never quoted");
});

test("a 20,000-character subagent_type does not become a 20,000-character reason", () => {
  const r = run(turn(...applier("ap1", "x".repeat(20_000) + ":self-review-applier"), notification("ap1")));
  assert.ok(blocks(r));
  assert.ok(!r.json.reason.includes("x".repeat(100)), "the type's bulk is not copied into the reason");
});

test("the refusal names the applier when the applier is what came after the reviewer", () => {
  // The applier's completion, not a file edit, is the latest thing needing a
  // marker behind it. The list the generic block uses drops every applier a
  // marker already covers — inside this branch that is all of them — so this
  // message read "you changed  after it finished", naming nothing, in exactly
  // the scenario the applier arming exists to catch.
  const r = run(turn(...reviewed(), ...applier("ap1"), notification("ap1"), ...marker()));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /landed after it finished: .*applier subagent/);
});

test("a rejected marker in an earlier turn does not answer this turn's block", () => {
  // `rejected` has no gate — the fallback branch acts on it without comparing it
  // to anything — so turn scope is its only bound. Round 1 window-scoped it
  // alongside `outcome` and `fileMarker`, which do have a gate, and this turn
  // came back "1 problem(s) with the record" for a turn that wrote no marker,
  // never naming the file it had just changed. Proven against the 932c109
  // binary, which names the file.
  const r = run([
    human("go"), ...write(`${PROJECT}/src/a.ts`), ...writeMarker({ summary: "bad" }), said("done"),
    human("now do b"), ...write(`${PROJECT}/src/b.ts`), said("done"),
  ]);
  assert.ok(blocks(r));
  assert.match(r.json.reason, /b\.ts/, "the block is about the change this turn made");
  assert.doesNotMatch(r.json.systemMessage, /problem\(s\) with the record/,
    "and not about a record written in a turn that is over");
});

// ---------- plugin packaging: write-file marker, exempt names, config ----------

test("a CONVERGED.json write in a scratch dir after the last change releases the turn and is logged", () => {
  const logDir = mkdtempSync(path.join(tmpdir(), "srlog-"));
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...writeMarker({ outcome: "converged", rounds: 2, fixed: 1, dismissed: 0, open: 0 })), { env: { SELF_REVIEW_LOG_DIR: logDir } });
  assert.equal(r.stdout, "");
  const lines = readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].summary, "outcome=converged rounds=2 fixed=1 dismissed=0 open=0", "the gate logs the summary it formatted, not whatever the model typed");
  assert.equal(lines[0].cwd, PROJECT);
});

// A marker that does not validate is a REJECTED marker, not an absent one. The
// difference is the block reason: repeating "run the review loop" at a model
// that ran it and mistyped the record is what makes a correction cost a whole
// Stop cycle per defect.
test("a marker whose record does not validate is refused, and the reason says which fields", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...writeMarker({ outcome: "converged", rounds: 2 })));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /does not validate/);
  assert.match(r.json.reason, /fixed is required/);
  assert.match(r.json.reason, /dismissed is required/);
  assert.match(r.json.reason, /open is required/, "every defect at once, not one per rejection");
  assert.doesNotMatch(r.json.reason, /Files changed this turn/, "the generic reminder is the wrong message here");
  assert.match(r.json.reason, /"outcome":"converged"/, "the exact body to write");
});

test("the legacy {summary: string} body is refused by name", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...writeMarker({ summary: "rounds=1 fixed=0 dismissed=0 open=0" })));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /`summary` is no longer a string/);
});

test("a marker file that is not JSON, or not an object, is refused rather than ignored", () => {
  const file = `${SCRATCH}/self-review/CONVERGED.json`;
  const raw = (content) => call("Write", { file_path: file, content }, `File created successfully at: ${file}`);
  for (const [content, match] of [["converged!", /not valid JSON/], ['["converged"]', /must contain a JSON object/]]) {
    const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...raw(content)));
    assert.ok(blocks(r), content);
    assert.match(r.json.reason, match);
  }
});

test("the escape hatch clears the gate, and its counts are refused", () => {
  assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...writeMarker({ outcome: "not-applicable", reason: "user-declined" }))).stdout, "");
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...writeMarker({ outcome: "not-applicable", reason: "user-declined", rounds: 0 })));
  assert.ok(blocks(r), "rounds=0 is what made the hatch read as a converged review");
  assert.match(r.json.reason, /rounds cannot be given/);
});

test("a rejected marker corrected in the same turn releases; the correction is what counts", () => {
  const entries = turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...writeMarker({ outcome: "converged" }), ...writeMarker());
  assert.equal(run(entries).stdout, "", "a bad write followed by a good one is a corrected mistake");
});

test("the write marker is logged once even when the gate runs again in the same turn", () => {
  const logDir = mkdtempSync(path.join(tmpdir(), "srlog-"));
  const entries = turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...writeMarker());
  run(entries, { env: { SELF_REVIEW_LOG_DIR: logDir } });
  run(entries, { env: { SELF_REVIEW_LOG_DIR: logDir } });
  assert.equal(readFileSync(path.join(logDir, "log.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("a write marker before the last change, or one whose write failed, does not release", () => {
  assert.ok(blocks(run(turn(...writeMarker(), ...write(`${PROJECT}/src/a.ts`)))));
  const denied = call("Write", { file_path: `${SCRATCH}/self-review/CONVERGED.json`, content: '{"summary":"x"}' }, "Error: permission denied");
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...denied))));
  const notJson = call("Write", { file_path: `${SCRATCH}/self-review/CONVERGED.json`, content: "converged!" }, "File created successfully");
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...notJson))));
});

test("the block reason names the write marker and the plugin's converged.sh, and the plugin-qualified skill name", () => {
  const r = run(turn(...write(`${PROJECT}/src/a.ts`)));
  assert.match(r.json.reason, /self-review\/CONVERGED\.json/);
  assert.match(r.json.reason, new RegExp(CONVERGED_SH));
  assert.match(r.json.reason, /skill "self-review:self-review"/);
});

test("conventional extensionless names — LICENSE, README, .gitignore — are not code", () => {
  for (const f of ["LICENSE", "README", "CHANGELOG", ".gitignore", ".editorconfig", ".npmrc", ".env"]) {
    assert.equal(run(turn(...write(`${PROJECT}/${f}`))).stdout, "", f);
  }
  assert.ok(blocks(run(turn(...write(`${PROJECT}/Makefile`)))));
  assert.ok(blocks(run(turn(...write(`${PROJECT}/bin/deploy`)))));
});

test("a user config file extends the exempt lists and sets the reminder cap; a broken one is ignored with a warning", () => {
  const cfgDir = mkdtempSync(path.join(tmpdir(), "srcfg-"));
  const cfg = path.join(cfgDir, "config.json");
  writeFileSync(cfg, JSON.stringify({ exempt: { extensions: [".md", ".foo"], names: ["NOTES"] } }));
  assert.equal(run(turn(...write(`${PROJECT}/a.foo`)), { env: { SELF_REVIEW_CONFIG: cfg } }).stdout, "");
  assert.equal(run(turn(...write(`${PROJECT}/NOTES`)), { env: { SELF_REVIEW_CONFIG: cfg } }).stdout, "");
  assert.ok(blocks(run(turn(...write(`${PROJECT}/a.json`)), { env: { SELF_REVIEW_CONFIG: cfg } })), "arrays replace, they do not merge");
  writeFileSync(cfg, JSON.stringify({ gate: { maxReminders: 0 } }));
  const capped = run(turn(...write(`${PROJECT}/a.ts`)), { env: { SELF_REVIEW_CONFIG: cfg } });
  assert.ok(!blocks(capped) && /released without a convergence marker/.test(capped.json.systemMessage));
  writeFileSync(cfg, "{ not json");
  const r = run(turn(...write(`${PROJECT}/a.foo`)), { env: { SELF_REVIEW_CONFIG: cfg } });
  assert.ok(blocks(r), "defaults apply when the user config is unreadable");
  assert.match(r.stderr, /config\.json/);
});

test("a CONVERGED.json written inside the project, not a scratch dir, is not a marker", () => {
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...writeMarker(CONVERGED_RECORD, PROJECT)))));
  assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...writeMarker(CONVERGED_RECORD, mkdtempSync(path.join(tmpdir(), "sr-"))))).stdout, "");
});

test("the write marker is logged once even when another session's entry landed after it", () => {
  const logDir = mkdtempSync(path.join(tmpdir(), "srlog-"));
  const entries = turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...writeMarker());
  run(entries, { env: { SELF_REVIEW_LOG_DIR: logDir } });
  const file = path.join(logDir, "log.jsonl");
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ cwd: "/elsewhere", summary: "other session", marker: "Write999" }) + "\n");
  run(entries, { env: { SELF_REVIEW_LOG_DIR: logDir } });
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
});

test("a .env suffix is exempt like the bare dotfile: docker.env passes", () => {
  assert.equal(run(turn(...write(`${PROJECT}/docker.env`))).stdout, "");
});

test("a wrong-shaped user config (null or mistyped keys) is ignored per key with a warning; the gate still runs", () => {
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "srcfg-")), "config.json");
  writeFileSync(cfg, JSON.stringify({ gate: null, exempt: { extensions: "md", names: [".env"] }, pollGuard: { maxChecks: "two" } }));
  const r = run(turn(...write(`${PROJECT}/a.ts`)), { env: { SELF_REVIEW_CONFIG: cfg } });
  assert.ok(blocks(r));
  assert.match(r.stderr, /gate.*expected object|expected object.*gate/);
  assert.equal(run(turn(...write(`${PROJECT}/a.md`)), { env: { SELF_REVIEW_CONFIG: cfg } }).stdout, "", "mistyped extensions list falls back to the default list");
});

test("a missing or corrupt config/defaults.json does not crash the hook: everything is gated and stderr says why", () => {
  const root = mkdtempSync(path.join(tmpdir(), "srplug-"));
  cpSync(path.join(PLUGIN_ROOT, "hooks"), path.join(root, "hooks"), { recursive: true });
  const r = run(turn(...write(`${PROJECT}/README.md`)), { gate: path.join(root, "hooks/self-review-gate.mjs") });
  assert.ok(blocks(r), "with no exemption list known, a prose file is gated rather than the hook dying");
  assert.match(r.stderr, /defaults\.json/);
});

test("an array override with a non-string element is ignored per key, not a crash", () => {
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "srcfg-")), "config.json");
  writeFileSync(cfg, JSON.stringify({ exempt: { extensions: [".md", 123] } }));
  const r = run(turn(...write(`${PROJECT}/a.json`)), { env: { SELF_REVIEW_CONFIG: cfg } });
  assert.equal(r.stdout, "", "the default extension list stays in force");
  assert.match(r.stderr, /exempt\.extensions/);
});

test("only the plugin's own converged.sh is the marker script: a same-named script elsewhere is not", () => {
  const token = "SELF-REVIEW CONVERGED — rounds=1";
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(`${PROJECT}/scripts/converged.sh "rounds=1"`, token)))));
  assert.ok(blocks(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(`./converged.sh "rounds=1"`, token)))));
  assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(`${SH(CONVERGED_SH.replace(homedir(), "~"))} "rounds=1"`, token))).stdout, "", "the ~ spelling of the plugin path counts");
  assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...bash(`scripts/converged.sh "rounds=1"`, token)), { payload: { cwd: PLUGIN_ROOT } }).stdout, "", "relative to the plugin root counts");
});

test("the marker command the gate prints is runnable where the install path has a space", () => {
  // The gate's message is copied into a Bash call verbatim, so at an install
  // path holding a space the instruction was two words: the command failed with
  // ENOENT, and the marker the gate itself was waiting for could not be
  // produced at all — the turn could not end however correct the work was.
  // Nine releases could not see it, because a suite always runs the copy that
  // lives at the developer's own path.
  const dir = mkdtempSync(path.join(tmpdir(), "gate-hostile-"));
  const install = path.join(dir, "cold run – ü");
  cpSync(PLUGIN_ROOT, path.join(install, "plugin"), { recursive: true });
  const gate = path.join(install, "plugin/hooks/self-review-gate.mjs");
  try {
    const blocked = run(turn(...write(`${PROJECT}/src/a.ts`)), { gate });
    const printed = /or run: (.*?) --converged/.exec(blocked.json.reason)?.[1];
    assert.ok(printed, blocked.json?.reason);

    // What a shell makes of it is ONE word, and that word is the copy's script.
    // The brackets are what makes "one word" visible: unquoted, the space split
    // it in two and printf printed two.
    const resolved = spawnSync("bash", ["-c", `printf '<%s>' ${printed}`], { encoding: "utf8" });
    assert.equal(resolved.stdout, `<${realpathSync(path.join(install, "plugin/scripts/converged.sh"))}>`);

    // And running exactly what it says clears that gate.
    const cleared = run(turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...bash(`${printed} "rounds=1"`, MARKER_OUT)), { gate });
    assert.equal(cleared.stdout, "", cleared.json?.reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the write marker counts when the Write overwrote an existing file (the harness's 'updated successfully' wording)", () => {
  const file = `${SCRATCH}/self-review/CONVERGED.json`;
  const overwrite = call("Write", { file_path: file, content: JSON.stringify(CONVERGED_RECORD) }, `The file ${file} has been updated successfully.`);
  assert.equal(run(turn(...write(`${PROJECT}/src/a.ts`), ...reviewed(), ...overwrite)).stdout, "");
});

test("an unknown (typo'd) config key is dropped with a warning naming it", () => {
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "srcfg-")), "config.json");
  writeFileSync(cfg, JSON.stringify({ exempt: { extenstions: [".foo"] } }));
  const r = run(turn(...write(`${PROJECT}/a.foo`)), { env: { SELF_REVIEW_CONFIG: cfg } });
  assert.ok(blocks(r), "the typo'd list has no effect");
  assert.match(r.stderr, /unknown key exempt\.extenstions/);
});

test("a default run — shipped defaults, no user config — writes nothing to stderr", () => {
  const r = run(turn(...write(`${PROJECT}/a.md`)), { env: { SELF_REVIEW_CONFIG: "/nonexistent/config.json" } });
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

// --- F7: the gate judges what was written, not how ---------------------------
//
// D4, 2026-08-30: a prose-only turn was blocked with "2 shell command(s) that
// write files" for a `python3 - <<'EOF'` heredoc and a `node
// scripts/new-decision.mjs` that each wrote a `.md`. The command shape was
// decided; the artifact was never looked at. `isExempt` ran only on targets the
// parser could resolve, and a scripted write has no resolvable target — so the
// `.md` exemption never got a chance to fire.
// The fixture repo cannot live under a temp dir: every path below tmpdir() is
// a SCRATCH prefix to the gate, so a `.mjs` written there is exempt and there
// would be nothing to detect. Home is the nearest writable place that is not
// scratch — the same trick coldrun.test.mjs uses, with the same two-layer
// cleanup, because `node --test` kills this file's process and no in-process
// hook survives that.
const HOME_FIXTURE = `.srg-f7-`;
const fixtures = new Set();
process.on("exit", () => { for (const dir of fixtures) rmSync(dir, { recursive: true, force: true }); });
for (const name of (() => { try { return readdirSync(REAL_HOME); } catch { return []; } })()) {
  const owner = new RegExp(`^\\${HOME_FIXTURE}(\\d+)-`).exec(name);
  if (!owner) continue;
  try { process.kill(Number(owner[1]), 0); continue; } catch (err) { if (err.code !== "ESRCH") continue; }
  try { rmSync(path.join(REAL_HOME, name), { recursive: true, force: true }); } catch { /* someone else's */ }
}

function repoFixture(files = {}) {
  const repo = mkdtempSync(path.join(REAL_HOME, `${HOME_FIXTURE}${process.pid}-`));
  fixtures.add(repo);
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(repo, file), body);
  }
  return { repo, git };
}
// The turn's writes are the ones newer than the turn's first message, and the
// synthetic transcript's clock is 2023 — so a file that must read as OLDER than
// the turn has to say so.
const aged = (file) => utimesSync(file, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
const SCRIPTED = (root) => [
  `python3 - <<'EOF'\nopen('${root}/anything.txt','w').write('x')\nEOF`,
  `node scripts/new-decision.mjs "a decision"`,
];

test("F7: a scripted write whose artifact is prose passes, and the gate says nothing", () => {
  const { repo } = repoFixture({ "docs/decision-0012.md": "# a decision\n" });
  const r = run(turn(...SCRIPTED(repo).map((cmd) => bash(cmd))), { payload: { cwd: repo } });
  assert.equal(blocks(r), false, r.json?.reason);
  assert.equal(r.stdout, "", "the exact turn D4 blocked");
});

test("F7: a scripted write whose artifact is code blocks, and names the file", () => {
  const { repo } = repoFixture({ "docs/decision-0012.md": "# a decision\n", "src/generated.mjs": "export const x = 1;\n" });
  const r = run(turn(...SCRIPTED(repo).map((cmd) => bash(cmd))), { payload: { cwd: repo } });
  assert.ok(blocks(r), "a scripted write that produced code is a change");
  assert.match(r.json.reason, /src\/generated\.mjs/, "named, not counted: the block used to say only 'N shell command(s)'");
  assert.doesNotMatch(r.json.reason, /decision-0012\.md/, "the exempt half is not evidence of a change");
});

test("F7: a non-ASCII filename is evidence too", () => {
  // git C-quotes any path with a byte over 0x7f (`?? "\316\273-guard.mjs"`), and
  // the unquoting used to borrow JSON.parse, which throws on an octal escape.
  // The file then dropped out of the evidence entirely; with an EXEMPT file
  // co-changed, `written` was non-empty and `gated` empty, so the turn ended
  // with an ungated code write. The name uses a codepoint with no NFD
  // decomposition, so the assertion does not depend on the filesystem's
  // normalisation.
  const { repo } = repoFixture({ "docs/decision-0012.md": "# a decision\n", "src/\u03bb-guard.mjs": "export const x = 1;\n" });
  const r = run(turn(...SCRIPTED(repo).map((cmd) => bash(cmd))), { payload: { cwd: repo } });
  assert.ok(blocks(r), "a scripted write that produced code is a change, whatever the file is called");
  assert.match(r.json.reason, /\u03bb-guard\.mjs/, "named, not silently dropped");
});

test("F7: a turn whose start has no timestamp says that, not \"no git repository\"", () => {
  // writesSince() returned a bare null for three different causes and the
  // caller named the third for all of them, so this read as a missing
  // repository from inside a perfectly good checkout.
  const { repo } = repoFixture({ "src/generated.mjs": "export const x = 1;\n" });
  const entries = turn(bash(SCRIPTED(repo)[0]));
  entries[0] = { ...entries[0], timestamp: "not a date" };   // the turn's own boundary
  const r = run(entries, { payload: { cwd: repo } });
  assert.ok(blocks(r));
  assert.match(r.json.reason, /could not determine which files — no timestamp for the start of this turn/);
});

test("F7: a mixed turn counts the blind commands, not all of them", () => {
  // The caveat used to be attached to the count of every bash command, so one
  // unresolved write out of two read as though neither target was known.
  const r = run(turn(bash(`python3 - <<'EOF'\nopen('${PROJECT}/x','w').write('a')\nEOF`),
    bash(`printf 'x' > ${PROJECT}/real.mjs`)));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /real\.mjs/, "the resolved target is still named");
  assert.match(r.json.reason, /2 shell command\(s\) that write files \(1 of them could not be resolved — no git repository\)/);
});

test("F7: a code file left dirty BEFORE the turn is not this turn's write", () => {
  const { repo } = repoFixture({ "docs/note.md": "prose\n", "src/old.mjs": "export const old = 1;\n" });
  aged(path.join(repo, "src/old.mjs"));
  const r = run(turn(...SCRIPTED(repo).map((cmd) => bash(cmd))), { payload: { cwd: repo } });
  assert.equal(blocks(r), false, r.json?.reason);
});

test("F7: with no repository to ask, the block says so instead of claiming files", () => {
  const r = run(turn(bash(`python3 - <<'EOF'\nopen('/repo/fake-project/x','w').write('a')\nEOF`)));
  assert.ok(blocks(r));
  assert.match(r.json.reason, /shell command\(s\) that write files \(could not determine which files — no git repository\)/);
  assert.doesNotMatch(r.json.reason, /changed \d+ files/);
});

test("F7: a resolvable target still decides on its own, without asking git", () => {
  // The fallback is for the unknowable case only. A parser that CAN name the
  // target must keep naming it — otherwise a write to a path outside the repo
  // would silently stop being a change.
  const { repo } = repoFixture({ "docs/note.md": "prose\n" });
  const r = run(turn(bash(`printf 'x' > ${PROJECT}/real.mjs`)), { payload: { cwd: repo } });
  assert.ok(blocks(r));
  assert.match(r.json.reason, /real\.mjs/);
});

// The same defect F7 closed, in the shape F7 left open. Reported from a real
// session 2026-09-02: prose-only turns blocked because the markdown went out
// through a heredoc. F7 made an UNRESOLVABLE write consult git for its artifact,
// but `bashWriteTargets` only reached that fallback when it could name nothing
// at all. One command that both wrote a doc to a resolvable path AND ran an
// interpreter whose target could not be resolved returned the doc — filtered by
// scratch alone, so the `.md` exemption never fired — and the turn blocked
// citing a file the gate itself exempts everywhere else.
test("F7: a resolvable PROSE target beside an unresolvable write is still prose", () => {
  const { repo } = repoFixture({ "docs/notes.md": "# notes\n", "anything.txt": "x\n" });
  // ONE command: the two writes have to share a Bash call. Split across two
  // calls each is analysed on its own, the resolvable half returns null as a
  // pure prose write, and the defect never arises.
  const r = run(turn(bash(`python3 -c "open('${repo}/anything.txt','w').write('x')" && cat > ${repo}/docs/notes.md <<'EOF'\n# notes\nEOF`)), { payload: { cwd: repo } });
  assert.equal(blocks(r), false, r.json?.reason);
  assert.equal(r.stdout, "", "a prose-only turn says nothing");
});

test("F7: a resolvable prose target does not hide a code artifact beside it", () => {
  // The fix must not buy the prose case by going blind: the git evidence is
  // still what answers, so a code file written in the same turn still blocks
  // and is still the file that gets named.
  const { repo } = repoFixture({ "docs/notes.md": "# notes\n", "src/generated.mjs": "export const x = 1;\n" });
  // ONE command: the two writes have to share a Bash call. Split across two
  // calls each is analysed on its own, the resolvable half returns null as a
  // pure prose write, and the defect never arises.
  const r = run(turn(bash(`python3 -c "open('${repo}/anything.txt','w').write('x')" && cat > ${repo}/docs/notes.md <<'EOF'\n# notes\nEOF`)), { payload: { cwd: repo } });
  assert.ok(blocks(r), "the unresolvable write really did produce code");
  assert.match(r.json.reason, /src\/generated\.mjs/);
  assert.doesNotMatch(r.json.reason, /notes\.md/, "the exempt half is not evidence of a change");
});

// ---------- the orchestrator arms the gate too (F10c) ----------
//
// The orchestrator runs the whole post-setup protocol in a fresh context and
// spawns the finders, the verifier and the applier itself. That makes it the one
// agent on BOTH sides of this gate's comparison: a change source, because its
// applier writes where the main chain cannot see, and the evidence a review ran.
//
// The two are separated by which FIELDS each side reads. The change side takes
// the collapsed monotonic anchor; the evidence side reads `launchedAt` and
// `doneAt` raw and compares them to changes the orchestrator did NOT make. Put
// one index on both sides of a strict `>` and `converged` blocks forever, which
// is how a gate gets deleted rather than fixed.

const ORCHESTRATOR = "self-review:self-review-orchestrator";
// The type is overridable for the same reason `applier` is: it is model-authored
// text, and the two fixtures that hold that line need to craft one.
const orch = (id, type = ORCHESTRATOR) => launch(id, type);
const resume = (to) => call("SendMessage", { to, message: "keep going" }, "Message sent");
const NOT_CONVERGED = [`${CONVERGED_Q} --not-converged --rounds 1 --fixed 0 --dismissed 0 --open 1`,
  "SELF-REVIEW CONVERGED — outcome=not-converged rounds=1 fixed=0 dismissed=0 open=1"];

test("an orchestrator that completed after the lead's last edit satisfies converged", () => {
  const r = run(turn(...write(`${PROJECT}/a.ts`), ...orch("o1"), notification("o1"), ...marker()));
  assert.equal(r.stdout, "", "launched after the edit, completed before the marker");
});

test("a converged marker between the orchestrator's launch and its completion does not pass", () => {
  // "You launched the review and said you were done" is no check. This is the
  // shape completion-arming exists to refuse, and it must not merely be blocked
  // — the turn has to end, because ending the turn is how this loop waits.
  const inflight = turn(...write(`${PROJECT}/a.ts`), ...orch("o1"), ...marker());
  const r = run(inflight);
  assert.ok(!blocks(r), "a running orchestrator releases the turn rather than blocking it");
  assert.match(r.json.systemMessage, /editing subagent is still running/);
  // Once it completes, the marker is behind the anchor again and the turn blocks
  // until it is re-marked.
  const landed = run([...inflight, notification("o1"), said("it reported")]);
  assert.ok(blocks(landed), "the completion moved the anchor past the marker");
  const remarked = run([...inflight, notification("o1"), ...marker(), said("re-marked")]);
  assert.equal(remarked.stdout, "", "re-marking after the completion is what discharges it");
});

test("a not-converged marker written mid-flight does not stay discharged once the orchestrator completes", () => {
  // The hole in arming on completion ALONE, and the reason the orchestrator's
  // anchor has to join `changeAtW`: an honest not-converged marker sits ahead of
  // a launch-only anchor, and the edits its applier then makes would land behind
  // a marker that was already accepted.
  const midflight = turn(...write(`${PROJECT}/a.ts`), ...orch("o1"), ...bash(...NOT_CONVERGED));
  assert.equal(run(midflight).stdout, "", "not-converged needs no reviewer behind it");
  const after = run([...midflight, notification("o1"), said("its applier had been writing")]);
  assert.ok(blocks(after), "the completion re-arms: those edits have no marker behind them");
});

test("a lead edit AFTER the orchestrator finished is refused — nobody read it", () => {
  const r = run(turn(...orch("o1"), notification("o1"), ...write(`${PROJECT}/a.ts`), ...marker()));
  assert.ok(blocks(r), "the orchestrator cannot vouch for an edit made after it reported");
  assert.match(r.json.reason, /converged/i);
});

test("a lead edit DURING the run is refused too — the orchestrator vouches only for its launch tree", () => {
  // Stricter than the finder rule's known limit, and deliberately so: the
  // orchestrator does not merely read the tree, it edits it through its applier,
  // so a mid-run lead edit could be overwritten or simply never read.
  const r = run(turn(...orch("o1"), ...write(`${PROJECT}/a.ts`), notification("o1"), ...marker()));
  assert.ok(blocks(r), "launched before the edit, so the edit is outside what it reviewed");
});

test("resuming an orchestrator cannot walk its anchor back behind a marker", () => {
  // The applier's monotonicity finding, one type over. A SendMessage sets `done`
  // false, so a launch-or-completion anchor would drop back to the launch —
  // behind a marker already written — turning a block into a silent pass. And
  // resuming is the first thing a model debugging a block reaches for.
  const blocked = turn(...write(`${PROJECT}/a.ts`), ...orch("o1"), ...bash(...NOT_CONVERGED), notification("o1"));
  assert.ok(blocks(run(blocked)), "control: the completion is ahead of the marker");
  // The interjections age `pending` out. Without them the resumed orchestrator
  // is simply STILL RUNNING, and a running agent releases the turn on purpose —
  // which is the correct answer, not the disarm. The bug this guards is the one
  // that appears after it stops running: the anchor back at the launch, behind
  // a marker, and the turn silently passing.
  const resumed = [...blocked, ...resume("o1"),
    human("something"), said("a"), human("something else"), said("b")];
  assert.ok(blocks(run(resumed)), "a resume is a fresh dispatch and needs a marker AFTER it");
});

test("a clean resume re-arms and its own completion discharges it", () => {
  const r = run(turn(...write(`${PROJECT}/a.ts`), ...orch("o1"), notification("o1"),
    ...resume("o1"), notification("o1"), ...marker()));
  assert.equal(r.stdout, "", "a resume is a fresh dispatch; its completion is the evidence");
});

test("a resume renews the change side but never the evidence side", () => {
  // The launch is what the evidence clause reads, and a resume does not move it.
  // So an edit made between the first completion and the resume is still an edit
  // the orchestrator was not launched over.
  const r = run(turn(...orch("o1"), notification("o1"), ...write(`${PROJECT}/a.ts`),
    ...resume("o1"), notification("o1"), ...marker()));
  assert.ok(blocks(r), "resuming does not retroactively put the launch after the edit");
});

test("an orchestrator must not vouch for a main-chain applier that ran beside it", () => {
  // THE COMPOSITION TEST. Both arming rules are live at once — the fallback path
  // is today's loop — so a session can hold a finished orchestrator and a
  // main-chain applier. The orchestrator's launch precedes the applier's edits,
  // so it read none of them.
  const r = run(turn(...orch("o1"), notification("o1"), ...reviewed(),
    ...applier("ap1"), notification("ap1"), ...marker()));
  assert.ok(blocks(r), "the applier's edits arrived after everything that read the tree");
  // The refusal has to be true as well as correct, and this asserts the part
  // that is specific to THIS composition: the state is `stale`, meaning a
  // reviewer did complete — the orchestrator — and what outran it is the
  // applier's completion, not a file edit. A match on the reviewer-type list
  // alone would not have discriminated: that list is a fixed enumeration
  // printed in every state, so it is held by its own fixture below.
  assert.match(r.json.reason, /A reviewer did complete, but this landed after it finished: .*applier subagent/,
    "the refusal must say a reviewer ran and name what outran it");
});

test("the refusal enumerates every type that can be the reviewer", () => {
  // A fixed list in a fixed sentence, so this fixture is a spelling guard and
  // nothing cleverer — which is exactly why it is needed. F10c folded the
  // orchestrator into `reviewers` and left the list naming two of three, and a
  // model whose only reviewer WAS an orchestrator read a refusal flatly denying
  // any reviewer ran. Two finders filed it independently; one reproduced it.
  const r = run(turn(...reviewed(), ...write(`${PROJECT}/a.ts`), ...marker()));
  assert.ok(blocks(r), "an edit after the finder finished is stale");
  for (const type of ["self-review-finder", "self-review-cold-grader", "self-review-orchestrator"]) {
    assert.ok(r.json.reason.includes(type), `the refusal must name ${type}`);
  }
});

test("the fallback loop still converges with a dead orchestrator in the window", () => {
  // The orchestrator failed early; the lead ran today's loop by hand. A finder
  // that completed after the applier is the evidence, exactly as before F10c.
  const r = run(turn(...write(`${PROJECT}/a.ts`), ...orch("o1"), notification("o1"),
    ...applier("ap1"), notification("ap1"), ...reviewed(), ...marker()));
  assert.equal(r.stdout, "", "a failed orchestrator must not poison the fallback path");
});

test("each orchestrator is judged against the changes it did not make", () => {
  // Two orchestrators around one lead edit. The first was launched before the
  // edit and cannot vouch for it; the second was launched after and can.
  const first = turn(...orch("o1"), notification("o1"), ...write(`${PROJECT}/a.ts`), ...marker());
  assert.ok(blocks(run(first)), "the first alone was launched before the edit");
  const second = run(turn(...orch("o1"), notification("o1"), ...write(`${PROJECT}/a.ts`),
    ...orch("o2"), notification("o2"), ...marker()));
  assert.equal(second.stdout, "", "the second was launched after every change it did not make");
});

test("an orchestrator launched in the same entry as an edit does not clear it", () => {
  // Strict `>`, consistent with the `beside` rule: same index is not "after".
  const id = "o1";
  const both = {
    type: "assistant", uuid: `a${++seq}`, timestamp: stamp(),
    message: { role: "assistant", content: [
      { type: "tool_use", id: "w-both", name: "Write", input: { file_path: `${PROJECT}/a.ts`, content: "x" } },
      { type: "tool_use", id: "o-both", name: "Agent", input: { prompt: "review", subagent_type: ORCHESTRATOR } },
    ] },
  };
  const r = run(turn(both,
    toolResult("w-both", `File created successfully at: ${PROJECT}/a.ts`, { filePath: `${PROJECT}/a.ts` }),
    toolResult("o-both", LAUNCHED(id), {}),
    notification(id), ...marker()));
  assert.ok(blocks(r), "an edit in the launching entry is not an edit the launch came after");
});

test("only the orchestrator's own type arms: a neighbouring name does not", () => {
  for (const type of ["general-purpose", "review-orchestrator", "self-review-orchestrators", "x-self-review-orchestrator"]) {
    const r = run(turn(...launch(`x-${type}`, type), notification(`x-${type}`)));
    assert.equal(r.stdout, "", `${type} must not arm the gate`);
  }
});

test("after an orchestrator completes, the block asks for a re-mark and not another loop", () => {
  // The whole point of delegating the loop is that the main session does not
  // re-read the change. A block that ends "invoke the skill and follow it to
  // convergence" would spend the review twice and pull the context back into
  // the session the orchestrator exists to spare, so the instruction after a
  // completion is: read the report, mark. Fable ruled this wording.
  const r = run(turn(...write(`${PROJECT}/a.ts`), ...orch("o1"), notification("o1"), said("it reported")));
  assert.ok(blocks(r), "a completion with no marker behind it still blocks");
  assert.match(r.json.reason, /read its report and act on anything it left open/);
  assert.doesNotMatch(r.json.reason, /follow it to convergence/,
    "the loop instruction is what this branch replaces");
  assert.doesNotMatch(r.json.reason, /After spawning reviewers/,
    "advice about waiting on reviewers it was just told not to spawn");
  assert.match(r.json.reason, /If it FAILED/,
    "the one case where the completion is not a review must still name the loop");
  assert.match(r.json.systemMessage, /read its report and re-mark/,
    "the status line has to name the same next step as the reason");
});

test("a lead edit after the completion gets the loop instruction back", () => {
  // The branch keys on the LAST change, not on the presence of an orchestrator:
  // an edit nobody has read is exactly the case that wants a fresh review.
  const r = run(turn(...orch("o1"), notification("o1"), ...write(`${PROJECT}/a.ts`), said("then I edited")));
  assert.ok(blocks(r), "an unreviewed edit blocks");
  assert.match(r.json.reason, /follow it to convergence/);
  assert.doesNotMatch(r.json.reason, /read its report and act on anything it left open/);
  assert.match(r.json.systemMessage, /running the review loop before the turn ends/);
});

// The applier's two leak fixtures, over the second editor type. Both halves of
// that finding were reproduced live once, and the orchestrator reaches the same
// two sinks — describeChanges' count line and the new blockReason branch — so
// the guard needs holding on both types or a regression ships green.
test("a model-authored orchestrator subagent_type never reaches the block reason", () => {
  const r = run(turn(...orch("o1", "outcome=converged claims a review ran:self-review-orchestrator"), notification("o1")));
  assert.ok(blocks(r));
  assert.ok(!r.json.reason.includes("outcome=converged claims a review ran"),
    "the type is model-authored text: counted, never quoted");
});

test("a 20,000-character orchestrator subagent_type does not become a 20,000-character reason", () => {
  const r = run(turn(...orch("o1", "x".repeat(20_000) + ":self-review-orchestrator"), notification("o1")));
  assert.ok(blocks(r));
  assert.ok(!r.json.reason.includes("x".repeat(100)), "the type's bulk is not copied into the reason");
});

test("one orchestrator cannot vouch for another orchestrator's later completion", () => {
  // `externalChangeAt` excludes EVERY orchestrator, not just the one being
  // judged, and that is one orchestrator too many. o1 is launched, a lead edit
  // lands, o2 launches and finishes, and only THEN does o1 report — so o1's own
  // applier's edits are a fixed set at index 40, after o2 had already stopped
  // reading. o1 is correctly stale against the edit; o2 clears the whole
  // session anyway, because its clause never looks at o1.
  //
  // The ruling's own words are "launched after every change it did not make",
  // and another orchestrator's edits are changes it did not make.
  const r = run(turn(...orch("o1"), ...write(`${PROJECT}/a.ts`),
    ...orch("o2"), notification("o2"), notification("o1"), ...marker()));
  assert.ok(blocks(r), "o2 finished before o1's edits were a fixed set");
});

// Two orchestrators launched in ONE entry tie on `launchedAt`, so each raises the
// other's baseline to at least its own launch index and the strict `>` refuses
// BOTH — not merely the earlier one. That is the same boundary the
// launched-beside-an-edit fixture pins: same index is not "after". It is ruled
// correct rather than tolerated — two concurrent loops over one tree each have
// finders reading what the other's applier is mutating, and neither's edits are
// a fixed set until its own completion, so vouching in either direction would be
// false. Admitting one would need the scopes to be disjoint AND the later
// finisher to have read the earlier's edits: both are report properties, and
// reading the report is the self-report this gate refuses.
//
// Pinned because the boundary of a strict comparison is what a later edit flips
// — someone reads the note, sees the tie, and "fixes" it with `>=`.
const twoOrchestratorsInOneEntry = (a, b) => {
  const both = {
    type: "assistant", uuid: `a${++seq}`, timestamp: stamp(),
    message: { role: "assistant", content: [
      { type: "tool_use", id: `o-${a}`, name: "Agent", input: { prompt: "review", subagent_type: ORCHESTRATOR } },
      { type: "tool_use", id: `o-${b}`, name: "Agent", input: { prompt: "review", subagent_type: ORCHESTRATOR } },
    ] },
  };
  return [both, toolResult(`o-${a}`, LAUNCHED(a), {}), toolResult(`o-${b}`, LAUNCHED(b), {})];
};

test("two orchestrators launched in one entry vouch for neither", () => {
  const r = run(turn(...twoOrchestratorsInOneEntry("o1", "o2"),
    notification("o1"), notification("o2"), ...marker()));
  assert.ok(blocks(r), "equal launch indices satisfy no orchestrator's clause");
  // And the refusal must still be true: a reviewer DID complete. Telling the
  // model nothing ran would send it to run a whole loop it already paid for.
  assert.match(r.json.reason, /A reviewer did complete, but this landed after it finished/);
});

test("a third orchestrator in its own message clears what the tied pair could not", () => {
  // The escape, pinned beside the refusal: the ruling forbids a permanent block,
  // and a launch strictly after both siblings' anchors satisfies the clause.
  const r = run(turn(...twoOrchestratorsInOneEntry("o1", "o2"),
    notification("o1"), notification("o2"),
    ...orch("o3"), notification("o3"), ...marker()));
  assert.equal(r.stdout, "", "o3 was launched after every change it did not make");
});

// ---------- the seam: the agent files on disk against the gate's regexes ----
//
// `REVIEWER_TYPES`, `APPLIER_TYPE` and `ORCHESTRATOR_TYPE` are hardcoded here
// (deliberately — see their comments), and the agent definitions are separate
// files whose `name:` the harness registers. That is a name spelled in two
// places, which this repository has twice watched drift in one of them. So the
// subject of these tests is not a typed list: it is `agents/*.md` read off
// disk, with the expected classification per file. Adding an agent fails here
// until someone decides which side of the gate it is on.
const AGENT_DIR = path.join(PLUGIN_ROOT, "agents");
const AGENT_FILES = readdirSync(AGENT_DIR).filter((f) => f.endsWith(".md")).sort();

// What the gate must think of each shipped agent. `reviewer` = its completion
// is evidence a review ran; `editor` = its launch means it was told to edit.
// The orchestrator is BOTH and is not in this list because it does not ship
// yet — its definition is held in docs/design-notes/orchestrator-agent.md, and
// moving it here without adding its row fails the last test below, which is
// the point.
const EXPECTED = {
  "self-review-finder": ["reviewer"],
  "self-review-cold-grader": ["reviewer"],
  "self-review-verifier": [],
  "self-review-applier": ["editor"],
};

test("every agent file's name is its filename, which is what the harness registers", () => {
  for (const file of AGENT_FILES) {
    assert.equal(agentDefinition(path.join(AGENT_DIR, file)).name, file.replace(/\.md$/, ""),
      `${file}: the gate matches on the type the harness registers, and that is \`name:\``);
  }
});

test("the gate classifies each shipped agent exactly as its role says, by running it", () => {
  for (const file of AGENT_FILES) {
    const name = agentDefinition(path.join(AGENT_DIR, file)).name;
    const type = `self-review:${name}`;
    assert.ok(EXPECTED[name], `${file}: an agent type the gate has no ruling for — decide which side of it this one is on`);

    // Reviewer: a change, this agent completing after it, then the marker. A
    // reviewer clears `converged`; anything else leaves it refused.
    const asReviewer = run(turn(...write(`${PROJECT}/src/a.ts`), ...launch(`sm-${name}`, type),
      notification(`sm-${name}`), ...marker()));
    // Editor: nothing written and no marker at all. Only a type whose launch
    // means "told to edit" can arm the gate from that alone.
    const asEditor = run(turn(...launch(`se-${name}`, type), notification(`se-${name}`)));

    const seen = [...(blocks(asReviewer) ? [] : ["reviewer"]), ...(blocks(asEditor) ? ["editor"] : [])];
    assert.deepEqual(seen, EXPECTED[name], `${file} classified as [${seen}]`);
  }
});

test("the applier is the one agent that writes, and the only one with neither shell nor spawn", () => {
  const toolsOf = (name) => {
    const stated = agentDefinition(path.join(AGENT_DIR, `${name}.md`)).tools;
    // An agent file that omits `tools:` inherits every tool the lead holds, so
    // reading that as "no tools" would pass every assertion below for the one
    // file that fails all of them in fact. Refuse it here instead.
    assert.ok(stated, `${name}: states no \`tools:\`, so it inherits everything — including Bash and Edit`);
    return stated;
  };
  const applierTools = toolsOf("self-review-applier");
  assert.ok(applierTools.some((t) => t === "Edit" || t === "Write"), "the writing hand has to be able to write");
  // Not a preference: the whole reason the edits go to a subagent at all is
  // that this one cannot reach `git checkout`, and cannot fan out further.
  assert.ok(!applierTools.includes("Bash"), "a writing agent with a shell can undo the author's uncommitted work");
  assert.ok(!applierTools.includes("Agent"), "the applier applies; it does not spawn");

  for (const [name, roles] of Object.entries(EXPECTED)) {
    if (roles.includes("editor")) continue;
    const tools = toolsOf(name).filter((t) => t === "Edit" || t === "NotebookEdit"
      // The cold-grader's Write is its documented state file, and it has no Bash.
      || (t === "Write" && name !== "self-review-cold-grader"));
    assert.deepEqual(tools, [], `${name}: a reviewer that can edit is not reading the change, it is part of it`);
  }
});

test("the refusal names every agent whose completion would have satisfied it", () => {
  // The reason string is a typed prose list beside three regexes, which is the
  // exact shape that has taken findings here twice. A reviewer missing from it
  // sends a model that HAD one back to run the loop again.
  const r = run(turn(...write(`${PROJECT}/src/a.ts`), ...marker()));
  assert.ok(blocks(r));
  for (const [name, roles] of Object.entries(EXPECTED)) {
    if (!roles.includes("reviewer")) continue;
    assert.ok(r.json.reason.includes(name), `the refusal does not name ${name}, which would have satisfied it`);
  }
});
