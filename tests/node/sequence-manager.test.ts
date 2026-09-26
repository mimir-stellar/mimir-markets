import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SEQUENCE,
  SequenceError,
  SequenceManager,
  classifySequenceError,
  isSequenceError,
  parseSequence,
  type SequenceFailureKind,
  type SequenceReservation,
} from "../../lib/agents/sequence-manager";

/**
 * Three real `G…` accounts, used only as distinct wallet addresses. A Stellar
 * StrKey is case-sensitive base32, so these are also a reminder that the manager
 * must scope a lock by the exact string, never a case-folded form.
 */
const WALLET_A = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const WALLET_B = "GDFSCDT3PNEMF4IS5HMWQ6E6SG5MUVBKTPKUJC45VGU2V232PSJYP3KP";
const WALLET_C = "GAXBLZIMZGCOMCKTQAOEH3ZO5UBSULHSIGEWMWV5IZAOYDEL7LEDNPKK";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A Horizon-shaped bad-sequence error, to prove the classifier reads nested codes. */
const horizonBadSeq = {
  response: {
    status: 400,
    data: { extras: { result_codes: { transaction: "tx_bad_seq", operations: ["op_underfunded"] } } },
  },
};

test("concurrent submissions on one wallet serialize and never reuse a sequence", async () => {
  let loads = 0;
  const manager = new SequenceManager({
    loader: async () => {
      loads += 1;
      return "100";
    },
  });

  let active = 0;
  let maxActive = 0;
  const seen: bigint[] = [];
  const submit = async (reservation: SequenceReservation): Promise<bigint> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    seen.push(reservation.sequence);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return reservation.sequence;
  };

  const results = await Promise.all([
    manager.guardedSubmit(WALLET_A, submit),
    manager.guardedSubmit(WALLET_A, submit),
    manager.guardedSubmit(WALLET_A, submit),
  ]);

  assert.equal(maxActive, 1, "the wallet lease must admit one submission at a time");
  assert.deepEqual(results, [101n, 102n, 103n]);
  assert.deepEqual(seen, [101n, 102n, 103n]);
  assert.equal(loads, 1, "one authoritative read covers the whole serialized burst");
  assert.deepEqual(manager.snapshot(WALLET_A).reserved, []);
});

test("different wallets do not block each other", async () => {
  const manager = new SequenceManager({ loader: async () => "5" });
  const release = deferred<void>();
  let concurrent = 0;
  let maxConcurrent = 0;

  const submit = async (): Promise<string> => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await release.promise;
    concurrent -= 1;
    return "ok";
  };

  const first = manager.guardedSubmit(WALLET_A, submit);
  const second = manager.guardedSubmit(WALLET_B, submit);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(maxConcurrent, 2, "a lock is scoped to one wallet, not the process");

  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["ok", "ok"]);
});

test("reclaim returns a rejected number to the pool while commit consumes it", async () => {
  const manager = new SequenceManager({ loader: async () => "40" });

  const first = await manager.reserve(WALLET_A);
  assert.equal(first.sequence, 41n);
  first.reclaim();

  const second = await manager.reserve(WALLET_A);
  assert.equal(second.sequence, 41n, "a reclaimed number is reused, not skipped");
  second.commit();

  const third = await manager.reserve(WALLET_A);
  assert.equal(third.sequence, 42n, "a committed number advances the cursor");
  third.commit();

  assert.equal(manager.snapshot(WALLET_A).nextSequence, 42n);
  assert.equal(manager.snapshot(WALLET_A).inFlight, false);
});

test("a settled lease is idempotent and always frees the wallet", async () => {
  const manager = new SequenceManager({ loader: async () => "7" });

  const lease = await manager.reserve(WALLET_A);
  assert.equal(lease.sequence, 8n);
  lease.commit();
  lease.commit(); // second call is a no-op, not a double release of the gate
  assert.equal(lease.settled, true);

  const next = await manager.reserve(WALLET_A);
  assert.equal(next.sequence, 9n, "commit consumed 8, so 9 is next");
  next.reclaim();
  next.reclaim(); // settle is idempotent in this direction too
  assert.equal(manager.snapshot(WALLET_A).reserved.length, 0);
});

test("a stale sequence is refreshed and retried once against the new chain value", async () => {
  let loads = 0;
  let chain = 10n;
  const manager = new SequenceManager({
    loader: async () => {
      loads += 1;
      return chain.toString();
    },
  });

  const attempts: bigint[] = [];
  const hash = await manager.guardedSubmit(WALLET_A, async (reservation) => {
    attempts.push(reservation.sequence);
    if (attempts.length === 1) {
      chain = 12n; // another submission landed between build and submit
      throw horizonBadSeq;
    }
    return "hash-ok";
  });

  assert.equal(hash, "hash-ok");
  assert.deepEqual(attempts, [11n, 13n], "the rejected 11 is reclaimed and the retry uses 13");
  assert.equal(loads, 2, "the retry re-reads the chain before rebuilding");
});

test("repeated stale failures stop at the attempt budget and surface the last error", async () => {
  const manager = new SequenceManager({ loader: async () => "1" });
  let calls = 0;

  await assert.rejects(
    manager.guardedSubmit(
      WALLET_A,
      async () => {
        calls += 1;
        throw horizonBadSeq;
      },
      { attempts: 3 },
    ),
    (error: unknown) => isSequenceError(error) && error.info.kind === "stale" && error.info.safeToRetry,
  );

  assert.equal(calls, 3);
  // A failed burst must not leave the wallet locked for the next poll round.
  const lease = await manager.reserve(WALLET_A);
  lease.reclaim();
});

test("a duplicate submission is never retried and is marked ambiguous", async () => {
  let loads = 0;
  const manager = new SequenceManager({
    loader: async () => {
      loads += 1;
      return "20";
    },
  });
  let calls = 0;
  const duplicate = {
    response: { status: 400, data: { extras: { result_codes: { transaction: "tx_duplicate" } } } },
  };

  await assert.rejects(
    manager.guardedSubmit(
      WALLET_A,
      async () => {
        calls += 1;
        throw duplicate;
      },
      { attempts: 3 },
    ),
    (error: unknown) =>
      isSequenceError(error) &&
      error.info.kind === "duplicate" &&
      error.info.ambiguous &&
      !error.info.safeToRetry,
  );

  assert.equal(calls, 1, "a duplicate may already be on chain — resubmitting would be unsafe");
  assert.equal(loads, 2, "the sequence is refreshed so the next call is not stale");
  assert.equal(manager.snapshot(WALLET_A).lastFailureKind, "duplicate");
});

test("malformed, stale, duplicate, cancelled, paused and dependency failures are classified", () => {
  const cases: Array<[unknown, SequenceFailureKind]> = [
    [horizonBadSeq, "stale"],
    [new Error("tx_bad_seq"), "stale"],
    [{ response: { status: 400, data: { extras: { result_codes: { transaction: "tx_duplicate" } } } } }, "duplicate"],
    [{ response: { status: 400, data: { extras: { result_codes: { transaction: "tx_too_late" } } } } }, "cancelled"],
    [new Error("transaction is not yet valid"), "cancelled"],
    [new Error("market creation is temporarily paused"), "paused"],
    [new Error("byoa funded actions is not enabled"), "paused"],
    [new Error("fetch failed"), "dependency_failure"],
    [new Error("503 Service Unavailable"), "dependency_failure"],
    [new Error("XR Read Error: malformed envelope"), "malformed"],
    [new Error("wholly unexpected"), "unknown"],
  ];

  for (const [error, kind] of cases) {
    assert.equal(classifySequenceError(error).kind, kind, `${String(error)} -> ${kind}`);
  }

  // An already-classified error keeps its own verdict rather than being re-parsed.
  const stale = classifySequenceError(horizonBadSeq);
  assert.deepEqual(classifySequenceError(new SequenceError(stale)), stale);
});

test("a malformed authoritative sequence is refused, never retried, and leaves no lease", async () => {
  let loads = 0;
  const manager = new SequenceManager({
    loader: async () => {
      loads += 1;
      return loads === 1 ? "not-a-number" : "5";
    },
  });
  let submitted = 0;

  await assert.rejects(
    manager.guardedSubmit(WALLET_A, async () => {
      submitted += 1;
      return "never";
    }),
    (error: unknown) => isSequenceError(error) && error.info.kind === "malformed",
  );

  assert.equal(submitted, 0, "nothing may be built on an unreadable sequence");
  assert.equal(manager.snapshot(WALLET_A).inFlight, false);
  assert.deepEqual(manager.snapshot(WALLET_A).reserved, []);

  // The failed reservation released the gate: the next read is authoritative.
  const lease = await manager.reserve(WALLET_A);
  assert.equal(lease.sequence, 6n);
  lease.reclaim();
});

test("a paused wallet never reserves, reads or submits", async () => {
  let paused = true;
  let loads = 0;
  const manager = new SequenceManager({
    loader: async () => {
      loads += 1;
      return "1";
    },
    isPaused: () => paused,
  });
  let submitted = 0;

  await assert.rejects(
    manager.guardedSubmit(WALLET_A, async () => {
      submitted += 1;
      return "never";
    }),
    (error: unknown) =>
      isSequenceError(error) && error.info.kind === "paused" && error.info.safeToRetry === false,
  );

  assert.equal(loads, 0);
  assert.equal(submitted, 0);
  assert.equal(manager.snapshot(WALLET_A).inFlight, false);

  paused = false;
  const lease = await manager.reserve(WALLET_A);
  assert.equal(lease.sequence, 2n, "the gate is free again once the pause clears");
  lease.reclaim();
});

test("an unexpected failure is ambiguous and still releases the wallet gate", async () => {
  const manager = new SequenceManager({ loader: async () => "1" });

  await assert.rejects(
    manager.guardedSubmit(WALLET_A, async () => {
      throw new Error("kaboom");
    }),
    (error: unknown) =>
      isSequenceError(error) &&
      error.info.kind === "unknown" &&
      error.info.ambiguous &&
      !error.info.safeToRetry,
  );

  const lease = await manager.reserve(WALLET_A);
  assert.equal(lease.sequence, 2n);
  lease.reclaim();
});

test("a transport failure is ambiguous and is not auto-retried", async () => {
  const manager = new SequenceManager({ loader: async () => "1" });
  let calls = 0;

  await assert.rejects(
    manager.guardedSubmit(
      WALLET_A,
      async () => {
        calls += 1;
        throw new Error("fetch failed");
      },
      { attempts: 3 },
    ),
    (error: unknown) =>
      isSequenceError(error) &&
      error.info.kind === "dependency_failure" &&
      error.info.ambiguous &&
      !error.info.safeToRetry,
  );

  assert.equal(calls, 1, "a possibly-delivered request must never be replayed blindly");
});

test("an explicit refresh reconciles the cursor with the chain in both directions", async () => {
  let chain = 50n;
  const manager = new SequenceManager({ loader: async () => chain.toString() });

  assert.equal(await manager.refresh(WALLET_A), 50n);

  chain = 55n; // the chain moved on (a landed transaction or another actor)
  assert.equal(await manager.refresh(WALLET_A), 55n);
  assert.equal(manager.snapshot(WALLET_A).nextSequence, 55n);

  chain = 53n; // a lower read is drift, not a real reversal; the cursor must follow
  await manager.refresh(WALLET_A);
  assert.equal(manager.snapshot(WALLET_A).nextSequence, 53n);
});

test("recover classifies a failure, records it and re-reads the chain", async () => {
  let loads = 0;
  const manager = new SequenceManager({
    loader: async () => {
      loads += 1;
      return "2";
    },
  });

  const info = await manager.recover(WALLET_A, new Error("tx_bad_seq"));
  assert.deepEqual(
    { kind: info.kind, safeToRetry: info.safeToRetry, requiresRefresh: info.requiresRefresh, ambiguous: info.ambiguous },
    { kind: "stale", safeToRetry: true, requiresRefresh: true, ambiguous: false },
  );
  assert.equal(loads, 1);
  assert.equal(manager.snapshot(WALLET_A).lastFailureKind, "stale");

  const second = await manager.recover(WALLET_A, new Error("tx_too_late"));
  assert.deepEqual(
    { kind: second.kind, safeToRetry: second.safeToRetry, ambiguous: second.ambiguous },
    { kind: "cancelled", safeToRetry: false, ambiguous: false },
  );
});

test("parseSequence accepts the whole non-negative int64 range and rejects garbage", () => {
  assert.equal(parseSequence("0"), 0n);
  assert.equal(parseSequence("  42  "), 42n);
  assert.equal(parseSequence(MAX_SEQUENCE), MAX_SEQUENCE);
  assert.equal(parseSequence(MAX_SEQUENCE.toString()), MAX_SEQUENCE);

  const malformed = ["", "-1", "1.5", "0x10", "1e3", 1.5, -1, null, undefined, {}, [], true];
  for (const value of malformed) {
    assert.throws(
      () => parseSequence(value),
      (error: unknown) => isSequenceError(error) && error.info.kind === "malformed",
      `expected ${JSON.stringify(value)} to be malformed`,
    );
  }
  assert.throws(
    () => parseSequence((MAX_SEQUENCE + 1n).toString()),
    (error: unknown) => isSequenceError(error) && error.info.kind === "malformed",
  );
});

test("reset clears tracked state so a recovered wallet re-reads the chain", async () => {
  const manager = new SequenceManager({ loader: async () => "9" });

  const lease = await manager.reserve(WALLET_A);
  lease.commit();
  lease.reclaim(); // already settled: a no-op
  assert.equal(manager.snapshot(WALLET_A).nextSequence, 10n);

  manager.reset(WALLET_A);
  const fresh = await manager.reserve(WALLET_A);
  assert.equal(fresh.sequence, 10n, "state was dropped and the chain re-read");
  fresh.reclaim();

  manager.reset();
  assert.equal(manager.snapshot(WALLET_B).networkSequence, null);
});

test("runExclusive serializes an arbitrary critical section per wallet", async () => {
  const manager = new SequenceManager({ loader: async () => "0" });
  const order: string[] = [];
  const gate = deferred<void>();

  const first = manager.runExclusive(WALLET_C, async () => {
    order.push("first-in");
    await gate.promise;
    order.push("first-out");
  });
  const second = manager.runExclusive(WALLET_C, async () => {
    order.push("second-in");
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["first-in"], "the second section waits for the first");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-in", "first-out", "second-in"]);
  assert.equal(manager.snapshot(WALLET_C).inFlight, false);
});
