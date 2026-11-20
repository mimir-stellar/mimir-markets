/** Offline planning only. This module has no transports, signers, or stores. */
import { buildCandidateSignature, type CandidateLike } from "./dedupe.js";
import { cryptoThresholdReason, parseDraftedCandidateBatch } from "./drafting.js";

const MAX_ATOMIC = (1n << 127n) - 1n;

export interface BatchManifestBudget {
  /** Integer Stellar USDC atomic units (7 decimals), serialized as strings. */
  stakeAtomic: string;
  maxTotalStakeAtomic: string;
  maxMarkets: number;
}

export type BatchRejectionCode =
  | "invalid_candidate"
  | "invalid_resolution_url"
  | "invalid_deadline"
  | "deadline_elapsed"
  | "unsafe_crypto_threshold"
  | "duplicate_existing"
  | "duplicate_batch"
  | "market_limit"
  | "budget_exceeded";

export interface BatchManifestEntry {
  index: number;
  statement: string | null;
  resolutionUrl: string | null;
  deadline: string | null;
  category: string | null;
  threshold: number | null;
  /** Proposed cost, including entries that were rejected. */
  stakeAtomic: string;
  status: "proposed" | "rejected";
  rejection: { code: BatchRejectionCode; detail: string } | null;
}

export interface DryRunBatchManifest {
  schemaVersion: 1;
  dryRun: true;
  evaluatedAt: string;
  stateSource: "supplied_snapshot";
  executionReady: false;
  sideEffects: { marketCreation: false; payments: false; livePublishing: false };
  error: "invalid_draft_response" | null;
  budget: BatchManifestBudget & {
    asset: "USDC";
    decimals: 7;
    plannedStakeAtomic: string;
    remainingStakeAtomic: string;
  };
  summary: { drafted: number; proposed: number; rejected: number };
  entries: BatchManifestEntry[];
}

export interface BatchManifestInput {
  /** Captured model response, not a live LLM invocation. */
  draftResponse: string;
  /** Explicit ISO timestamp with timezone makes replay deterministic. */
  evaluatedAt: string;
  budget: BatchManifestBudget;
  /** Caller-supplied existing candidates; no Postgres or chain reads occur. */
  existingCandidates?: readonly CandidateLike[];
}

function atomic(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39) {
    throw new Error(`${field} must be a canonical nonnegative atomic integer string`);
  }
  const amount = BigInt(value);
  if (amount > MAX_ATOMIC) throw new Error(`${field} exceeds the Soroban i128 range`);
  return amount;
}

function timestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(`${year}-${month}-01T00:00:00Z`);
  if (!Number.isFinite(days.getTime())) return null;
  days.setUTCMonth(days.getUTCMonth() + 1);
  days.setUTCDate(0);
  if (+day < 1 || +day > days.getUTCDate() || +hour > 23 || +minute > 59 || +second > 59) return null;
  if (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Preserve dedupe's existing signature rules, without mutating caller state. */
function existingSignatures(candidates: readonly CandidateLike[]): Set<string> {
  if (!Array.isArray(candidates)) throw new Error("existingCandidates must be an array");
  return new Set(candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid existing candidate snapshot");
    for (const field of ["question", "title", "resolutionUrl", "deadline"] as const) {
      if (candidate[field] !== undefined && typeof candidate[field] !== "string") {
        throw new Error("invalid existing candidate snapshot");
      }
    }
    if (!(candidate.question || candidate.title)?.trim() || !candidate.resolutionUrl?.trim() || !candidate.deadline?.trim()) {
      throw new Error("existing candidates require a statement, resolutionUrl and deadline");
    }
    return buildCandidateSignature(candidate);
  }));
}

/** Every parsed draft receives a decision; only proposed rows consume budget. */
export function buildDryRunBatchManifest(input: BatchManifestInput): DryRunBatchManifest {
  if (!input || typeof input !== "object" || !input.budget || typeof input.budget !== "object") {
    throw new Error("Batch input requires a budget object");
  }
  if (typeof input.draftResponse !== "string") throw new Error("draftResponse must be a string");
  if (typeof input.evaluatedAt !== "string") throw new Error("evaluatedAt must be an ISO timestamp with timezone");
  const now = timestamp(input.evaluatedAt);
  if (now === null) throw new Error("evaluatedAt must be a valid ISO timestamp with timezone");
  const stake = atomic(input.budget.stakeAtomic, "stakeAtomic");
  const cap = atomic(input.budget.maxTotalStakeAtomic, "maxTotalStakeAtomic");
  if (stake === 0n) throw new Error("stakeAtomic must be positive");
  const limit = input.budget.maxMarkets;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("maxMarkets must be a nonnegative safe integer");
  const existing = existingSignatures(input.existingCandidates === undefined ? [] : input.existingCandidates);
  const seen = new Set<string>();
  const parsed = parseDraftedCandidateBatch(input.draftResponse);
  let planned = 0n;
  let proposed = 0;

  const entries = parsed.entries.map(({ index, statement, candidate }): BatchManifestEntry => {
    let rejection: BatchManifestEntry["rejection"] = null;
    let resolutionUrl = candidate?.resolutionUrl ?? null;
    const reject = (code: BatchRejectionCode, detail: string) => { rejection = { code, detail }; };
    if (!candidate) {
      reject("invalid_candidate", "Draft must contain a nonempty question, resolutionUrl and deadline");
    } else {
      let url: URL | null = null;
      try { url = new URL(candidate.resolutionUrl); } catch { /* Refuse malformed URLs. */ }
      const deadline = timestamp(candidate.deadline);
      const thresholdReason = candidate.threshold === undefined ? null : cryptoThresholdReason(candidate.threshold);
      const signature = buildCandidateSignature(candidate);
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        // A rejected source URL can still contain credentials. Keep its reason,
        // but never copy the unsafe value into a shareable manifest.
        resolutionUrl = null;
        reject("invalid_resolution_url", "Resolution URL must be HTTP(S) without embedded credentials");
      } else if (deadline === null) {
        reject("invalid_deadline", "Deadline must be a valid ISO timestamp with timezone");
      } else if (deadline <= now) {
        reject("deadline_elapsed", "Deadline must be later than evaluatedAt");
      } else if (thresholdReason) {
        reject("unsafe_crypto_threshold", thresholdReason);
      } else if (existing.has(signature)) {
        reject("duplicate_existing", "Signature already occurs in the supplied existing-market snapshot");
      } else if (seen.has(signature)) {
        reject("duplicate_batch", "Signature already occurs earlier in this batch");
      } else {
        // Dedupe's first occurrence wins even if it exceeds the planning budget.
        seen.add(signature);
        if (proposed >= limit) {
          reject("market_limit", "Proposed market count would exceed maxMarkets");
        } else if (planned + stake > cap) {
          reject("budget_exceeded", "Proposed stake would exceed maxTotalStakeAtomic");
        } else {
          planned += stake;
          proposed += 1;
        }
      }
    }
    return {
      index,
      statement,
      resolutionUrl,
      deadline: candidate?.deadline ?? null,
      category: candidate?.category ?? null,
      threshold: candidate?.threshold !== undefined && Number.isFinite(candidate.threshold) ? candidate.threshold : null,
      stakeAtomic: stake.toString(),
      status: rejection ? "rejected" : "proposed",
      rejection,
    };
  });

  return {
    schemaVersion: 1,
    dryRun: true,
    evaluatedAt: new Date(now).toISOString(),
    stateSource: "supplied_snapshot",
    executionReady: false,
    sideEffects: { marketCreation: false, payments: false, livePublishing: false },
    error: parsed.error,
    budget: {
      asset: "USDC", decimals: 7,
      stakeAtomic: stake.toString(), maxTotalStakeAtomic: cap.toString(), maxMarkets: limit,
      plannedStakeAtomic: planned.toString(), remainingStakeAtomic: (cap - planned).toString(),
    },
    summary: { drafted: entries.length, proposed, rejected: entries.length - proposed },
    entries,
  };
}

export function serializeDryRunBatchManifest(manifest: DryRunBatchManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}
