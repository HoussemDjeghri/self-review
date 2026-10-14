// Run: node --test plugin/hooks/lib/agent-settings.test.mjs   (or ./test.sh for everything)
//
// config/agents.json is the one place a model or effort is edited. The agent
// files still carry both, because the applier and the ticket validator are
// spawned from skill prose with no parameters and the harness reads only the
// frontmatter. These tests are what make the second copy a mirror rather than
// a second source: an edit to one side alone fails here, naming the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinition } from "./frontmatter.mjs";
import { agentSettings, finderSettings, roleOf, roles, rowSettings } from "./agent-settings.mjs";

const AGENT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../agents");
const agentFiles = readdirSync(AGENT_DIR).filter((file) => file.endsWith(".md"));
// The one row with no file of its own: the finder, raised for angles G and H.
const FILELESS = new Set(["risk-finder"]);

for (const file of agentFiles) {
  const role = roleOf(path.basename(file, ".md"));
  test(`agents/${file} frontmatter equals its config/agents.json row`, () => {
    const definition = agentDefinition(path.join(AGENT_DIR, file));
    const expected = agentSettings(role);
    assert.deepEqual({ model: definition.model, effort: definition.effort }, expected,
      `edit agents/${file} to "model: ${expected.model}" and "effort: ${expected.effort}" — config/agents.json is the source`);
  });
}

test("every config/agents.json row names an agent file, except the risk finder", () => {
  const files = new Set(agentFiles.map((file) => roleOf(path.basename(file, ".md"))));
  for (const role of roles()) {
    if (FILELESS.has(role)) continue;
    assert.ok(files.has(role), `config/agents.json row "${role}" has no agents/self-review-${role}.md`);
  }
});

test("a risk row runs as the risk finder, any other row as its own agent", () => {
  assert.deepEqual(finderSettings("self-review-finder", { risk: true }), agentSettings("risk-finder"));
  assert.deepEqual(finderSettings("self-review-finder", {}), agentSettings("finder"));
  assert.deepEqual(finderSettings("self-review-cold-grader", {}), agentSettings("cold-grader"));
});

test("an unknown role throws rather than printing a call with no model", () => {
  assert.throws(() => agentSettings("self-review-nobody"), /no row for "nobody"/);
  assert.throws(() => agentSettings("$comment"), /no row/);
});

test("every row has a model and a known effort", () => {
  for (const role of roles()) assert.doesNotThrow(() => agentSettings(role), role);
});

test("a row with a misspelt or missing value throws rather than printing a call without it", () => {
  assert.throws(() => rowSettings("risk-finder", { model: "opus", efort: "medium" }), /effort undefined/);
  assert.throws(() => rowSettings("finder", { effort: "high" }), /has no model/);
  assert.throws(() => rowSettings("finder", { model: "sonnet", effort: "hihg" }), /not one of/);
  assert.deepEqual(rowSettings("finder", { model: "sonnet", effort: "high" }), { model: "sonnet", effort: "high" });
});
