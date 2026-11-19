/*
 * Pre-flight for a funded agent action: would the policy allow it, does the agent
 * have the money, and what would it actually be paid?
 *
 * This is a READ-ONLY preflight preview. Nothing here is signed, submitted or
 * settled; the figures describe what an executed transaction would produce given
 * the current simulation inputs. Callers must present it as a preview, never as a
 * completed transaction.
 *
 * `allowanceAtomic` is a HISTORICAL NAME, kept because the response shape is a
 * public API surface. On the EVM chain it was the ERC-20 allowance the agent had
 * granted the market contract, and a stake could not land without one. Soroban has
 * no standing allowance on this path — `challenge_claim` carries auth for exactly
 * the staked amount — so the caller now passes the agent's spendable USDC BALANCE,
 * which is the constraint that actually decides whether the stake goes through.
 * The arithmetic is identical either way: "have >= need".
 */
import { splitFees, snapshotFeePolicy, type SettlementOutcome } from "@/lib/fees";
import { unitsToUsdc, usdcToUnits } from "@/lib/usdc";
import type { ActionVerdict } from "./registry";

export function buildAgentDryRun(args: {
  principalUsdc: number;
  grossPayoutUsdc: number;
  outcome: SettlementOutcome;
  /** Spendable USDC in atomic units (7 decimals). See the module note on the name. */
  allowanceAtomic: bigint;
  requiredAtomic: bigint;
  platformFeeBps: number;
  agentOwnerFeeBps: number;
  platformRecipient: string;
  ownerRecipient: string;
  policy: ActionVerdict;
}) {
  const fees = splitFees({
    principalUnits: usdcToUnits(args.principalUsdc),
    grossPayoutUnits: usdcToUnits(args.grossPayoutUsdc),
    outcome: args.outcome,
    snapshot: snapshotFeePolicy({
      platformFeeBps: args.platformFeeBps,
      agentOwnerFeeBps: args.agentOwnerFeeBps,
      platformRecipient: args.platformRecipient,
      agentOwnerRecipient: args.ownerRecipient,
    }),
  });
  const sufficient = args.allowanceAtomic >= args.requiredAtomic;
  return {
    /** Always false-safe: a preview is never an executed transaction. */
    preview: true as const,
    executed: false as const,
    allowed: args.policy.allowed && sufficient,
    policy: args.policy,
    allowance: {
      currentAtomic: args.allowanceAtomic.toString(),
      requiredAtomic: args.requiredAtomic.toString(),
      sufficient,
      /** What `currentAtomic` measures, so a caller is not misled by the key name. */
      source: "spendable_usdc_balance",
    },
    payout: {
      principalUsdc: unitsToUsdc(fees.principalUnits),
      grossProfitUsdc: unitsToUsdc(fees.grossProfitUnits),
      platformFeeUsdc: unitsToUsdc(fees.platformFeeUnits),
      agentOwnerFeeUsdc: unitsToUsdc(fees.agentOwnerFeeUnits),
      totalReturnUsdc: unitsToUsdc(fees.payoutUnits),
    },
  };
}
