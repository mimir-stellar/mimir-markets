/**
 * Bounded chain-to-index discrepancy report.
 *
 *   npx tsx scripts/report-index-discrepancies.ts --capture <capture.json> --claims 1,2,3 [--max-findings 200]
 *
 * Reads only the selected claims and settlements from the read index
 * (DATABASE_URL) and compares them with a captured chain range. Read-only: no
 * Postgres writes, no cursor movement, no RPC. Writes the JSON report to stdout.
 *
 * Exit codes: 0 no discrepancies, 2 discrepancies found, 1 invalid input or failure.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeClaimSelection, parseDiscrepancyCapture, runIndexDiscrepancyReport } from "../lib/server/index-discrepancy";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  try {
    const capturePath = arg("capture");
    const claimsArg = arg("claims");
    if (!capturePath || !claimsArg) throw new Error("usage: --capture <capture.json> --claims <id,id,...> [--max-findings N]");
    const claimIds = normalizeClaimSelection(
      claimsArg.split(",").map((s) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN)),
    );
    const maxFindingsArg = arg("max-findings");
    const maxFindings = maxFindingsArg === undefined ? undefined : Number(maxFindingsArg);
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to read the index");

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(resolve(capturePath), "utf8"));
    } catch {
      throw new Error(`cannot read capture ${capturePath}`);
    }
    const report = await runIndexDiscrepancyReport(parseDiscrepancyCapture(raw), claimIds, { maxFindings });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const { missing, stale, conflicting } = report.summary;
    process.exitCode = missing + stale + conflicting > 0 ? 2 : 0;
  } catch (error) {
    // Never dump capture records, rows or environment values into logs.
    console.error(`[index-discrepancies] ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  }
}

void main();
