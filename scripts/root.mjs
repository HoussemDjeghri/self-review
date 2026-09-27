#!/usr/bin/env node
/**
 * root.mjs — print the installed plugin's root directory.
 *
 * For a session that receives `${CLAUDE_PLUGIN_ROOT}` unexpanded. The answer is
 * the install Claude Code recorded in `installed_plugins.json`, never the newest
 * folder in the cache: the cache keeps every version, and a modification time
 * says which was touched last, not which is installed.
 *
 * Usage: node <any installed copy>/scripts/root.mjs   (takes no arguments)
 * Falls back to this file's own plugin root when the record has no usable entry.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isMain, pluginName } from "../hooks/lib/config.mjs";

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function configDir(env) {
  const cfg = env.CLAUDE_CONFIG_DIR;
  if (!cfg) return path.join(homedir(), ".claude");
  return cfg.startsWith("~") ? path.join(homedir(), cfg.replace(/^~[/\\]?/, "")) : cfg;
}

const isWithin = (dir, parent) => {
  const rel = path.relative(parent, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * The install that applies to `cwd`: a project-scoped install whose project
 * contains it (the deepest one), else the user-scoped install, else the first
 * recorded. Entries whose directory is gone are skipped.
 */
export function installedRoot({ env = process.env, cwd = process.cwd(), ownRoot = OWN_ROOT } = {}) {
  const name = pluginName(ownRoot) || "self-review";
  let record;
  try {
    record = JSON.parse(readFileSync(path.join(configDir(env), "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return ownRoot;
  }
  const entries = Object.entries(record?.plugins ?? {})
    .filter(([key]) => key.startsWith(`${name}@`))
    .flatMap(([, list]) => (Array.isArray(list) ? list : []))
    .filter((entry) => typeof entry?.installPath === "string" && existsSync(entry.installPath));
  const project = entries
    .filter((entry) => entry.projectPath && isWithin(path.resolve(cwd), path.resolve(entry.projectPath)))
    .sort((a, b) => b.projectPath.length - a.projectPath.length)[0];
  const chosen = project ?? entries.find((entry) => entry.scope === "user") ?? entries[0];
  return chosen?.installPath ?? ownRoot;
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write(`root.mjs: takes no arguments (got ${process.argv.slice(2).join(" ")})\nusage: node <plugin>/scripts/root.mjs\n`);
    process.exit(2);
  }
  console.log(installedRoot());
}
