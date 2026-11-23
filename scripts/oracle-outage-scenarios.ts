/**
 * Run the oracle outage and recovery scenarios without credentials (#817).
 *
 *   npx tsx scripts/oracle-outage-scenarios.ts
 *   npx tsx scripts/oracle-outage-scenarios.ts --json
 *
 * The runner reads no environment variables, performs no network I/O, does not
 * load a Stellar signer and never asks an LLM for a verdict. It exits non-zero
 * when any scenario's actual decision differs from its expected conservative
 * outcome, so it can run as a lightweight CI check.
 */

import { runOracleOutageScenarios } from "../lib/oracle/outage-recovery";

const json = process.argv.includes("--json");
const results = runOracleOutageScenarios();
const failures = results.filter((result) => !result.passed);

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    console.log(`\n${result.passed ? "PASS" : "FAIL"}  ${result.id} — ${result.title}`);
    for (const step of result.steps) {
      const verdict = step.decision.verdict?.verdict ? ` ${step.decision.verdict.verdict}` : "";
      const delay = step.decision.delayMs !== undefined ? ` (retry in ${step.decision.delayMs}ms)` : "";
      console.log(
        `  ${step.passed ? "ok" : "XX"}  ${step.label}: ${step.decision.action}/${step.decision.reason}${verdict}${delay}`,
      );
      if (!step.passed) {
        console.log(
          `      expected: ${step.expectation.action}/${step.expectation.reason}${step.expectation.verdict ? ` ${step.expectation.verdict}` : ""}`,
        );
      }
    }
  }
  console.log(
    `\n${results.length - failures.length}/${results.length} scenarios passed; no credentials, network or LLM calls used.`,
  );
}

if (failures.length > 0) process.exitCode = 1;
