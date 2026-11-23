#!/usr/bin/env node
/**
 * Council Independence & Correlation Assumptions — Operator CLI Report.
 *
 * Usage:
 *   npx tsx scripts/report-council-independence.ts
 *   npx tsx scripts/report-council-independence.ts --json
 *   npx tsx scripts/report-council-independence.ts --markdown
 *   npx tsx scripts/report-council-independence.ts --strict
 *   npx tsx scripts/report-council-independence.ts --out report.md --markdown
 *
 * Evaluates public configuration of the council persona roster, execution
 * providers, evidence sources, and peer-reasoning information sharing.
 *
 * CRITICAL SAFETY INVARIANT:
 * Avoid presenting correlated internal AI agents as independently verified
 * institutions or decentralized third-party oracles.
 */

import { writeFileSync } from "node:fs";
import {
  buildCouncilIndependenceReport,
  formatCouncilIndependenceReport,
  type CouncilIndependenceReport,
} from "../lib/council/independence";

interface CliArgs {
  json: boolean;
  markdown: boolean;
  strict: boolean;
  out?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Set(argv);
  const outIndex = argv.findIndex((a) => a === "--out");
  return {
    json: args.has("--json"),
    markdown: args.has("--markdown") || args.has("--md"),
    strict: args.has("--strict"),
    out: outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : undefined,
    help: args.has("--help") || args.has("-h"),
  };
}

function printUsage(): void {
  console.log(`Mimir Council Independence & Correlation Assumptions Operator Report

Usage:
  tsx scripts/report-council-independence.ts [options]

Options:
  --json        Output raw JSON report payload
  --markdown    Format report as Markdown (suitable for PRs or documentation)
  --strict      Exit code 1 if high correlation risk or assumption violation
  --out <path>  Write output to a file instead of solely printing
  -h, --help    Show this help message
`);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const opts = parseArgs(argv);

  if (opts.help) {
    printUsage();
    return 0;
  }

  const report: CouncilIndependenceReport = buildCouncilIndependenceReport();

  let output: string;
  if (opts.json) {
    output = JSON.stringify(report, null, 2);
  } else {
    output = formatCouncilIndependenceReport(report, { markdown: opts.markdown });
  }

  if (opts.out) {
    writeFileSync(opts.out, output, "utf8");
    console.log(`Report written to ${opts.out}`);
  } else {
    console.log(output);
  }

  if (opts.strict) {
    if (report.summary.correlationRiskLevel === "high") {
      console.error(
        `\n[STRICT CHECK FAILED] Council has high correlation risk (${report.summary.effectiveIndependentClusters} effective clusters across ${report.summary.activePersonas} personas).`,
      );
      return 1;
    }
  }

  return 0;
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("report-council-independence.ts") ||
    process.argv[1].endsWith("report-council-independence.js"));

if (isDirectRun) {
  const exitCode = main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
