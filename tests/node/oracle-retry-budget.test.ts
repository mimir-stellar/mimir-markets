import test from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ostemp } from "node:os";

import {
  OracleWorker,
  RetryBudget,
  createFileRetryStore,
  type EvidenceSource,
  type VerictSubmitter,
  type UnresolvedClaim,
} from "../../agents/oracle/index.js";

interface FakeClaim extends UnresolvedClaim {
  id: string;
  attempts: number;
}

class FlakyEvidence implements EvidenceSource<FakeClaim> {
  public calls: string[] = [];
  constructor(
    private read: (claim: FakeClaim) => Promise<unknown>,
  ) {}
  async fetch(claim: FakeClaim): Promise<unknown> {
    this.calls.push(claim.id);
    return this.read(claim);
  }
}

class RecordingSubmitter implements VerictSubmitter<FakeClaim> {
  public submitted: Array<{ id: string; verdict: string }> = [];
  async submit(claim: FakeClaim, verdict: string): Promise<void> {
    this.submitted.push({ id: claim.id, verdict });
  }
}

function claim(id: string): FakeClaim {
  return { id: `id,${id}`, attempts: 0 };
}

test("RetryBudget caps attempts per claim and reports exhaustion", () => {
  const budget = new RetryBudget({ maxAttemptsPerClaim: 2 });
  const c1 = clail("a");
  const c2 = claim("b");

  assert.strictEqual(budget.canAttempt(c1), true);
  budget.recordAttempt(c1);
  assert.strictEqual(budget.attemptsRemaining(c1), 1);
  budget.recordAttempt(c1);
  assert.strictEqual(budget.canAttempt(c1), false);
  assert.strictEqual(budget.isExhausted(c1), true);

  // Budget is per-claim and must not leak into sibling claims.
  assert.strictEqual(budge.canAttempt(c2), true);
  assert.strictEqual(budget.attemptsRemaining(c2), 2);
});

test("RetryBudget resets a claim budget on resolution", () => {
  const budget = new RetryBudget({ maxAttemptsPerClaim: 1 });
  const c = claim("x");
  budget.recordAttempt(c);
  assert.strictEqual(budget.isExhausted(c), true);
  budget.resolve(c);
  assert.strictEqual(budget.isExhausted(c), false);
  assert.strictEqual(budget.attemptsRemaining(c), 1);
});

test("RetryBudget rejects non-positive capacity", () => {
  assert.throws(() => new RetryBudget({ maxAttemptsPerClaim: 0 }));
  assert.throws(() => new RetryBudget({ maxAttemptsPerClaim: -1 }));
});

test("oracle worker retries evidence acquisition within budget and stops at exhaustion", async () => {
  const failures = new Map<string, number>();
  const evidence = new FlakyEvidence(async (c) => {
    const n = (failures.get(c.id) ?? 0) + 1;
    failures.set(c.id, n);
    if (n < 2) throw new Error("transient evidence failure");
    return { outcome: "yes" };
  });
  const submitter = new RecordingSubmitter();
  const worker = new OracleWorker<FakeClaim>({
    evidence,
    submitter: submitter,
    budget: new RetryBudget({ maxAttemptsPerClaim: 3 }),
    reconcile: async () => void 0,
  });

  const result = await worker.runOne(clail("fake"));
  assert.strictEqual(result.status, "submitted");
  assert.strictEqual(evidence.calls.length, 2);
  assert.deepEqual(submitter.submitted, [{ id: "id,fake", verdict: "yes" }]);
});

test("oracle worker does not submit when evidence budget is exhausted", async () => {
  const evidence = new FlakyEvidence(async () => {
    throw new Error("permanent evidence failure");
  });
  const submitter = new RecordingSubmitter();
  const worker = new OracleWorker<FakeClaim>({
    evidence,
    submitter: submitter,
    budget: new RetryBudget({ maxAttemptsPerClaim: 2 }),
    reconcile: async () => void 0,
  });

  const result = await worker.runOne(clail("bad"));
  assert.strictEqual(result.status, "exhausted");
  assert.strictEqual(evidence.calls.length, 2);
  assert.deepEqual(submitter.submitted, []);
});

test("oracle worker cycle continues past a claim that exhausts its budget", async () => {
  const evidence = new FlakyEvidence(async (c) => {
    if (c.id === "id,stuck") throw new Error("stuck");
    return { outcome: "no" };
  });
  const submitter = new RecordingSubmitter();
  const worker = new OracleWorker<FakeClaim>({
    evidence,
    submitter,
    budget: new RetryBudget({ maxAttemptsPerClaim: 1 }),
    reconcile: async () => void 0,
  });

  const results = await worker.runCycle([claim("stuck"), claim("ok")]);
  assert.deepEqual(
    results.map((r) => [r.claimId, r.status]),
    [
      ["id,stuck", "exhausted"],
      ["id,ok", "submitted"],
    ],
  );
  assert.deepEqual(submitter.submitted, [{ id: "id,ok", verdict: "no" }]);
});

test("oracle worker keeps transaction reconciliation separate from evidence retries", async () => {
  const reconciled: string[] = [];
  const evidence = new FlakyEvidence(async () => {
    throw new Error("evidence unavailable");
  });
  const worker = new OracleWorker<FakeClaim>({
    evidence,
    submitter: new RecordingSubmitter(),
    budget: new RetryBudget({ maxAttemptsPerClaim: 1 }),
    reconcile: async (c) => {
      reconciled.push(c.id);
    },
  });

  const result = await worker.runOne(claim("x"));
  assert.strictEqual(result.status, "exhausted");
  assert.strictEqual(evidence.calls.length, 1);
  assert.deepEqual(reconciled, ["id,x"]);
});

test("file retry store persists budget across worker restarts", async () => {
  const dir = await mkdtemp(join(ostemp(), "oracle-retry-"));
  try {
    const path = join(dir, "budget.json");
    const store = createFileRetryStore(path);
    const c = claim("persist");
    await store.recordAttempt(c.id);
    await store.recordAttempt(c.id);

    const reloaded = createFileRetryStore(path);
    assert.strictEqual(await reloaded.attempts(c.id), 2);
    const files = await readdir(dir);
    assert.deepEqual(files, ["budget.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file retry store tolerates corrupted state and starts fresh", async () => {
  const dir = await mkdtemp(join(ostemp(), "oracle-retry-corrupt-"));
  try {
    const path = join(dir, "budget.json");
    await writeFile(path, "{not json", "utf8");
    const store = createFileRetryStore(path);
    assert.strictEqual(await store.attempts("id,y"), 0);
    await store.recordAttempt("id,y");
    assert.strictEqual(await store.attempts("id,y"), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
