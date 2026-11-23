/**
 * Dedupe helpers and durable market creation intents for the market creator.
 *
 * Provides:
 * - Deterministic deduplication identities for candidates and on-chain claims.
 * - Cryptographic statement digests for reviewed market candidates.
 * - Durable intent storage across cycles with state directory persistence.
 * - Reconciliation of ambiguous submissions to prevent duplicate market generation.
 * - Backward-compatible candidate normalization and filtering rules.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../lib/content-hash";

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  deadline?: string | number;
  // Optional canonical fields that may be present on candidates.
  id?: string | number;
  title?: string;
  category?: string;
  creatorPosition?: string;
  counterPosition?: string;
  settlementRule?: string;
  threshold?: number;
  qualityScore?: number;
  statementDigest?: string;
  [key: string]: unknown;
}

export interface ExistingClaimSignature {
  id: number;
  category: string;
  questionKey: string;
  resolutionUrlKey: string;
}

export type IntentStatus =
  | "draft"
  | "reviewed"
  | "persisted"
  | "signing"
  | "submitted"
  | "created"
  | "reconciled"
  | "duplicate"
  | "rejected";

export interface MarketCreationIntent {
  /** Deterministic deduplication identity for this market creation intent. */
  id: string;
  /** Cryptographic digest of the reviewed canonical statement before signing. */
  statementDigest: string;
  /** Canonical market question. */
  question: string;
  /** Target resolution URL. */
  resolutionUrl: string;
  /** Canonical deadline (ISO 8601 string). */
  deadline: string;
  /** Market category (e.g. crypto, sports, stocks, weather). */
  category?: string;
  /** Creator position statement. */
  creatorPosition?: string;
  /** Counter position statement. */
  counterPosition?: string;
  /** Settlement rule. */
  settlementRule?: string;
  /** Review quality score. */
  qualityScore?: number;
  /** Lifecycle status of the creation intent. */
  status: IntentStatus;
  /** Known alternate phrasings or ambiguous submissions reconciled into this intent. */
  aliases?: string[];
  /** Parent or canonical intent ID if this intent was reconciled into another. */
  reconciledWithId?: string;
  /** On-chain claim ID once created. */
  claimId?: number;
  /** On-chain transaction hash or explorer link. */
  txHash?: string;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Last updated timestamp (ms). */
  updatedAt: number;
}

export interface ReconciliationResult {
  action: "create" | "reconcile" | "duplicate";
  intentId: string;
  intent: MarketCreationIntent;
  matchedBy?: "exact_identity" | "statement_digest" | "normalized_question" | "resolution_source" | "existing_claim";
  existingClaimId?: number;
  reason?: string;
}

export interface DurableIntentStoreOptions {
  /** Optional directory to persist intents durably on disk. */
  stateDir?: string;
}

// ── Normalization helpers ─────────────────────────────────────────────────────

export function normaliseQuestion(question: string | undefined): string {
  if (!question) return "";
  return question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(will|does|do|did|the|their|a|an|in|on|at|by|before|after|during)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function normaliseDeadline(deadline: string | number | undefined): string {
  if (deadline === undefined || deadline === null || deadline === "") return "";
  if (typeof deadline === "number") {
    // Contract seconds vs ms timestamp
    const ms = deadline < 1e11 ? deadline * 1000 : deadline;
    if (!Number.isFinite(ms)) return "";
    return new Date(ms).toISOString();
  }
  const parsedMs = Date.parse(deadline);
  if (!Number.isFinite(parsedMs)) return deadline.trim().toLowerCase();
  return new Date(parsedMs).toISOString();
}

function normaliseSnapshot(candidate: CandidateLike): string {
  const source = (candidate.sourceId ?? "").trim().toLowerCase();
  const version = (candidate.sourceVersion ?? candidate.captureVersion ?? "").trim().toLowerCase();
  // Encode absent values distinctly so a missing snapshot never equals a real one.
  return `${source}@${version}`;
}

/**
 * Validate and canonicalise a resolution source URL.
 * Requires http or https protocol and returns normalized URL href (without trailing slash on pathname).
 * Returns null if URL is malformed, empty, or not http(s).
 */
export function canonicaliseResolutionSourceUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const origin = parsed.origin.toLowerCase();
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname === "" && !parsed.search && !parsed.hash) {
      pathname = "";
    }
    const search = parsed.search;
    return `${origin}${pathname}${search}`;
  } catch {
    return null;
  }
}

/**
 * Check whether a string contains invalid UTF-16 text encoding (such as unpaired surrogates).
 */
export function hasInvalidTextEncoding(text: string): boolean {
  try {
    encodeURIComponent(text);
    return false;
  } catch {
    return true;
  }
}

/**
 * Normalise human text for robust comparison.
 * Folds diacritics, case, punctuation, common stop words, and currency notations.
 */
export function normalizeComparableText(value: string | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // Normalize currency notation: $100k -> 100000 usd, $100,000 -> 100000 usd
    .replace(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*k\b/gi, (_m, n) => `${n.replace(/,/g, "")}000 usd`)
    .replace(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*m\b/gi, (_m, n) => `${n.replace(/,/g, "")}000000 usd`)
    .replace(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g, (_m, n) => `${n.replace(/,/g, "")} usd`)
    // Canonicalize common asset tickers to full names for disambiguation
    .replace(/\bbtc\b/g, "bitcoin")
    .replace(/\beth\b/g, "ethereum")
    .replace(/\bsol\b/g, "solana")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    // Strip common non-discriminating filler words
    .replace(/\b(will|does|do|did|the|their|a|an|in|on|at|by|before|after|during|to|of|for|is|are|be)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalise resolution URLs.
 * Strips hash, tracking/search params, trailing slashes, and folds protocol/case.
 */
export function normalizeResolutionUrl(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

// ── Deterministic identity and statement digest ───────────────────────────────

/**
 * Build a legacy candidate signature: question|url|deadline.
 */
export function buildCandidateSignature(
  candidate: CandidateLike,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): string {
  const question = normalizeComparableText(candidate.question ?? candidate.title);
  const url = normalizeResolutionUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  const snapshot = normaliseSnapshot(candidate);
  return `${policyVersion}|${question}|${url}|${deadline}|${snapshot}`;
}

/** Signature of an existing on-chain claim, for `filterDuplicateCandidates`. */
export function buildExistingClaimSignature(claim: {
  id: number;
  category?: string;
  question?: string;
  resolution_url?: string;
}): ExistingClaimSignature {
  return {
    id: claim.id,
    category: normaliseCategory(claim.category),
    questionKey: normalizeComparableText(claim.question),
    resolutionUrlKey: normalizeResolutionUrl(claim.resolution_url),
  };
}

/**
 * Derive a deterministic deduplication identity for a candidate.
 * Combines normalized question, normalized resolution URL, canonical deadline, and category.
 */
export function buildDeduplicationIdentity(candidate: CandidateLike): string {
  const questionKey = normalizeComparableText(candidate.question ?? candidate.title);
  const urlKey = normalizeResolutionUrl(candidate.resolutionUrl);
  const deadlineKey = normaliseDeadline(candidate.deadline);
  const categoryKey = String(candidate.category ?? "").trim().toLowerCase();

  const payload = [
    "intent_dedupe_v1",
    questionKey,
    urlKey,
    deadlineKey,
    categoryKey,
  ].join("\u001f");

  return sha256Hex(payload);
}

/**
 * Compute the cryptographic content digest of a reviewed statement before signing.
 * Covers all statement terms: question, resolution source, deadline, category,
 * positions, and settlement rules.
 */
export function computeStatementDigest(candidate: CandidateLike): string {
  const payload = JSON.stringify({
    category: String(candidate.category ?? "").trim().toLowerCase(),
    counterPosition: String(candidate.counterPosition ?? "").trim(),
    creatorPosition: String(candidate.creatorPosition ?? "").trim(),
    deadline: normaliseDeadline(candidate.deadline),
    question: String(candidate.question ?? candidate.title ?? "").trim(),
    resolutionUrl: normalizeResolutionUrl(candidate.resolutionUrl),
    settlementRule: String(candidate.settlementRule ?? "").trim(),
  });
  return sha256Hex(payload);
}

// ── Ambiguity detection and reconciliation ────────────────────────────────────

/**
 * Check if a submission is an ambiguous variant of an existing candidate or intent.
 */
export function isAmbiguousMatch(
  candidate: CandidateLike,
  target: CandidateLike | MarketCreationIntent,
): boolean {
  const candQuestion = normalizeComparableText(candidate.question ?? candidate.title);
  const targetQuestion = normalizeComparableText(target.question ?? target.title);
  if (!candQuestion || !targetQuestion) return false;

  const candUrl = normalizeResolutionUrl(candidate.resolutionUrl);
  const targetUrl = normalizeResolutionUrl(target.resolutionUrl);

  // If questions are comparable matches under normalization
  if (candQuestion === targetQuestion) {
    // If URLs are both provided and match, or one is omitted, it's an ambiguous match
    if (!candUrl || !targetUrl || candUrl === targetUrl) {
      return true;
    }
  }

  // If same resolution URL and same category, check for question substring containment
  const candCat = String(candidate.category ?? "").trim().toLowerCase();
  const targetCat = String(target.category ?? "").trim().toLowerCase();
  if (candUrl && targetUrl && candUrl === targetUrl && candCat === targetCat) {
    if (candQuestion.includes(targetQuestion) || targetQuestion.includes(candQuestion)) {
      return true;
    }
  }

  return false;
}

/**
 * Reconcile a candidate submission against existing intents and on-chain claims.
 * Ambiguous submissions are reconciled into existing intents instead of creating duplicates.
 */
export function reconcileSubmission(
  candidate: CandidateLike,
  existingIntents: readonly MarketCreationIntent[],
  existingClaims: readonly ExistingClaimSignature[] = [],
): ReconciliationResult {
  const id = buildDeduplicationIdentity(candidate);
  const statementDigest = computeStatementDigest(candidate);
  const question = String(candidate.question ?? candidate.title ?? "").trim();
  const resolutionUrl = normalizeResolutionUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  const now = Date.now();

  // 1. Check exact deduplication identity against existing intents
  const exactIntent = existingIntents.find((intent) => intent.id === id);
  if (exactIntent) {
    if (question && !exactIntent.aliases?.includes(question)) {
      exactIntent.aliases = [...(exactIntent.aliases ?? []), question];
    }
    return {
      action: "duplicate",
      intentId: exactIntent.id,
      intent: exactIntent,
      matchedBy: "exact_identity",
      reason: "Submission matches an existing creation intent identity exactly",
    };
  }

  // 2. Check statement digest against existing intents
  const digestIntent = existingIntents.find(
    (intent) => intent.statementDigest === statementDigest,
  );
  if (digestIntent) {
    if (question && !digestIntent.aliases?.includes(question)) {
      digestIntent.aliases = [...(digestIntent.aliases ?? []), question];
    }
    return {
      action: "duplicate",
      intentId: digestIntent.id,
      intent: digestIntent,
      matchedBy: "statement_digest",
      reason: "Submission matches an existing creation intent statement digest",
    };
  }

  // 3. Reconcile against on-chain active claims
  const candQuestionKey = normalizeComparableText(candidate.question ?? candidate.title);
  const candUrlKey = normalizeResolutionUrl(candidate.resolutionUrl);
  const candCategory = String(candidate.category ?? "").trim().toLowerCase();

  for (const claim of existingClaims) {
    const categoryMatches = !claim.category || claim.category.toLowerCase().trim() === candCategory;
    const questionMatches = claim.questionKey && claim.questionKey === candQuestionKey;
    const sourceMatches = claim.resolutionUrlKey && claim.resolutionUrlKey === candUrlKey;

    if (categoryMatches && (questionMatches || (sourceMatches && candQuestionKey.length > 0 && claim.questionKey.includes(candQuestionKey)))) {
      const syntheticIntent: MarketCreationIntent = {
        id,
        statementDigest,
        question,
        resolutionUrl,
        deadline,
        category: candCategory,
        status: "reconciled",
        claimId: claim.id,
        aliases: [question],
        createdAt: now,
        updatedAt: now,
      };
      return {
        action: "reconcile",
        intentId: id,
        intent: syntheticIntent,
        matchedBy: "existing_claim",
        existingClaimId: claim.id,
        reason: `Reconciled ambiguous submission with active on-chain claim #${claim.id}`,
      };
    }
  }

  // 4. Check ambiguous matches against existing intents
  for (const intent of existingIntents) {
    if (isAmbiguousMatch(candidate, intent)) {
      if (question && !intent.aliases?.includes(question)) {
        intent.aliases = [...(intent.aliases ?? []), question];
        intent.updatedAt = now;
      }
      return {
        action: "reconcile",
        intentId: intent.id,
        intent,
        matchedBy: "normalized_question",
        reason: `Reconciled ambiguous submission into canonical intent ${intent.id}`,
      };
    }
  }

  // 5. New unique intent
  const newIntent: MarketCreationIntent = {
    id,
    statementDigest,
    question,
    resolutionUrl,
    deadline,
    category: candCategory || undefined,
    creatorPosition: candidate.creatorPosition ? String(candidate.creatorPosition) : undefined,
    counterPosition: candidate.counterPosition ? String(candidate.counterPosition) : undefined,
    settlementRule: candidate.settlementRule ? String(candidate.settlementRule) : undefined,
    qualityScore: typeof candidate.qualityScore === "number" ? candidate.qualityScore : undefined,
    status: "draft",
    aliases: question ? [question] : [],
    createdAt: now,
    updatedAt: now,
  };

  return {
    action: "create",
    intentId: id,
    intent: newIntent,
  };
}

// ── Durable Intent Store ──────────────────────────────────────────────────────

export class DurableIntentStore {
  private readonly stateDir?: string;
  private readonly memoryIntents = new Map<string, MarketCreationIntent>();

  constructor(options: DurableIntentStoreOptions = {}) {
    this.stateDir = options.stateDir ?? process.env.MARKET_CREATOR_STATE_DIR;
    if (this.stateDir) {
      try {
        mkdirSync(this.stateDir, { recursive: true });
        this.loadFromDisk();
      } catch (err) {
        console.warn(
          `[dedupe] Warning: could not initialize intent store directory ${this.stateDir}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private getStoreFilePath(): string | null {
    if (!this.stateDir) return null;
    return path.join(this.stateDir, "creation-intents.json");
  }

  private loadFromDisk(): void {
    const filePath = this.getStoreFilePath();
    if (!filePath || !existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, "utf8");
      const list = JSON.parse(raw) as MarketCreationIntent[];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.id) {
            this.memoryIntents.set(item.id, item);
          }
        }
      }
    } catch (err) {
      console.warn(
        `[dedupe] Warning: failed to load creation intents from ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private persistToDisk(): void {
    const filePath = this.getStoreFilePath();
    if (!filePath) return;
    try {
      const list = Array.from(this.memoryIntents.values());
      writeFileSync(filePath, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      console.warn(
        `[dedupe] Warning: failed to persist creation intents to ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  public listIntents(): MarketCreationIntent[] {
    return Array.from(this.memoryIntents.values());
  }

  public getIntent(id: string): MarketCreationIntent | null {
    return this.memoryIntents.get(id) ?? null;
  }

  public getIntentByDigest(statementDigest: string): MarketCreationIntent | null {
    for (const intent of this.memoryIntents.values()) {
      if (intent.statementDigest === statementDigest) {
        return intent;
      }
    }
    return null;
  }

  /**
   * Persist the reviewed statement digest before signing.
   * Ensures the reviewed candidate is bound to its deterministic identity and digest.
   */
  public persistReviewedDigest(
    candidate: CandidateLike,
    statementDigest?: string,
  ): MarketCreationIntent {
    const id = buildDeduplicationIdentity(candidate);
    const digest = statementDigest ?? computeStatementDigest(candidate);
    if (!digest || !/^[0-9a-fA-F]{64}$/.test(digest)) {
      throw new Error(`Invalid statement digest: expected 64 hex characters, got "${digest}"`);
    }

    const now = Date.now();
    const existing = this.memoryIntents.get(id);

    const intent: MarketCreationIntent = {
      id,
      statementDigest: digest,
      question: String(candidate.question ?? candidate.title ?? existing?.question ?? "").trim(),
      resolutionUrl: normalizeResolutionUrl(candidate.resolutionUrl ?? existing?.resolutionUrl),
      deadline: normaliseDeadline(candidate.deadline ?? existing?.deadline),
      category: String(candidate.category ?? existing?.category ?? "").trim().toLowerCase() || undefined,
      creatorPosition: candidate.creatorPosition ? String(candidate.creatorPosition) : existing?.creatorPosition,
      counterPosition: candidate.counterPosition ? String(candidate.counterPosition) : existing?.counterPosition,
      settlementRule: candidate.settlementRule ? String(candidate.settlementRule) : existing?.settlementRule,
      qualityScore: typeof candidate.qualityScore === "number" ? candidate.qualityScore : existing?.qualityScore,
      status: "reviewed",
      aliases: existing?.aliases ?? [String(candidate.question ?? candidate.title ?? "").trim()].filter(Boolean),
      claimId: existing?.claimId,
      txHash: existing?.txHash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.memoryIntents.set(id, intent);
    this.persistToDisk();
    return intent;
  }

  /**
   * Guard called immediately prior to on-chain signing.
   * Fails closed if the reviewed statement digest has not been persisted,
   * or if the statement has drifted from the persisted digest.
   */
  public prepareForSigning(id: string, expectedDigest?: string): MarketCreationIntent {
    const intent = this.memoryIntents.get(id);
    if (!intent) {
      throw new Error(
        `Cannot sign market creation: no persisted intent found for identity ${id}. ` +
        `The reviewed statement digest must be persisted before signing.`,
      );
    }
    if (intent.status === "created") {
      throw new Error(`Intent ${id} has already been created on-chain (claim #${intent.claimId})`);
    }
    if (expectedDigest && intent.statementDigest !== expectedDigest) {
      throw new Error(
        `Statement digest mismatch for intent ${id}: ` +
        `persisted ${intent.statementDigest} vs signing candidate ${expectedDigest}`,
      );
    }

    intent.status = "signing";
    intent.updatedAt = Date.now();
    this.persistToDisk();
    return intent;
  }

  /**
   * Mark an intent as created on chain after successful transaction broadcast.
   */
  public markCreated(id: string, claimId: number, txHash?: string): MarketCreationIntent {
    const intent = this.memoryIntents.get(id);
    if (!intent) {
      throw new Error(`Cannot mark unknown intent ${id} as created`);
    }
    intent.status = "created";
    intent.claimId = claimId;
    if (txHash) intent.txHash = txHash;
    intent.updatedAt = Date.now();
    this.persistToDisk();
    return intent;
  }

  /**
   * Reconcile an incoming candidate submission against stored intents.
   */
  public reconcile(
    candidate: CandidateLike,
    existingClaims: readonly ExistingClaimSignature[] = [],
  ): ReconciliationResult {
    const result = reconcileSubmission(
      candidate,
      Array.from(this.memoryIntents.values()),
      existingClaims,
    );

    if (result.action === "create") {
      this.memoryIntents.set(result.intent.id, result.intent);
      this.persistToDisk();
    } else if (result.action === "reconcile" || result.action === "duplicate") {
      this.memoryIntents.set(result.intent.id, result.intent);
      this.persistToDisk();
    }

    return result;
  }

  public clear(): void {
    this.memoryIntents.clear();
    const filePath = this.getStoreFilePath();
    if (filePath && existsSync(filePath)) {
      try {
        writeFileSync(filePath, "[]", "utf8");
      } catch {
        // ignore in test teardown
      }
    }
  }
}

// ── Candidate filtering ───────────────────────────────────────────────────────

/**
 * Filter duplicate candidates while preserving input order.
 *
 * Supports:
 * - Deduplicating within the candidates list.
 * - Checking against an optional `seen` Set of signatures.
 * - Checking and reconciling against `existingClaims` (ExistingClaimSignature[]).
 * - Reconciling ambiguous candidate submissions instead of producing duplicate markets.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  seenOrExisting?: Set<string> | readonly ExistingClaimSignature[] | DurableIntentStore,
): T[] {
  const seenSignatures = new Set<string>();
  const seenQuestionKeys = new Set<string>();
  const seenSourceKeys = new Set<string>();

  const existingClaims: ExistingClaimSignature[] = [];

  if (seenOrExisting instanceof Set) {
    for (const item of seenOrExisting) seenSignatures.add(item);
  } else if (Array.isArray(seenOrExisting)) {
    existingClaims.push(...seenOrExisting);
  } else if (seenOrExisting instanceof DurableIntentStore) {
    for (const intent of seenOrExisting.listIntents()) {
      seenSignatures.add(buildCandidateSignature(intent));
      seenQuestionKeys.add(normalizeComparableText(intent.question));
      seenSourceKeys.add(normalizeResolutionUrl(intent.resolutionUrl));
    }
  }

  // Populate lookups from existing claims
  const existingQuestionKeys = new Map<string, number>();
  const existingSourceKeys = new Map<string, number>();

  for (const claim of existingClaims) {
    const cat = (claim.category ?? "").toLowerCase().trim();
    if (claim.questionKey) {
      existingQuestionKeys.set(`${cat}:${claim.questionKey}`, claim.id);
    }
    if (claim.resolutionUrlKey) {
      existingSourceKeys.set(`${cat}:${claim.resolutionUrlKey}`, claim.id);
    }
  }

  const out: T[] = [];

  for (const candidate of candidates) {
    const sig = buildCandidateSignature(candidate);
    const category = String(candidate.category ?? "").toLowerCase().trim();
    const questionKey = normalizeComparableText(candidate.question ?? candidate.title);
    const urlKey = normalizeResolutionUrl(candidate.resolutionUrl);

    // Exact signature duplicate
    if (seenSignatures.has(sig)) {
      continue;
    }

    // Check against active on-chain claims
    if (category && urlKey) {
      const activeSourceId = existingSourceKeys.get(`${category}:${urlKey}`);
      if (activeSourceId !== undefined) {
        console.warn(
          `[market-creator] Drop duplicate candidate - same source as active claim #${activeSourceId}: ` +
          String(candidate.question ?? candidate.title ?? "").slice(0, 90),
        );
        continue;
      }
    }

    if (category && questionKey) {
      const activeQuestionId = existingQuestionKeys.get(`${category}:${questionKey}`);
      if (activeQuestionId !== undefined) {
        console.warn(
          `[market-creator] Drop duplicate candidate - same question as active claim #${activeQuestionId}: ` +
          String(candidate.question ?? candidate.title ?? "").slice(0, 90),
        );
        continue;
      }
    }

    // Reconcile ambiguous submissions within the current run
    const compositeQuestionKey = `${category}:${questionKey}`;
    const compositeSourceKey = `${category}:${urlKey}`;

    if (questionKey && seenQuestionKeys.has(compositeQuestionKey)) {
      console.warn(
        `[market-creator] Reconciled ambiguous duplicate question within run: ` +
        String(candidate.question ?? candidate.title ?? "").slice(0, 90),
      );
      continue;
    }

    if (urlKey && seenSourceKeys.has(compositeSourceKey)) {
      console.warn(
        `[market-creator] Drop duplicate candidate within run (same category and resolution source): ` +
        String(candidate.question ?? candidate.title ?? "").slice(0, 90),
      );
      continue;
    }

    seenSignatures.add(sig);
    if (questionKey) seenQuestionKeys.add(compositeQuestionKey);
    if (urlKey) seenSourceKeys.add(compositeSourceKey);
    out.push(candidate);
  }

  return out;
}

/**
 * Drop cached dedupe keys that were produced under a different normalization
 * policy version. Keys are expected to carry their version as the prefix
 * before the first '|'. Returns the number of keys removed.
 */
export function invalidateIncompatibleKeys(
  seen: Set<string>,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): number {
  let removed = 0;
  for (const key of [...seen]) {
    const sep = key.indexOf("|");
    const keyVersion = sep < 0 ? "" : key.slice(0, sep);
    if (keyVersion !== policyVersion) {
      seen.delete(key);
      removed++;
    }
  }
  return removed;
}
