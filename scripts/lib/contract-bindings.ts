/**
 * Shared file layout for the generated contract bindings: where the release wasm
 * is, which files make up a package, and the `networks` block that pins the
 * deployed contract id.
 *
 * Used by `scripts/check-binding-drift.ts` (the CI guard) and
 * `scripts/write-contract-bindings.ts` (the generator) so both describe the same
 * package layout — see docs/CONTRACT_TOOLCHAINS.md.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Where `cargo build --target wasm32v1-none --release` puts the contracts. */
export const DEFAULT_WASM_DIR = path.join(
  REPO_ROOT,
  "contracts-soroban",
  "target",
  "wasm32v1-none",
  "release",
);

/** Contracts the app consumes, in the order they are checked and written. */
export const BINDING_PACKAGES = ["mimir-market", "mimir-squad"] as const;

/** `mimir-market` builds `mimir_market.wasm`. */
export function contractWasmPath(wasmDir: string, contract: string): string {
  return path.join(wasmDir, `${contract.replace(/-/g, "_")}.wasm`);
}

export function packageDir(outRoot: string, contract: string): string {
  return path.join(outRoot, contract);
}

/** The package's TypeScript sources — the spec array lives in one of them. */
export function packageSources(srcDir: string): string {
  if (!existsSync(srcDir)) return "";
  return readdirSync(srcDir)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => readFileSync(path.join(srcDir, file), "utf8"))
    .join("\n");
}

/**
 * The `export const networks = { … } as const` block that carries the deployed
 * contract id, or an empty string when a package has none.
 */
export function readNetworksBlock(source: string): string {
  const start = source.indexOf("export const networks = {");
  if (start < 0) return "";
  const end = source.indexOf("as const", start);
  if (end < 0) return "";
  return source.slice(start, end + "as const".length);
}
