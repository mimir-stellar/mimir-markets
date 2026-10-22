/**
 * Regenerate the TypeScript bindings in `sdk/contracts/` from a local wasm build.
 *
 * The generator is the one that ships inside the pinned `@stellar/stellar-sdk`,
 * i.e. the same package the bindings import and the same code path
 * `npm run check:bindings` reads — so a regeneration cannot disagree with the CI
 * guard. The deployed contract ids are carried over from the package being
 * replaced, so each package keeps its `networks` export and `Client` still
 * constructs without repeating an id.
 *
 * `npm run stellar:bindings` remains the route that generates from the live
 * testnet contracts; this script needs no network, no secrets and no Rust.
 *
 * Run: npm run stellar:bindings:local [-- --wasm-dir <dir>] [--out <dir>]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { BindingGenerator } from "@stellar/stellar-sdk";

import { DEFAULT_WASM_DIR, contractWasmPath, readNetworksBlock } from "./lib/contract-bindings";

const ROOT = path.resolve(import.meta.dirname, "..");

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && !value) {
    console.error(`${name} needs a path`);
    process.exit(1);
  }
  return value ? path.resolve(ROOT, value) : fallback;
}

const wasmDir = flag("--wasm-dir", DEFAULT_WASM_DIR);
const outRoot = flag("--out", path.join(ROOT, "sdk", "contracts"));
const only = (() => {
  const index = process.argv.indexOf("--contract");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && !value) {
    console.error("--contract needs a contract name");
    process.exit(1);
  }
  return value;
})();

for (const contract of ["mimir-market", "mimir-squad"]) {
  if (only && only !== contract) continue;

  const wasmPath = contractWasmPath(wasmDir, contract);
  if (!existsSync(wasmPath)) {
    console.error(`✗ no ${path.relative(ROOT, wasmPath)}; build the release wasm first:\n` +
      "  cargo build --release --locked --target wasm32v1-none --manifest-path contracts-soroban/Cargo.toml");
    process.exit(1);
  }

  const packageDir = path.join(outRoot, contract);
  const previousIndex = path.join(packageDir, "src", "index.ts");
  // Carry the deployed ids over from the package being replaced.
  const networks = existsSync(previousIndex) ? readNetworksBlock(readFileSync(previousIndex, "utf8")) : "";

  const bindings = BindingGenerator.fromWasm(readFileSync(wasmPath)).generate({
    contractName: contract.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()),
  });

  mkdirSync(path.join(packageDir, "src"), { recursive: true });
  const indexFile = [
    bindings.index,
    networks ? `\n${networks}\n` : "",
  ].join("");
  writeFileSync(path.join(packageDir, "src", "index.ts"), indexFile);
  writeFileSync(path.join(packageDir, "src", "client.ts"), bindings.client);
  if (bindings.types.trim()) writeFileSync(path.join(packageDir, "src", "types.ts"), bindings.types);
  writeFileSync(path.join(packageDir, "package.json"), bindings.packageJson);
  writeFileSync(path.join(packageDir, "tsconfig.json"), bindings.tsConfig);
  writeFileSync(path.join(packageDir, "README.md"), bindings.readme);
  writeFileSync(path.join(packageDir, ".gitignore"), bindings.gitignore);

  const files = ["src/index.ts", "src/client.ts", ...(bindings.types.trim() ? ["src/types.ts"] : [])];
  console.log(`✓ ${contract}: ${files.join(", ")} from ${path.relative(ROOT, wasmPath).replace(/\\/g, "/")}`);
  if (bindings.diagnostics.length > 0) {
    for (const d of bindings.diagnostics) {
      console.warn(`  ! event "${d.rawName}" declared ${d.declarations}x → ${d.interfaceName} / ${d.filterMethodName}()`);
    }
  }
}
console.log(
  `\nNext: npm run check:bindings -- --wasm-dir ${path.relative(ROOT, wasmDir).replace(/\\/g, "/")}` +
    " and npm run typecheck,\nthen commit sdk/contracts/ with the contract change.",
);
