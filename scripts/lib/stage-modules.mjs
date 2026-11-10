#!/usr/bin/env node
// stage-modules — give the pre-flight copy its dependency trees without letting
// the copy resolve back into the checkout, and say which checkout paths the
// tripwire has to watch.
//
//   node stage-modules.mjs stage <root> <ship>   NUL-separated node_modules paths on stdin
//   node stage-modules.mjs watch <checkout> <stage>   prints target and link, NUL-terminated
//
// Both roots must be physical (`pwd -P`); every comparison here is physical.
//
// WHY A REAL DIRECTORY AND NOT ONE LINK (Q-b, ruled 2026-11-09). `coldrun.sh
// --stage-only` used to link each ignored `node_modules` whole. Two defects
// came through that one link, both measured on CopilotKit (pnpm + nx):
//
//   * pnpm's workspace links are relative (`@scope/sibling -> ../../../sibling`),
//     and inside a linked tree "relative" is relative to the CHECKOUT. Every
//     cross-package import in the copy loaded the checkout's sibling, so nx
//     built `dist/` in the copy and the dependent package failed `Failed to
//     resolve entry` against the checkout's unbuilt one — a FAIL on every review
//     that only the stage produced.
//   * vite writes `node_modules/.vite-temp` and vitest `.vite/vitest/…` on every
//     run, so every package tripped the wire: 307 of 310 TRIP entries over 13
//     reviews.
//
// So each staged `node_modules` is a real directory, and each entry in it is
// handled by kind. A link is re-pointed at its physical target, mapped into the
// copy whenever the copy has that path: a workspace sibling lands on the copy's
// own, a store package passes through the copy's link to the checkout's store
// (it is not the code under review), and anything the copy never staged keeps
// today's target. One rule, no notion of "workspace link" in it, which is what
// makes it hold for pnpm, npm and yarn alike.
//
// The cache names below are the one closed list, and it lives in the STAGER on
// purpose: here a missing name surfaces as a TRIP and a wrong one as a FAIL that
// happens only in the copy. Neither can hide a write. The same list in the
// tripwire would decide what an alarm is allowed to say, which is the blind spot
// the wire exists to not have. Add a name only when a TRIP names it — not "all
// dot-dirs start empty": `node_modules/.prisma` holds generated code an app needs.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { isMain } from "../../hooks/lib/config.mjs";

// Measured 2026-11-09 (13 CopilotKit reviews): `.vite-temp` — vite bundles
// `vite.config.*` into it before every run, 297 TRIPs; `.vite` — vitest's results
// cache, 10 TRIPs.
const CACHE_DIRS = new Set([".vite", ".vite-temp"]);

const inside = (p, root) => p === root || p.startsWith(root + path.sep);

function mapper(root, ship) {
  return (target) => {
    if (!inside(target, root)) return target;
    const candidate = path.join(ship, path.relative(root, target));
    return existsSync(candidate) ? candidate : target;
  };
}

function stageDir(src, dest, map, top) {
  mkdirSync(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(from);
      } catch {
        // Dangling in the checkout: dangling in the copy too, and still pointing
        // where it pointed — a relative target would now climb out of the copy.
        symlinkSync(path.resolve(src, readlinkSync(from)), to);
        continue;
      }
      symlinkSync(map(target), to);
    } else if (entry.isDirectory()) {
      if (top && CACHE_DIRS.has(entry.name)) mkdirSync(to);
      // `.bin` too, not only `@scope/`: a pnpm shim runs `$basedir/..`, and
      // through a linked `.bin` that resolves physically into the checkout's
      // node_modules, so a workspace bin would run the checkout's code.
      else if (top && (entry.name === ".bin" || entry.name.startsWith("@"))) stageDir(from, to, map, false);
      else symlinkSync(realpathSync(from), to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, lstatSync(from).mode & 0o7777);
    }
    // Sockets and FIFOs are nobody's dependency; leaving them out is the safe side.
  }
}

/**
 * Stage every `node_modules` in `dirs` (paths under `root`) into the same place
 * under `ship`, shallowest first — so the root's `.pnpm` exists in the copy
 * before a package's links are mapped through it. A tree whose parent the copy
 * did not create is not staged, and neither is one the copy already holds.
 */
export function stageModules(root, ship, dirs) {
  const map = mapper(root, ship);
  const rels = dirs.map((d) => path.relative(root, d))
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || (a < b ? -1 : a > b ? 1 : 0));
  for (const rel of rels) {
    const dest = path.join(ship, rel);
    if (!existsSync(path.dirname(dest))) continue;
    try { lstatSync(dest); continue; } catch { /* not in the copy: stage it */ }
    // A dangling tree is skipped, as the old `[ -e … ] && ln -sfn` loop did.
    let src;
    try { src = realpathSync(path.join(root, rel)); } catch { continue; }
    try {
      stageDir(src, dest, map, true);
    } catch (err) {
      // A tree that cannot be walked entry by entry falls back to the old whole link — its workspace links resolve into the checkout again, but it is staged and watched, which beats losing the copy.
      // `rmSync` on `dest` removes only the copy's own directory of links (it does not follow symlinks).
      rmSync(dest, { recursive: true, force: true });
      symlinkSync(src, dest);
      process.stderr.write(`stage-modules: ${rel}: ${err.code ?? err.message} — linked whole instead; the tripwire watches it\n`);
    }
  }
}

/**
 * The checkout paths the tripwire walks: one line per link in `stage` whose
 * physical target is inside `checkout`, deduplicated by target and with any
 * target nested under another dropped — otherwise ~600 store links each re-walk
 * their package, and `.pnpm` is walked once either way. `[{ target, link }]`,
 * `link` relative to `stage`; the first link (sorted) names a shared target.
 */
export function watchedTargets(checkout, stage) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(p);
        } catch {
          // A dangling link is a removed target: its nearest existing directory's
          // mtime is what records the removal, so that is what is walked.
          let text;
          try { text = readlinkSync(p); } catch { continue; }
          let x = path.resolve(path.dirname(p), text);
          while (!existsSync(x) && x !== path.parse(x).root) x = path.dirname(x);
          try { target = realpathSync(x); } catch { continue; }
        }
        if (inside(target, checkout)) found.push({ target, link: path.relative(stage, p) });
      } else if (entry.isDirectory()) walk(p);
    }
  };
  walk(stage);
  // Component-wise, so a directory's descendants sort directly after it and
  // never after a sibling like `pkg-extra` (`-` sorts before `/` byte-wise).
  const parts = (p) => p.split(path.sep);
  const compare = (a, b) => {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length - y.length;
  };
  found.sort((a, b) => compare(a.target, b.target) || (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
  const kept = [];
  for (const item of found) {
    const last = kept.at(-1);
    if (last && inside(item.target, last.target)) continue;
    kept.push(item);
  }
  return kept;
}

if (isMain(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "stage" && a && b) {
    const dirs = readFileSync(0, "utf8").split("\0").filter(Boolean);
    stageModules(a, b, dirs);
  } else if (mode === "watch" && a && b) {
    for (const { target, link } of watchedTargets(a, b)) process.stdout.write(`${target}\0${link}\0`);
  } else {
    process.stderr.write("usage: stage-modules.mjs stage <root> <ship> < NUL-separated dirs | watch <checkout> <stage>\n");
    process.exit(2);
  }
}
