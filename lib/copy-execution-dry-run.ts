import {
  copyPermissionRevision,
  createCopyPreviewCacheEntry,
  evaluateCopy,
  setCopyPreviewCache,
  type CopyDryRunContext as _,
  type CopyExecutionContext,
  type CopyPermission,
  type CopyPreviewCacheEntry,
  type CopySignal,
} from "@/lib/copy-trading";
import { checkWriteAllowed, isPaused } from "@/lib/ops/flags";
import { parseUsdcAtomic } from "@/lib/usdc";

export type CopyDryRunContext = Omit<CopyExecutionContext, "globalPaused" | "simulation">;

/**
 * A policy calculator for a supplied snapshot. No Soroban call, signature, audit
 * insert, reservation or transaction is made here. In particular, a positive
 * result is never an authorization to stake: the executor must re-read live
 * state and simulate the exact invocation before any funded action.
 *
 * Previews are bound to the permission revision and cached. Any owner policy update
 * or revocation invalidates the cached entry and changes the revision.
 */
export function buildCopyExecutionDryRun(args: {
  permission: CopyPermission;
  signal: CopySignal;
  context: CopyDryRunContext;
  env?: Record<string, string | undefined>;
  cache?: boolean;
}) {
  const env = args.env ?? process.env;
  const writeGate = checkWriteAllowed(
    { feature: "copy_trading", capability: "copy_execution", category: args.signal.category },
    env,
  );
  const previewGate = checkWriteAllowed(
    { capability: "copy_execution", category: args.signal.category }, env,
  );
  const decision = evaluateCopy(args.permission, args.signal, {
    ...args.context,
    globalPaused: isPaused("copy_execution", env),
    // This sentinel isolates policy checks. It is never presented as a
    // successful Soroban simulation or reused by a funded path.
    simulation: { ok: true, blockNumber: 0n },
  });
  let stakeAtomic: string | null = null;
  try { stakeAtomic = parseUsdcAtomic(args.signal.stakeUsdc).toString(); } catch { /* malformed input has no amount */ }

  const permissionRevision = copyPermissionRevision(args.permission);
  const policyEligible = previewGate.allowed && decision.allowed;

  let previewEntry: CopyPreviewCacheEntry | null = null;
  if (args.cache !== false) {
    previewEntry = createCopyPreviewCacheEntry({
      permission: args.permission,
      signal: args.signal,
      decision,
      policyEligible,
      now: args.context.now,
    });
    setCopyPreviewCache(previewEntry);
  }

  return {
    mode: "dry_run" as const,
    preflight: true as const,
    stateSource: "supplied_snapshot" as const,
    policyEligible,
    reason: !decision.allowed ? decision.reason : !previewGate.allowed ? previewGate.reason : null,
    detail: !previewGate.allowed ? previewGate.detail : null,
    fundedGateOpen: writeGate.allowed,
    fundedGateBlock: writeGate.reason ?? null,
    stakeAtomic,
    permissionRevision,
    previewId: previewEntry?.previewId ?? null,
    simulation: "not_run" as const,
    executionReady: false as const,
    transactionSubmitted: false as const,
    feeQuote: null,
  };
}
