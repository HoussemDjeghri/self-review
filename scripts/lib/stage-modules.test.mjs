import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageModules, watchedTargets } from "./stage-modules.mjs";

function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "stage-modules-")));
  const co = path.join(base, "co");
  const ship = path.join(base, "ship");
  mkdirSync(co);
  mkdirSync(ship);
  return { base, co, ship };
}

test("a dangling node_modules tree is skipped, and the rest is staged", () => {
  const { co, ship } = fixture();
  mkdirSync(path.join(co, "a", "node_modules"), { recursive: true });
  writeFileSync(path.join(co, "a", "node_modules", "x.js"), "");
  mkdirSync(path.join(co, "b"));
  symlinkSync(path.join(co, "nowhere"), path.join(co, "b", "node_modules"));
  mkdirSync(path.join(ship, "a"));
  mkdirSync(path.join(ship, "b"));
  assert.doesNotThrow(() =>
    stageModules(co, ship, [path.join(co, "a", "node_modules"), path.join(co, "b", "node_modules")]));
  assert.ok(lstatSync(path.join(ship, "a", "node_modules", "x.js")).isFile());
  assert.throws(() => lstatSync(path.join(ship, "b", "node_modules")));
});

test("a tree that cannot be walked is linked whole", { skip: process.getuid?.() === 0 }, () => {
  const { co, ship } = fixture();
  const nm = path.join(co, "a", "node_modules");
  mkdirSync(path.join(nm, "sub"), { recursive: true });
  mkdirSync(path.join(ship, "a"));
  chmodSync(nm, 0o311);
  try {
    stageModules(co, ship, [nm]);
  } finally {
    chmodSync(nm, 0o755);
  }
  const dest = path.join(ship, "a", "node_modules");
  assert.ok(lstatSync(dest).isSymbolicLink());
  assert.equal(realpathSync(dest), nm);
});

test("watch keeps one link per target, drops nested targets, and keeps a byte-wise-earlier sibling", () => {
  const { base, co, ship } = fixture();
  mkdirSync(path.join(co, "p", "sub"), { recursive: true });
  mkdirSync(path.join(co, "p-extra"));
  const outside = path.join(base, "outside");
  mkdirSync(outside);
  symlinkSync(path.join(co, "p"), path.join(ship, "l1"));
  symlinkSync(path.join(co, "p"), path.join(ship, "l2"));
  symlinkSync(path.join(co, "p", "sub"), path.join(ship, "l3"));
  symlinkSync(path.join(co, "p-extra"), path.join(ship, "l4"));
  symlinkSync(outside, path.join(ship, "outside"));
  assert.deepEqual(watchedTargets(co, ship), [
    { target: path.join(co, "p"), link: "l1" },
    { target: path.join(co, "p-extra"), link: "l4" },
  ]);
});

test("a link whose checkout target is gone is watched at its nearest existing directory", () => {
  const { co, ship } = fixture();
  mkdirSync(path.join(co, "nm", "foo"), { recursive: true });
  symlinkSync(path.join(co, "nm", "foo"), path.join(ship, "foo"));
  rmSync(path.join(co, "nm", "foo"), { recursive: true });
  assert.ok(!existsSync(path.join(ship, "foo")));
  assert.deepEqual(watchedTargets(co, ship), [{ target: path.join(co, "nm"), link: "foo" }]);
});
