/**
 * Pure helpers for the contract-bindings drift check.
 *
 * Generated bindings embed the contract's whole spec as an array of base64
 * `ScSpecEntry` XDR, and the release wasm carries the same entries in its
 * `contractspecv0` custom section. Comparing the two therefore compares the
 * interface the client was generated from against the contract that is about to
 * be deployed — no network, no secrets, no external generator.
 */
import { xdr } from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";

/** A contract whose committed bindings are checked against a wasm build. */
export interface BindingSource {
  /** Crate/package name, e.g. `mimir-market`. */
  name: string;
  /** Wasm built with the pinned release toolchain. */
  wasm: Buffer;
  /** Source of the committed generated `src/index.ts`. */
  bindings: string;
}

export type DriftCode =
  /** The release wasm was never built, so there is nothing to compare. */
  | "WASM_NOT_BUILT"
  /** The generated bindings package is missing from the checkout. */
  | "BINDINGS_NOT_COMMITTED"
  /** The wasm carries no readable `contractspecv0` section. */
  | "WASM_SPEC_UNREADABLE"
  /** The bindings contain no `new ContractSpec([...])` array at all. */
  | "BINDINGS_SPEC_MISSING"
  /** An entry in the bindings array is not decodable `ScSpecEntry` XDR. */
  | "BINDINGS_SPEC_UNDECODABLE"
  /** The contract has an entry the committed bindings were not generated from. */
  | "ENTRY_MISSING"
  /** The committed bindings carry an entry the contract no longer has. */
  | "ENTRY_STALE"
  /** Both sides have the entry with different bytes: the signature changed. */
  | "ENTRY_CHANGED";

export interface DriftFinding {
  code: DriftCode;
  contract: string;
  detail: string;
}

const SPEC_MARKER = "new ContractSpec([";

const ENTRY_LABELS: Record<string, string> = {
  scSpecEntryFunctionV0: "function",
  scSpecEntryUdtStructV0: "struct",
  scSpecEntryUdtUnionV0: "union",
  scSpecEntryUdtEnumV0: "enum",
  scSpecEntryUdtErrorEnumV0: "error enum",
  scSpecEntryEventV0: "event",
};

/**
 * The string array passed to `new ContractSpec([...])` in generated bindings.
 *
 * Throws rather than returning nothing: a bindings file this cannot read proves
 * nothing, and a silent pass is the failure mode the check exists to prevent.
 */
export function committedSpecEntries(bindings: string): string[] {
  const start = bindings.indexOf(SPEC_MARKER);
  if (start < 0) {
    throw new Error("no `new ContractSpec([...])` argument in the committed bindings");
  }
  const literals: string[] = [];
  let cursor = start + SPEC_MARKER.length;
  for (;;) {
    while (cursor < bindings.length && /[\s,]/.test(bindings[cursor]!)) cursor += 1;
    const quote = bindings[cursor];
    if (quote === "]") break;
    if (quote !== '"' && quote !== "'") {
      throw new Error(
        `unexpected ${JSON.stringify(quote ?? "end of file")} before spec entry ${literals.length}`,
      );
    }
    const literalStart = (cursor += 1);
    while (cursor < bindings.length && bindings[cursor] !== quote) cursor += 1;
    literals.push(bindings.slice(literalStart, cursor));
    cursor += 1;
  }
  if (literals.length === 0) {
    throw new Error("the committed bindings declare an empty contract spec");
  }
  return literals;
}

/** `function settle_claim`, `struct Claim` — what a reviewer recognizes. */
export function describeEntry(base64: string): string {
  const entry = xdr.ScSpecEntry.fromXDR(base64, "base64");
  const kind = entry.switch().name;
  const label = ENTRY_LABELS[kind];
  if (!label) return kind;
  return `${label} ${(entry.value() as { name(): string | Buffer }).name().toString()}`;
}

/** Every spec entry of a built wasm, as normalized base64 XDR. */
export function wasmSpecEntries(wasm: Buffer): string[] {
  return Spec.fromWasm(wasm).entries.map((entry) => entry.toXDR("base64"));
}

/** Every spec entry committed in generated bindings, as normalized base64 XDR. */
export function bindingsSpecEntries(bindings: string): string[] {
  return new Spec(committedSpecEntries(bindings)).entries.map((entry) => entry.toXDR("base64"));
}

function byEntryName(entries: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const name = describeEntry(entry);
    grouped.set(name, [...(grouped.get(name) ?? []), entry]);
  }
  return grouped;
}

/**
 * Findings for one contract. An empty array means the committed bindings were
 * generated from exactly the spec the built contract exposes.
 */
export function checkBindings(source: BindingSource): DriftFinding[] {
  const found = (code: DriftCode, detail: string): DriftFinding => ({
    code,
    contract: source.name,
    detail,
  });

  let built: string[];
  try {
    built = wasmSpecEntries(source.wasm);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      found(
        "WASM_SPEC_UNREADABLE",
        `the built wasm has no readable contract spec (${message}). Build it with the release toolchain: ` +
          "cargo build --release --locked --target wasm32v1-none --manifest-path contracts-soroban/Cargo.toml",
      ),
    ];
  }

  let committed: string[];
  try {
    committed = bindingsSpecEntries(source.bindings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith("no `new ContractSpec")
      ? "BINDINGS_SPEC_MISSING"
      : "BINDINGS_SPEC_UNDECODABLE";
    return [found(code, `the committed bindings cannot be read (${message})`)];
  }

  const builtByName = byEntryName(built);
  const committedByName = byEntryName(committed);
  const findings: DriftFinding[] = [];

  for (const [name, entries] of builtByName) {
    const theirs = committedByName.get(name);
    if (!theirs) {
      findings.push(found("ENTRY_MISSING", `${name} is in the built contract but not in the committed bindings`));
      continue;
    }
    const unchanged =
      entries.length === theirs.length && entries.every((entry) => theirs.includes(entry));
    if (!unchanged) {
      findings.push(found("ENTRY_CHANGED", `the ${name} signature differs from the committed bindings`));
    }
  }
  for (const name of committedByName.keys()) {
    if (!builtByName.has(name)) {
      findings.push(
        found("ENTRY_STALE", `${name} is in the committed bindings but no longer in the contract`),
      );
    }
  }
  return findings;
}
