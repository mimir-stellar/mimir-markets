/**
 * Pure policy predicates and durable signal consumption tracking for the demo BYOA traders.
 *
 * Keeps decision criteria, claim filtering, and consumed-signal gating testable in Node
 * without needing live network connections, wallets, or databases.
 */

import fs from "node:fs";
import path from "node:path";

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

export interface SecondOpinionClaimFields {
  question?: string | null;
  creator_position?: string | null;
  counter_position?: string | null;
  resolution_url?: string | null;
  settlement_rule?: string | null;
}

export interface SignalConsumptionRecord {
  signalId: string;
  consumedAt: number;
  outcome?: string;
}

export interface SignalConsumptionStore {
  isConsumed(signalId: string): boolean;
  markConsumed(signalId: string, outcome?: string, nowMs?: number): SignalConsumptionRecord;
}

/**
 * Build a deterministic signal identity for a trader's decision on a claim.
 */
export function buildSignalIdentity(agentId: string, claimId: number | string): string {
  const normalizedAgent = agentId.trim();
  if (!normalizedAgent) {
    throw new Error("signal identity requires a non-empty agentId");
  }
  const normalizedClaim =
    typeof claimId === "number"
      ? Number.isFinite(claimId)
        ? String(claimId)
        : ""
      : claimId.trim();
  if (!normalizedClaim) {
    throw new Error("signal identity requires a valid claimId");
  }
  return `${normalizedAgent}:${normalizedClaim}`;
}

/**
 * File-backed durable store of consumed signal identities.
 *
 * Persists a JSON object mapping `signalId -> SignalConsumptionRecord` using
 * atomic temp-file + rename writes so repeat polling or worker restarts never
 * repurchase paid quotes for an already-completed decision.
 */
export class FileSignalConsumptionStore implements SignalConsumptionStore {
  private readonly filePath: string;
  private readonly records = new Map<string, SignalConsumptionRecord>();

  constructor(filePath: string) {
    const resolved = filePath.trim();
    if (!resolved) {
      throw new Error("signal consumption store requires a non-empty file path");
    }
    this.filePath = resolved;
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `corrupt signal consumption store at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`invalid signal consumption store format at ${this.filePath}`);
    }

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Partial<SignalConsumptionRecord>;
      const consumedAt = typeof entry.consumedAt === "number" && Number.isFinite(entry.consumedAt)
        ? entry.consumedAt
        : 0;
      const record: SignalConsumptionRecord = {
        signalId: typeof entry.signalId === "string" && entry.signalId.trim() ? entry.signalId.trim() : key.trim(),
        consumedAt,
        ...(typeof entry.outcome === "string" && entry.outcome ? { outcome: entry.outcome } : {}),
      };
      this.records.set(record.signalId, record);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: Record<string, SignalConsumptionRecord> = {};
    for (const [key, record] of this.records.entries()) {
      payload[key] = record;
    }
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  isConsumed(signalId: string): boolean {
    const key = signalId.trim();
    if (!key) return false;
    return this.records.has(key);
  }

  markConsumed(signalId: string, outcome?: string, nowMs: number = Date.now()): SignalConsumptionRecord {
    const key = signalId.trim();
    if (!key) {
      throw new Error("cannot consume an empty signal identity");
    }
    const existing = this.records.get(key);
    if (existing) return existing;

    const record: SignalConsumptionRecord = {
      signalId: key,
      consumedAt: nowMs,
      ...(outcome ? { outcome } : {}),
    };
    this.records.set(key, record);
    this.persist();
    return record;
  }

  size(): number {
    return this.records.size;
  }
}

export interface ShouldBuySecondOpinionOptions {
  buySecondOpinion?: boolean;
  mimirUrl?: string | null;
  dryRun?: boolean;
  claim?: SecondOpinionClaimFields | null;
  /** Stable identity for this trader+claim decision signal (e.g. from `buildSignalIdentity`). */
  signalId?: string | null;
  /** Durable store or set of already-consumed signal identities. */
  consumedSignals?: Pick<SignalConsumptionStore, "isConsumed"> | ReadonlySet<string> | null;
}

/**
 * Pure predicate to determine if a trader should purchase an oracle second opinion over x402.
 *
 * Requirements:
 * - DRY_RUN must be false (dry runs must spend nothing, skipping paid x402 reads)
 * - BUY_SECOND_OPINION must be true
 * - MIMIR_URL must be a non-empty string
 * - claim must have a valid question and resolution_url
 * - If `consumedSignals` is provided, `signalId` must be non-empty and not already consumed
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
      firstArg.signalId,
      firstArg.consumedSignals,
    );
  }
  return evaluateShouldBuySecondOpinion(
    Boolean(firstArg),
    mimirUrl,
    Boolean(dryRun),
    claim,
  );
}

function isSignalAlreadyConsumed(
  signalId: string | null | undefined,
  consumedSignals: Pick<SignalConsumptionStore, "isConsumed"> | ReadonlySet<string> | null | undefined,
): boolean {
  if (!consumedSignals) return false;
  const key = typeof signalId === "string" ? signalId.trim() : "";
  if (!key) return true; // Fail closed when a consumption store is supplied without a valid signalId.
  if ("isConsumed" in consumedSignals && typeof consumedSignals.isConsumed === "function") {
    return consumedSignals.isConsumed(key);
  }
  return consumedSignals.has(key);
}

function evaluateShouldBuySecondOpinion(
  buySecondOpinion: boolean,
  mimirUrl: string | null | undefined,
  dryRun: boolean,
  claim: SecondOpinionClaimFields | null | undefined,
  signalId?: string | null,
  consumedSignals?: Pick<SignalConsumptionStore, "isConsumed"> | ReadonlySet<string> | null,
): boolean {
  if (dryRun) return false;
  if (!buySecondOpinion) return false;
  if (!mimirUrl || !mimirUrl.trim()) return false;
  if (!claim) return false;
  if (!claim.question || !claim.question.trim()) return false;
  if (!claim.resolution_url || !claim.resolution_url.trim()) return false;
  if (isSignalAlreadyConsumed(signalId, consumedSignals)) return false;
  return true;
}
