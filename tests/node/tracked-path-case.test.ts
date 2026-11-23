import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/check-tracked-path-case.mjs");

test("checks indexed files and directories without checking out either spelling", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mimir-path-case-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd, input, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["config", "core.ignorecase", "false"]);
  const blob = git(["hash-object", "-w", "--stdin"], "").trim();
  // Git for Windows otherwise silently skips the newline fixture during update-index.
  const stage = (paths: string[]) =>
    git(
      ["-c", "core.protectNTFS=false", "update-index", "-z", "--index-info"],
      paths.map((p) => `100644 ${blob}\t${p}\0`).join(""),
    );
  const check = () => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });

  const initial = ["docs/b.md", "src/name\nfile.ts", "src/é space.ts"];
  const indexed = () => git(["ls-files", "--cached", "-z"]).split("\0").filter(Boolean).sort();
  stage(initial);
  assert.deepEqual(indexed(), [...initial].sort());
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stderr, "");

  const additions = ["src/Name\nfile.ts", "Docs/a.md", "src/É space.ts"];
  stage(additions);
  assert.deepEqual(indexed(), [...initial, ...additions].sort());
  const clash = check();
  assert.equal(clash.status, 1);
  assert.deepEqual(clash.stderr.trimEnd().split(/\r?\n/), [
    'Case-only tracked path collision: "Docs" / "docs"',
    'Case-only tracked path collision: "src/Name\\nfile.ts" / "src/name\\nfile.ts"',
    'Case-only tracked path collision: "src/É space.ts" / "src/é space.ts"',
  ]);
});
