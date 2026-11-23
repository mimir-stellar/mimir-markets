import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArgs as parseRunnerArgs } from "../../scripts/run-node-tests.mjs";

const parseArgs = parseRunnerArgs as (args: string[]) => Record<string, unknown>;

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/run-node-tests.mjs", ...args], { encoding: "utf8" });
}

test("machine-readable help describes default values, aliases and both path syntaxes", () => {
  const result = runCli("--help-json", "no-such-test-file");
  assert.equal(result.status, 0, result.stderr);
  const { flags }: { flags: Array<{ name: string; default: unknown; negations?: string[] }> } =
    JSON.parse(result.stdout);
  const cache = flags.find((flag) => flag.name === "--cache");
  assert.ok(cache?.negations);
  assert.equal(cache.default, true);
  assert.deepEqual(cache.negations, ["--no-cache", "--no-compile-cache"]);
  assert.equal(parseArgs([]).cache, cache.default);
  for (const name of cache.negations) {
    assert.equal(parseArgs([name]).cache, false);
    assert.equal(parseArgs([name, cache.name]).cache, true);
  }
  assert.deepEqual(parseArgs(["--coverage-dir", "dir=one"]), parseArgs(["--coverage-dir=dir=one"]));
  assert.equal(parseArgs(["--coverage-dir=dir=one"]).coverage, true);
});

test("human help works through its alias and includes cache flags", () => {
  const result = runCli("-h");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/);
  assert.match(result.stdout, /--no-cache, --no-compile-cache/);
  assert.match(result.stdout, /--help-json/);
});

test("invalid flags still fail explicitly even when help was requested", () => {
  for (const invalid of ["--hepl", "--cache=false"]) {
    const result = runCli("--help-json", invalid);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unknown node test option/);
  }
});
