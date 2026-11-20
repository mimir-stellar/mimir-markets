import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDryRunBatchManifest,
  serializeDryRunBatchManifest,
  type BatchManifestInput,
} from "../../agents/market-creator/batch-manifest.js";
import { buildCandidateSignature, filterDuplicateCandidates } from "../../agents/market-creator/dedupe.js";
import {
  draftClaimCandidates,
  filterUnsafeCryptoThresholds,
  parseDraftedCandidates,
} from "../../agents/market-creator/drafting.js";
import { exportBatchManifest } from "../../scripts/market-creator-manifest.js";

const NOW = "2030-01-01T00:00:00Z";
const candidate = (question = "Will the temperature exceed 30 C?", extra = {}) => ({
  question,
  resolutionUrl: "https://example.org/weather",
  deadline: "2030-01-02T00:00:00Z",
  category: "weather",
  ...extra,
});
const input = (candidates: unknown[], extra: Partial<BatchManifestInput> = {}): BatchManifestInput => ({
  draftResponse: JSON.stringify(candidates),
  evaluatedAt: NOW,
  budget: { stakeAtomic: "20000000", maxTotalStakeAtomic: "40000000", maxMarkets: 5 },
  ...extra,
});

test("exports every statement, proposed budget, and rejection in input order", () => {
  const rows = [candidate(), candidate(" Will THE temperature exceed 30 C!!! "),
    candidate("Will BTC exceed $100?", { category: "crypto", threshold: 0.5 }),
    candidate("Missing fields", { deadline: "" }), candidate("Second valid"), candidate("Third valid")];
  const manifest = buildDryRunBatchManifest(input(rows));
  assert.deepEqual(manifest.summary, { drafted: 6, proposed: 2, rejected: 4 });
  assert.deepEqual(manifest.entries.map((entry) => entry.rejection?.code ?? null),
    [null, "duplicate_batch", "unsafe_crypto_threshold", "invalid_candidate", null, "budget_exceeded"]);
  assert.deepEqual(manifest.entries.map((entry) => entry.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(manifest.entries[3].statement, "Missing fields");
  assert.ok(manifest.entries.every((entry) => entry.stakeAtomic === "20000000"));
  assert.equal(manifest.budget.plannedStakeAtomic, "40000000");
  assert.equal(manifest.budget.remainingStakeAtomic, "0");
  assert.deepEqual(JSON.parse(serializeDryRunBatchManifest(manifest)), manifest);
});

test("existing signatures and equivalent deadline timezones use the supported dedupe rules", () => {
  const existing = Object.freeze([Object.freeze(candidate())]);
  const rows = [candidate("WILL the temperature exceed 30 C!!!", {
    resolutionUrl: "https://EXAMPLE.org/weather/", deadline: "2030-01-02T01:00:00+01:00",
  }), candidate("New market")];
  const manifest = buildDryRunBatchManifest(input(rows, { existingCandidates: existing }));
  assert.equal(manifest.entries[0].rejection?.code, "duplicate_existing");
  assert.equal(manifest.entries[1].status, "proposed");
  assert.equal(existing.length, 1);
  const parsed = parseDraftedCandidates(JSON.stringify(rows));
  const expected = filterDuplicateCandidates(parsed, new Set(existing.map(buildCandidateSignature)));
  assert.deepEqual(manifest.entries.filter((e) => e.status === "proposed").map((e) => e.statement), expected.map((c) => c.question));
});

test("uses exact atomic arithmetic above the Number safe-integer boundary", () => {
  const stakeAtomic = "9007199254740993";
  const manifest = buildDryRunBatchManifest(input([candidate(), candidate("Another")], {
    budget: { stakeAtomic, maxTotalStakeAtomic: "18014398509481986", maxMarkets: 2 },
  }));
  assert.equal(manifest.budget.plannedStakeAtomic, "18014398509481986");
  assert.equal(manifest.budget.remainingStakeAtomic, "0");
  assert.equal(manifest.summary.proposed, 2);
});

test("exact budget boundary is accepted and one atomic unit short is rejected", () => {
  for (const [cap, expected] of [["20000000", 1], ["19999999", 0]] as const) {
    const manifest = buildDryRunBatchManifest(input([candidate()], {
      budget: { stakeAtomic: "20000000", maxTotalStakeAtomic: cap, maxMarkets: 5 },
    }));
    assert.equal(manifest.summary.proposed, expected);
    assert.equal(manifest.entries[0].rejection?.code ?? null, expected ? null : "budget_exceeded");
  }
});

test("zero budget and zero market limit still export rejected statements", () => {
  const emptyBudget = buildDryRunBatchManifest(input([candidate()], {
    budget: { stakeAtomic: "20000000", maxTotalStakeAtomic: "0", maxMarkets: 5 },
  }));
  assert.equal(emptyBudget.entries[0].rejection?.code, "budget_exceeded");
  const zeroLimit = buildDryRunBatchManifest(input([candidate()], {
    budget: { stakeAtomic: "20000000", maxTotalStakeAtomic: "40000000", maxMarkets: 0 },
  }));
  assert.equal(zeroLimit.entries[0].rejection?.code, "market_limit");
  assert.equal(zeroLimit.budget.remainingStakeAtomic, "40000000");
});

test("invalid amounts and market limits fail before any plan can be produced", () => {
  for (const amount of ["-1", "2.5", "2e7", " 20000000", "020000000", "", "1".repeat(40), ((1n << 127n)).toString()]) {
    for (const field of ["stakeAtomic", "maxTotalStakeAtomic"] as const) {
      const batch = input([]);
      batch.budget[field] = amount;
      assert.throws(() => buildDryRunBatchManifest(batch), /atomic|i128/);
    }
  }
  const zeroStake = input([]);
  zeroStake.budget.stakeAtomic = "0";
  assert.throws(() => buildDryRunBatchManifest(zeroStake), /positive/);
  for (const maxMarkets of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const batch = input([]);
    batch.budget.maxMarkets = maxMarkets;
    assert.throws(() => buildDryRunBatchManifest(batch), /safe integer/);
  }
});

test("malformed captured response has an explicit batch error; an empty array is valid", () => {
  for (const response of ["", "not json", '{"question":"x"}', "[broken]"]) {
    const manifest = buildDryRunBatchManifest(input([], { draftResponse: response }));
    assert.equal(manifest.error, "invalid_draft_response");
    assert.deepEqual(manifest.summary, { drafted: 0, proposed: 0, rejected: 0 });
    assert.equal(manifest.budget.remainingStakeAtomic, "40000000");
  }
  assert.equal(buildDryRunBatchManifest(input([])).error, null);
});

test("null, non-object, and incomplete drafts retain rejection rows", () => {
  const manifest = buildDryRunBatchManifest(input([null, 7, [], {}, { question: "Retain me" }]));
  assert.equal(manifest.entries.length, 5);
  assert.ok(manifest.entries.every((row) => row.rejection?.code === "invalid_candidate"));
  assert.equal(manifest.entries[4].statement, "Retain me");
});

test("refuses malformed or elapsed deadlines, credentials, and non-HTTP URLs", () => {
  const rows = [
    candidate("Elapsed", { deadline: NOW }),
    candidate("Date only", { deadline: "2030-01-02" }),
    candidate("No timezone", { deadline: "2030-01-02T00:00:00" }),
    candidate("Impossible date", { deadline: "2030-02-30T00:00:00Z" }),
    candidate("Bad URL", { resolutionUrl: "invalid" }),
    candidate("Wrong protocol", { resolutionUrl: "file:///tmp/example" }),
    candidate("Credentials", { resolutionUrl: "https://user:secret@example.org" }),
  ];
  assert.deepEqual(buildDryRunBatchManifest(input(rows)).entries.map((row) => row.rejection?.code),
    ["deadline_elapsed", "invalid_deadline", "invalid_deadline", "invalid_deadline", "invalid_resolution_url", "invalid_resolution_url", "invalid_resolution_url"]);
  for (const evaluatedAt of ["bad", "2030-02-30T00:00:00Z", "2030-01-01T00:00:00"]) {
    assert.throws(() => buildDryRunBatchManifest(input([], { evaluatedAt })), /timestamp/);
  }
});

test("existing snapshot failure cannot silently disable duplicate checks", () => {
  assert.throws(() => buildDryRunBatchManifest(input([], { existingCandidates: [{}] })), /require/);
  assert.throws(() => buildDryRunBatchManifest(input([], { existingCandidates: [{ question: "x", resolutionUrl: "x" }] })), /require/);
});

test("rejected URLs cannot leak embedded credentials into serialized manifests", () => {
  const secret = "synthetic-password-do-not-export";
  const username = "synthetic-user-do-not-export";
  const urls = [
    `https://${username}:${secret}@example.org/source`,
    `https://${username}@example.org/source`,
    `https://:${secret}@example.org/source`,
    `https://${encodeURIComponent(username)}:${encodeURIComponent(secret)}@example.org/source`,
    `https://${username}:${secret}@`,
    `ftp://${username}:${secret}@example.org/source`,
    "file:///tmp/synthetic-source",
  ];
  const batch = input(urls.map((resolutionUrl, i) => candidate(`Private URL ${i}`, { resolutionUrl })));
  const original = JSON.stringify(batch);
  const manifest = buildDryRunBatchManifest(batch);
  assert.ok(manifest.entries.every((entry) => entry.rejection?.code === "invalid_resolution_url"));
  assert.ok(manifest.entries.every((entry) => entry.resolutionUrl === null));
  assert.deepEqual(manifest.entries.map((entry) => entry.statement), urls.map((_, i) => `Private URL ${i}`));
  assert.equal(manifest.summary.proposed, 0);
  assert.equal(manifest.budget.plannedStakeAtomic, "0");
  const serialized = serializeDryRunBatchManifest(manifest);
  assert.equal(serialized.includes(username), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(JSON.stringify(batch), original, "caller input is not mutated");
  assert.equal(serialized, serializeDryRunBatchManifest(buildDryRunBatchManifest(batch)));
});

test("valid URLs retain their exact spelling even when another rule rejects a draft", () => {
  const resolutionUrl = "https://EXAMPLE.org/Source/?case=Mixed#Section";
  const manifest = buildDryRunBatchManifest(input([
    candidate("Safe source", { resolutionUrl }),
    candidate("Expired with safe source", { resolutionUrl, deadline: NOW }),
  ]));
  assert.equal(manifest.entries[0].status, "proposed");
  assert.equal(manifest.entries[1].rejection?.code, "deadline_elapsed");
  assert.ok(manifest.entries.every((entry) => entry.resolutionUrl === resolutionUrl));
});

test("drafting APIs keep supported parsing and threshold filtering behavior", async () => {
  const rows = [candidate(), candidate("Unsafe", { threshold: 0.5 }), { question: "Incomplete" }];
  const raw = "Prose\n```json\n" + JSON.stringify(rows) + "\n```";
  const parsed = parseDraftedCandidates(raw);
  assert.equal(parsed.length, 2);
  const filtered = filterUnsafeCryptoThresholds(parsed);
  assert.equal(filtered.length, 1);
  const calls: string[] = [];
  assert.deepEqual(await draftClaimCandidates(async (prompt) => { calls.push(prompt); return raw; }, { sourceText: "Synthetic source" }), filtered);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("Synthetic source"));
});

test("replay is deterministic and no network transport is called", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected live transport"); };
  try {
    const batch = input([candidate()]);
    Object.freeze(batch.budget);
    Object.freeze(batch);
    const first = buildDryRunBatchManifest(batch);
    assert.equal(serializeDryRunBatchManifest(first), serializeDryRunBatchManifest(buildDryRunBatchManifest(batch)));
    assert.deepEqual(first.sideEffects, { marketCreation: false, payments: false, livePublishing: false });
    assert.equal(first.executionReady, false);
    assert.equal(first.stateSource, "supplied_snapshot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI writes only a local manifest and never overwrites input or existing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "creator-manifest-"));
  try {
    const source = join(directory, "batch.json");
    const output = join(directory, "manifest.json");
    writeFileSync(source, JSON.stringify(input([candidate()])));
    assert.equal(exportBatchManifest(["--input", source, "--out", output]), 0);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.summary.proposed, 1);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => exportBatchManifest(["--input", source, "--out", source]), /differ/);
    assert.throws(() => exportBatchManifest(["--input", source, "--out", output]));
    const errorOutput = join(directory, "error.json");
    writeFileSync(source, JSON.stringify(input([], { draftResponse: "bad response" })));
    assert.equal(exportBatchManifest(["--input", source, "--out", errorOutput]), 1);
    assert.equal(JSON.parse(readFileSync(errorOutput, "utf8")).error, "invalid_draft_response");
    const invalidOutput = join(directory, "invalid.json");
    writeFileSync(source, JSON.stringify({ ...input([]), budget: { stakeAtomic: "wrong" } }));
    assert.throws(() => exportBatchManifest(["--input", source, "--out", invalidOutput]));
    assert.equal(existsSync(invalidOutput), false);
    assert.throws(() => exportBatchManifest(["--live"]), /Unknown/);
    assert.throws(() => exportBatchManifest([]), /required/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published synthetic fixture matches the deterministic manifest", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/market-creator-manifest/batch.json", import.meta.url), "utf8"));
  const expected = readFileSync(new URL("../fixtures/market-creator-manifest/manifest.json", import.meta.url), "utf8");
  assert.equal(serializeDryRunBatchManifest(buildDryRunBatchManifest(fixture)), expected);
});

test("CLI exports the rejection reason while withholding URL credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "creator-manifest-privacy-"));
  try {
    const source = join(directory, "batch.json");
    const output = join(directory, "manifest.json");
    const password = "synthetic-cli-password-do-not-export";
    const batch = input([candidate("Private source", { resolutionUrl: `https://synthetic-user:${password}@example.org` })]);
    writeFileSync(source, JSON.stringify(batch));
    assert.equal(exportBatchManifest(["--input", source, "--out", output]), 0);
    const exported = readFileSync(output, "utf8");
    const manifest = JSON.parse(exported);
    assert.equal(manifest.entries[0].rejection.code, "invalid_resolution_url");
    assert.equal(manifest.entries[0].resolutionUrl, null);
    assert.equal(exported.includes(password), false);
    assert.equal(exported.includes("synthetic-user"), false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(source, "utf8"), JSON.stringify(batch));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all valid proposals beyond a count cap remain in the report", () => {
  const manifest = buildDryRunBatchManifest(input([candidate(), candidate("Second"), candidate("Third")], {
    budget: { stakeAtomic: "20000000", maxTotalStakeAtomic: "80000000", maxMarkets: 1 },
  }));
  assert.equal(manifest.summary.proposed, 1);
  assert.deepEqual(manifest.entries.map((entry) => entry.rejection?.code ?? null), [null, "market_limit", "market_limit"]);
  assert.equal(manifest.budget.remainingStakeAtomic, "60000000");
});

test("malformed runtime budget and explicit null snapshot fail closed", () => {
  assert.throws(() => buildDryRunBatchManifest({ ...input([]), budget: null } as unknown as BatchManifestInput), /budget object/);
  assert.throws(() => buildDryRunBatchManifest(input([], { existingCandidates: null } as unknown as Partial<BatchManifestInput>)), /array/);
});
