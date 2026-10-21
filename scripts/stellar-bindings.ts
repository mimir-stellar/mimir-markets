/*
 * Regenerate the TypeScript client bindings in `sdk/contracts/` from the
 * contracts as they are actually deployed on Stellar Testnet.

 * Pointing `--contract-id` at the live instances (rather than `--wasm` at a
 * local build) means the generated spec is downloaded from the network and the
 * deployed contract id is embedded in each package's `networks.testnet` export.
 * If the bindings and the deployment ever drift, generation fails here instead of
 * at runtime.
 *
 *   npm run stellar:bindings
 *
 * CI compares the committed bindings against a local release wasm build via
 * `scripts/check-binding-drift.ts`, so a contract signature change that is not
 * accompanied by regenerated bindings fails there, with the changed entries
 * named, instead of at runtime as a simulation error.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  ENV_KEYS,
  NETWORK,
  NETWORK_PASSPHRASE,
  REPO_ROOT,
  SOROBAN_RPC_URL,
  requireEnv,
} from "./lib/stellar-env";

interface Target {
  label: string;
  contractId: string;
  outputDir: string;
}

function generate(target: Target): void {
  console.log(`[${target.label}] → ${path.relative(REPO_ROOT, target.outputDir)}`);
  const result = spawnSync(
    "stellar",
    [
      "contract",
      "bindings",
      "typescript",
      "--contract-id",
      target.contractId,
      "--output-dir",
      target.outputDir,
      "--overwrite",
      "--network",
      NETWORK,
      "--rpc-url",
      SOROBAN_RPC_URL,
      "--network-passphrase",
      NETWORK_PASSPHRASE,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`bindings generation failed for ${target.label}\n${result.stderr ?? ""}`);
  }
  console.log(`    ✓ generated from ${target.contractId}`);
}

function main(): void {
  const targets: Target[] = [
    {
      label: "mimir-market",
      contractId: requireEnv(ENV_KEYS.marketId, "run: npx tsx deploy/deploy.ts"),
      outputDir: path.join(REPO_ROOT, "sdk", "contracts", "mimir-market"),
    },
    {
      label: "mimir-squad",
      contractId: requireEnv(ENV_KEYS.squadId, "run: npx tsx deploy/deploy.ts"),
      outputDir: path.join(REPO_ROOT, "sdk", "contracts", "mimir-squad"),
    },
  ];

  console.log("── Generating TypeScript bindings from the live testnet contracts ──");
  for (const target of targets) generate(target);
  console.log(
    "\n✓ bindings regenerated. They are consumed as TypeScript sources via" +
      "\n  sdk/contracts/index.ts — no nested npm install is needed.",
  );
}

try {
  main();
} catch (error) {
  console.error("stellar-bindings FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}
