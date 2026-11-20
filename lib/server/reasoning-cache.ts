/**
 * Memoizes council reasoning per (claim, persona).
 *
 * The prompt is built only from a claim's question and its two sides — all
 * immutable once the claim exists — so the same pair always regenerates the same
 * kind of text. In production 13K paid reads burned 22 minutes of active CPU (plus
 * 13K LLM calls) for four distinct pairs, because the traffic generator hammers
 * claimId=1 across four personas.
 *
 * This caches the *generation*, never the HTTP response: the route still runs the
 * HTTP 402 payment gate on every read, so each reader keeps paying the persona's wallet. Do not
 * turn this into a Cache-Control header — that would serve paid content for free.
 *
 * ponytail: per-instance Map. Fluid reuses instances so the hit rate is high; move
 * it to Neon only if cross-instance misses show up as real LLM spend.
 */

import { checkPublishableText } from "@/lib/reasoning/redact";

export const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

export interface CachedReasoning {
  question: string;
  sideA: string;
  sideB: string;
  reasoning: string;
  statementDigest?: string;
}

/**
 * Returns true when the generated reasoning is safe to publish. Unsafe
 * generations must be neither cached nor returned to readers.
 */
export function isPublishableReasoning(reasoning: string): boolean {
  return checkPublishableText(reasoning).safe;
}

export type Entry = CachedReasoning & { at: number };

const entries = new Map<string, Entry>();

const cacheKey = (claimId: number, slug: string, statementDigest?: string) =>
  statementDigest ? `${claimId}:${slug}:${statementDigest}` : `${claimId}:${slug}`;

export function getCachedReasoning(
  claimId: number,
  slug: string,
  statementDigestOrNowMs?: string | number,
  nowMs = Date.now()
): Entry | null {
  const statementDigest =
    typeof statementDigestOrNowMs === "string" ? statementDigestOrNowMs : undefined;
  const effectiveNow =
    typeof statementDigestOrNowMs === "number" ? statementDigestOrNowMs : nowMs;

  if (statementDigest) {
    const key = cacheKey(claimId, slug, statementDigest);
    const hit = entries.get(key);
    if (!hit) {
      return null;
    }
    if (hit.statementDigest && hit.statementDigest !== statementDigest) {
      return null;
    }
    if (effectiveNow - hit.at > TTL_MS) {
      entries.delete(key);
      return null;
    }
    return hit;
  }

  // Fallback for callers without statementDigest: find the latest entry for (claimId, slug)
  const prefix = `${claimId}:${slug}`;
  for (const [k, v] of entries.entries()) {
    if (k === prefix || k.startsWith(`${prefix}:`)) {
      if (effectiveNow - v.at > TTL_MS) {
        entries.delete(k);
        return null;
      }
      return v;
    }
  }

  return null;
}

export function setCachedReasoning(
  claimId: number,
  slug: string,
  value: CachedReasoning,
  statementDigestOrNowMs?: string | number,
  nowMs = Date.now()
): void {
  // Never cache unsafe generations — they must not be served to readers.
  if (!isPublishableReasoning(value.reasoning)) {
    return;
  }
  const statementDigest =
    typeof statementDigestOrNowMs === "string" ? statementDigestOrNowMs : value.statementDigest;
  const effectiveNow =
    typeof statementDigestOrNowMs === "number" ? statementDigestOrNowMs : nowMs;

  const key = cacheKey(claimId, slug, statementDigest);
  // Invalidate any previous entry for the same (claimId, slug) so stale wording/digests do not linger
  const prefix = `${claimId}:${slug}`;
  for (const k of entries.keys()) {
    if (k === prefix || k.startsWith(`${prefix}:`)) {
      entries.delete(k);
    }
  }

  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) {
      entries.delete(oldest);
    }
  }
  entries.set(key, { ...value, statementDigest, at: effectiveNow });
}

/** Test seam — production code never needs this. */
export function clearReasoningCache(): void {
  entries.clear();
}
