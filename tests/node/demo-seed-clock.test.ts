import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DEMO_SEED_NOW,
  resolveSeedNow,
} from "../../scripts/lib/demo-seed-clock";

test("dry-run uses a stable reference timestamp without environment secrets", () => {
  assert.equal(resolveSeedNow({ dryRun: true, env: {} }), DEFAULT_DEMO_SEED_NOW);
  assert.equal(resolveSeedNow({ dryRun: true, env: {} }), DEFAULT_DEMO_SEED_NOW);
});

test("dry-run accepts an explicit deterministic timestamp", () => {
  assert.equal(
    resolveSeedNow({ dryRun: true, env: { DEMO_SEED_NOW: "1704067200" } }),
    1704067200,
  );
});

test("live seeding uses the current clock and ignores the preview timestamp", () => {
  assert.equal(
    resolveSeedNow({
      dryRun: false,
      env: { DEMO_SEED_NOW: "1704067200" },
      now: () => 1_800_000_123_000,
    }),
    1_800_000_123,
  );
});

test("invalid preview timestamps fail closed", () => {
  assert.throws(
    () => resolveSeedNow({ dryRun: true, env: { DEMO_SEED_NOW: "not-a-timestamp" } }),
    /DEMO_SEED_NOW must be a Unix timestamp/,
  );
  assert.throws(
    () => resolveSeedNow({ dryRun: true, env: { DEMO_SEED_NOW: "0" } }),
    /DEMO_SEED_NOW must be a positive safe Unix timestamp/,
  );
});
