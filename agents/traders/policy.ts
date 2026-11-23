/**
 * Pure policy predicates and bounded decision journal for the demo BYOA traders.
 *
 * Keeps decision criteria, claim filtering, and decision journaling testable
 * in Node without needing live network connections, wallets, or databases.
 *
 * The decision journal coordinates with sequence reservations from
 * `lib/agents/sequence-manager.ts` to track autonomous staking decisions within
 * strict spending and sequence bounds, recording signal, policy revision, and
 * disposition digests while strictly excluding private model prompts and signing keys.
 */

import { sha256Hex, isHash32Hex } from "../../lib/content-hash";
import type { SequenceReservation, ReservationState } from "../../lib/agents/sequence-manager";

export interface JoinableClaimCandidate {
  id: number;
  deadline: number;
  creator: string;
  visibility: string;
}

/**
 * Filter down to claims a trader is eligible to challenge:
 * - Must not be within 5 minutes (300s) of deadline
 * - Must not be created by the trader
 * - Must have public visibility
 * - Must not already have a position by this trader
 */
export function filterJoinableClaims<T extends JoinableClaimCandidate>(
  claims: readonly T[],
  challengersById: Map<number, { address: string }[]>,
  myAddress: string,
  nowSeconds: number,
): T[] {
  const joinable: T[] = [];
  for (const claim of claims) {
    if (claim.deadline <= nowSeconds + 300) continue; // too close to settle into
    if (claim.creator === myAddress) continue; // never challenge yourself
    if (claim.visibility !== "public") continue;
    const challengers = challengersById.get(claim.id) ?? [];
    if (challengers.some((c) => c.address === myAddress)) continue; // one position each
    joinable.push(claim);
  }
  return joinable;
}

/**
 * Rounding rule applied when converting a fractional stake into atomic USDC
 * units. Recorded in every dry-run report so the result is auditable.
 *
 * - `policyVersion` bumps whenever the rule changes.
 * - `rounding` is always `"floor"`: a stake never exceeds the requested
 *   fraction of the budget, so spending limits are never breached.
 */
export const STAKE_ROUNDING_POLICY = {
  policyVersion: 1,
  rounding: "floor",
  atomicDecimals: 7,
} as const;

export interface StakeSizingResult {
  /** Stake in atomic USDC units (7 decimals). Integer. */
  stakeAtomic: bigint;
  /** Budget remainder left after the stake, in atomic units. Integer. */
  remainderAtomic: bigint;
  policyVersion: number;
  rounding: string;
}

/**
 * Size a stake as `budgetAtomic * fractionBps / 10000`, rounded down to an
 * integer number of atomic units. `fractionBps` is basis points (0..10000).
 * All arithmetic is integer; no floating point is involved.
 */
export function computeStakeSizing(
  budgetAtomic: bigint,
  fractionBps: number,
): StakeSizingResult {
  if (budgetAtomic < 0n) {
    throw new Error("budgetAtomic must be non-negative");
  }
  if (!Number.isInteger(fractionBps) || fractionBps < 0 || fractionBps > 10000) {
    throw new Error("fractionBps must be an integer in [0, 10000]");
  }
  const product = budgetAtomic * BigInt(fractionBps);
  const stakeAtomic = product / 10000n; // BigInt division floors for non-negative values
  const remainderAtomic = budgetAtomic - stakeAtomic;
  return {
    stakeAtomic,
    remainderAtomic,
    policyVersion: STAKE_ROUNDING_POLICY.policyVersion,
    rounding: STAKE_ROUNDING_POLICY.rounding,
  };
}

export interface SecondOpinionClaimFields {
  question?: string | null;
  creator_position?: string | null;
  counter_position?: string | null;
  resolution_url?: string | null;
  settlement_rule?: string | null;
}

export interface ShouldBuySecondOpinionOptions {
  buySecondOpinion?: boolean;
  mimirUrl?: string | null;
  dryRun?: boolean;
  claim?: SecondOpinionClaimFields | null;
}

/**
 * Pure predicate to determine if a trader should purchase an oracle second opinion over x402.
 *
 * Requirements:
 * - DRY_RUN must be false (dry runs must spend nothing, skipping paid x402 reads)
 * - BUY_SECOND_OPINION must be true
 * - MIMIR_URL must be a non-empty string
 * - claim must have a valid question and resolution_url
 */
export function shouldBuySecondOpinion(
  options: ShouldBuySecondOpinionOptions,
): boolean;
export function shouldBuySecondOpinion(
  buySecondOpinion: boolean,
  mimirUrl: string | null | undefined,
  dryRun: boolean,
  claim: SecondOpinionClaimFields | null | undefined,
): boolean;
export function shouldBuySecondOpinion(
  firstArg: ShouldBuySecondOpinionOptions | boolean,
  mimirUrl?: string | null,
  dryRun?: boolean,
  claim?: SecondOpinionClaimFields | null,
): boolean {
  if (typeof firstArg === "object" && firstArg !== null) {
    return evaluateShouldBuySecondOpinion(
      Boolean(firstArg.buySecondOpinion),
      firstArg.mimirUrl,
      Boolean(firstArg.dryRun),
      firstArg.claim,
    );
  }
  return evaluateShouldBuySecondOpinion(
    Boolean(firstArg),
    mimirUrl,
    Boolean(dryRun),
    claim,
  );
}

function evaluateShouldBuySecondOpinion(
  buySecondOpinion: boolean,
  mimirUrl: string | null | undefined,
  dryRun: boolean,
  claim: SecondOpinionClaimFields | null | undefined,
): boolean {
  if (dryRun) return false;
  if (!buySecondOpinion) return false;
  if (!mimirUrl || !mimirUrl.trim()) return false;
  if (!claim) return false;
  if (!claim.question || !claim.question.trim()) return false;
  if (!claim.resolution_url || !claim.resolution_url.trim()) return false;
  return true;
}

// ── Bounded Trader Decision Journal ──────────────────────────────────────────

/** Default maximum capacity for the in-memory decision journal. */
export const DEFAULT_TRADER_DECISION_JOURNAL_CAPACITY = 200;

/** Stellar secret seeds start with 'S' and have 56 base32 characters. */
const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/;

/** Sensitive key identifiers representing signing secrets or private keys. */
const FORBIDDEN_SECRET_KEY_NAMES = new Set([
  "secret",
  "seed",
  "privatekey",
  "secretkey",
  "signingkey",
  "signer",
  "keyenv",
  "secretkeyenv",
]);

/** Model prompt fields that must not be stored in journal entries. */
const PRIVATE_PROMPT_KEY_NAMES = new Set([
  "prompt",
  "systemprompt",
  "userprompt",
  "modelprompt",
  "privateprompt",
  "rawprompt",
  "strategy",
  "personastrategy",
  "systeminstruction",
  "instructions",
]);

export class TraderJournalSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraderJournalSecurityError";
  }
}

/**
 * Scan an object or string for raw signing material (e.g. Stellar secret seeds, private key properties).
 * Fails closed by throwing TraderJournalSecurityError if detected.
 */
export function assertNoSigningMaterial(value: unknown, path = "input"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (STELLAR_SECRET_SEED_PATTERN.test(value)) {
      throw new TraderJournalSecurityError(
        `signing material detected in ${path}: Stellar secret seed must be excluded`,
      );
    }
    return;
  }
  if (typeof value === "object") {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === "bigint") {
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        assertNoSigningMaterial(value[i], `${path}[${i}]`);
      }
      return;
    }
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase().replace(/[^a-z]/g, "");
      if (FORBIDDEN_SECRET_KEY_NAMES.has(lowerKey)) {
        throw new TraderJournalSecurityError(
          `signing material detected in ${path}.${key}: forbidden secret key name`,
        );
      }
      assertNoSigningMaterial(val, `${path}.${key}`);
    }
  }
}

/**
 * Strip private model prompt fields recursively so prompt templates and persona strategies
 * are never recorded in decision entries or digests.
 */
export function stripPrivatePrompts<T>(input: T): T {
  if (input === null || typeof input !== "object") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(stripPrivatePrompts) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase().replace(/[^a-z]/g, "");
    if (PRIVATE_PROMPT_KEY_NAMES.has(lowerKey)) {
      continue;
    }
    result[key] = stripPrivatePrompts(val);
  }
  return result as T;
}

/**
 * Canonical JSON serialization with sorted keys and omitted undefined fields,
 * producing deterministic output for SHA-256 digest computation.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Compute the SHA-256 digest of market signal data after stripping private model prompts
 * and asserting no signing material is present.
 */
export function computeSignalDigest(signal: unknown): string {
  assertNoSigningMaterial(signal, "signal");
  const sanitized = stripPrivatePrompts(signal);
  return sha256Hex(canonicalJson(sanitized));
}

/**
 * Compute the SHA-256 digest of policy configuration or revision identifier.
 */
export function computePolicyRevisionDigest(policyRevision: unknown): string {
  assertNoSigningMaterial(policyRevision, "policyRevision");
  const sanitized = stripPrivatePrompts(policyRevision);
  return sha256Hex(canonicalJson(sanitized));
}

/**
 * Compute the SHA-256 digest of the final trader disposition.
 */
export function computeDispositionDigest(disposition: unknown): string {
  assertNoSigningMaterial(disposition, "disposition");
  const sanitized = stripPrivatePrompts(disposition);
  return sha256Hex(canonicalJson(sanitized));
}

export type TraderDispositionAction =
  | "stake"
  | "pass"
  | "skip_exposure"
  | "dry_run"
  | "abstain"
  | (string & {});

export interface TraderDisposition {
  action: TraderDispositionAction;
  verdict?: "AGREE" | "DISAGREE" | "ABSTAIN";
  confidence?: number;
  stakeUsdc?: number;
  sequence?: string | bigint;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface SequenceReservationSnapshot {
  readonly address: string;
  readonly sequence: string;
  readonly state: ReservationState;
}

export interface TraderDecisionEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly agentId: string;
  readonly claimId: number;
  readonly signalDigest: string;
  readonly policyRevision: string;
  readonly policyRevisionDigest: string;
  readonly disposition: TraderDisposition;
  readonly dispositionDigest: string;
  readonly sequenceReservation?: SequenceReservationSnapshot;
}

export interface TraderDecisionInput {
  agentId: string;
  claimId: number;
  timestamp?: number;
  /** Raw signal data or a precomputed 64-character hex SHA-256 digest */
  signal: Record<string, unknown> | string;
  signalDigest?: string;
  /** Policy revision identifier/config or a precomputed 64-character hex SHA-256 digest */
  policyRevision: Record<string, unknown> | string | number;
  policyRevisionDigest?: string;
  /** Disposition outcome or a precomputed 64-character hex SHA-256 digest */
  disposition: TraderDisposition | TraderDispositionAction | string;
  dispositionDigest?: string;
  /** Sequence reservation from SequenceManager or snapshot */
  sequenceReservation?: SequenceReservation | SequenceReservationSnapshot | null;
}

export interface TraderDecisionJournalOptions {
  /** Maximum number of entries retained before the oldest are evicted (FIFO). */
  capacity?: number;
}

/**
 * Bounded trader decision journal.
 *
 * Records deterministic digests for market signals, policy revisions, and disposition outcomes,
 * strictly excluding private model prompts and signing keys while bounding in-memory capacity.
 */
export class TraderDecisionJournal {
  private readonly maxCapacity: number;
  private readonly buffer: TraderDecisionEntry[] = [];
  private sequenceCounter = 0;

  constructor(options?: TraderDecisionJournalOptions) {
    const rawCap =
      options?.capacity ??
      Number(process.env.TRADER_JOURNAL_CAPACITY ?? DEFAULT_TRADER_DECISION_JOURNAL_CAPACITY);
    if (!Number.isFinite(rawCap) || !Number.isInteger(rawCap) || rawCap <= 0) {
      throw new RangeError(`Journal capacity must be a positive integer, got ${rawCap}`);
    }
    this.maxCapacity = rawCap;
  }

  capacity(): number {
    return this.maxCapacity;
  }

  size(): number {
    return this.buffer.length;
  }

  record(input: TraderDecisionInput): TraderDecisionEntry {
    assertNoSigningMaterial(input, "decisionInput");

    if (!input.agentId || !input.agentId.trim()) {
      throw new Error("agentId must be a non-empty string");
    }
    if (!Number.isInteger(input.claimId) || input.claimId <= 0) {
      throw new Error(`claimId must be a positive integer, got ${input.claimId}`);
    }

    const timestamp = input.timestamp ?? Date.now();

    // Signal digest
    let signalDigest = input.signalDigest;
    if (signalDigest !== undefined) {
      if (!isHash32Hex(signalDigest)) {
        throw new Error("signalDigest must be a 64-character hex string");
      }
      signalDigest = signalDigest.toLowerCase();
    } else {
      signalDigest = computeSignalDigest(input.signal);
    }

    // Policy revision & digest
    const policyRevision =
      typeof input.policyRevision === "string"
        ? input.policyRevision
        : canonicalJson(stripPrivatePrompts(input.policyRevision));

    let policyRevisionDigest = input.policyRevisionDigest;
    if (policyRevisionDigest !== undefined) {
      if (!isHash32Hex(policyRevisionDigest)) {
        throw new Error("policyRevisionDigest must be a 64-character hex string");
      }
      policyRevisionDigest = policyRevisionDigest.toLowerCase();
    } else {
      policyRevisionDigest = computePolicyRevisionDigest(input.policyRevision);
    }

    // Disposition & digest
    const rawDisp =
      typeof input.disposition === "string"
        ? { action: input.disposition as TraderDispositionAction }
        : input.disposition;
    const disposition: TraderDisposition = stripPrivatePrompts({
      action: rawDisp.action,
      ...(rawDisp.verdict ? { verdict: rawDisp.verdict } : {}),
      ...(rawDisp.confidence !== undefined ? { confidence: rawDisp.confidence } : {}),
      ...(rawDisp.stakeUsdc !== undefined ? { stakeUsdc: rawDisp.stakeUsdc } : {}),
      ...(rawDisp.sequence !== undefined ? { sequence: String(rawDisp.sequence) } : {}),
      ...(rawDisp.reason ? { reason: String(rawDisp.reason).slice(0, 256) } : {}),
      ...(rawDisp.metadata ? { metadata: rawDisp.metadata } : {}),
    });

    let dispositionDigest = input.dispositionDigest;
    if (dispositionDigest !== undefined) {
      if (!isHash32Hex(dispositionDigest)) {
        throw new Error("dispositionDigest must be a 64-character hex string");
      }
      dispositionDigest = dispositionDigest.toLowerCase();
    } else {
      dispositionDigest = computeDispositionDigest(disposition);
    }

    // Sequence reservation snapshot if provided
    let sequenceReservation: SequenceReservationSnapshot | undefined;
    if (input.sequenceReservation) {
      sequenceReservation = {
        address: input.sequenceReservation.address,
        sequence: input.sequenceReservation.sequence.toString(),
        state: input.sequenceReservation.state,
      };
    }

    this.sequenceCounter += 1;
    const id = `tdj_${timestamp}_${input.claimId}_${this.sequenceCounter}`;

    const entry: TraderDecisionEntry = Object.freeze({
      id,
      timestamp,
      agentId: input.agentId.trim(),
      claimId: input.claimId,
      signalDigest,
      policyRevision,
      policyRevisionDigest,
      disposition: Object.freeze(disposition),
      dispositionDigest,
      ...(sequenceReservation ? { sequenceReservation: Object.freeze(sequenceReservation) } : {}),
    });

    this.buffer.push(entry);
    while (this.buffer.length > this.maxCapacity) {
      this.buffer.shift();
    }

    return entry;
  }

  get(id: string): TraderDecisionEntry | undefined {
    return this.buffer.find((e) => e.id === id);
  }

  entries(): readonly TraderDecisionEntry[] {
    return [...this.buffer];
  }

  recent(limit = this.buffer.length): TraderDecisionEntry[] {
    const n = Math.max(0, limit);
    return this.buffer.slice(-n);
  }

  byAgent(agentId: string): TraderDecisionEntry[] {
    const id = agentId.trim();
    return this.buffer.filter((e) => e.agentId === id);
  }

  byClaim(claimId: number): TraderDecisionEntry[] {
    return this.buffer.filter((e) => e.claimId === claimId);
  }

  last(): TraderDecisionEntry | undefined {
    return this.buffer[this.buffer.length - 1];
  }

  clear(): void {
    this.buffer.length = 0;
  }

  updateReservationState(id: string, state: ReservationState): boolean {
    const index = this.buffer.findIndex((e) => e.id === id);
    if (index === -1) return false;
    const existing = this.buffer[index];
    if (!existing.sequenceReservation) return false;
    const updatedReservation: SequenceReservationSnapshot = Object.freeze({
      ...existing.sequenceReservation,
      state,
    });
    this.buffer[index] = Object.freeze({
      ...existing,
      sequenceReservation: updatedReservation,
    });
    return true;
  }
}

export function createTraderDecisionJournal(
  options?: TraderDecisionJournalOptions,
): TraderDecisionJournal {
  return new TraderDecisionJournal(options);
}

/**
 * Verify that a recorded decision entry matches the canonical digests of its component inputs.
 */
export function verifyDecisionDigest(
  entry: Pick<TraderDecisionEntry, "signalDigest" | "policyRevisionDigest" | "dispositionDigest">,
  components: {
    signal: unknown;
    policyRevision: unknown;
    disposition: unknown;
  },
): {
  valid: boolean;
  signalMatches: boolean;
  policyRevisionMatches: boolean;
  dispositionMatches: boolean;
} {
  const signalMatches = computeSignalDigest(components.signal) === entry.signalDigest;
  const policyRevisionMatches =
    computePolicyRevisionDigest(components.policyRevision) === entry.policyRevisionDigest;
  const dispositionMatches =
    computeDispositionDigest(components.disposition) === entry.dispositionDigest;
  return {
    valid: signalMatches && policyRevisionMatches && dispositionMatches,
    signalMatches,
    policyRevisionMatches,
    dispositionMatches,
  };
}
