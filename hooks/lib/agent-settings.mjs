/**
 * Model and effort per agent type, read from config/agents.json — the one
 * place either is edited (the agent files mirror it; agent-settings.test.mjs
 * holds them equal). Before this table they were literals in five
 * agent files, tier.mjs, brief.mjs and SKILL.md, and the effort in a plan row
 * was never passed to the Agent call at all, so a risk finder raised to opus
 * ran at whatever the finder's frontmatter said.
 *
 * Unlike config.mjs this throws: only scripts call it, never a hook at module
 * scope, and a missing row printed as a call without a model would quietly
 * spawn the reviewer on the session's model — the failure the pins exist for.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PLUGIN_ROOT } from "./config.mjs";

export const AGENTS_PATH = path.join(PLUGIN_ROOT, "config", "agents.json");
const PREFIX = "self-review-";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

let cache = null;
const load = () => (cache ??= JSON.parse(readFileSync(AGENTS_PATH, "utf8")));

/** The table's key for an agent file name: `self-review-verifier` → `verifier`. */
export const roleOf = (agent) => (agent.startsWith(PREFIX) ? agent.slice(PREFIX.length) : agent);

/** `{ model, effort }` for a role, or for an agent name. Throws on an unknown one. */
export function agentSettings(roleOrAgent) {
  const role = roleOf(roleOrAgent);
  const table = load();
  if (role.startsWith("$") || !Object.hasOwn(table, role)) throw new Error(`config/agents.json has no row for "${role}"`);
  return rowSettings(role, table[role]);
}

/** `{ model, effort }` from a table row, or a throw naming what is wrong with it. */
export function rowSettings(role, row) {
  const { model, effort } = row ?? {};
  if (typeof model !== "string" || model === "") throw new Error(`config/agents.json row "${role}" has no model`);
  if (!EFFORTS.has(effort)) throw new Error(`config/agents.json row "${role}" has effort ${JSON.stringify(effort)}, not one of ${[...EFFORTS].join("|")}`);
  return { model, effort };
}

/** Settings for a finder plan row: a row marked `risk` runs as the risk finder. */
export const finderSettings = (agent, row) => agentSettings(row.risk ? "risk-finder" : agent);

/** Every role the table defines, comments excluded. */
export const roles = () => Object.keys(load()).filter((key) => !key.startsWith("$"));
