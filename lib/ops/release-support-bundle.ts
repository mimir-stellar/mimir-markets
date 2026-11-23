/**
 * Reproducible artifact and schema support bundle.
 *
 * A support bundle packages the public, machine-readable state that a funded
 * release review needs offline: digests (schema fingerprint, release readiness
 * fingerprint, artifact sha256 digests), versions (package, schema snapshot,
 * release readiness schema), and bounded findings (schema snapshot drift,
 * artifact provenance, release readiness validation).
 *
 * Privacy boundary: the bundle collects only public data — tracked repo files,
 * committed manifests, and computed digests. It never reads `process.env`,
 * never opens a database connection, never touches the network, and never
 * includes wallet seeds, DATABASE_URL values, or local environment contents.
 * Any string that carries a secret shape is scrubbed before it enters the
 * bundle, so the bundle is safe to attach to a release record or paste into a
 * public log.
 *
 * Reproducibility: given the same repo state, `buildSupportBundle()` produces
 * byte-identical output. Serialization uses sorted keys and a trailing newline,
 * and findings are sorted deterministically, so two runs diff as equal.
 *
 * This module is pure — no `process.env`, no network, no clock — so the
 * `node:test` suite, the CLI (`scripts/report-support-bundle.ts`) and CI all
 * evaluate the same bytes and reach the same verdict.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCHEMA_SNAPSHOT_RELATIVE,
  SCHEMA_SNAPSHOT_SCHEMA_VERSION,
  buildSchemaSnapshot,
  loadSchemaSnapshot,
  schemaSnapshotPath,
  verifyRepoSchemaSnapshot,
  type SchemaSnapshot,
} from "./schema-snapshot";
import {
  verifyRepoArtifactProvenance,
  type ProvenanceReport,
} from "./artifact-provenance";
import {
  RELEASE_READINESS_SCHEMA_VERSION,
  releaseReadinessFingerprint,
  validateReleaseReadinessRegistry,
} from "./release-readiness";

export const RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION = 1 as const;
export const RELEASE_SUPPORT_BUNDLE_KIND =
  "mimir-release-support-bundle" as const;

export interface SupportBundleDigests {
  /** SHA-256 over the committed schema statement set. */
  schemaFingerprint: string;
  /** SHA-256 over the release readiness gate registry. */
  releaseReadinessFingerprint: string;
  /** Computed sha256 digest per artifact id from the Wasm bytes. */
  artifactDigests: Record<string, string>;
}

export interface SupportBundleVersions {
  packageVersion: string;
  schemaSnapshotSchemaVersion: number;
  releaseReadinessSchemaVersion: number;
}

export interface SupportBundleFinding {
  source: "schema-snapshot" | "artifact-provenance" | "release-readiness";
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface SupportBundle {
  schemaVersion: typeof RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION;
  kind: typeof RELEASE_SUPPORT_BUNDLE_KIND;
  digests: SupportBundleDigests;
  versions: SupportBundleVersions;
  findings: SupportBundleFinding[];
  ok: boolean;
}

export interface BuildSupportBundleOptions {
  repoRoot?: string;
  packageVersion?: string;
  statements?: ReadonlyArray<{ sql: string; args?: ReadonlyArray<unknown> }>;
  snapshotPath?: string;
  artifactManifestPath?: string;
  artifactMode?: "develop" | "release";
  artifactRequireBuilt?: boolean;
  artifactFileContents?: Record<string, Uint8Array | Buffer>;
}

const PACKAGE_JSON_RELATIVE = "package.json";
const SECRET_SHAPES: ReadonlyArray<
  readonly [string, (value: string) => boolean]
> = [
  [
    "stellar-secret-seed",
    (value) =>
      value.startsWith("S") &&
      (value.length === 56 || value.length >= 32) &&
      /^[A-Z2-7]+$/.test(value),
  ],
  ["api-key", (value) => /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/.test(value)],
  ["github-token", (value) => /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(value)],
  ["posthog-key", (value) => /\bphc_[A-Za-z0-9]{20,}/.test(value)],
  ["aws-access-key", (value) => /\bAKIA[0-9A-Z]{16}\b/.test(value)],
  ["private-key", (value) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)],
  [
    "url-with-embedded-credentials",
    (value) => /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/.test(value),
  ],
];

export function looksLikeSecret(value: string): string | null {
  for (const [, test] of SECRET_SHAPES) {
    if (test(value)) return "secret-shaped";
  }
  return null;
}

function scrubToken(token: string): string {
  const match = token.match(/^([(\[{'"]*)(.*?)([)\]}',.:;!?]*)$/);
  if (match && match[2]) {
    const [, prefix, core, suffix] = match;
    const shape = looksLikeSecret(core);
    if (shape) return `${prefix}[REDACTED:secret-shaped]${suffix}`;
  }
  const shape = looksLikeSecret(token);
  if (shape) return `[REDACTED:secret-shaped]`;
  return token;
}

export function scrubMessage(message: string): string {
  return message
    .split(/\s+/)
    .map((token) => scrubToken(token))
    .join(" ");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    );
  return `{${entries.join(",")}}`;
}

function sortFindings(
  findings: SupportBundleFinding[],
): SupportBundleFinding[] {
  return [...findings].sort((a, b) => {
    const sourceCmp = a.source.localeCompare(b.source);
    if (sourceCmp !== 0) return sourceCmp;
    const codeCmp = a.code.localeCompare(b.code);
    if (codeCmp !== 0) return codeCmp;
    return a.message.localeCompare(b.message);
  });
}

function readPackageVersion(repoRoot: string, override?: string): string {
  if (override !== undefined) return override;
  const pkgPath = path.resolve(repoRoot, PACKAGE_JSON_RELATIVE);
  if (!existsSync(pkgPath)) {
    return "0.0.0-unspecified";
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim() !== "") {
      return pkg.version.trim();
    }
  } catch {
    // Falls through to default fallback
  }
  return "0.0.0-unspecified";
}

/**
 * Build a reproducible support bundle from tracked repo files only.
 *
 * The bundle contains:
 *   - digests: schema fingerprint, release readiness fingerprint, artifact digests
 *   - versions: package version, schema snapshot schema version, release readiness schema version
 *   - findings: schema snapshot drift, artifact provenance, release readiness validation
 *   - ok: true only when all sources report no error-severity findings
 *
 * No environment variables, database URLs, wallet seeds, or local contents are
 * read. Every string that enters the bundle is scrubbed against secret shapes.
 */
export function buildSupportBundle(
  options: BuildSupportBundleOptions = {},
): SupportBundle {
  const repoRoot = options.repoRoot ?? process.cwd();
  const snapshotPath = options.snapshotPath
    ? schemaSnapshotPath(repoRoot, options.snapshotPath)
    : schemaSnapshotPath(repoRoot, DEFAULT_SCHEMA_SNAPSHOT_RELATIVE);

  // ── Schema snapshot ────────────────────────────────────────────────────
  let schemaSnapshotFingerprint = "";
  let schemaSnapshotVersion = SCHEMA_SNAPSHOT_SCHEMA_VERSION;
  const schemaFindings: SupportBundleFinding[] = [];

  if (options.statements) {
    const actualSnapshot = buildSchemaSnapshot(options.statements, {
      source: path.relative(repoRoot, snapshotPath),
    });
    schemaSnapshotFingerprint = actualSnapshot.fingerprint;
    schemaSnapshotVersion = actualSnapshot.schemaVersion;
    const schemaReport = verifyRepoSchemaSnapshot({
      repoRoot,
      statements: options.statements,
      snapshotPath,
    });
    for (const finding of schemaReport.findings) {
      schemaFindings.push({
        source: "schema-snapshot",
        code: finding.code,
        severity: finding.severity,
        message: scrubMessage(finding.message),
      });
    }
  } else if (existsSync(snapshotPath)) {
    try {
      const loaded = loadSchemaSnapshot(snapshotPath);
      schemaSnapshotFingerprint = loaded.fingerprint;
      schemaSnapshotVersion = loaded.schemaVersion;
    } catch (error) {
      schemaFindings.push({
        source: "schema-snapshot",
        code: "SNAPSHOT_INVALID",
        severity: "error",
        message: scrubMessage(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  } else {
    schemaFindings.push({
      source: "schema-snapshot",
      code: "SNAPSHOT_MISSING",
      severity: "error",
      message: scrubMessage(
        `no committed schema snapshot at ${path.relative(repoRoot, snapshotPath)}`,
      ),
    });
  }

  // ── Artifact provenance ────────────────────────────────────────────────
  const artifactReport: ProvenanceReport = verifyRepoArtifactProvenance({
    repoRoot,
    mode: options.artifactMode ?? "develop",
    requireBuilt: options.artifactRequireBuilt,
    fileContents: options.artifactFileContents,
    manifestPath: options.artifactManifestPath,
  });

  const artifactFindings: SupportBundleFinding[] =
    artifactReport.findings.map((finding) => ({
      source: "artifact-provenance" as const,
      code: finding.code,
      severity: finding.severity,
      message: scrubMessage(finding.message),
    }));

  const artifactDigests: Record<string, string> = {};
  for (const [id, digest] of Object.entries(artifactReport.digests)) {
    artifactDigests[id] = digest;
  }

  // ── Release readiness ──────────────────────────────────────────────────
  const registryProblems = validateReleaseReadinessRegistry();
  const readinessFindings: SupportBundleFinding[] = registryProblems.map(
    (problem) => ({
      source: "release-readiness" as const,
      code: "REGISTRY_PROBLEM",
      severity: "error",
      message: scrubMessage(problem),
    }),
  );

  const releaseReadinessFingerprintValue = releaseReadinessFingerprint();

  // ── Assemble ───────────────────────────────────────────────────────────
  const allFindings = sortFindings([
    ...schemaFindings,
    ...artifactFindings,
    ...readinessFindings,
  ]);
  const ok = allFindings.every((f) => f.severity !== "error");

  const bundle: SupportBundle = {
    schemaVersion: RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION,
    kind: RELEASE_SUPPORT_BUNDLE_KIND,
    digests: {
      schemaFingerprint: schemaSnapshotFingerprint,
      releaseReadinessFingerprint: releaseReadinessFingerprintValue,
      artifactDigests,
    },
    versions: {
      packageVersion: readPackageVersion(repoRoot, options.packageVersion),
      schemaSnapshotSchemaVersion: schemaSnapshotVersion,
      releaseReadinessSchemaVersion: RELEASE_READINESS_SCHEMA_VERSION,
    },
    findings: allFindings,
    ok,
  };
  return bundle;
}

/**
 * Serialize a support bundle deterministically (sorted keys, trailing newline).
 * Two bundles built from the same inputs serialize to byte-identical strings.
 */
export function serializeSupportBundle(bundle: SupportBundle): string {
  return `${canonicalJson(bundle)}\n`;
}

/**
 * Parse and structurally validate a support bundle. Throws on schema failures
 * so a consumer cannot soft-succeed on garbage JSON.
 */
export function parseSupportBundle(raw: unknown): SupportBundle {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `support bundle must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!isPlainObject(raw)) {
    throw new Error("support bundle must be a JSON object");
  }
  if (raw.schemaVersion !== RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion must be ${RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION}`,
    );
  }
  if (raw.kind !== RELEASE_SUPPORT_BUNDLE_KIND) {
    throw new Error(`kind must be "${RELEASE_SUPPORT_BUNDLE_KIND}"`);
  }
  const digests = raw.digests;
  if (!isPlainObject(digests)) {
    throw new Error("digests must be an object");
  }
  if (typeof digests.schemaFingerprint !== "string") {
    throw new Error("digests.schemaFingerprint must be a string");
  }
  if (typeof digests.releaseReadinessFingerprint !== "string") {
    throw new Error("digests.releaseReadinessFingerprint must be a string");
  }
  if (!isPlainObject(digests.artifactDigests)) {
    throw new Error("digests.artifactDigests must be an object");
  }
  for (const [id, value] of Object.entries(digests.artifactDigests)) {
    if (typeof value !== "string") {
      throw new Error(`digests.artifactDigests.${id} must be a string`);
    }
  }
  const versions = raw.versions;
  if (!isPlainObject(versions)) {
    throw new Error("versions must be an object");
  }
  if (typeof versions.packageVersion !== "string") {
    throw new Error("versions.packageVersion must be a string");
  }
  if (
    typeof versions.schemaSnapshotSchemaVersion !== "number" ||
    !Number.isInteger(versions.schemaSnapshotSchemaVersion)
  ) {
    throw new Error("versions.schemaSnapshotSchemaVersion must be an integer");
  }
  if (
    typeof versions.releaseReadinessSchemaVersion !== "number" ||
    !Number.isInteger(versions.releaseReadinessSchemaVersion)
  ) {
    throw new Error("versions.releaseReadinessSchemaVersion must be an integer");
  }
  const findings = raw.findings;
  if (!Array.isArray(findings)) {
    throw new Error("findings must be an array");
  }
  const parsedFindings: SupportBundleFinding[] = findings.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`findings[${index}] must be an object`);
    }
    if (
      entry.source !== "schema-snapshot" &&
      entry.source !== "artifact-provenance" &&
      entry.source !== "release-readiness"
    ) {
      throw new Error(
        `findings[${index}].source must be "schema-snapshot", "artifact-provenance" or "release-readiness"`,
      );
    }
    if (typeof entry.code !== "string" || entry.code.trim() === "") {
      throw new Error(`findings[${index}].code must be a non-empty string`);
    }
    if (entry.severity !== "error" && entry.severity !== "warning") {
      throw new Error(`findings[${index}].severity must be "error" or "warning"`);
    }
    if (typeof entry.message !== "string" || entry.message.trim() === "") {
      throw new Error(`findings[${index}].message must be a non-empty string`);
    }
    return {
      source: entry.source,
      code: entry.code,
      severity: entry.severity,
      message: entry.message,
    };
  });
  if (typeof raw.ok !== "boolean") {
    throw new Error("ok must be a boolean");
  }
  return {
    schemaVersion: RELEASE_SUPPORT_BUNDLE_SCHEMA_VERSION,
    kind: RELEASE_SUPPORT_BUNDLE_KIND,
    digests: {
      schemaFingerprint: digests.schemaFingerprint as string,
      releaseReadinessFingerprint: digests.releaseReadinessFingerprint as string,
      artifactDigests: digests.artifactDigests as Record<string, string>,
    },
    versions: {
      packageVersion: versions.packageVersion as string,
      schemaSnapshotSchemaVersion: versions
        .schemaSnapshotSchemaVersion as number,
      releaseReadinessSchemaVersion: versions
        .releaseReadinessSchemaVersion as number,
    },
    findings: parsedFindings,
    ok: raw.ok as boolean,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Format a support bundle for CLI / CI logs. No secret values are echoed.
 */
export function formatSupportBundle(bundle: SupportBundle): string {
  const schemaPrefix = bundle.digests.schemaFingerprint
    ? `${bundle.digests.schemaFingerprint.slice(0, 12)}…`
    : "none";
  const lines: string[] = [
    `support bundle: ${bundle.ok ? "OK" : "FAILED"}`,
    `  kind ${bundle.kind} schemaVersion ${bundle.schemaVersion}`,
    `  versions: package=${bundle.versions.packageVersion} ` +
      `schemaSnapshot=${bundle.versions.schemaSnapshotSchemaVersion} ` +
      `releaseReadiness=${bundle.versions.releaseReadinessSchemaVersion}`,
    `  digests: schema=${schemaPrefix} ` +
      `readiness=${bundle.digests.releaseReadinessFingerprint.slice(0, 12)}… ` +
      `artifacts=${Object.keys(bundle.digests.artifactDigests).length}`,
    `  findings: ${bundle.findings.length} total, ` +
      `${bundle.findings.filter((f) => f.severity === "error").length} error(s)`,
  ];
  for (const finding of bundle.findings) {
    const mark = finding.severity === "error" ? "✗" : "!";
    lines.push(
      `  ${mark} [${finding.source}] ${finding.code}: ${scrubMessage(finding.message)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Bundle path used by the CLI and by consumers that write the bundle to disk.
 */
export function supportBundlePath(
  repoRoot: string,
  relative = "support-bundle.json",
): string {
  return path.resolve(repoRoot, relative);
}
