import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getSchemaStatements } from "../../lib/db";
import {
  buildSchemaSnapshot,
  verifyRepoSchemaSnapshot,
  type SchemaStatement,
} from "../../lib/ops/schema-snapshot";
import {
  ROLLBACK_READINESS_KIND,
  ROLLBACK_READINESS_SCHEMA_VERSION,
  buildRollbackReadinessReport,
  formatRollbackReadinessReport,
  serializeRollbackReadinessReport,
  type RollbackReadinessReport,
} from "../../lib/ops/rollback-readiness";

const MIGRATION_SQL =
  "INSERT INTO schema_migrations(migration_id, schema_version, checksum, applied_at) VALUES($1, $2, $3, $4)";

const STATEMENTS: SchemaStatement[] = [
  { sql: "CREATE TABLE IF NOT EXISTS alpha (\n  id TEXT PRIMARY KEY\n)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_alpha_id ON alpha(id)" },
  { sql: MIGRATION_SQL, args: ["alpha-v1", 1, "alpha-checksum-v1", 0] },
];

const DIGEST = "a".repeat(64);

interface RepoOptions {
  pinned?: boolean;
  snapshot?: boolean;
  statements?: SchemaStatement[];
}

/** Synthetic repo root: a manifest and (optionally) a committed schema snapshot. */
function makeRepo(options: RepoOptions = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rollback-readiness-"));
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, "schemas"), { recursive: true });
  const artifact = (id: string) => ({
    id,
    crate: id,
    sourceDir: `contracts/${id}`,
    wasmPath: `target/${id}.wasm`,
    buildTarget: "wasm32v1-none",
    profile: "release",
    sha256: options.pinned ? DIGEST : null,
  });
  writeFileSync(
    join(root, "deploy", "contract-artifacts.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      hashAlgorithm: "sha256",
      artifacts: [artifact("alpha-market"), artifact("beta-squad")],
    }),
  );
  if (options.snapshot !== false) {
    writeFileSync(
      join(root, "schemas", "db-schema.snapshot.json"),
      JSON.stringify(buildSchemaSnapshot(options.statements ?? STATEMENTS)),
    );
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const allFilesPresent = () => true;

function blockerCodes(report: RollbackReadinessReport): string[] {
  return report.blockers.map((blocker) => blocker.code);
}

// ── Positive ──────────────────────────────────────────────────────────────

test("positive: the repository report lists predecessor artifacts, schema assumptions and blockers", () => {
  const statements = getSchemaStatements();
  const report = buildRollbackReadinessReport({ repoRoot: process.cwd(), statements });

  assert.equal(report.schemaVersion, ROLLBACK_READINESS_SCHEMA_VERSION);
  assert.equal(report.kind, ROLLBACK_READINESS_KIND);
  assert.equal(report.mode, "develop");

  const ids = report.predecessorArtifacts.map((artifact) => artifact.id);
  assert.ok(ids.includes("contract-wasm:mimir-market"));
  assert.ok(ids.includes("contract-wasm:mimir-squad"));
  assert.ok(ids.includes("file:schemas/db-schema.snapshot.json"));
  assert.ok(ids.includes("file:docs/ROLLBACK.md"));
  assert.ok(ids.includes("file:docs/AGENT_INCIDENT_RUNBOOK.md"));
  assert.ok(
    report.predecessorArtifacts.every((artifact) => artifact.status !== "missing"),
    "every required rollback input is committed",
  );

  // The drift assumption must agree with the independent snapshot gate, so this
  // test tracks the repository instead of freezing its current schema state.
  const drift = verifyRepoSchemaSnapshot({ repoRoot: process.cwd(), statements });
  const assumption = (id: string) =>
    report.schemaAssumptions.find((candidate) => candidate.id === id);
  assert.equal(assumption("snapshot-committed")?.status, "holds");
  assert.equal(assumption("schema-matches-snapshot")?.status, drift.ok ? "holds" : "violated");
  assert.equal(report.ok, drift.ok);

  // Nothing is pinned or evidenced on a clean checkout: honest warnings, and
  // the only possible errors are schema findings.
  assert.equal(report.rollbackReady, false);
  assert.ok(
    report.blockers
      .filter((blocker) => blocker.severity === "error")
      .every((blocker) => blocker.source === "schema-snapshot"),
  );
  assert.ok(blockerCodes(report).includes("DIGEST_UNPINNED"));
  assert.ok(blockerCodes(report).includes("GATE_NOT_EVIDENCED"));
});

test("positive: a fully pinned, evidenced, drift-free repo is rollback ready", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  try {
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      mode: "release",
      statements: STATEMENTS,
      fileExists: allFilesPresent,
      evidence: {
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: {
          "cache-backup-verify": { status: "pass" },
          "rollback-rehearsal": { status: "pass", detail: "rehearsed on testnet" },
        },
      },
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.ok, true);
    assert.equal(report.rollbackReady, true);
    const pins = report.predecessorArtifacts.filter((a) => a.kind === "contract-wasm-pin");
    assert.deepEqual(
      pins.map((pin) => [pin.id, pin.status, pin.sha256]),
      [
        ["contract-wasm:alpha-market", "pinned", DIGEST],
        ["contract-wasm:beta-squad", "pinned", DIGEST],
      ],
    );
  } finally {
    cleanup();
  }
});

// ── Failure and boundary ──────────────────────────────────────────────────

test("boundary: unpinned digests are a warning in develop mode and an error in release mode", () => {
  const { root, cleanup } = makeRepo({ pinned: false });
  try {
    const develop = buildRollbackReadinessReport({
      repoRoot: root,
      statements: STATEMENTS,
      fileExists: allFilesPresent,
    });
    const release = buildRollbackReadinessReport({
      repoRoot: root,
      mode: "release",
      statements: STATEMENTS,
      fileExists: allFilesPresent,
    });
    const unpinned = (report: RollbackReadinessReport) =>
      report.blockers.filter((blocker) => blocker.code === "DIGEST_UNPINNED");

    assert.equal(unpinned(develop).length, 2);
    assert.ok(unpinned(develop).every((blocker) => blocker.severity === "warning"));
    assert.equal(develop.ok, true);

    assert.ok(unpinned(release).every((blocker) => blocker.severity === "error"));
    assert.equal(release.ok, false);
    assert.equal(release.rollbackReady, false);
    assert.equal(
      release.predecessorArtifacts.find((a) => a.id === "contract-wasm:alpha-market")?.status,
      "unpinned",
    );
  } finally {
    cleanup();
  }
});

test("failure: a missing required runbook is always an error, even in develop mode", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  try {
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      statements: STATEMENTS,
      fileExists: (relative) => relative !== "docs/ROLLBACK.md",
    });
    const missing = report.blockers.filter(
      (blocker) => blocker.code === "PREDECESSOR_ARTIFACT_MISSING",
    );
    assert.equal(missing.length, 1);
    assert.equal(missing[0].severity, "error");
    assert.match(missing[0].message, /docs\/ROLLBACK\.md/);
    assert.equal(report.ok, false);
    assert.equal(
      report.predecessorArtifacts.find((a) => a.id === "file:docs/ROLLBACK.md")?.status,
      "missing",
    );
  } finally {
    cleanup();
  }
});

test("failure: schema drift violates the matching assumption and blocks", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  try {
    const drifted: SchemaStatement[] = [
      ...STATEMENTS,
      { sql: "CREATE TABLE IF NOT EXISTS gamma (\n  id TEXT PRIMARY KEY\n)" },
    ];
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      statements: drifted,
      fileExists: allFilesPresent,
    });
    const status = (id: string) =>
      report.schemaAssumptions.find((assumption) => assumption.id === id)?.status;
    assert.equal(status("snapshot-committed"), "holds");
    assert.equal(status("schema-matches-snapshot"), "violated");
    assert.ok(blockerCodes(report).includes("TABLE_DRIFT"));
    assert.equal(report.ok, false);
  } finally {
    cleanup();
  }
});

test("failure: a missing committed snapshot violates snapshot-committed", () => {
  const { root, cleanup } = makeRepo({ pinned: true, snapshot: false });
  try {
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      statements: STATEMENTS,
      fileExists: (relative) => relative !== "schemas/db-schema.snapshot.json",
    });
    assert.equal(
      report.schemaAssumptions.find((a) => a.id === "snapshot-committed")?.status,
      "violated",
    );
    assert.ok(blockerCodes(report).includes("SNAPSHOT_MISSING"));
    assert.equal(report.ok, false);
  } finally {
    cleanup();
  }
});

test("failure: duplicate migration versions violate migration-versions-unique", () => {
  const duplicated: SchemaStatement[] = [
    ...STATEMENTS,
    { sql: MIGRATION_SQL, args: ["alpha-v1-again", 1, "other-checksum", 0] },
  ];
  const { root, cleanup } = makeRepo({ pinned: true, statements: duplicated });
  try {
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      statements: duplicated,
      fileExists: allFilesPresent,
    });
    assert.equal(
      report.schemaAssumptions.find((a) => a.id === "migration-versions-unique")?.status,
      "violated",
    );
    assert.ok(blockerCodes(report).includes("MIGRATION_DUPLICATE_VERSION"));
  } finally {
    cleanup();
  }
});

test("boundary: without schema statements the drift assumptions are unverified, fail-closed in release", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  try {
    const develop = buildRollbackReadinessReport({ repoRoot: root, fileExists: allFilesPresent });
    const release = buildRollbackReadinessReport({
      repoRoot: root,
      mode: "release",
      fileExists: allFilesPresent,
    });
    for (const report of [develop, release]) {
      assert.equal(
        report.schemaAssumptions.find((a) => a.id === "schema-matches-snapshot")?.status,
        "unverified",
      );
      assert.equal(
        report.schemaAssumptions.find((a) => a.id === "snapshot-committed")?.status,
        "holds",
      );
    }
    const severity = (report: RollbackReadinessReport) =>
      report.blockers.find((blocker) => blocker.code === "SCHEMA_UNVERIFIED")?.severity;
    assert.equal(severity(develop), "warning");
    assert.equal(severity(release), "error");
  } finally {
    cleanup();
  }
});

test("failure: a failed or missing rollback gate is a blocker; other gates are not reported", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  try {
    const failed = buildRollbackReadinessReport({
      repoRoot: root,
      statements: STATEMENTS,
      fileExists: allFilesPresent,
      evidence: {
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: {
          "rollback-rehearsal": { status: "fail", detail: "restore dry-run aborted" },
          "cache-backup-verify": { status: "pass" },
        },
      },
    });
    const gateBlockers = failed.blockers.filter((b) => b.source === "release-readiness");
    assert.deepEqual(
      gateBlockers.map((b) => [b.code, b.severity, b.subject]),
      [["GATE_FAILED", "error", "rollback-rehearsal"]],
    );
    assert.equal(failed.ok, false);

    const release = buildRollbackReadinessReport({
      repoRoot: root,
      mode: "release",
      statements: STATEMENTS,
      fileExists: allFilesPresent,
    });
    const missing = release.blockers.filter((b) => b.code === "GATE_MISSING_EVIDENCE");
    assert.deepEqual(missing.map((b) => b.subject).sort(), [
      "cache-backup-verify",
      "rollback-rehearsal",
    ]);
    assert.ok(missing.every((b) => b.severity === "error"));
  } finally {
    cleanup();
  }
});

test("failure: malformed evidence fails closed and never echoes secret-shaped values", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  const secret = `S${"A".repeat(55)}`;
  try {
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      mode: "release",
      statements: STATEMENTS,
      fileExists: allFilesPresent,
      evidence: {
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: { "rollback-rehearsal": { status: "pass", detail: secret } },
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.rollbackReady, false);
    assert.ok(report.blockers.some((b) => b.source === "release-readiness" && b.severity === "error"));
    assert.equal(serializeRollbackReadinessReport(report).includes(secret), false);
    assert.equal(formatRollbackReadinessReport(report).includes(secret), false);

    const invalid = buildRollbackReadinessReport({
      repoRoot: root,
      statements: STATEMENTS,
      fileExists: allFilesPresent,
      evidence: { results: { "rollback-rehearsal": { status: "waived" } } },
    });
    assert.ok(blockerCodes(invalid).includes("EVIDENCE_INVALID"));
    assert.equal(invalid.ok, false);
  } finally {
    cleanup();
  }
});

test("failure: an unreadable manifest is reported as a blocker instead of throwing", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  try {
    writeFileSync(join(root, "deploy", "contract-artifacts.manifest.json"), "{not json");
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      statements: STATEMENTS,
      fileExists: allFilesPresent,
    });
    assert.ok(blockerCodes(report).includes("MANIFEST_INVALID"));
    assert.equal(report.ok, false);
    assert.equal(
      report.predecessorArtifacts.some((a) => a.kind === "contract-wasm-pin"),
      false,
    );
  } finally {
    cleanup();
  }
});

// ── Offline guarantees and determinism ────────────────────────────────────

test("offline: building the report writes nothing and ignores the environment", () => {
  const { root, cleanup } = makeRepo({ pinned: true });
  const before = JSON.stringify(readdirSync(root, { recursive: true }).sort());
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://user:hunter2@example.invalid/db";
  try {
    const report = buildRollbackReadinessReport({
      repoRoot: root,
      statements: STATEMENTS,
      fileExists: allFilesPresent,
    });
    const text = `${serializeRollbackReadinessReport(report)}${formatRollbackReadinessReport(report)}`;
    assert.equal(text.includes("hunter2"), false);
    assert.equal(JSON.stringify(readdirSync(root, { recursive: true }).sort()), before);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    cleanup();
  }
});

test("determinism: two builds from the same inputs serialize byte-identically", () => {
  const { root, cleanup } = makeRepo({ pinned: false });
  try {
    const options = { repoRoot: root, statements: STATEMENTS, fileExists: allFilesPresent };
    const first = serializeRollbackReadinessReport(buildRollbackReadinessReport(options));
    const second = serializeRollbackReadinessReport(buildRollbackReadinessReport(options));
    assert.equal(first, second);
    assert.ok(first.endsWith("\n"));
    assert.equal(
      JSON.parse(first).kind,
      ROLLBACK_READINESS_KIND,
    );
  } finally {
    cleanup();
  }
});

test("format: the text report names artifacts, assumptions and blockers", () => {
  const { root, cleanup } = makeRepo({ pinned: false });
  try {
    const text = formatRollbackReadinessReport(
      buildRollbackReadinessReport({
        repoRoot: root,
        mode: "release",
        statements: STATEMENTS,
        fileExists: allFilesPresent,
      }),
    );
    assert.match(text, /Predecessor artifacts/);
    assert.match(text, /Schema assumptions/);
    assert.match(text, /Blockers/);
    assert.match(text, /contract-wasm:alpha-market/);
    assert.match(text, /DIGEST_UNPINNED/);
    assert.match(text, /NOT READY/);
  } finally {
    cleanup();
  }
});
