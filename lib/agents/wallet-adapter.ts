/**
 * Vendor-neutral wallet boundary for BYOA funded actions, Stellar edition.
 *
 * ── Why the EVM shape could not be ported field-for-field ────────────────────
 *
 * The old adapter described a call as `{ target, data, value }` — an address, ABI
 * calldata, and native ETH. None of the three survives the move:
 *
 *   `data`   Soroban has no calldata. An invocation is a contract id, a function
 *            name and typed arguments, and the generated bindings build the
 *            envelope. There is no opaque byte string to hand around, so
 *            {@link AgentWalletCall} carries the assembled-call factory instead.
 *   `value`  There is no payable call. XLM is the fee, never an argument, so the
 *            old `native_value_forbidden` rejection has nothing left to reject —
 *            it is gone rather than kept as a check that can never fire.
 *   gas      Sponsorship is gone as a product decision (agents self-fund their
 *            own sub-cent fees), so `sponsorGas` and
 *            `gas_sponsorship_not_allowed` are gone with it.
 *
 * What DOES survive unchanged is the part that matters: the budget policy. Those
 * ceilings are pure arithmetic over atomic USDC and are identical on any chain,
 * so {@link authorizeWalletCall} keeps its exact semantics minus the two
 * rejections that referred to EVM-only concepts.
 */

import { isAccountAddress, isContractAddress, type StellarSigner } from "@/lib/stellar";

export type AgentWalletKind =
  /** A plain `G…` account signing with its own Ed25519 seed. */
  | "keypair"
  /** A `C…` contract account (Soroban custom account / multisig). */
  | "contract_account"
  /** A hosted signer that holds the key on the agent owner's behalf. */
  | "custodial";

/**
 * One contract invocation, described as the thing that can build it.
 *
 * A factory rather than a pre-built transaction because the bindings SIMULATE at
 * construction time and bake the simulation's footprint into the envelope: an
 * envelope assembled for a dry run is stale by the time it would be sent. Handing
 * over the factory lets `simulate` and `send` each build a fresh one.
 */
export interface AgentWalletCall {
  /** `C…` contract this call targets. Checked against the policy allowlist. */
  contractId: string;
  /** Contract function name, for logs and audit rows. */
  method: string;
  /** Atomic USDC newly exposed by the call. */
  exposureAtomic: bigint;
  /** Build (and thereby simulate) the invocation for a given signer. */
  assemble: (signer: StellarSigner) => Promise<{
    signAndSend: () => Promise<{ sendTransactionResponse?: { hash: string } | undefined }>;
  }>;
}

export interface StellarAgentWalletAdapter {
  readonly kind: AgentWalletKind;
  /** `G…` account or `C…` contract account. */
  readonly address: string;
  /**
   * Keypair and contract-account signatures are verified through the same caller
   * API. For a `G…` account this is a local Ed25519 check (SEP-43 base64
   * signature); a `C…` account delegates to its own `__check_auth`.
   */
  verifySignature(args: { message: string; signature: string }): Promise<boolean>;
  simulate(call: AgentWalletCall): Promise<{ ok: boolean; reason?: string }>;
  /** Returns the Stellar transaction hash. */
  send(call: AgentWalletCall): Promise<string>;
}

/**
 * Read-only preview of what a call would cost and expose, derived from
 * simulation. Never sends; `executed` is always `false` so UIs cannot mistake
 * a preflight for a submitted transaction.
 */
export interface AgentWalletPreflight {
  readonly executed: false;
  /** Whether simulation reports the call as runnable. */
  simulationOk: boolean;
  /** Simulation failure reason, when `simulationOk` is false. */
  reason?: string;
  /** Exact atomic USDC exposure this call would add. */
  exposureAtomic: bigint;
  /** XLM fee in stroops as estimated by simulation (fee only, never value). */
  feeStroops: bigint;
  /** Whether the account keeps its XLM reserve after paying the fee. */
  reserveReady: boolean;
}

export async function previewWalletCall(args: {
  adapter: StellarAgentWalletAdapter;
  call: AgentWalletCall;
  feeStroops: bigint;
  reserveReady: boolean;
}): Promise<AgentWalletPreflight> {
  const result = await args.adapter.simulate(args.call);
  return {
    executed: false,
    simulationOk: result.ok,
    reason: result.ok ? undefined : result.reason,
    exposureAtomic: args.call.exposureAtomic,
    feeStroops: args.feeStroops,
    reserveReady: args.reserveReady,
  };
}

export interface WalletBudgetPolicy {
  maxPerCallAtomic: bigint;
  maxPerSessionAtomic: bigint;
  maxPerDayAtomic: bigint;
  maxTotalOpenExposureAtomic: bigint;
  /** `C…` contract ids this wallet may be pointed at. */
  allowedTargets: readonly string[];
  paused: boolean;
}

export interface WalletBudgetUsage {
  sessionAtomic: bigint;
  dayAtomic: bigint;
  totalOpenExposureAtomic: bigint;
}

export type WalletBudgetRejection =
  | "paused"
  | "target_not_allowed"
  | "per_call_exceeded"
  | "session_exceeded"
  | "day_exceeded"
  | "total_exposure_exceeded";

export function authorizeWalletCall(args: {
  call: Pick<AgentWalletCall, "contractId" | "exposureAtomic">;
  policy: WalletBudgetPolicy;
  usage: WalletBudgetUsage;
}): { allowed: true } | { allowed: false; reason: WalletBudgetRejection } {
  const { call, policy, usage } = args;
  if (policy.paused) return { allowed: false, reason: "paused" };
  // Exact comparison, not case-insensitive: a Stellar StrKey is case-SENSITIVE
  // base32, so the EVM `toLowerCase()` pairing would turn a valid contract id
  // into one that matches nothing.
  if (!policy.allowedTargets.some((target) => target === call.contractId)) {
    return { allowed: false, reason: "target_not_allowed" };
  }
  if (call.exposureAtomic > policy.maxPerCallAtomic) {
    return { allowed: false, reason: "per_call_exceeded" };
  }
  if (usage.sessionAtomic + call.exposureAtomic > policy.maxPerSessionAtomic) {
    return { allowed: false, reason: "session_exceeded" };
  }
  if (usage.dayAtomic + call.exposureAtomic > policy.maxPerDayAtomic) {
    return { allowed: false, reason: "day_exceeded" };
  }
  if (usage.totalOpenExposureAtomic + call.exposureAtomic > policy.maxTotalOpenExposureAtomic) {
    return { allowed: false, reason: "total_exposure_exceeded" };
  }
  return { allowed: true };
}

/** Worker keypairs and hosted signers plug into this same interface. */
export function assertWalletAdapter(adapter: StellarAgentWalletAdapter): StellarAgentWalletAdapter {
  if (!isAccountAddress(adapter.address) && !isContractAddress(adapter.address)) {
    throw new Error("invalid adapter address");
  }
  return adapter;
}
