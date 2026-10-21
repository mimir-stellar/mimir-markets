/**
 * Check that the committed TypeScript bindings in `sdk/contracts/` were
 * generated from the contract spec in the release wasm.
 *
 * A contract entry point that changed without regenerated bindings otherwise
 * fails at runtime as a simulation error; this fails it in CI instead. Offline
 * and secret-free: it reads the built wasm and the committed bindings, nothing
 * else. The bindings themselves are regenerated against the live deployment by
 * `npm run stellar:bindings`.
 *
 * Run: npm run check:bindings [-- --wasm-dir <dir>]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bindingsSpecEntries, checkBindings, type DriftFinding } from "./lib/binding-drift";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = ["mimir-market", "mimir-squad"];
const DEFAULT_WASM_DIR = path.join(ROOT, "contracts-soroban", "target", "wasm32v1-none", "release");

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && !value) {
    console.error(`${name} needs a directory`);
    process.exit(1);
  }
  return value ? path.resolve(ROOT, value) : fallback;
}

const relative = (file: string) => path.relative(ROOT, file).replace(/\\/g, "/");
const wasmDir = flag("--wasm-dir", DEFAULT_WASM_DIR);

const findings: DriftFinding[] = [];
for (const contract of CONTRACTS) {
  const wasmPath = path.join(wasmDir, `${contract.replace(/-/g, "_")}.wasm`);
  const bindingsPath = path.join(ROOT, "sdk", "contracts", contract, "src", "index.ts");

  if (!existsSync(wasmPath)) {
    findings.push({
      code: "WASM_NOT_BUILT",
      contract,
      detail: `no ${relative(wasmPath)}; build it with the release toolchain before checking bindings`,
    });
    continue;
  }
  if (!existsSync(bindingsPath)) {
    findings.push({
      code: "BINDINGS_NOT_COMMITTED",
      contract,
      detail: `${relative(bindingsPath)} is missing; regenerate the bindings`,
    });
    continue;
  }

  const entries = bindingsSpecEntries(readFileSync(bindingsPath, "utf8")).length;
  const drift = checkBindings({
    name: contract,
    wasm: readFileSync(wasmPath),
    bindings: readFileSync(bindingsPath, "utf8"),
  });
  if (drift.length === 0) {
    console.log(`✓ ${contract}: ${entries} spec entries match ${relative(wasmPath)}`);
  } else {
    findings.push(...drift);
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`✗ ${finding.code} ${finding.contract}: ${finding.detail}`);
  }
  if (findings.some((finding) => !finding.code.startsWith("WASM_"))) {
    console.error(
      "\nThe committed bindings no longer describe the built contract. Regenerate them with\n" +
        "  npm run stellar:bindings\n" +
        "and commit sdk/contracts/ in the same pull request. See docs/CONTRACT_TOOLCHAINS.md.",
    );
  }
  process.exit(1);
}
console.log("✓ generated contract bindings match the release wasm spec");
