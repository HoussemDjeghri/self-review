/**
 * Agent-definition frontmatter, read the way the harness reads it.
 *
 * Three copies of this reader existed — `evals/run.mjs`, and the two seam
 * suites that check `agents/*.md` against the gate's and tree-guard's
 * hardcoded type lists — and one defect was live in two of them at once, which
 * is the rule of three arriving with its evidence attached.
 *
 * `tools` is the field worth spelling out. An agent file that OMITS `tools:`
 * inherits every tool its parent holds, so **absent is the widest grant there
 * is, not the narrowest** — and all three copies returned `[]` for it. That
 * made the seam tests pass for the most dangerous file they could be shown: a
 * new agent with a full toolset read as a reviewer that cannot edit, and as an
 * agent with no shell to keep out of git. So absent is `null` here. It is not
 * an array, so an assertion written against a tool list throws instead of
 * passing vacuously, and every caller has to say out loud what it means by it.
 *
 * Both YAML spellings are read for the same reason. A hand-edited agent file
 * drifts into the block list, and `^tools:\s*(.+)$` scored
 * `tools:\n  - Read\n  - Bash` as one tool named `- Read` — an agent with a
 * shell, again invisible to the test whose subject is agents with shells.
 */
import { readFileSync } from "node:fs";

const HEADER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const unquote = (value) => value.trim().replace(/^["']|["']$/g, "").trim();

/** The frontmatter block, or "" when the file has none. */
export const header = (text) => text.match(HEADER)?.[1] ?? "";

/** The body with the frontmatter removed — what a spawned agent is given. */
export const body = (text) => text.replace(HEADER, "");

/**
 * A scalar field's value, or null when the key is absent or empty. Anchored to
 * spaces and tabs rather than `\s`, which matches newlines: `\s*(.+)` on an
 * empty `tools:` walked to the next line and returned ITS text as the value.
 */
export const field = (head, name) => {
  const value = head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1]?.trim();
  return value ? unquote(value) : null;
};

/**
 * The tool grant: an array when the file states one, and **null when it does
 * not**, meaning the agent inherits everything. An explicit `tools:` with
 * nothing after it is an empty array — a stated grant of nothing, which is a
 * different fact and reported as one.
 */
export const tools = (head) => {
  const line = head.match(/^tools:[ \t]*(.*)$/m);
  if (!line) return null;
  const inline = line[1].trim().replace(/^\[|\]$/g, "").trim();
  if (inline) return inline.split(",").map(unquote).filter(Boolean);
  const items = [];
  for (const row of head.slice(line.index + line[0].length).replace(/^\r?\n/, "").split(/\r?\n/)) {
    const item = row.match(/^[ \t]+-[ \t]*(.+)$/);
    if (!item) break;
    items.push(unquote(item[1]));
  }
  return items;
};

/** Read one agent file: `{ name, model, effort, tools, body }`. */
export function agentDefinition(file) {
  const text = readFileSync(file, "utf8");
  const head = header(text);
  return {
    name: field(head, "name"),
    model: field(head, "model"),
    effort: field(head, "effort"),
    tools: tools(head),
    body: body(text),
  };
}

/** Does this definition hold `tool`? An inherited grant holds everything. */
export const grants = (definition, tool) => definition.tools === null || definition.tools.includes(tool);
