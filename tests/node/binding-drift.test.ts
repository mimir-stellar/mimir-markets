import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { xdr } from "@stellar/stellar-sdk";

import {
  bindingsSpecEntries,
  checkBindings,
  committedSpecEntries,
  type DriftFinding,
} from "../../scripts/lib/binding-drift";
import { packageSources } from "../../scripts/lib/contract-bindings";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function committedBindings(contract: string): string {
  return packageSources(path.join(ROOT, "sdk", "contracts", contract, "src"));
}

function uleb128(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value > 0 ? 0x80 : 0));
  } while (value > 0);
  return Buffer.from(bytes);
}

/**
 * A wasm whose `contractspecv0` custom section holds exactly these entries —
 * the same shape cargo rustc emits for a Soroban contract, so `Spec.fromWasm`
 * reads it the same way.
 */
function wasmWithSpec(entries: string[]): Buffer {
  const name = Buffer.from("contractspecv0");
  const body = Buffer.concat(
    entries.map((entry) => Buffer.from(xdr.ScSpecEntry.fromXDR(entry, "base64").toXDR("raw"))),
  );
  const content = Buffer.concat([uleb128(name.length), name, body]);
  return Buffer.concat([
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    Buffer.from([0, ...uleb128(content.length)]),
    content,
  ]);
}

const MARKET_ENTRIES = bindingsSpecEntries(committedBindings("mimir-market"));

const check = (entries: string[], bindings: string): DriftFinding[] =>
  checkBindings({ name: "fixture", wasm: wasmWithSpec(entries), bindings });

test("bindings generated from a spec report no drift", () => {
  for (const contract of ["mimir-market", "mimir-squad"]) {
    const entries = bindingsSpecEntries(committedBindings(contract));
    assert.deepEqual(check(entries, committedBindings(contract)), [], contract);
  }
});

/** A function entry no committed bindings can contain. */
function extraFunction(name: string): string {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({ doc: Buffer.alloc(0), name, inputs: [], outputs: [] }),
  ).toXDR("base64");
}

test("an entry the contract gained is reported as missing", () => {
  const findings = check([...MARKET_ENTRIES, extraFunction("zzz_not_generated")], committedBindings("mimir-market"));
  assert.deepEqual(findings.map((f) => f.code), ["ENTRY_MISSING"]);
  assert.match(findings[0]!.detail, /not in the committed bindings/);
});

test("an entry the contract lost is reported as stale", () => {
  const findings = check(MARKET_ENTRIES.slice(0, -1), committedBindings("mimir-market"));
  assert.deepEqual(findings.map((f) => f.code), ["ENTRY_STALE"]);
  assert.match(findings[0]!.detail, /no longer in the contract/);
});

test("an entry whose bytes changed is reported as changed", () => {
  const index = MARKET_ENTRIES.findIndex((entry) => {
    const decoded = xdr.ScSpecEntry.fromXDR(entry, "base64");
    return decoded.switch().name === "scSpecEntryFunctionV0";
  });
  const decoded = xdr.ScSpecEntry.fromXDR(MARKET_ENTRIES[index]!, "base64").functionV0();
  // Same name, no return type: a signature edit is what the guard must catch.
  const mutated = xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: decoded.doc(),
      name: decoded.name(),
      inputs: decoded.inputs(),
      outputs: [],
    }),
  ).toXDR("base64");
  const findings = check(
    MARKET_ENTRIES.map((entry, i) => (i === index ? mutated : entry)),
    committedBindings("mimir-market"),
  );
  assert.deepEqual(findings.map((f) => f.code), ["ENTRY_CHANGED"]);
});

test("bindings with no spec array fail closed", () => {
  const findings = check(MARKET_ENTRIES, "export const networks = {};");
  assert.deepEqual(findings.map((f) => f.code), ["BINDINGS_SPEC_MISSING"]);
});

test("a wasm with no readable spec fails closed", () => {
  const withoutSection = Buffer.concat([
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    Buffer.from([0, 3, 1, 100]),
  ]);
  const findings = checkBindings({ name: "fixture", wasm: withoutSection, bindings: committedBindings("mimir-market") });
  assert.deepEqual(findings.map((f) => f.code), ["WASM_SPEC_UNREADABLE"]);
});

test("the spec array reader rejects an empty or malformed array", () => {
  assert.throws(() => committedSpecEntries("new ContractSpec([])"), /empty contract spec/);
  assert.throws(() => committedSpecEntries("new ContractSpec([ 7 ])"), /unexpected "7"/);
});
