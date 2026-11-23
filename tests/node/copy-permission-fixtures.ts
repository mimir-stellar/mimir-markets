import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  currentPeriodStart,
  evaluateSpend,
  permissionKey,
  type SpendPermissionRecord,
} from "../../lib/agents/spend-permissions";
import { buildCopyExecutionDryRun, type CopyDryRunContext } from "../../lib/copy-execution-dry-run";
import {
  computeCopyUsageFromExecutions,
  copyPolicyHash,
  copyRevokeMessage,
  evaluateCopy,
  type CopyExecutionContext,
  type CopyPermission,
  type CopySignal,
  type CopySkipReason,
  type CopyUsageExecutionRow,
} from "../../lib/copy-trading";
import { usdcToUnits, USDC_UNIT } from "../../lib/usdc";

export const COPY_FIXTURE_NOW_MS = 1_780_000_000_000;
export const COPY_FIXTURE_UNIT = USDC_UNIT;
export const COPY_FIXTURE_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const COPY_FIXTURE_MIMIR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
export const COPY_FIXTURE_OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";

export type CopySignalFixture = CopySignal;

export interface CopyFixturePreview {
  claimId: number;
  policyEligible: boolean;
  reason: string | null;
  stakeAtomic: string | null;
  stateSource: "supplied_snapshot";
  simulation: "not_run";
  executionReady: false;
  transactionSubmitted: false;
}

export interface CopyFixtureAudit {
  executionId: string;
  permissionId: string;
  claimId: number;
  sourcePositionId: string;
  status: "executed" | "skipped";
  stakeAtomic: bigint;
  reason?: CopySkipReason;
  simulationBlock: bigint;
  policyHash: string;
  createdAt: number;
}

export interface CopyFixturePolicyCheck {
  executed: number;
  skipped: number;
  totalStakeAtomic: string;
  remainingAllowanceAtomic: string;
  signedPolicyHash: string;
}

export interface CopyFixtureExecutionOptions {
  afterExecution?: (index: number, row: CopyFixtureAudit) => void;
  simulationFailures?: ReadonlySet<number>;
}

export interface CopyPermissionScenario {
  readonly stateDir: string;
  readonly signedPolicyHash: string;
  readonly permission: CopyPermission;
  preview(signals: readonly CopySignalFixture[]): Promise<CopyFixturePreview[]>;
  execute(
    signals: readonly CopySignalFixture[],
    options?: CopyFixtureExecutionOptions,
  ): Promise<CopyFixtureAudit[]>;
  revoke(args?: { nonce?: string; at?: number }): string;
  replacePermission(permission: CopyPermission): void;
  audit(): CopyFixtureAudit[];
  totalExecutedAtomic(): bigint;
  allowanceAtomic(): bigint;
  assertWithinSignedPolicy(): CopyFixturePolicyCheck;
  close(): void;
}

type SerializedPermission = Omit<CopyPermission, "spendPermission"> & {
  spendPermission: Omit<CopyPermission["spendPermission"], "allowanceAtomic"> & { allowanceAtomic: string };
};

interface StoredState {
  permission: CopyPermission;
  signedPolicyHash: string;
  allowanceAtomic: string;
  revokedAt: number | null;
  revokeMessage: string | null;
  ledger: string;
}

type SerializedState = Omit<StoredState, "permission"> & { permission: SerializedPermission };

type SerializedAudit = Omit<CopyFixtureAudit, "stakeAtomic" | "simulationBlock"> & {
  stakeAtomic: string;
  simulationBlock: string;
};

function fixturePermission(
  overrides: Partial<Omit<CopyPermission, "signedPolicyHash">> = {},
): CopyPermission {
  const base = {
    permissionId: "copy-permission-887",
    ownerWallet: COPY_FIXTURE_OWNER,
    executionAgentId: "agent-b",
    signalAgentId: "agent-a",
    maxPerPositionUsdc: 3,
    dailyCapUsdc: 5,
    weeklyCapUsdc: 10,
    totalOpenExposureUsdc: 8,
    maxRealizedLossAtomic: String(15n * COPY_FIXTURE_UNIT),
    allowedCategories: ["crypto"],
    allowedModes: ["pool"],
    minConfidenceBps: 7000,
    minPayoutBps: 12000,
    expiresAt: COPY_FIXTURE_NOW_MS + 60_000,
    depth: 1 as const,
    status: "active" as const,
    spendPermission: {
      token: COPY_FIXTURE_USDC,
      spender: COPY_FIXTURE_MIMIR,
      allowanceAtomic: 10n * COPY_FIXTURE_UNIT,
      periodSeconds: 86_400,
    },
    ...overrides,
  };
  return { ...base, signedPolicyHash: copyPolicyHash(base) };
}

function canonicalPolicyHash(permission: CopyPermission): string {
  const { signedPolicyHash: _ignored, ...fields } = permission;
  return copyPolicyHash({ ...fields, status: "active" });
}

function serializePermission(permission: CopyPermission): SerializedPermission {
  return {
    ...permission,
    spendPermission: {
      ...permission.spendPermission,
      allowanceAtomic: permission.spendPermission.allowanceAtomic.toString(),
    },
  };
}

function deserializePermission(permission: SerializedPermission): CopyPermission {
  return {
    ...permission,
    spendPermission: {
      ...permission.spendPermission,
      allowanceAtomic: BigInt(permission.spendPermission.allowanceAtomic),
    },
  };
}

function serializeAudit(row: CopyFixtureAudit): SerializedAudit {
  return {
    ...row,
    stakeAtomic: row.stakeAtomic.toString(),
    simulationBlock: row.simulationBlock.toString(),
  };
}

function deserializeAudit(row: SerializedAudit): CopyFixtureAudit {
  return {
    ...row,
    stakeAtomic: BigInt(row.stakeAtomic),
    simulationBlock: BigInt(row.simulationBlock),
  };
}

export function createCopyPermissionScenario(options: {
  stateDir?: string;
  permissionOverrides?: Partial<Omit<CopyPermission, "signedPolicyHash">>;
  nowMs?: number;
  env?: Record<string, string | undefined>;
} = {}): CopyPermissionScenario {
  const nowMs = options.nowMs ?? COPY_FIXTURE_NOW_MS;
  const stateDir = options.stateDir ?? mkdtempSync(path.join(tmpdir(), "mimir-copy-permissions-"));
  mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  const auditPath = path.join(stateDir, "audit.json");
  const env = {
    MIMIR_FEATURE_COPY_TRADING: "1",
    MIMIR_PAUSE_COPY_EXECUTION: "0",
    ...options.env,
  };
  const initialPermission = fixturePermission(options.permissionOverrides);
  const initialState: StoredState = {
    permission: initialPermission,
    signedPolicyHash: canonicalPolicyHash(initialPermission),
    allowanceAtomic: initialPermission.spendPermission.allowanceAtomic.toString(),
    revokedAt: null,
    revokeMessage: null,
    ledger: "100",
  };

  function readState(): StoredState {
    if (!existsSync(statePath)) return initialState;
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as SerializedState;
    return { ...raw, permission: deserializePermission(raw.permission) };
  }

  function writeState(state: StoredState): void {
    const payload: SerializedState = {
      ...state,
      permission: serializePermission(state.permission),
    };
    writeFileSync(statePath, JSON.stringify(payload));
  }

  function readAudit(): CopyFixtureAudit[] {
    if (!existsSync(auditPath)) return [];
    const rows = JSON.parse(readFileSync(auditPath, "utf8")) as SerializedAudit[];
    return rows.map(deserializeAudit);
  }

  function writeAudit(rows: readonly CopyFixtureAudit[]): void {
    writeFileSync(auditPath, JSON.stringify(rows.map(serializeAudit)));
  }

  function readContext(state: StoredState): CopyDryRunContext {
    const rows = readAudit();
    const executedRows: CopyUsageExecutionRow[] = rows
      .filter((row) => row.status === "executed")
      .map((row) => ({
        status: "executed",
        stake_atomic: row.stakeAtomic.toString(),
        created_at: row.createdAt,
      }));
    const usage = computeCopyUsageFromExecutions(executedRows, nowMs);
    return {
      now: nowMs,
      env,
      usage: {
        usedTodayUsdc: usage.usedTodayUsdc,
        usedThisWeekUsdc: usage.usedThisWeekUsdc,
        openExposureUsdc: usage.openExposureUsdc,
        realizedLossAtomic: "0",
      },
      existingClaimIds: new Set(rows.filter((row) => row.status === "executed").map((row) => row.claimId)),
      ancestryAgentIds: [state.permission.signalAgentId],
      configuredUsdc: COPY_FIXTURE_USDC,
      configuredSpender: COPY_FIXTURE_MIMIR,
      onchainAllowanceAtomic: BigInt(state.allowanceAtomic),
    };
  }

  function evaluateFixtureSpend(args: Parameters<typeof evaluateSpend>[0]): ReturnType<typeof evaluateSpend> {
    const previousToken = process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ID;
    process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ID = COPY_FIXTURE_USDC;
    try {
      return evaluateSpend(args);
    } finally {
      if (previousToken === undefined) delete process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ID;
      else process.env.NEXT_PUBLIC_STELLAR_USDC_SAC_ID = previousToken;
    }
  }

  function spendRecord(permission: CopyPermission): SpendPermissionRecord {
    const spend = permission.spendPermission;
    const startAt = Math.floor(nowMs / 1000) - spend.periodSeconds;
    const endAt = Math.floor(permission.expiresAt / 1000);
    const fields = {
      account: COPY_FIXTURE_OWNER,
      spender: spend.spender,
      token: spend.token,
      allowanceAtomic: spend.allowanceAtomic,
      periodSeconds: spend.periodSeconds,
      startAt,
      endAt,
      salt: "887",
    };
    return {
      permissionHash: permissionKey(fields),
      agentId: permission.executionAgentId,
      ...fields,
      extraData: "",
      signature: "Zml4dHVyZS1vd25lci1zaWduYXR1cmU=",
      permissionJson: "{}",
      createdAt: startAt * 1000,
    };
  }

  function spendThisPeriodAtomic(rows: readonly CopyFixtureAudit[], record: SpendPermissionRecord): bigint {
    const periodStart = currentPeriodStart(record, Math.floor(nowMs / 1000));
    return rows
      .filter((row) => row.status === "executed" && Math.floor(row.createdAt / 1000) >= periodStart)
      .reduce((sum, row) => sum + row.stakeAtomic, 0n);
  }

  return {
    stateDir,
    get signedPolicyHash() {
      return readState().signedPolicyHash;
    },
    get permission() {
      return readState().permission;
    },
    async preview(signals) {
      const state = readState();
      const snapshot = readContext(state);
      return signals.map((signal) => {
        const result = buildCopyExecutionDryRun({
          permission: state.permission,
          signal,
          context: snapshot,
          env,
        });
        return {
          claimId: signal.claimId,
          policyEligible: result.policyEligible,
          reason: result.reason ?? null,
          stakeAtomic: result.stakeAtomic,
          stateSource: result.stateSource,
          simulation: result.simulation,
          executionReady: result.executionReady,
          transactionSubmitted: result.transactionSubmitted,
        };
      });
    },
    async execute(signals, executeOptions = {}) {
      const ordered = [...signals].sort(
        (a, b) => a.claimId - b.claimId || a.sourcePositionId.localeCompare(b.sourcePositionId),
      );
      const results: CopyFixtureAudit[] = [];
      for (const [index, signal] of ordered.entries()) {
        const state = readState();
        const rows = readAudit();
        const snapshot = readContext(state);
        const ledger = BigInt(state.ledger) + 1n;
        state.ledger = ledger.toString();
        let reason: CopySkipReason | undefined;
        let stakeAtomic = 0n;

        if (state.revokedAt !== null) {
          reason = "permission_revoked";
        } else if (canonicalPolicyHash(state.permission) !== state.signedPolicyHash) {
          reason = "policy_hash_mismatch";
        } else {
          const record = spendRecord(state.permission);
          const spendDecision = evaluateFixtureSpend({
            permission: record,
            spentThisPeriodAtomic: spendThisPeriodAtomic(rows, record),
            amountAtomic: usdcToUnits(signal.stakeUsdc),
            nowSeconds: Math.floor(nowMs / 1000),
            spender: COPY_FIXTURE_MIMIR,
          });
          if (!spendDecision.allowed) {
            reason = spendDecision.reason === "expired" ? "permission_expired" : "spend_permission_mismatch";
          } else {
            const context: CopyExecutionContext = {
              ...snapshot,
              globalPaused: false,
              simulation: executeOptions.simulationFailures?.has(signal.claimId)
                ? { ok: false, blockNumber: ledger }
                : { ok: true, blockNumber: ledger },
            };
            const decision = evaluateCopy(state.permission, signal, context);
            if (!decision.allowed) {
              reason = decision.reason;
            } else {
              stakeAtomic = usdcToUnits(decision.stakeUsdc);
            }
          }
        }

        if (stakeAtomic > 0n) {
          state.allowanceAtomic = (BigInt(state.allowanceAtomic) - stakeAtomic).toString();
        }
        const row: CopyFixtureAudit = {
          executionId: `copy-exec-${ledger}`,
          permissionId: state.permission.permissionId,
          claimId: signal.claimId,
          sourcePositionId: signal.sourcePositionId,
          status: stakeAtomic > 0n ? "executed" : "skipped",
          stakeAtomic,
          ...(reason ? { reason } : {}),
          simulationBlock: ledger,
          policyHash: state.signedPolicyHash,
          createdAt: nowMs,
        };
        writeState(state);
        writeAudit([...rows, row]);
        executeOptions.afterExecution?.(index, row);
        results.push(row);
      }
      return results;
    },
    revoke(args = {}) {
      const state = readState();
      const at = args.at ?? nowMs;
      const nonce = args.nonce ?? "revoke-887";
      state.revokedAt = at;
      state.revokeMessage = copyRevokeMessage({
        permissionId: state.permission.permissionId,
        ownerWallet: state.permission.ownerWallet,
        nonce,
        expiresAt: Math.floor(at / 1000) + 300,
      });
      writeState(state);
      return state.revokeMessage;
    },
    replacePermission(permission) {
      const state = readState();
      state.permission = permission;
      writeState(state);
    },
    audit() {
      return readAudit();
    },
    totalExecutedAtomic() {
      return readAudit()
        .filter((row) => row.status === "executed")
        .reduce((sum, row) => sum + row.stakeAtomic, 0n);
    },
    allowanceAtomic() {
      return BigInt(readState().allowanceAtomic);
    },
    assertWithinSignedPolicy() {
      const state = readState();
      if (canonicalPolicyHash(state.permission) !== state.signedPolicyHash) {
        throw new Error("policy_hash_mismatch");
      }
      const rows = readAudit();
      const executed = rows.filter((row) => row.status === "executed");
      const usage = computeCopyUsageFromExecutions(
        executed.map((row) => ({
          status: "executed",
          stake_atomic: row.stakeAtomic.toString(),
          created_at: row.createdAt,
        })),
        nowMs,
      );
      const signed = state.permission;
      const perPositionAtomic = usdcToUnits(signed.maxPerPositionUsdc);
      for (const row of executed) {
        if (row.stakeAtomic <= 0n || row.stakeAtomic > perPositionAtomic || row.policyHash !== state.signedPolicyHash) {
          throw new Error("execution_outside_signed_policy");
        }
      }
      const ceilings: Array<[bigint, bigint]> = [
        [BigInt(usage.dailyUsedAtomic), usdcToUnits(signed.dailyCapUsdc)],
        [BigInt(usage.weeklyUsedAtomic), usdcToUnits(signed.weeklyCapUsdc)],
        [BigInt(usage.openExposureAtomic), usdcToUnits(signed.totalOpenExposureUsdc)],
        [BigInt(usage.openExposureAtomic), BigInt(signed.maxRealizedLossAtomic)],
      ];
      for (const [spent, ceiling] of ceilings) {
        if (spent > ceiling) throw new Error("execution_outside_signed_policy");
      }
      const total = executed.reduce((sum, row) => sum + row.stakeAtomic, 0n);
      const signedAllowance = signed.spendPermission.allowanceAtomic;
      if (total > signedAllowance || BigInt(state.allowanceAtomic) !== signedAllowance - total) {
        throw new Error("execution_outside_signed_allowance");
      }
      return {
        executed: executed.length,
        skipped: rows.length - executed.length,
        totalStakeAtomic: total.toString(),
        remainingAllowanceAtomic: state.allowanceAtomic,
        signedPolicyHash: state.signedPolicyHash,
      };
    },
    close() {
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
