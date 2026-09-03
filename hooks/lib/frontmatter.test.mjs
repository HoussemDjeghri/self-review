// Run: node --test plugin/hooks/lib/frontmatter.test.mjs   (or ./test.sh for everything)
//
// The subject here is one asymmetry: a missing `tools:` is the WIDEST grant an
// agent file can carry, and three separate readers of this frontmatter turned
// it into the narrowest. Every test below is the shape that got past them.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinition, body, field, grants, header, tools } from "./frontmatter.mjs";

const AGENT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../agents");
const head = (yaml) => header(`---\n${yaml}\n---\nthe agent's instructions.\n`);

test("an agent that states no tools inherits every tool, and reads as null rather than none", () => {
  assert.equal(tools(head("name: a\nmodel: opus")), null,
    "an empty list here is the bug: it passes `cannot edit` and `has no shell` for a fully-tooled agent");
  assert.ok(grants({ tools: null }, "Bash"), "an inherited grant holds everything, including a shell");
  assert.ok(!grants({ tools: ["Read"] }, "Bash"));
});

test("a stated empty grant is not an inherited one", () => {
  assert.deepEqual(tools(head("name: a\ntools:\nmodel: opus")), [],
    "`tools:` with nothing after it says `nothing`, which is a different fact from saying nothing");
});

test("the three YAML spellings of a tool list read the same", () => {
  const expected = ["Read", "Bash"];
  assert.deepEqual(tools(head("tools: Read, Bash")), expected);
  assert.deepEqual(tools(head('tools: [Read, "Bash"]')), expected);
  assert.deepEqual(tools(head("tools:\n  - Read\n  - Bash")), expected,
    "the block list is what a hand-edited agent file drifts into, and it read as one tool named `- Read`");
});

test("a block list stops at the next key rather than eating the frontmatter", () => {
  assert.deepEqual(tools(head("tools:\n  - Read\nmodel: opus\neffort: high")), ["Read"]);
  assert.equal(field(head("tools:\n  - Read\nmodel: opus"), "model"), "opus");
});

test("an empty scalar is absent, not the next line's value", () => {
  // `^name:\s*(.+)$` walked the newline and returned the model as the name.
  assert.equal(field(head("name:\nmodel: opus"), "name"), null);
  assert.equal(field(head("name: self-review-finder"), "name"), "self-review-finder");
});

test("the body is what a spawned agent is given, and it is not the header", () => {
  const text = "---\nname: a\n---\nthe agent's instructions.\n";
  assert.equal(body(text), "the agent's instructions.\n");
  assert.equal(header("no frontmatter here"), "", "a file without a header has no fields, and does not throw");
});

test("every shipped agent reads as the definition its own file states", () => {
  const finder = agentDefinition(path.join(AGENT_DIR, "self-review-finder.md"));
  assert.equal(finder.name, "self-review-finder");
  assert.equal(finder.model, "sonnet");
  assert.equal(finder.effort, "high");
  assert.ok(finder.tools?.includes("Read") && !finder.tools.includes("Edit"));
  assert.ok(!finder.body.startsWith("---"));
});
