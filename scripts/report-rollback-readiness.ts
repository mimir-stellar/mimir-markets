/**
 * Offline rollback readiness report — CLI.
 *
 *   npm run report:rollback-readiness                         # print the report
 *   npm run report:rollback-readiness -- --json               # machine-readable JSON
 *   npm run report:rollback-readiness -- --mode=release       # funded-release mode
 *   npm run report:rollback-readiness -- --evidence ev.json   # include recorded rollback gate evidence
 *   npm run report:rollback-readiness -- --out report.json    # write the deterministic report
 *
 * Shows the predecessor artifacts a rollback needs, the schema assumptions it
 * makes and the blockers observed. Reproducible from a clean checkout: it reads
 * tracked repo files only and performs no deployment, no database write and no
 * chain transaction. It never reads `.env`, a database URL, a seed or any other
 * credential.
 *
 * Exit codes:
 *   0  no error-severity blockers (warnings are allowed in develop mode)
 *   1  error-severity blockers, or the report could not be produced
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSchemaStatements } from "../lib/db";
import {
  buildRollbackReadinessReport,
  formatRollbackReadinessReport,
  serializeRollbackReadinessReport,
} from "../lib/ops/rollback-readiness";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  json: boolean;
  out?: string;
  evidence?: string;
  mode: "develop" | "release";
  help: boolean;
}

/** Value of `--flag <value>` or `--flag=<value>`; undefined when absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const inline = argv.find((value) => value.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return next && !next.startsWith("-") ? next : undefined;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv);
  return {
    json: flags.has("--json"),
    out: flagValue(argv, "--out"),
    evidence: flagValue(argv, "--evidence"),
    mode: flags.has("--mode=release") || flags.has("--release") ? "release" : "develop",
    help: flags.has("--help") || flags.has("-h"),
  };
}

function loadEvidence(evidenceArg: string): unknown {
  const evidencePath = path.resolve(process.cwd(), evidenceArg);
  if (!existsSync(evidencePath)) {
    throw new Error(`evidence file not found: ${evidenceArg}`);
  }
  return JSON.parse(readFileSync(evidencePath, "utf8")) as unknown;
}

function printHelp(): void {
  console.log(
    [
      "Usage: node scripts/report-rollback-readiness.ts [options]",
      "",
      "  --json              print the report as JSON instead of text",
      "  --out <file>        write the deterministic report to disk",
      "  --evidence <file>   release evidence JSON (rollback-area gates are reported)",
      "  --mode=release      funded-release mode: unpinned digests, unevidenced gates and",
      "                      unchecked schema drift are errors",
      "",
      "Exit codes:",
      "  0  no error-severity blockers",
      "  1  error-severity blockers, or the report could not be produced",
    ].join("\n"),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let report;
  try {
    report = buildRollbackReadinessReport({
      repoRoot: REPO_ROOT,
      mode: args.mode,
      statements: getSchemaStatements(),
      evidence: args.evidence ? loadEvidence(args.evidence) : undefined,
    });
  } catch (error) {
    console.error(
      `✗ rollback readiness report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  console.log(args.json ? serializeRollbackReadinessReport(report).trimEnd() : formatRollbackReadinessReport(report));

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeRollbackReadinessReport(report), "utf8");
    // Keep stdout pure JSON when --json is set.
    const note = `  · rollback readiness report → ${path.relative(REPO_ROOT, outPath) || args.out}`;
    if (args.json) console.error(note);
    else console.log(note);
  }

  if (!report.ok) process.exit(1);
}

main();
