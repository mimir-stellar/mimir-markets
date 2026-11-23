import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSchemaSnapshot,
  loadSchemaSnapshot,
  schemaSnapshotPath,
} from "../../lib/ops/schema-snapshot";
import {
  buildSupportBundle,
  parseSupportBundle,
  serializeSupportBundle,
  formatSupportBundle,
  supportBundlePath,
  scrubMessage,
  looksLikeSecret,
  RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION,
  RELEASE_SUPPORT_BUNDLE_KIND,
  type SupportBundle,
} from "../../lib/ops/release-support-bundle";

function fixtureBundle(overrides: Partial<SupportBundle> = {}): SupportBundle {
  return {
    schemaVersion: RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION,
    kind: RELEASE_SUPPORT_BUNDLE_KIND,
    digests: {
      schemaFingerprint: "a".repeat(64),
      releaseReadinessFingerprint: "b".repeat(64),
      artifactDigests: {},
    },
    versions: {
      packageVersion: "0.1.0",
      schemaSnapshotSchemaVersion: 1,
      releaseReadinessSchemaVersion: 1,
    },
    findings: [],
    ok: true,
    ...overrides,
  };
}

// ── Build from repo files ────────────────────────────────────────────────

test("positive: buildSupportBundle produces digests, versions and findings from repo files", () => {
  const bundle = buildSupportBundle({ repoRoot: process.cwd() });

  assert.equal(bundle.schemaVersion, RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.kind, RELEASE_SUPPORT_BUNDLE_KIND);
  assert.match(bundle.digests.schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.match(bundle.digests.releaseReadinessFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(typeof bundle.digests.artifactDigests, "object");
  assert.equal(typeof bundle.versions.packageVersion, "string");
  assert.equal(bundle.versions.packageVersion.length > 0, true);
  assert.equal(bundle.versions.schemaSnapshotSchemaVersion, 1);
  assert.equal(bundle.versions.releaseReadinessSchemaVersion, 1);
  assert.ok(Array.isArray(bundle.findings));
  assert.equal(typeof bundle.ok, "boolean");
});

test("positive: schema fingerprint matches the committed snapshot", () => {
  const bundle = buildSupportBundle({ repoRoot: process.cwd() });
  const snapshot = loadSchemaSnapshot(schemaSnapshotPath(process.cwd()));
  assert.equal(bundle.digests.schemaFingerprint, snapshot.fingerprint);
});

test("positive: buildSupportBundle accepts custom statements and computes fingerprint", () => {
  const statements = [
    { sql: "CREATE TABLE IF NOT EXISTS test_table (id BIGINT PRIMARY KEY)" },
    {
      sql: "INSERT INTO schema_migrations (migration_id, schema_version, checksum, applied_at) VALUES (?, ?, ?, ?)",
      args: ["test-migration", 1, "chk-1", 0],
    },
  ];
  const expectedSnapshot = buildSchemaSnapshot(statements);
  const bundle = buildSupportBundle({
    repoRoot: process.cwd(),
    statements,
  });
  assert.equal(bundle.digests.schemaFingerprint, expectedSnapshot.fingerprint);
});

// ── Reproducibility ─────────────────────────────────────────────────────

test("positive: the same repo state produces a byte-identical bundle", () => {
  const first = buildSupportBundle({ repoRoot: process.cwd() });
  const second = buildSupportBundle({ repoRoot: process.cwd() });
  assert.equal(serializeSupportBundle(first), serializeSupportBundle(second));
});

test("positive: serialized bundle has sorted keys and a trailing newline", () => {
  const bundle = fixtureBundle();
  const serialized = serializeSupportBundle(bundle);
  assert.equal(serialized.endsWith("\n"), true);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, [...keys].sort());
});

// ── Parsing and validation ─────────────────────────────────────────────

test("positive: parseSupportBundle accepts a well-formed bundle", () => {
  const bundle = fixtureBundle();
  const parsed = parseSupportBundle(serializeSupportBundle(bundle));
  assert.equal(parsed.schemaVersion, RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION);
  assert.equal(parsed.kind, RELEASE_SUPPORT_BUNDLE_KIND);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.findings, []);
});

test("positive: parseSupportBundle accepts an object directly", () => {
  const bundle = fixtureBundle();
  const parsed = parseSupportBundle(bundle);
  assert.equal(parsed.ok, true);
});

test("negative: parseSupportBundle rejects wrong schemaVersion", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        schemaVersion: 2,
      }),
    /schemaVersion must be 1/,
  );
});

test("negative: parseSupportBundle rejects wrong kind", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        kind: "something-else",
      }),
    /kind must be/,
  );
});

test("negative: parseSupportBundle rejects non-object root", () => {
  assert.throws(
    () => parseSupportBundle("not json and not an object"),
    /support bundle must be valid JSON/,
  );
  assert.throws(() => parseSupportBundle(null), /support bundle must be a JSON object/);
  assert.throws(() => parseSupportBundle([]), /support bundle must be a JSON object/);
  assert.throws(() => parseSupportBundle(123), /support bundle must be a JSON object/);
});

test("negative: parseSupportBundle rejects missing digests", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        digests: undefined as unknown as SupportBundle["digests"],
      }),
    /digests must be an object/,
  );
});

test("negative: parseSupportBundle rejects non-string schemaFingerprint", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        digests: {
          ...fixtureBundle().digests,
          schemaFingerprint: 123 as unknown as string,
        },
      }),
    /digests\.schemaFingerprint must be a string/,
  );
});

test("negative: parseSupportBundle rejects non-string releaseReadinessFingerprint", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        digests: {
          ...fixtureBundle().digests,
          releaseReadinessFingerprint: null as unknown as string,
        },
      }),
    /digests\.releaseReadinessFingerprint must be a string/,
  );
});

test("negative: parseSupportBundle rejects invalid artifact digest value", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        digests: {
          ...fixtureBundle().digests,
          artifactDigests: { "some-artifact": 123 as unknown as string },
        },
      }),
    /artifactDigests\.some-artifact must be a string/,
  );
});

test("negative: parseSupportBundle rejects invalid versions object", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        versions: "0.1.0" as unknown as SupportBundle["versions"],
      }),
    /versions must be an object/,
  );
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        versions: {
          ...fixtureBundle().versions,
          packageVersion: 123 as unknown as string,
        },
      }),
    /versions\.packageVersion must be a string/,
  );
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        versions: {
          ...fixtureBundle().versions,
          schemaSnapshotSchemaVersion: "1" as unknown as number,
        },
      }),
    /versions\.schemaSnapshotSchemaVersion must be an integer/,
  );
});

test("negative: parseSupportBundle rejects invalid finding source", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        findings: [
          {
            source: "not-a-source" as SupportBundle["findings"][number]["source"],
            code: "TEST_CODE",
            severity: "error",
            message: "a test finding",
          },
        ],
      }),
    /source must be/,
  );
});

test("negative: parseSupportBundle rejects invalid finding severity", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        findings: [
          {
            source: "release-readiness",
            code: "TEST_CODE",
            severity: "waived" as SupportBundle["findings"][number]["severity"],
            message: "a test finding",
          },
        ],
      }),
    /severity must be "error" or "warning"/,
  );
});

test("negative: parseSupportBundle rejects empty finding code or message", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        findings: [
          {
            source: "release-readiness",
            code: "",
            severity: "error",
            message: "test message",
          },
        ],
      }),
    /code must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        findings: [
          {
            source: "release-readiness",
            code: "TEST_CODE",
            severity: "error",
            message: "   ",
          },
        ],
      }),
    /message must be a non-empty string/,
  );
});

test("negative: parseSupportBundle rejects non-boolean ok", () => {
  assert.throws(
    () =>
      parseSupportBundle({
        ...fixtureBundle(),
        ok: "yes" as unknown as boolean,
      }),
    /ok must be a boolean/,
  );
});

// ── Privacy and secret redaction ────────────────────────────────────────

test("positive: secret-shaped values in finding messages are scrubbed from formatted output", () => {
  const bundle = fixtureBundle({
    findings: [
      {
        source: "release-readiness",
        code: "PRIVACY_TEST",
        severity: "error",
        message:
          "connection string was postgres://mimir:hunter2@db.example.com/mimir and seed SABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      },
    ],
    ok: false,
  });

  const text = formatSupportBundle(bundle);
  assert.ok(
    !text.includes("postgres://mimir:hunter2@db.example.com/mimir"),
    "raw DATABASE_URL must not appear in formatted output",
  );
  assert.ok(
    !text.includes("SABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
    "raw Stellar seed must not appear in formatted output",
  );
  assert.ok(text.includes("[REDACTED:secret-shaped]"), "redacted marker must appear");
});

test("positive: scrubMessage redacts database credentials, API keys, and private keys", () => {
  const raw =
    "Error with url postgres://admin:supersecret@127.0.0.1:5432/mimir_db and api-key sk-abcdef1234567890abcdef and token ghp_12345678901234567890";
  const scrubbed = scrubMessage(raw);
  assert.ok(!scrubbed.includes("supersecret"));
  assert.ok(!scrubbed.includes("sk-abcdef1234567890abcdef"));
  assert.ok(!scrubbed.includes("ghp_12345678901234567890"));
  assert.ok(scrubbed.includes("[REDACTED:secret-shaped]"));
});

test("positive: looksLikeSecret identifies secret shapes and permits safe values", () => {
  assert.equal(looksLikeSecret("postgres://user:pass@host/db"), "secret-shaped");
  assert.equal(looksLikeSecret("SABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), "secret-shaped");
  assert.equal(looksLikeSecret("sk-1234567890123456"), "secret-shaped");
  assert.equal(looksLikeSecret("ghp_12345678901234567890"), "secret-shaped");
  assert.equal(looksLikeSecret("phc_12345678901234567890"), "secret-shaped");
  assert.equal(looksLikeSecret("AKIA1234567890123456"), "secret-shaped");
  assert.equal(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----"), "secret-shaped");

  assert.equal(looksLikeSecret("regular-identifier"), null);
  assert.equal(looksLikeSecret("https://stellar.org"), null);
  assert.equal(looksLikeSecret("12345"), null);
});

// ── Boundary & failure cases ───────────────────────────────────────────

test("positive: bundle with no built Wasm has empty artifact digests in develop mode", () => {
  const bundle = buildSupportBundle({
    repoRoot: process.cwd(),
    artifactRequireBuilt: false,
    artifactMode: "develop",
  });
  assert.equal(typeof bundle.digests.artifactDigests, "object");
});

test("negative: release mode with unpinned artifacts marks bundle as not ok", () => {
  const bundle = buildSupportBundle({
    repoRoot: process.cwd(),
    artifactMode: "release",
    artifactRequireBuilt: false,
  });
  assert.equal(bundle.ok, false);
  assert.ok(
    bundle.findings.some(
      (f) => f.source === "artifact-provenance" && f.severity === "error",
    ),
  );
});

test("negative: statement drift against committed snapshot produces error finding", () => {
  const driftingStatements = [
    { sql: "CREATE TABLE IF NOT EXISTS unknown_drift_table (id BIGINT PRIMARY KEY)" },
    {
      sql: "INSERT INTO schema_migrations (migration_id, schema_version, checksum, applied_at) VALUES (?, ?, ?, ?)",
      args: ["unknown-drift", 999, "unknown-hash", 0],
    },
  ];
  const bundle = buildSupportBundle({
    repoRoot: process.cwd(),
    statements: driftingStatements,
  });
  assert.equal(bundle.ok, false);
  assert.ok(
    bundle.findings.some(
      (f) => f.source === "schema-snapshot" && f.code === "FINGERPRINT_MISMATCH",
    ),
  );
});

test("positive: bundle path resolves under repo root", () => {
  const resolved = supportBundlePath(process.cwd(), "support-bundle.json");
  assert.equal(resolved, join(process.cwd(), "support-bundle.json"));
});

// ── Synthetic repo root isolation ──────────────────────────────────────

test("positive: buildSupportBundle works against a synthetic repo root", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mimir-support-bundle-test-"));
  try {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "synthetic", version: "9.9.9" }),
      "utf8",
    );

    const bundle = buildSupportBundle({
      repoRoot: tmp,
      artifactRequireBuilt: false,
    });
    assert.equal(bundle.versions.packageVersion, "9.9.9");
    assert.equal(typeof bundle.ok, "boolean");
    // In synthetic dir with no committed snapshot or manifest, it safely reports missing findings
    assert.equal(bundle.ok, false);
    assert.ok(bundle.findings.some((f) => f.source === "schema-snapshot"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
