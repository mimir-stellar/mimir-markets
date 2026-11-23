import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ALL_TIERS,
  allTiers,
  scopeOf,
  scopesForPaths,
  type Scope,
} from "./path-scope";

function scopedTiers(scope: Scope): string[] {
  assert.equal(scope.kind, "scoped", `expected scoped, got ${scope.kind}`);
  return [...scope.tiers].sort();
}

test("app directory maps to the app tier only", () => {
  assert.deepEqual(scopedTiers(scopeOf("app/page.tsx")), ["app"]);
});

test("contracts directory maps to the contracts tier only", () => {
  assert.deepEqual(
    scopedTiers(scopeOf("contracts-soroban/src/lib.rs")),
    ["contracts"],
  );
});

test("shared lib/ fans out to app, agents and tests", () => {
  assert.deepEqual(scopedTiers(scopeOf("lib/ci/path-scope.ts")), [
    "agents",
    "app",
    "tests",
  ]);
});

test("shared root files enable every tier", () => {
  assert.deepEqual(scopedTiers(scopeOf(".nvmrc")), [...ALL_TIERS].sort());
});

test("file-level scope applies to exact match only", () => {
  assert.deepEqual(scopedTiers(scopeOf("package.json")), [
    "agents",
    "app",
    "tests",
  ]);
});

test("docs and root doc files are doc-only and enable nothing", () => {
  assert.deepEqual(scopeOf("docs/AGENTS.md"), { kind: "doc" });
  assert.deepEqual(scopeOf("README.md"), { kind: "doc" });
  assert.deepEqual(scopesForPaths(["docs/a.md", "LICENSE"]), { kind: "doc" });
});

test("unclassified root-level file fails closed as unknown", () => {
  assert.deepEqual(scopeOf("new-config.yaml"), { kind: "unknown" });
});

test("unknown path poisons the whole change even alongside known paths", () => {
  assert.deepEqual(
    scopesForPaths(["app/page.tsx", "mystery-root-file"]),
    { kind: "unknown" },
  );
});

test("unknown nested path under a known prefix is still classified by prefix", () => {
  assert.deepEqual(scopedTiers(scopeOf("tests/node/new.test.ts")), ["tests"]);
});

test("combined change unions tiers and ignores doc-only entries", () => {
  assert.deepEqual(
    scopedTiers(scopesForPaths(["agents/worker.ts", "docs/x.md", "contracts-soroban/a.rs"])),
    ["agents", "contracts"],
  );
});

test("allTiers returns every known tier", () => {
  assert.deepEqual([...allTiers()].sort(), ["agents", "app", "contracts", "tests"]);
});
