/**
 * Offline rollback readiness report.
 *
 * Answers one question before a funded release: "if this release has to be
 * rolled back, is everything the rollback needs actually here?" It reports
 *
 *  - the predecessor artifacts a rollback depends on (the pinned Wasm digests a
 *    rollback redeploys, the committed schema snapshot, the runbooks and the
 *    rehearsal / cache-backup inputs),
 *  - the schema assumptions a rollback makes about the Postgres read index, and
 *  - the blockers observed while checking both, plus the rollback-area gates of
 *    the release readiness checklist.
 *
 * Boundaries: this module is a read-only report. It performs no deployment, no
 * database write and no chain transaction, never opens a network connection and
 * never reads `process.env`. It only reads tracked repo files, and every string
 * that enters the report is scrubbed against secret shapes. Soroban contract
 * state stays authoritative; the schema snapshot describes the disposable read
 * index only.
 *
 * Reproducibility: the same inputs yield byte-identical output. Blockers are
 * sorted deterministically and serialization uses a fixed key order.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { loadArtifactManifest, type ArtifactManifest } from "./artifact-provenance";
import {
  RELEASE_GATES,
  evaluateReleaseEvidence,
  evaluateReleaseReadiness,
  type ReleaseMode,
} from "./release-readiness";
import { scrubMessage } from "./release-support-bundle";
import {
  DEFAULT_SCHEMA_SNAPSHOT_RELATIVE,
  loadSchemaSnapshot,
  schemaSnapshotPath,
  verifyRepoSchemaSnapshot,
  verifySchemaSnapshot,
  type SchemaSnapshot,
  type SchemaSnapshotFinding,
  type SchemaSnapshotFindingCode,
  type SchemaStatement,
} from "./schema-snapshot";

export const ROLLBACK_READINESS_SCHEMA_VERSION = 1 as const;
export const ROLLBACK_READINESS_KIND = "mimir-rollback-readiness" as const;

const DEFAULT_MANIFEST_RELATIVE = "deploy/contract-artifacts.manifest.json";
const HEX64 = /^[0-9a-f]{64}$/;

/** Rollback procedure inputs that are not named by a release readiness gate. */
const ROLLBACK_PROCEDURE_FILES = [
  "docs/ROLLBACK.md",
  "scripts/rollback-rehearsal.ts",
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export type PredecessorArtifactStatus =
  | "pinned"
  | "unpinned"
  | "invalid-pin"
  | "present"
  | "missing";

export interface PredecessorArtifact {
  /** `contract-wasm:<manifest id>` or `file:<repo-relative path>`. */
  id: string;
  kind: "contract-wasm-pin" | "file";
  /** Repo-relative path the rollback reads (the Wasm path for a pin). */
  path: string;
  status: PredecessorArtifactStatus;
  /** Lowercase hex digest, only for a valid pin. */
  sha256?: string;
  detail: string;
}

export const SCHEMA_ASSUMPTION_IDS = [
  "snapshot-committed",
  "schema-matches-snapshot",
  "migration-versions-unique",
  "migrations-registered",
] as const;
export type SchemaAssumptionId = (typeof SCHEMA_ASSUMPTION_IDS)[number];

export type SchemaAssumptionStatus = "holds" | "violated" | "unverified";

export interface SchemaAssumption {
  id: SchemaAssumptionId;
  statement: string;
  status: SchemaAssumptionStatus;
  detail: string;
}

export type RollbackBlockerSource =
  | "predecessor-artifacts"
  | "schema-snapshot"
  | "release-readiness";

export interface RollbackBlocker {
  source: RollbackBlockerSource;
  code: string;
  severity: "error" | "warning";
  /** Artifact id, assumption id or gate id the blocker is about. */
  subject?: string;
  message: string;
}

export interface RollbackReadinessSummary {
  artifacts: number;
  artifactsReady: number;
  assumptions: number;
  assumptionsHolding: number;
  errors: number;
  warnings: number;
}

export interface RollbackReadinessReport {
  schemaVersion: typeof ROLLBACK_READINESS_SCHEMA_VERSION;
  kind: typeof ROLLBACK_READINESS_KIND;
  mode: ReleaseMode;
  predecessorArtifacts: PredecessorArtifact[];
  schemaAssumptions: SchemaAssumption[];
  blockers: RollbackBlocker[];
  summary: RollbackReadinessSummary;
  /** No error-severity blockers. Warnings do not fail develop mode. */
  ok: boolean;
  /** No blockers at all: every artifact, assumption and rollback gate is satisfied. */
  rollbackReady: boolean;
}

export interface BuildRollbackReadinessOptions {
  repoRoot?: string;
  mode?: ReleaseMode;
  /**
   * Current schema statements (`getSchemaStatements()`). Without them drift
   * cannot be checked, so `schema-matches-snapshot` is reported as unverified.
   */
  statements?: ReadonlyArray<SchemaStatement>;
  /** Repo-relative path of the committed schema snapshot. */
  snapshotPath?: string;
  /** Repo-relative path of the contract artifact manifest. */
  artifactManifestPath?: string;
  /** Raw release evidence JSON; `undefined`/`null` means nothing recorded. */
  evidence?: unknown;
  /** Existence check for required files, keyed by repo-relative path. */
  fileExists?: (repoRelativePath: string) => boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function severityFor(mode: ReleaseMode): RollbackBlocker["severity"] {
  return mode === "release" ? "error" : "warning";
}

function rollbackGateIds(): ReadonlySet<string> {
  return new Set(
    RELEASE_GATES.filter((gate) => gate.area === "rollback").map((gate) => gate.id),
  );
}

/** Required file -> why a rollback needs it, derived from the gate registry. */
function requiredRollbackFiles(snapshotRelative: string): Map<string, string> {
  const required = new Map<string, string>();
  for (const gate of RELEASE_GATES) {
    if (gate.area !== "rollback") continue;
    for (const checkPath of gate.checkPaths) {
      const reasons = required.get(checkPath);
      required.set(
        checkPath,
        reasons ? `${reasons}, ${gate.id}` : `required by gate ${gate.id}`,
      );
    }
  }
  for (const file of ROLLBACK_PROCEDURE_FILES) {
    if (!required.has(file)) required.set(file, "rollback procedure input");
  }
  required.set(snapshotRelative, "committed schema snapshot the rollback returns to");
  return required;
}

// ── Predecessor artifacts ────────────────────────────────────────────────────

interface ArtifactCheck {
  artifacts: PredecessorArtifact[];
  blockers: RollbackBlocker[];
}

function checkContractPins(
  repoRoot: string,
  manifestRelative: string,
  mode: ReleaseMode,
): ArtifactCheck {
  const manifestAbs = path.resolve(repoRoot, manifestRelative);
  let manifest: ArtifactManifest;
  try {
    manifest = loadArtifactManifest(manifestAbs);
  } catch (error) {
    return {
      artifacts: [],
      blockers: [
        {
          source: "predecessor-artifacts",
          code: "MANIFEST_INVALID",
          severity: "error",
          subject: manifestRelative,
          message: `cannot read the contract artifact manifest ${manifestRelative}: ${errorMessage(error)}`,
        },
      ],
    };
  }

  if (manifest.artifacts.length === 0) {
    return {
      artifacts: [],
      blockers: [
        {
          source: "predecessor-artifacts",
          code: "EMPTY_ARTIFACTS",
          severity: "error",
          subject: manifestRelative,
          message: "manifest lists no contract artifacts — there is no Wasm to roll back to",
        },
      ],
    };
  }

  const artifacts: PredecessorArtifact[] = [];
  const blockers: RollbackBlocker[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.artifacts) {
    const id = `contract-wasm:${entry.id}`;
    if (seen.has(entry.id)) {
      blockers.push({
        source: "predecessor-artifacts",
        code: "DUPLICATE_ARTIFACT_ID",
        severity: "error",
        subject: id,
        message: `duplicate artifact id "${entry.id}" — the rollback target would be ambiguous`,
      });
      continue;
    }
    seen.add(entry.id);

    if (entry.sha256 === null) {
      artifacts.push({
        id,
        kind: "contract-wasm-pin",
        path: entry.wasmPath,
        status: "unpinned",
        detail: "no sha256 pin recorded, so a rollback cannot verify the Wasm it redeploys",
      });
      blockers.push({
        source: "predecessor-artifacts",
        code: "DIGEST_UNPINNED",
        severity: severityFor(mode),
        subject: id,
        message:
          `artifact "${entry.id}" has no pinned digest — ` +
          "run `npm run verify:artifacts -- --write-pins` after a clean build",
      });
    } else if (!HEX64.test(entry.sha256)) {
      artifacts.push({
        id,
        kind: "contract-wasm-pin",
        path: entry.wasmPath,
        status: "invalid-pin",
        detail: "recorded pin is not 64 lowercase hex characters",
      });
      blockers.push({
        source: "predecessor-artifacts",
        code: "DIGEST_INVALID_PIN",
        severity: "error",
        subject: id,
        message: `pinned sha256 for artifact "${entry.id}" is not 64 lowercase hex characters`,
      });
    } else {
      artifacts.push({
        id,
        kind: "contract-wasm-pin",
        path: entry.wasmPath,
        status: "pinned",
        sha256: entry.sha256,
        detail: "pinned Wasm digest a rollback redeploys",
      });
    }
  }
  return { artifacts, blockers };
}

function checkRequiredFiles(
  required: ReadonlyMap<string, string>,
  snapshotRelative: string,
  fileExists: (repoRelativePath: string) => boolean,
): ArtifactCheck {
  const artifacts: PredecessorArtifact[] = [];
  const blockers: RollbackBlocker[] = [];

  for (const [filePath, reason] of [...required].sort(([a], [b]) => a.localeCompare(b))) {
    const present = fileExists(filePath);
    const id = `file:${filePath}`;
    artifacts.push({
      id,
      kind: "file",
      path: filePath,
      status: present ? "present" : "missing",
      detail: reason,
    });
    // A missing snapshot is reported once, by the schema assumptions.
    if (!present && filePath !== snapshotRelative) {
      blockers.push({
        source: "predecessor-artifacts",
        code: "PREDECESSOR_ARTIFACT_MISSING",
        severity: "error",
        subject: id,
        message: `required rollback input ${filePath} is missing (${reason})`,
      });
    }
  }
  return { artifacts, blockers };
}

// ── Schema assumptions ───────────────────────────────────────────────────────

const ASSUMPTION_STATEMENTS: Record<SchemaAssumptionId, string> = {
  "snapshot-committed":
    "A committed schema snapshot records the schema a rollback must return to.",
  "schema-matches-snapshot":
    "The current schema definition matches the committed snapshot, so a rolled-back read index is rebuilt against a known schema.",
  "migration-versions-unique":
    "Every registered migration has a unique schema_version, so the rollback target version is unambiguous.",
  "migrations-registered":
    "The schema registers at least one migration, so the rollback target version is recorded.",
};

/** Exhaustive over the finding codes, so a new code cannot be silently dropped. */
const ASSUMPTION_BY_FINDING_CODE: Record<SchemaSnapshotFindingCode, SchemaAssumptionId> = {
  SNAPSHOT_MISSING: "snapshot-committed",
  SNAPSHOT_INVALID: "snapshot-committed",
  EMPTY_SCHEMA: "schema-matches-snapshot",
  FINGERPRINT_MISMATCH: "schema-matches-snapshot",
  TABLE_DRIFT: "schema-matches-snapshot",
  INDEX_DRIFT: "schema-matches-snapshot",
  MIGRATION_DRIFT: "schema-matches-snapshot",
  MIGRATION_DUPLICATE_VERSION: "migration-versions-unique",
  MIGRATION_UNREGISTERED: "migrations-registered",
};

interface SchemaCheck {
  assumptions: SchemaAssumption[];
  blockers: RollbackBlocker[];
}

function describeSnapshot(snapshot: SchemaSnapshot): string {
  const latest = snapshot.migrations.reduce<SchemaSnapshot["migrations"][number] | null>(
    (best, migration) =>
      best === null || migration.schema_version > best.schema_version ? migration : best,
    null,
  );
  const latestText = latest
    ? `latest migration "${latest.migration_id}" at schema_version ${latest.schema_version}`
    : "no migrations";
  return (
    `snapshot schemaVersion ${snapshot.schemaVersion}, fingerprint ${snapshot.fingerprint}, ` +
    `${snapshot.tables.length} table(s), ${snapshot.indexes.length} index(es), ` +
    `${snapshot.migrations.length} migration(s), ${latestText}`
  );
}

/** Findings and the committed snapshot, with or without live statements. */
function collectSchemaFindings(
  repoRoot: string,
  snapshotRelative: string,
  statements: ReadonlyArray<SchemaStatement> | undefined,
): { expected: SchemaSnapshot | null; findings: SchemaSnapshotFinding[] } {
  if (statements) {
    const report = verifyRepoSchemaSnapshot({
      repoRoot,
      statements,
      snapshotPath: snapshotRelative,
    });
    return { expected: report.expected, findings: report.findings };
  }

  const snapshotAbs = schemaSnapshotPath(repoRoot, snapshotRelative);
  if (!existsSync(snapshotAbs)) {
    return {
      expected: null,
      findings: [
        {
          code: "SNAPSHOT_MISSING",
          severity: "error",
          message:
            `no committed schema snapshot at ${snapshotRelative} — ` +
            "run `npm run check:schema-snapshot -- --write` and commit the result",
        },
      ],
    };
  }
  try {
    const expected = loadSchemaSnapshot(snapshotAbs);
    // Compared with itself, only the self-contained migration checks can fire.
    return { expected, findings: verifySchemaSnapshot(expected, expected).findings };
  } catch (error) {
    return {
      expected: null,
      findings: [{ code: "SNAPSHOT_INVALID", severity: "error", message: errorMessage(error) }],
    };
  }
}

/** What a holding assumption can state about the committed snapshot. */
function holdsDetail(id: SchemaAssumptionId, expected: SchemaSnapshot | null): string {
  if (!expected) return "no snapshot to compare";
  switch (id) {
    case "snapshot-committed":
      return describeSnapshot(expected);
    case "schema-matches-snapshot":
      return `source schema matches fingerprint ${expected.fingerprint}`;
    case "migration-versions-unique":
    case "migrations-registered":
      return `${expected.migrations.length} migration(s) registered, each with a unique schema_version`;
  }
}

function checkSchemaAssumptions(
  repoRoot: string,
  snapshotRelative: string,
  statements: ReadonlyArray<SchemaStatement> | undefined,
  mode: ReleaseMode,
): SchemaCheck {
  const { expected, findings } = collectSchemaFindings(repoRoot, snapshotRelative, statements);
  const driftChecked = statements !== undefined;

  const violations = new Map<SchemaAssumptionId, SchemaSnapshotFinding[]>();
  for (const finding of findings) {
    const id = ASSUMPTION_BY_FINDING_CODE[finding.code];
    violations.set(id, [...(violations.get(id) ?? []), finding]);
  }

  const assumptions: SchemaAssumption[] = SCHEMA_ASSUMPTION_IDS.map((id) => {
    const violated = violations.get(id);
    if (violated) {
      return {
        id,
        statement: ASSUMPTION_STATEMENTS[id],
        status: "violated",
        detail: violated.map((finding) => finding.code).join(", "),
      };
    }
    if (id === "schema-matches-snapshot" && !driftChecked) {
      return {
        id,
        statement: ASSUMPTION_STATEMENTS[id],
        status: "unverified",
        detail: "current schema statements were not supplied, so drift was not checked",
      };
    }
    return {
      id,
      statement: ASSUMPTION_STATEMENTS[id],
      status: "holds",
      detail: holdsDetail(id, expected),
    };
  });

  const blockers: RollbackBlocker[] = findings.map((finding) => ({
    source: "schema-snapshot",
    code: finding.code,
    severity: finding.severity,
    subject: ASSUMPTION_BY_FINDING_CODE[finding.code],
    message: finding.message,
  }));

  if (!driftChecked) {
    blockers.push({
      source: "schema-snapshot",
      code: "SCHEMA_UNVERIFIED",
      severity: severityFor(mode),
      subject: "schema-matches-snapshot",
      message:
        "schema drift against the committed snapshot was not checked because no schema " +
        "statements were supplied — run `npm run report:rollback-readiness`",
    });
  }
  return { assumptions, blockers };
}

// ── Release readiness (rollback-area gates) ──────────────────────────────────

function checkRollbackGates(evidence: unknown, mode: ReleaseMode): RollbackBlocker[] {
  const gateIds = rollbackGateIds();
  const report =
    evidence === undefined || evidence === null
      ? evaluateReleaseReadiness(null, { mode })
      : evaluateReleaseEvidence(evidence, { mode });

  return report.findings
    .filter((finding) => finding.gateId === undefined || gateIds.has(finding.gateId))
    .map((finding) => ({
      source: "release-readiness" as const,
      code: finding.code,
      severity: finding.severity,
      subject: finding.gateId,
      message: finding.message,
    }));
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function compareBlockers(a: RollbackBlocker, b: RollbackBlocker): number {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  return (
    a.source.localeCompare(b.source) ||
    a.code.localeCompare(b.code) ||
    (a.subject ?? "").localeCompare(b.subject ?? "") ||
    a.message.localeCompare(b.message)
  );
}

/**
 * Build the rollback readiness report from tracked repo files.
 *
 * Fail-closed: `ok` is true only when there is no error-severity blocker, and
 * `rollbackReady` only when there is no blocker of any severity. Unpinned
 * digests, unevidenced rollback gates and unchecked schema drift are warnings in
 * develop mode and errors in release mode; a missing required file, schema drift
 * and a failed gate are errors in both.
 */
export function buildRollbackReadinessReport(
  options: BuildRollbackReadinessOptions = {},
): RollbackReadinessReport {
  const repoRoot = options.repoRoot ?? process.cwd();
  const mode: ReleaseMode = options.mode ?? "develop";
  const snapshotRelative = options.snapshotPath ?? DEFAULT_SCHEMA_SNAPSHOT_RELATIVE;
  const manifestRelative = options.artifactManifestPath ?? DEFAULT_MANIFEST_RELATIVE;
  const fileExists =
    options.fileExists ?? ((relative: string) => existsSync(path.resolve(repoRoot, relative)));

  const pins = checkContractPins(repoRoot, manifestRelative, mode);
  const files = checkRequiredFiles(
    requiredRollbackFiles(snapshotRelative),
    snapshotRelative,
    fileExists,
  );
  const schema = checkSchemaAssumptions(repoRoot, snapshotRelative, options.statements, mode);
  const gateBlockers = checkRollbackGates(options.evidence, mode);

  const predecessorArtifacts = [...pins.artifacts, ...files.artifacts].map((artifact) => ({
    ...artifact,
    detail: scrubMessage(artifact.detail),
  }));
  const schemaAssumptions = schema.assumptions.map((assumption) => ({
    ...assumption,
    detail: scrubMessage(assumption.detail),
  }));
  const blockers = [...pins.blockers, ...files.blockers, ...schema.blockers, ...gateBlockers]
    .map((blocker) => ({ ...blocker, message: scrubMessage(blocker.message) }))
    .sort(compareBlockers);

  const errors = blockers.filter((blocker) => blocker.severity === "error").length;
  return {
    schemaVersion: ROLLBACK_READINESS_SCHEMA_VERSION,
    kind: ROLLBACK_READINESS_KIND,
    mode,
    predecessorArtifacts,
    schemaAssumptions,
    blockers,
    summary: {
      artifacts: predecessorArtifacts.length,
      artifactsReady: predecessorArtifacts.filter(
        (artifact) => artifact.status === "pinned" || artifact.status === "present",
      ).length,
      assumptions: schemaAssumptions.length,
      assumptionsHolding: schemaAssumptions.filter((a) => a.status === "holds").length,
      errors,
      warnings: blockers.length - errors,
    },
    ok: errors === 0,
    rollbackReady: blockers.length === 0,
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

/** Deterministic serialization: fixed key order, two-space indent, trailing newline. */
export function serializeRollbackReadinessReport(report: RollbackReadinessReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const ARTIFACT_MARK: Record<PredecessorArtifactStatus, string> = {
  pinned: "✓",
  present: "✓",
  unpinned: "✗",
  "invalid-pin": "✗",
  missing: "✗",
};

const ASSUMPTION_MARK: Record<SchemaAssumptionStatus, string> = {
  holds: "✓",
  violated: "✗",
  unverified: "-",
};

/** Format a report for CLI / CI logs. */
export function formatRollbackReadinessReport(report: RollbackReadinessReport): string {
  const lines: string[] = [
    `Rollback readiness report (${report.kind} v${report.schemaVersion}, mode: ${report.mode})`,
    "",
    "Predecessor artifacts",
  ];
  for (const artifact of report.predecessorArtifacts) {
    const digest = artifact.sha256 ? ` ${artifact.sha256}` : "";
    lines.push(
      `  ${ARTIFACT_MARK[artifact.status]} ${artifact.id} — ${artifact.status}${digest} (${artifact.detail})`,
    );
  }
  if (report.predecessorArtifacts.length === 0) lines.push("  (none found)");

  lines.push("", "Schema assumptions");
  for (const assumption of report.schemaAssumptions) {
    lines.push(
      `  ${ASSUMPTION_MARK[assumption.status]} ${assumption.id} — ${assumption.status}: ${assumption.detail}`,
    );
  }

  lines.push("", "Blockers");
  if (report.blockers.length === 0) lines.push("  (none)");
  for (const blocker of report.blockers) {
    const subject = blocker.subject ? ` [${blocker.subject}]` : "";
    lines.push(`  ${blocker.severity === "error" ? "✗" : "!"} ${blocker.severity} ${blocker.code}${subject}: ${blocker.message}`);
  }

  lines.push(
    "",
    report.rollbackReady
      ? "ROLLBACK READY — every predecessor artifact, schema assumption and rollback gate is satisfied"
      : `NOT READY — ${report.summary.errors} error(s), ${report.summary.warnings} warning(s)`,
  );
  return lines.join("\n");
}
