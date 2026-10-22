/**
 * Check that the committed TypeScript bindings in `sdk/contracts/` were
 * generated from the contract spec in the release wasm.
 *
 * A contract entry point that changed without regenerated bindings otherwise
 * fails at runtime as a simulation error; this fails it in CI instead. Offline
 * and secret-free: it reads the built wasm and the committed bindings, nothing
 * else. Regenerate with `npm run stellar:bindings:local` (from a wasm build) or
 * `npm run stellar:bindings` (from the live testnet contracts).
 *
 * Run: npm run check:bindings [-- --wasm-dir <dir>]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  BINDING_PACKAGES,
  DEFAULT_WASM_DIR,
  contractWasmPath,
  packageSources,
} from "./lib/contract-bindings";
import { bindingsSpecEntries, checkBindings, type DriftFinding } from "./lib/binding-drift";

const ROOT = path.resolve(import.meta.dirname, "..");

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
for (const contract of BINDING_PACKAGES) {
  const wasmPath = contractWasmPath(wasmDir, contract);
  const srcDir = path.join(ROOT, "sdk", "contracts", contract, "src");
  const bindings = packageSources(srcDir);

  if (!existsSync(wasmPath)) {
    findings.push({
      code: "WASM_NOT_BUILT",
      contract,
      detail: `no ${relative(wasmPath)}; build it with the release toolchain before checking bindings`,
    });
    continue;
  }
  if (!bindings) {
    findings.push({
      code: "BINDINGS_NOT_COMMITTED",
      contract,
      detail: `${relative(srcDir)} has no TypeScript sources; regenerate the bindings`,
    });
    continue;
  }

  const drift = checkBindings({ name: contract, wasm: readFileSync(wasmPath), bindings });
  if (drift.length === 0) {
    console.log(
      `✓ ${contract}: ${bindingsSpecEntries(bindings).length} spec entries match ${relative(wasmPath)}`,
    );
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
        "  npm run stellar:bindings:local\n" +
        "and commit sdk/contracts/ in the same pull request. See docs/CONTRACT_TOOLCHAINS.md.",
    );
  }
  process.exit(1);
}
console.log("✓ generated contract bindings match the release wasm spec");
