/**
 * Paid council-to-council reads.
 *
 * A persona can buy another persona's public reasoning before making its own
 * decision. This turns the council into a small information market instead of
 * ten isolated voters.
 *
 * Deliberation deadlines: each peer read is bounded by an overall deadline.
 * Reads that do not complete before the deadline are reported as deadline
 * abstentions (kind: "deadline_abstention") rather than being silently dropped,
 * so callers can distinguish a missing opinion caused by time pressure from a
 * substantive disagreement, and never treat a missing vote as consensus.
 */

import { fetchWithBudget, payingWalletFor, type PayingWallet } from "../../../lib/x402/buyer";
import { outboundTraceHeaders } from "../../../lib/ops/trace-http";
import { getCouncilWallet } from "../../../lib/agent-wallets";
import { usdcToUnits } from "../../../lib/usdc";
import {
  type PersonaSpec,
  personaSecretEnv,
} from "../personas";

export interface PeerReasoningRead {
  kind: "reasoning";
  sellerSlug: string;
  sellerName: string;
  reasoning: string;
  pricePaidUnits: string | null;
  /**
   * Quorum policy revision in force when this read was taken. Recorded so
   * aggregate decisions can reference the exact policy they were made under,
   * and so historical captured ballots replay deterministically even after
   * policy defaults change.
   */
  policyRevision: string;
}

/**
 * A peer that was asked but did not contribute reasoning in time. This is an
 * abstention, not a disagreement: it carries no opinion and must not be counted
 * toward either side of a consensus.
 */
export interface PeerDeadlineAbstention {
  kind: "deadline_abstention";
  sellerSlug: string;
  reason: "deadline_exceeded";
}

export type PeerReadOutcome = PeerReasoningRead | PeerDeadlineAbstention;

/**
 * Stable reference for the quorum policy revision that peer reads are
 * recorded under. Pinned explicitly so that changing defaults elsewhere does
 * not silently rewrite the revision attached to previously captured ballots.
 */
export const PEER_REASONING_POLICY_REVISION = "quorum-policy/v1";

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

/**
 * Replays a council policy over captured ballots without contacting any model
 * provider. Each fixture pairs a claim with the independent opinions gathered
 * earlier, so quorum and confidence rules can be compared on identical inputs.
 */
export interface CapturedBallot {
  persona: string;
  verdict: "yes" | "no" | "abstain";
  confidence: number;
}

export interface CouncilPolicy {
  name: string;
  quorum: number;
  minConfidence: number;
}

export interface PolicyDecision {
  policy: string;
  decision: "yes" | "no" | "undecided";
}

export function runPolicyComparison(
  ballots: CapturedBallot[],
  policies: CouncilPolicy[],
): PolicyDecision[] {
  return policies.map((policy) => {
    const counted = ballots.filter(
      (b) => b.verdict !== "abstain" && b.confidence >= policy.minConfidence,
    );
    if (counted.length < policy.quorum) {
      return { policy: policy.name, decision: "undecided" as const };
    }
    const yes = counted.filter((b) => b.verdict === "yes").length;
    const no = counted.length - yes;
    if (yes === no) return { policy: policy.name, decision: "undecided" as const };
    return { policy: policy.name, decision: yes > no ? ("yes" as const) : ("no" as const) };
  });
}

export function changedDecisions(
  baseline: PolicyDecision[],
  candidate: PolicyDecision[],
): PolicyDecision[] {
  const byName = new Map(baseline.map((d) => [d.policy, d.decision]));
  return candidate.filter((d) => byName.get(d.policy) !== d.decision);
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
 * Returns the peer reads that completed before the deadline, plus one
 * deadline abstention for every seller that was still outstanding when the
 * deadline elapsed. A deadline of 0 or less disables the bound (no abstentions
 * are produced from time alone).
 */
export async function buyPeerReasoning(args: {
  buyer: PersonaSpec;
  activePersonas: PersonaSpec[];
  claimId: number;
  baseUrl: string;
  readsPerPersona: number;
  capUsdc: number;
  delayMs: number;
  deadlineMs?: number;
  policyRevision?: string;
}): Promise<PeerReadOutcome[]> {
  if (args.readsPerPersona <= 0) return [];

  const payer = payingWalletForPersona(args.buyer);
  if (!payer) return [];

  const policyRevision = args.policyRevision ?? PEER_REASONING_POLICY_REVISION;
  const sellers = selectPeerSellers(
    args.buyer,
    args.activePersonas,
    args.claimId,
    args.readsPerPersona,
  );
  const deadlineMs = args.deadlineMs ?? 0;
  const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : Number.POSITIVE_INFINITY;
  const outcomes: PeerReadOutcome[] = [];

  let remainingUnits = usdcToUnits(args.capUsdc);
  let deadlineHit = false;

  for (const seller of sellers) {
    if (Date.now() >= deadlineAt) {
      deadlineHit = true;
      break;
    }
    if (remainingUnits <= 0n) break;

    const url =
      `${args.baseUrl.replace(/\/$/, "")}/api/council/reasoning` +
      `?claimId=${encodeURIComponent(String(args.claimId))}` +
      `&persona=${encodeURIComponent(seller.slug)}`;

    try {
      // Trace header on the same request as the payment: a peer's paid read and
      // the persona's decision cycle are one trace. Inert to the x402 proof.
      const result = await fetchWithBudget(url, payer, remainingUnits, {
        method: "GET",
        headers: { accept: "application/json", ...outboundTraceHeaders() },
      });
      if (!result.response.ok) {
        if (Date.now() >= deadlineAt) deadlineHit = true;
        continue;
      }

      const body = (await result.response.json()) as ReasoningResponse;
      const reasoning = String(body.reasoning ?? "").trim();
      if (!reasoning) {
        if (Date.now() >= deadlineAt) deadlineHit = true;
        continue;
      }

      outcomes.push({
        kind: "reasoning",
        sellerSlug: body.persona?.slug ?? seller.slug,
        sellerName: body.persona?.name ?? seller.displayName,
        reasoning: reasoning.slice(0, 360),
        pricePaidUnits: result.payment?.priceUnits?.toString() ?? null,
        policyRevision,
      });

      if (result.payment) {
        remainingUnits -= result.payment.priceUnits;
      }
    } catch (err) {
      console.warn(
        `[council:${args.buyer.slug}] peer read failed from ${seller.slug}:`,
        err instanceof Error ? err.message : err,
      );
      if (Date.now() >= deadlineAt) deadlineHit = true;
    }

    if (args.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }
  }

  // Any seller we did not get a reasoning response from by the deadline is an
  // abstention. Sellers already represented in `outcomes` are excluded.
  if (deadlineHit || Date.now() >= deadlineAt) {
    const answered = new Set(
      outcomes.filter((o): o is PeerReasoningRead => o.kind === "reasoning").map((o) => o.sellerSlug),
    );
    for (const seller of sellers) {
      if (answered.has(seller.slug)) continue;
      if (outcomes.some((o) => o.kind === "deadline_abstention" && o.sellerSlug === seller.slug)) continue;
      if (!deadlineHit && Date.now() < deadlineAt) continue;
      outcomes.push({
        kind: "deadline_abstention",
        sellerSlug: seller.slug,
        reason: "deadline_exceeded",
      });
    }
  }

  return outcomes;
}

/** Narrow a mixed outcome list to substantive peer reasoning only. */
export function substantivePeerReads(outcomes: PeerReadOutcome[]): PeerReasoningRead[] {
  return outcomes.filter((o): o is PeerReasoningRead => o.kind === "reasoning");
}