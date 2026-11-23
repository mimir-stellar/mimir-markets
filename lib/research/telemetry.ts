import type { CategoryRejection } from "./categories";
import type { FetchFailure } from "./gateway";
import type { AllowlistReason } from "./allowlist";

export interface ResearchMetricsSnapshot {
  coverage: Record<string, number>;
  rejects: Partial<Record<CategoryRejection, number>>;
  sourceFailures: Record<string, number>;
  settlementAmbiguity: Record<string, number>;
  /** Why research-domain allowlist refusals happened, so a misconfiguration is visible. */
  allowlistRejects: Partial<Record<AllowlistReason, number>>;
}

export interface ResearchIncidentBundle {
  generatedAt: string;
  metrics: ResearchMetricsSnapshot;
  /** Bounded failure categories only; never raw error messages or URLs. */
  failureCategories: string[];
  /** Source digests keyed by a redacted source identifier. */
  sourceDigests: Record<string, string>;
  /** Request policy in effect; excludes provider credentials and purchased content. */
  requestPolicy: Record<string, unknown>;
}

const state: ResearchMetricsSnapshot = { coverage: {}, rejects: {}, sourceFailures: {}, settlementAmbiguity: {}, allowlistRejects: {} };
const sourceDigests: Record<string, string> = {};
let requestPolicy: Record<string, unknown> = {};

const SENSITIVE_KEY = /(key|secret|token|credential|password|auth|cookie|purchase|private|content|body)/i;

function increment(target: Record<string, number>, key: string): void { target[key] = (target[key] ?? 0) + 1; }
export function recordCategoryCoverage(category: string): void { increment(state.coverage, category.trim().toLowerCase()); }
export function recordCategoryReject(reason: CategoryRejection): void { increment(state.rejects as Record<string, number>, reason); }
export function recordSourceFailure(failure: FetchFailure["kind"]): void { increment(state.sourceFailures, failure); }
export function recordSettlementAmbiguity(category: string): void { increment(state.settlementAmbiguity, category.trim().toLowerCase()); }
export function recordAllowlistReject(reason: AllowlistReason): void { increment(state.allowlistRejects as Record<string, number>, reason); }

/** Records a digest for a source; the identifier is stored as given and the digest must be a hash, not content. */
export function recordSourceDigest(sourceId: string, digest: string): void { sourceDigests[sourceId] = digest; }

/** Sets the request policy exported in incident bundles, dropping any sensitive-looking keys. */
export function setResearchRequestPolicy(policy: Record<string, unknown>): void {
  requestPolicy = {};
  for (const [k, v] of Object.entries(policy)) {
    if (!SENSITIVE_KEY.test(k)) requestPolicy[k] = v;
  }
}

export function researchMetricsSnapshot(): ResearchMetricsSnapshot { return structuredClone(state); }

/** Builds a redacted incident bundle: metrics, bounded failure categories, source digests and request policy. */
export function buildResearchIncidentBundle(now: Date = new Date()): ResearchIncidentBundle {
  const metrics = researchMetricsSnapshot();
  return {
    generatedAt: now.toISOString(),
    metrics,
    failureCategories: Object.keys(metrics.sourceFailures).sort(),
    sourceDigests: structuredClone(sourceDigests),
    requestPolicy: structuredClone(requestPolicy),
  };
}

export function resetResearchMetrics(): void {
  for (const group of Object.values(state)) for (const key of Object.keys(group)) delete group[key];
  for (const key of Object.keys(sourceDigests)) delete sourceDigests[key];
  requestPolicy = {};
}
