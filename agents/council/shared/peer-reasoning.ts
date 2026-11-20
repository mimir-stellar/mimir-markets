/**
 * Paid council-to-council reads.
 *
 * A persona can buy another persona's public reasoning before making its own
 * decision. This turns the council into a small information market instead of
 * ten isolated voters.
 */

import { fetchWithBudget, payingWalletFor, type PayingWallet } from "../../../lib/x402/buyer";
import { outboundTraceHeaders } from "../../../lib/ops/trace-http";
import { getCouncilWallet } from "../../../lib/agent-wallets";
import { usdcToUnits } from "../../../lib/usdc";
import { sha256Hex } from "../../../lib/content-hash";
import {
  type PersonaSpec,
  personaSecretEnv,
} from "../personas";

export interface ClaimStatementInput {
  question?: string;
  creatorPosition?: string;
  creator_position?: string;
  sideA?: string;
  counterPosition?: string;
  counter_position?: string;
  opponent_position?: string;
  sideB?: string;
  resolutionUrl?: string;
  resolution_url?: string;
  settlementRule?: string;
  settlement_rule?: string;
  contextHash?: string;
  context_hash?: string;
}

/**
 * Computes a deterministic SHA-256 digest over a claim's statement wording
 * (question, creator position, counter position) and source commitment
 * (resolution URL, settlement rule, context hash).
 *
 * Any change to wording or source commitment produces a different digest,
 * invalidating cached peer reasoning while preserving entries for unrelated claims.
 */
export function claimStatementDigest(claim: ClaimStatementInput): string {
  const question = (claim.question ?? "").trim();
  const creatorPos = (claim.creatorPosition ?? claim.creator_position ?? claim.sideA ?? "").trim();
  const counterPos = (claim.counterPosition ?? claim.counter_position ?? claim.opponent_position ?? claim.sideB ?? "").trim();
  const sourceUrl = (claim.resolutionUrl ?? claim.resolution_url ?? "").trim();
  const rule = (claim.settlementRule ?? claim.settlement_rule ?? "").trim();
  const ctxHash = (claim.contextHash ?? claim.context_hash ?? "").trim().toLowerCase();

  const payload = [
    `question:${question}`,
    `creator:${creatorPos}`,
    `counter:${counterPos}`,
    `source:${sourceUrl}`,
    `rule:${rule}`,
    `context:${ctxHash}`,
  ].join("\n");

  return sha256Hex(payload);
}

/** Upper bound on cached peer reasoning entries so memory stays bounded. */
export const PEER_REASONING_CACHE_MAX_ENTRIES = 500;

export interface PersistedPeerReasoning {
  claimId: number;
  buyerSlug: string;
  statementDigest: string;
  reads: PeerReasoningRead[];
  cachedAt: number;
}

const persistentPeerReasoningCache = new Map<string, PersistedPeerReasoning>();

export function peerReasoningCacheKey(
  claimId: number,
  buyerSlug: string,
  statementDigest?: string,
): string {
  return statementDigest ? `${claimId}:${buyerSlug}:${statementDigest}` : `${claimId}:${buyerSlug}`;
}

export function getCachedPeerReasoning(
  claimId: number,
  buyerSlug: string,
  statementDigest?: string,
): PeerReasoningRead[] | null {
  if (statementDigest) {
    const key = peerReasoningCacheKey(claimId, buyerSlug, statementDigest);
    const hit = persistentPeerReasoningCache.get(key);
    if (hit) return hit.reads;
    return null;
  }
  for (const [, value] of persistentPeerReasoningCache) {
    if (value.claimId === claimId && value.buyerSlug === buyerSlug) {
      return value.reads;
    }
  }
  return null;
}

export function setCachedPeerReasoning(
  claimId: number,
  buyerSlug: string,
  reads: PeerReasoningRead[],
  statementDigest = "",
  nowMs = Date.now(),
): void {
  const key = peerReasoningCacheKey(claimId, buyerSlug, statementDigest);
  persistentPeerReasoningCache.delete(key);
  persistentPeerReasoningCache.set(key, {
    claimId,
    buyerSlug,
    statementDigest,
    reads,
    cachedAt: nowMs,
  });
  while (persistentPeerReasoningCache.size > PEER_REASONING_CACHE_MAX_ENTRIES) {
    const oldest = persistentPeerReasoningCache.keys().next().value;
    if (oldest === undefined) break;
    persistentPeerReasoningCache.delete(oldest);
  }
}

export function clearPeerReasoningCache(): void {
  persistentPeerReasoningCache.clear();
}

export function peerReasoningCacheSize(): number {
  return persistentPeerReasoningCache.size;
}

export function prunePeerReasoningCache(joinableClaimIds: ReadonlySet<number>): void {
  for (const [key, value] of persistentPeerReasoningCache) {
    if (!joinableClaimIds.has(value.claimId)) {
      persistentPeerReasoningCache.delete(key);
    }
  }
}

export function invalidatePeerReasoning(claimId: number, statementDigest?: string): void {
  for (const [key, value] of persistentPeerReasoningCache) {
    if (value.claimId === claimId) {
      if (!statementDigest || value.statementDigest === statementDigest) {
        persistentPeerReasoningCache.delete(key);
      }
    }
  }
}

export interface PeerReasoningRead {
  sellerSlug: string;
  sellerName: string;
  reasoning: string;
  pricePaidUnits: string | null;
}

export interface PeerOutageReport {
  sellerSlug: string;
  status: "network_error" | "timeout" | "http_error";
  httpStatus?: number;
  message: string;
}

export interface PeerReasoningConflict {
  sellerSlug: string;
  reason: string;
}

export interface PeerReasoningOutcome {
  reads: PeerReasoningRead[];
  outages: PeerOutageReport[];
  conflicts: PeerReasoningConflict[];
  remainingUnits: bigint;
  totalPaidUnits: bigint;
}

export interface BuyPeerReasoningArgs {
  buyer: PersonaSpec;
  activePersonas: PersonaSpec[];
  claimId: number;
  baseUrl: string;
  readsPerPersona: number;
  capUsdc: number;
  delayMs: number;
  /** Custom paying wallet (allows testing with fake/mock wallets without live keys). */
  payer?: PayingWallet | null;
  /** Injectable fetchWithBudget for fake transports / synthetic fault injection. */
  fetchWithBudgetImpl?: typeof fetchWithBudget;
  /** Injectable sleep function to avoid test latency. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Max timeout in ms per peer read. */
  timeoutMs?: number;
  /** Callback on peer provider outage. */
  onOutage?: (outage: PeerOutageReport) => void;
  /** Detect and reject conflicting peer reasoning / equivocation. */
  rejectEquivocation?: boolean;
  /** Statement digest to bind peer reasoning cache entries to. */
  statementDigest?: string;
  /** Claim statement input used to derive statement digest if not explicitly provided. */
  claim?: ClaimStatementInput;
  /** Whether to bypass the local cache check (defaults to false). */
  skipCache?: boolean;
}

interface ReasoningResponse {
  reasoning?: string;
  persona?: {
    slug?: string;
    name?: string;
  };
}

function payingWalletForPersona(persona: PersonaSpec): PayingWallet | null {
  if (!process.env[personaSecretEnv(persona)]) return null;
  try {
    return payingWalletFor(getCouncilWallet(persona.slug));
  } catch {
    return null;
  }
}

export function selectPeerSellers(
  buyer: PersonaSpec,
  activePersonas: PersonaSpec[],
  claimId: number,
  count: number,
): PersonaSpec[] {
  const peers = activePersonas.filter((persona) => persona.slug !== buyer.slug);
  if (peers.length <= count) return peers;

  const buyerIndex = activePersonas.findIndex((persona) => persona.slug === buyer.slug);
  const offset = Math.max(0, buyerIndex) + claimId;
  const rotated = [...peers.slice(offset % peers.length), ...peers.slice(0, offset % peers.length)];
  return rotated.slice(0, count);
}

/**
 * Execute paid peer reads with detailed outcome reporting (including partial
 * provider outages and equivocation detection).
 */
export async function buyPeerReasoningDetailed(
  args: BuyPeerReasoningArgs,
): Promise<PeerReasoningOutcome> {
  const capUnits = usdcToUnits(args.capUsdc);
  const emptyOutcome: PeerReasoningOutcome = {
    reads: [],
    outages: [],
    conflicts: [],
    remainingUnits: capUnits,
    totalPaidUnits: 0n,
  };

  if (args.readsPerPersona <= 0) return emptyOutcome;

  const statementDigest =
    args.statementDigest ?? (args.claim ? claimStatementDigest(args.claim) : undefined);

  if (!args.skipCache && statementDigest) {
    const cached = getCachedPeerReasoning(args.claimId, args.buyer.slug, statementDigest);
    if (cached && cached.length > 0) {
      return {
        reads: cached,
        outages: [],
        conflicts: [],
        remainingUnits: capUnits,
        totalPaidUnits: 0n,
      };
    }
  }

  const payer =
    args.payer !== undefined
      ? args.payer
      : payingWalletForPersona(args.buyer);
  if (!payer) return emptyOutcome;

  const doFetch = args.fetchWithBudgetImpl ?? fetchWithBudget;
  const sleep =
    args.sleepFn ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let remainingUnits = capUnits;
  let totalPaidUnits = 0n;
  const sellers = selectPeerSellers(
    args.buyer,
    args.activePersonas,
    args.claimId,
    args.readsPerPersona,
  );

  const reads: PeerReasoningRead[] = [];
  const outages: PeerOutageReport[] = [];
  const conflicts: PeerReasoningConflict[] = [];
  const seenSellerReasoning = new Map<string, string>();

  for (const seller of sellers) {
    if (remainingUnits <= 0n) break;

    const url =
      `${args.baseUrl.replace(/\/$/, "")}/api/council/reasoning` +
      `?claimId=${encodeURIComponent(String(args.claimId))}` +
      `&persona=${encodeURIComponent(seller.slug)}` +
      (statementDigest ? `&statementDigest=${encodeURIComponent(statementDigest)}` : "");

    try {
      let fetchPromise = doFetch(url, payer, remainingUnits, {
        method: "GET",
        headers: { accept: "application/json", ...outboundTraceHeaders() },
      });

      if (args.timeoutMs != null && args.timeoutMs > 0) {
        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`peer read timeout after ${args.timeoutMs}ms`)),
            args.timeoutMs,
          );
        });
        fetchPromise = Promise.race([fetchPromise, timeoutPromise]).finally(() => {
          clearTimeout(timer);
        });
      }

      const result = await fetchPromise;

      if (!result.response.ok) {
        const status = result.response.status;
        const outage: PeerOutageReport = {
          sellerSlug: seller.slug,
          status: "http_error",
          httpStatus: status,
          message: `peer reasoning endpoint HTTP ${status}`,
        };
        outages.push(outage);
        if (args.onOutage) args.onOutage(outage);
        continue;
      }

      const body = (await result.response.json()) as ReasoningResponse;
      const reasoning = String(body.reasoning ?? "").trim();
      if (!reasoning) continue;

      const sellerKey = body.persona?.slug ?? seller.slug;

      // Equivocation / conflict detection for peer reasoning
      if (args.rejectEquivocation) {
        const prior = seenSellerReasoning.get(sellerKey);
        if (prior && prior !== reasoning) {
          conflicts.push({
            sellerSlug: sellerKey,
            reason: `conflicting reasoning detected for seller '${sellerKey}'`,
          });
          continue;
        }
      }

      seenSellerReasoning.set(sellerKey, reasoning);

      const priceUnits = result.payment?.priceUnits ?? 0n;
      reads.push({
        sellerSlug: sellerKey,
        sellerName: body.persona?.name ?? seller.displayName,
        reasoning: reasoning.slice(0, 360),
        pricePaidUnits: result.payment?.priceUnits?.toString() ?? null,
      });

      if (result.payment) {
        remainingUnits -= priceUnits;
        totalPaidUnits += priceUnits;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|timed out/i.test(message);
      const outage: PeerOutageReport = {
        sellerSlug: seller.slug,
        status: isTimeout ? "timeout" : "network_error",
        message,
      };
      outages.push(outage);
      if (args.onOutage) args.onOutage(outage);

      console.warn(
        `[council:${args.buyer.slug}] peer read failed from ${seller.slug}:`,
        message,
      );
    }

    if (args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  if (reads.length > 0 && statementDigest) {
    setCachedPeerReasoning(args.claimId, args.buyer.slug, reads, statementDigest);
  }

  return {
    reads,
    outages,
    conflicts,
    remainingUnits,
    totalPaidUnits,
  };
}

export async function buyPeerReasoning(
  args: BuyPeerReasoningArgs,
): Promise<PeerReasoningRead[]> {
  const outcome = await buyPeerReasoningDetailed(args);
  return outcome.reads;
}

export interface SyntheticPeerScenario {
  sellerSlug: string;
  sellerName?: string;
  reasoning?: string;
  status?: "ok" | "timeout" | "503" | "500" | "network_error";
  pricePaidUnits?: string;
}

/**
 * Simulate synthetic peer reasoning reads with fake transport to cover partial
 * provider outages and delayed/equivocating peers without live LLM calls.
 */
export async function simulatePeerReasoningScenario(args: {
  buyer: PersonaSpec;
  activePersonas: PersonaSpec[];
  claimId: number;
  scenarios: Record<string, SyntheticPeerScenario>;
  readsPerPersona?: number;
  capUsdc?: number;
  rejectEquivocation?: boolean;
  statementDigest?: string;
  claim?: ClaimStatementInput;
  skipCache?: boolean;
}): Promise<PeerReasoningOutcome> {
  const fakePayer: PayingWallet = {
    address: "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y",
    newClient: () => ({} as any),
  };

  const fakeFetchWithBudget: typeof fetchWithBudget = async (url) => {
    const urlObj = new URL(url);
    const personaSlug = urlObj.searchParams.get("persona") ?? "";
    const scenario = args.scenarios[personaSlug];

    if (!scenario || scenario.status === "network_error") {
      throw new Error(`Connection reset by peer: ${personaSlug}`);
    }
    if (scenario.status === "timeout") {
      throw new Error(`Timeout waiting for provider: ${personaSlug}`);
    }
    if (scenario.status === "503" || scenario.status === "500") {
      const code = scenario.status === "503" ? 503 : 500;
      return {
        response: new Response("Provider unavailable", { status: code }),
        payment: null,
      };
    }

    const priceUnits = BigInt(scenario.pricePaidUnits ?? "10000");
    const body = {
      reasoning: scenario.reasoning ?? `Synthetic reasoning from ${personaSlug}`,
      persona: {
        slug: scenario.sellerSlug,
        name: scenario.sellerName ?? scenario.sellerSlug,
      },
    };

    return {
      response: new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      payment: {
        priceUnits,
        txHash: "fake_tx_hash",
      },
    };
  };

  return buyPeerReasoningDetailed({
    buyer: args.buyer,
    activePersonas: args.activePersonas,
    claimId: args.claimId,
    baseUrl: "http://localhost:3000",
    readsPerPersona: args.readsPerPersona ?? 3,
    capUsdc: args.capUsdc ?? 0.05,
    delayMs: 0,
    payer: fakePayer,
    fetchWithBudgetImpl: fakeFetchWithBudget,
    rejectEquivocation: args.rejectEquivocation,
    statementDigest: args.statementDigest,
    claim: args.claim,
    skipCache: args.skipCache,
  });
}
