/**
 * Dry-run gate for the market-creator worker.
 *
 * MARKET_CREATOR_DRY_RUN=1 runs the full pipeline (sources, drafting, caps,
 * dedupe) but blocks every side effect that spends money or mutates chain
 * state: `create_claim` (stakes USDC), `cancelClaim` (sends a transaction), and
 * the paid council preflight (x402 payments). All three decisions come from one
 * policy object so the worker cannot accidentally allow one of them while the
 * others are gated.
 */

/** Side effects that dry run must block. Everything else is a free read. */
export type CreatorSideEffect = "create_claim" | "cancel_claim" | "paid_preflight";

export interface CreatorSideEffectPolicy {
  readonly dryRun: boolean;
  readonly createClaim: boolean;
  readonly cancelClaim: boolean;
  readonly paidPreflight: boolean;
}

/** Strict opt-in: anything other than exactly "1" leaves the worker funded. */
export function isMarketCreatorDryRun(
  env: Record<string, string | undefined>,
): boolean {
  return env.MARKET_CREATOR_DRY_RUN === "1";
}

export function creatorSideEffectPolicy(dryRun: boolean): CreatorSideEffectPolicy {
  return dryRun
    ? { dryRun: true,  createClaim: false, cancelClaim: false, paidPreflight: false }
    : { dryRun: false, createClaim: true,  cancelClaim: true,  paidPreflight: true  };
}

const POLICY_FIELD: Record<CreatorSideEffect, keyof CreatorSideEffectPolicy> = {
  create_claim:   "createClaim",
  cancel_claim:   "cancelClaim",
  paid_preflight: "paidPreflight",
};

export function allowsCreatorSideEffect(
  policy: CreatorSideEffectPolicy,
  effect: CreatorSideEffect,
): boolean {
  return policy[POLICY_FIELD[effect]];
}
