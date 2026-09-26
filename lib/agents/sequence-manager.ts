/**
 * Safe worker-wallet sequence management.
 *
 * ── The hazard this closes ────────────────────────────────────────────────────
 *
 * A Stellar transaction is only valid for exactly one sequence number: the
 * source account's current sequence plus one. The Soroban bindings build that
 * number into the envelope at ASSEMBLY time — `client.create_claim(...)`
 * simulates and freezes the transaction before `signAndSend()` is ever called —
 * and the classic payment helpers in `lib/agent-wallets.ts` do the same with a
 * `horizon.loadAccount()` read.
 *
 * So when two submissions from the SAME worker wallet overlap, both read the
 * same account sequence, both sign a transaction carrying `N+1`, and the second
 * is rejected `tx_bad_seq`. Nothing is lost, but the operation silently fails
 * and the worker has no idea whether its own first transaction landed. This
 * module makes that impossible by construction.
 *
 * ── What it does, and what it deliberately does NOT do ───────────────────────
 *
 * It owns a per-wallet lease. `reserve(address)` takes the wallet's only lock
 * (an in-process FIFO gate) and returns a {@link SequenceReservation}; the
 * caller MUST settle it with `commit()` (the transaction was submitted) or
 * `reclaim()` (nothing was submitted, so the next lease reuses the number).
 * Because the lock is held from the authoritative read, through the assembly
 * that bakes the sequence in, to the submit, two overlapping calls cannot read
 * the same sequence.
 *
 * The manager does NOT rewrite the sequence inside an assembled envelope. The
 * SDK owns that value and rebuilding a signed `Transaction` to patch it is
 * version-specific and far more dangerous than serializing the span that reads
 * it. What the tracked `sequence` on a reservation buys instead is drift
 * detection: the manager knows what the chain last said, what the next number
 * handed out was, and whether a refresh found the chain ahead (a transaction
 * landed, or an external actor used the account) or behind (a submission was
 * rejected and the cursor must roll back).
 *
 * ── Explicit behaviour per failure mode ──────────────────────────────────────
 *
 *   malformed          a sequence the chain reported is not a valid `int64`
 *                      (or a value outside the non-negative range). Never
 *                      retried; the wallet is left unlocked and its last known
 *                      sequence intact.
 *   stale              `tx_bad_seq` / `tx_bad_minseq`. The attempt consumed
 *                      nothing, so the manager refreshes from the chain and
 *                      retries the build+submit within the attempt budget.
 *   duplicate          `tx_duplicate`. The transaction may ALREADY be on chain,
 *                      so it is never auto-retried and is marked `ambiguous`:
 *                      reconcile by hash before doing anything else.
 *   cancelled          `tx_too_late` / `tx_too_early` (timebounds). Not retried
 *                      automatically — the operation's window is in question.
 *   paused             the incident switch (or a disabled feature) blocked the
 *                      wallet. No sequence is reserved and nothing is retried.
 *   dependency_failure a transport/RPC/Horizon failure. The request may have
 *                      been delivered, so it is `ambiguous` and never
 *                      auto-retried; the caller refetches and reconciles.
 *   unknown            anything unrecognised. Treated as ambiguous and halted.
 */

/** A sequence value as a loader may report it (both Horizon and RPC return strings). */
export type SequenceValue = bigint | string | number;

/** Authoritative read of an account's current sequence number. */
export type SequenceLoader = (address: string) => Promise<SequenceValue>;

/**
 * Signed 64-bit maximum, matching the XDR `SequenceNumber` used by Stellar Core.
 * The value is reported as a decimal string; anything past this is not a
 * sequence the chain can hold.
 */
export const MAX_SEQUENCE = (1n << 63n) - 1n;

export type SequenceFailureKind =
  | "malformed"
  | "stale"
  | "duplicate"
  | "cancelled"
  | "paused"
  | "dependency_failure"
  | "unknown";

export interface SequenceFailureInfo {
  kind: SequenceFailureKind;
  /**
   * Safe to re-attempt automatically because the failed attempt consumed
   * nothing. `duplicate` / `cancelled` / transport failures are deliberately
   * false: the transaction may have landed.
   */
  safeToRetry: boolean;
  /** Re-read the authoritative sequence before the next attempt. */
  requiresRefresh: boolean;
  /** The attempt may already be on chain — reconcile before resubmitting. */
  ambiguous: boolean;
  message: string;
}

interface FailurePolicy {
  safeToRetry: boolean;
  requiresRefresh: boolean;
  ambiguous: boolean;
}

const FAILURE_POLICY: Record<SequenceFailureKind, FailurePolicy> = {
  malformed: { safeToRetry: false, requiresRefresh: false, ambiguous: false },
  stale: { safeToRetry: true, requiresRefresh: true, ambiguous: false },
  duplicate: { safeToRetry: false, requiresRefresh: true, ambiguous: true },
  cancelled: { safeToRetry: false, requiresRefresh: true, ambiguous: false },
  paused: { safeToRetry: false, requiresRefresh: false, ambiguous: false },
  dependency_failure: { safeToRetry: false, requiresRefresh: true, ambiguous: true },
  unknown: { safeToRetry: false, requiresRefresh: false, ambiguous: true },
};

/** An error carrying a {@link SequenceFailureInfo} so agent loops can branch on it. */
export class SequenceError extends Error {
  readonly info: SequenceFailureInfo;

  constructor(info: SequenceFailureInfo) {
    super(info.message);
    this.name = "SequenceError";
    this.info = info;
  }
}

export function isSequenceError(value: unknown): value is SequenceError {
  return value instanceof SequenceError;
}

function sequenceFailure(kind: SequenceFailureKind, message: string): SequenceError {
  return new SequenceError({ kind, message, ...FAILURE_POLICY[kind] });
}

/**
 * Validate and normalise one sequence value.
 *
 * Both Horizon (`AccountResponse.sequenceNumber()`) and Soroban RPC
 * (`Account.sequenceNumber()`) hand back a decimal string, but a malformed or
 * truncated payload must fail loudly here rather than become a silently wrong
 * `BigInt` deeper in the path.
 */
export function parseSequence(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_SEQUENCE) {
      throw sequenceFailure("malformed", `sequence is out of range: ${value}`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw sequenceFailure("malformed", `sequence is not a non-negative integer: ${String(value)}`);
    }
    const parsed = BigInt(value);
    if (parsed > MAX_SEQUENCE) {
      throw sequenceFailure("malformed", `sequence is out of range: ${String(value)}`);
    }
    return parsed;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw sequenceFailure("malformed", `sequence is not a non-negative integer: ${JSON.stringify(value)}`);
    }
    const parsed = BigInt(trimmed);
    if (parsed > MAX_SEQUENCE) {
      throw sequenceFailure("malformed", `sequence is out of range: ${trimmed}`);
    }
    return parsed;
  }
  throw sequenceFailure("malformed", `sequence has an unexpected type: ${typeof value}`);
}

const DUPLICATE_MARKERS = [
  "tx_duplicate",
  "txduplicate",
  "duplicate",
  "already exists",
  "already submitted",
] as const;

const CANCELLED_MARKERS = [
  "tx_too_late",
  "txtoolate",
  "too late",
  "tx_too_early",
  "txtooearly",
  "not yet valid",
  "tx_bad_timebounds",
  "tx_too_far",
] as const;

const STALE_MARKERS = [
  "tx_bad_seq",
  "txbadseq",
  "bad_seq",
  "badseq",
  "tx_bad_minseq",
  "txbadminseq",
  "bad min seq",
  "invalid sequence",
  "sequence number",
] as const;

const MALFORMED_MARKERS = [
  "malformed",
  "invalid xdr",
  "cannot parse",
  "xdr read error",
  "unexpected type",
] as const;

const DEPENDENCY_MARKERS = [
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  "ehostunreach",
  "fetch failed",
  "socket hang up",
  "network error",
  "timed out",
  "timeout",
  "429",
  "rate limit",
  "too many requests",
  "502",
  "503",
  "504",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "internal server error",
] as const;

const PAUSED_MARKERS = [
  "paused",
  "temporarily paused",
  "kill switch",
  "is not enabled",
  "is unavailable",
  "temporarily disabled",
] as const;

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    // Leaves are always collected, however deep: a Horizon `result_codes.transaction`
    // sits five levels down and is exactly the string that matters.
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object") return;
    if (depth > 6) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value instanceof Error) parts.push(value.name, value.message);

    const record = value as Record<string, unknown>;
    let entries: unknown[] = [];
    try {
      entries = Object.values(record);
    } catch {
      entries = [];
    }
    for (const entry of entries) visit(entry, depth + 1);
  };

  visit(error, 0);
  return parts.join(" | ").toLowerCase();
}

function matchesAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

/**
 * Map an arbitrary submit/refresh failure onto an explicit sequence-failure kind.
 *
 * Horizon reports `result_codes.transaction = "tx_bad_seq"`, Soroban RPC reports
 * a transaction status with an XDR result, and a Node fetch failure is a bare
 * `TypeError`, so the classifier walks the whole error graph rather than reading
 * one `.message`. Anything it cannot place is `unknown`, which is treated as
 * ambiguous — never as safe to retry.
 */
export function classifySequenceError(error: unknown): SequenceFailureInfo {
  if (isSequenceError(error)) return error.info;

  const text = errorText(error);
  const kind: SequenceFailureKind = matchesAny(text, DUPLICATE_MARKERS)
    ? "duplicate"
    : matchesAny(text, CANCELLED_MARKERS)
      ? "cancelled"
      : matchesAny(text, STALE_MARKERS)
        ? "stale"
        : matchesAny(text, MALFORMED_MARKERS)
          ? "malformed"
          : matchesAny(text, DEPENDENCY_MARKERS)
            ? "dependency_failure"
            : matchesAny(text, PAUSED_MARKERS)
              ? "paused"
              : "unknown";

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : `unclassified sequence failure (${kind})`;

  return { kind, ...FAILURE_POLICY[kind], message };
}

/** A lease on one wallet's next sequence number. Settle it exactly once. */
export interface SequenceReservation {
  readonly address: string;
  /** The number reserved (the chain's sequence plus one at reservation time). */
  readonly sequence: bigint;
  readonly settled: boolean;
  /** The transaction was submitted: consume the number and free the wallet. */
  commit(): bigint;
  /** Nothing was submitted: return the number to the pool and free the wallet. */
  reclaim(): bigint;
}

export interface SequenceSnapshot {
  address: string;
  /** Last sequence the chain reported; null until the first successful read. */
  networkSequence: bigint | null;
  /** Highest sequence handed out in this process. */
  nextSequence: bigint | null;
  /** Sequences currently reserved (at most one, because the lease holds the gate). */
  reserved: bigint[];
  lastRefreshedAt: number | null;
  lastFailureKind: SequenceFailureKind | null;
  paused: boolean;
  inFlight: boolean;
}

export interface SequenceManagerOptions {
  /**
   * Authoritative sequence read. Defaults to Soroban RPC with a Horizon
   * fallback ({@link createStellarSequenceLoader}).
   */
  loader?: SequenceLoader;
  /** Consulted before every reservation; an incident switch or kill list. */
  isPaused?: (address: string) => boolean;
  /** Injectable clock, for deterministic snapshots in tests. */
  now?: () => number;
}

export interface GuardedSubmitOptions {
  /** Total build+submit attempts. Default 2 (one retry for a `stale` rejection). */
  attempts?: number;
  /** Base delay between attempts, multiplied by the attempt number. Default 0. */
  retryDelayMs?: number;
  /** Observability hook: called before a retry, with the classified failure. */
  onRetry?: (info: SequenceFailureInfo, attempt: number) => void;
}

interface WalletState {
  networkSequence: bigint | null;
  nextSequence: bigint | null;
  reserved: bigint[];
  lastRefreshedAt: number | null;
  lastFailureKind: SequenceFailureKind | null;
}

/**
 * An in-process FIFO gate: one holder at a time, waiters served in arrival
 * order. Handing the lock directly to the next waiter keeps `held` true so a
 * released wallet can never be acquired twice.
 */
class WalletGate {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  get waiting(): number {
    return this.waiters.length;
  }

  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.held = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function removeReserved(state: WalletState, sequence: bigint): void {
  const index = state.reserved.indexOf(sequence);
  if (index >= 0) state.reserved.splice(index, 1);
}

/**
 * Soroban RPC first, Horizon second — both report the SAME account sequence, and
 * the fallback exists because a rate-limited or briefly unavailable RPC must not
 * be able to stall every worker on the fleet.
 */
export function createStellarSequenceLoader(): SequenceLoader {
  return async (address: string) => {
    const { createHorizonServer, createSorobanRpcServer } = await import("@/lib/stellar");
    try {
      const account = await createSorobanRpcServer().getAccount(address);
      return account.sequenceNumber();
    } catch (rpcError) {
      try {
        const account = await createHorizonServer().loadAccount(address);
        return account.sequenceNumber();
      } catch {
        throw rpcError;
      }
    }
  };
}

/**
 * Per-worker-wallet sequence leases and drift tracking.
 *
 * One instance is process-wide ({@link sequenceManager}) so every submission
 * path in a worker shares the same lock; the class is exported so tests and
 * isolated callers can supply their own loader.
 */
export class SequenceManager {
  private readonly loader: SequenceLoader;
  private readonly pausedFor: (address: string) => boolean;
  private readonly clock: () => number;
  private readonly states = new Map<string, WalletState>();
  private readonly gates = new Map<string, WalletGate>();

  constructor(options: SequenceManagerOptions = {}) {
    this.loader = options.loader ?? createStellarSequenceLoader();
    this.pausedFor = options.isPaused ?? (() => false);
    this.clock = options.now ?? (() => Date.now());
  }

  private stateFor(address: string): WalletState {
    let state = this.states.get(address);
    if (!state) {
      state = {
        networkSequence: null,
        nextSequence: null,
        reserved: [],
        lastRefreshedAt: null,
        lastFailureKind: null,
      };
      this.states.set(address, state);
    }
    return state;
  }

  private gateFor(address: string): WalletGate {
    let gate = this.gates.get(address);
    if (!gate) {
      gate = new WalletGate();
      this.gates.set(address, gate);
    }
    return gate;
  }

  private async loadSequence(address: string): Promise<bigint> {
    // `parseSequence` throws a `malformed` SequenceError on an unusable payload.
    return parseSequence(await this.loader(address));
  }

  /**
   * Fold an authoritative read into the tracking state.
   *
   * With no lease out, the chain is the whole truth and the cursor is replaced.
   * With a lease out, a number already handed to a transaction in flight must
   * never be reissued, so the cursor only moves forward.
   */
  private reconcile(state: WalletState, observed: bigint): void {
    state.networkSequence = observed;
    state.lastRefreshedAt = this.clock();
    if (state.reserved.length === 0) {
      state.nextSequence = observed;
      return;
    }
    if (state.nextSequence === null || state.nextSequence < observed) {
      state.nextSequence = observed;
    }
  }

  /** Re-read the chain, folding the result into the tracking state. */
  async refresh(address: string): Promise<bigint> {
    const gate = this.gateFor(address);
    await gate.acquire();
    try {
      const observed = await this.loadSequence(address);
      this.reconcile(this.stateFor(address), observed);
      return observed;
    } finally {
      gate.release();
    }
  }

  private async refreshBestEffort(address: string): Promise<void> {
    try {
      this.reconcile(this.stateFor(address), await this.loadSequence(address));
    } catch {
      // A refresh is best-effort: a dead RPC must not replace the real failure
      // with a confusing one. The last known sequence stays authoritative.
    }
  }

  /**
   * Take the wallet's lease and return the next sequence number.
   *
   * Throws (releasing the lease) when the wallet is paused or the chain reports a
   * malformed sequence, so a caller can never proceed on untrusted state.
   */
  async reserve(address: string): Promise<SequenceReservation> {
    const gate = this.gateFor(address);
    await gate.acquire();
    try {
      if (this.pausedFor(address)) {
        throw sequenceFailure("paused", `worker wallet ${address} is paused — no sequence reserved`);
      }
      const state = this.stateFor(address);
      if (state.nextSequence === null) {
        this.reconcile(state, await this.loadSequence(address));
      }
      const sequence = (state.nextSequence ?? 0n) + 1n;
      if (sequence > MAX_SEQUENCE) {
        throw sequenceFailure("malformed", `worker wallet ${address} has exhausted the sequence space`);
      }
      state.nextSequence = sequence;
      state.reserved.push(sequence);
      return this.makeReservation(address, sequence, gate, state);
    } catch (error) {
      gate.release();
      throw error;
    }
  }

  private makeReservation(
    address: string,
    sequence: bigint,
    gate: WalletGate,
    state: WalletState,
  ): SequenceReservation {
    let settled = false;

    const reservation: SequenceReservation = {
      address,
      sequence,
      get settled(): boolean {
        return settled;
      },
      commit: (): bigint => {
        if (settled) return sequence;
        settled = true;
        removeReserved(state, sequence);
        if (state.nextSequence === null || state.nextSequence < sequence) {
          state.nextSequence = sequence;
        }
        gate.release();
        return sequence;
      },
      reclaim: (): bigint => {
        if (settled) return sequence;
        settled = true;
        removeReserved(state, sequence);
        // Nothing is in flight any more, so the last authoritative read is the
        // truth again — otherwise the rejected number would be skipped and the
        // next submission would be `tx_bad_seq` all over again.
        if (state.reserved.length === 0) {
          state.nextSequence = state.networkSequence;
        }
        gate.release();
        return sequence;
      },
    };

    return reservation;
  }

  /**
   * Run `submit` inside the wallet's lease, then settle it from the outcome.
   *
   * On a `stale` rejection the lease is reclaimed, the chain is re-read while the
   * lease is still held (so no other caller can be handed a superseded number),
   * and the whole build+submit is retried. `duplicate`, `cancelled`, transport
   * and unknown failures are never retried — they are ambiguous and the caller
   * must reconcile by hash.
   */
  async guardedSubmit<T>(
    address: string,
    submit: (reservation: SequenceReservation) => Promise<T>,
    options: GuardedSubmitOptions = {},
  ): Promise<T> {
    const attempts = Math.max(1, Math.floor(options.attempts ?? 2));
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    let lastError: unknown = null;
    let lastInfo: SequenceFailureInfo | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const reservation = await this.reserve(address);
      try {
        const value = await submit(reservation);
        reservation.commit();
        return value;
      } catch (error) {
        lastError = error;
        const info = classifySequenceError(error);
        lastInfo = info;
        this.stateFor(address).lastFailureKind = info.kind;
        // Refresh BEFORE releasing the lease, so a concurrent reservation cannot
        // be handed a sequence the chain has already moved past.
        if (info.requiresRefresh) await this.refreshBestEffort(address);
        reservation.reclaim();
        if (!info.safeToRetry || attempt >= attempts) break;
        options.onRetry?.(info, attempt);
        if (retryDelayMs > 0) await delay(retryDelayMs * attempt);
      }
    }

    if (isSequenceError(lastError)) throw lastError;
    throw new SequenceError(lastInfo ?? classifySequenceError(lastError));
  }

  /** Classify a failure, record it, and re-read the chain when the kind warrants it. */
  async recover(address: string, error: unknown): Promise<SequenceFailureInfo> {
    const info = classifySequenceError(error);
    this.stateFor(address).lastFailureKind = info.kind;
    if (info.requiresRefresh) await this.refreshBestEffort(address);
    return info;
  }

  /** Run an arbitrary per-wallet critical section without reserving a number. */
  async runExclusive<T>(address: string, fn: (snapshot: SequenceSnapshot) => Promise<T>): Promise<T> {
    const gate = this.gateFor(address);
    await gate.acquire();
    try {
      return await fn(this.snapshot(address));
    } finally {
      gate.release();
    }
  }

  snapshot(address: string): SequenceSnapshot {
    const state = this.stateFor(address);
    return {
      address,
      networkSequence: state.networkSequence,
      nextSequence: state.nextSequence,
      reserved: [...state.reserved],
      lastRefreshedAt: state.lastRefreshedAt,
      lastFailureKind: state.lastFailureKind,
      paused: this.pausedFor(address),
      inFlight: state.reserved.length > 0,
    };
  }

  /**
   * Drop tracked state. Operator/test recovery only: never call it while a lease
   * is out, because a fresh gate would let a second submission start alongside
   * the one still in flight.
   */
  reset(address?: string): void {
    if (address === undefined) {
      this.states.clear();
      this.gates.clear();
      return;
    }
    this.states.delete(address);
    this.gates.delete(address);
  }
}

/** Process-wide manager shared by every worker submission path. */
export const sequenceManager = new SequenceManager();

/** Convenience wrapper so a caller does not have to reach for the singleton. */
export function withWorkerWalletSequence<T>(
  address: string,
  submit: (reservation: SequenceReservation) => Promise<T>,
  options?: GuardedSubmitOptions,
): Promise<T> {
  return sequenceManager.guardedSubmit(address, submit, options);
}
