/**
 * Structured creator reporting for the market-creator worker.
 *
 * Exposes category budget exhaustion distinctly from source-quality rejections,
 * duplicate candidates, and global exposure ceiling limits while strictly
 * preserving exact USDC exposure checks.
 */

import {
  checkCategoryCreatorCap,
  normalizeCategory,
  type CategoryCapPolicy,
} from "./category-caps.js";
import {
  checkCreatorExposureCap,
} from "./exposure-caps.js";
import {
  decideMode,
  defaultCreatorPolicy,
  type CandidateInput,
  type CreatorDecisionCode,
  type CreatorPolicy,
  type ModeDecision,
} from "./mode-matrix.js";
import {
  buildCandidateSignature,
  type CandidateLike,
} from "../../agents/market-creator/dedupe.js";
import {
  cryptoThresholdReason,
  type ClaimCandidate,
} from "../../agents/market-creator/drafting.js";
import type { SettlementMode, SubjectType } from "../market-modes.js";

export type { CreatorDecisionCode };

export interface CandidateEvaluationContext {
  existingSignatures?: ReadonlySet<string>;
  policy?: CreatorPolicy;
  openExposureUsdc: number;
  categoryBuckets?: Record<string, { openMarkets: number; openExposureUsdc: number }>;
  activeMarkets: number;
  availableLiquidityUsdc?: number;
  stakeUsdc?: number;
  requestedMode?: SettlementMode;
  categoryEnabled?: (category: string) => boolean;
}

export interface CandidateExactExposure {
  stakeUsdc: number;
  openExposureUsdc: number;
  nextExposureUsdc: number;
  maxOpenExposureUsdc: number;
  categoryOpenExposureUsdc?: number;
  categoryNextExposureUsdc?: number;
  categoryMaxExposureUsdc?: number;
  categoryOpenMarkets?: number;
  categoryMaxMarkets?: number;
  limitedBy?: "markets" | "exposure";
}

export interface CreatorCandidateReport {
  question: string;
  category: string;
  resolutionUrl?: string;
  deadline?: string;
  disposition: "create" | "review" | "skip" | "open_duel_invite";
  decisionCode: CreatorDecisionCode;
  rationale: string;
  blockedBy?: string;
  exposure: CandidateExactExposure;
}

export interface CreatorReportSummary {
  totalEvaluated: number;
  totalAdmitted: number;
  totalSkipped: number;
  categoryBudgetExhausted: number;
  sourceQualityRejected: number;
  duplicates: number;
  globalExposureExceeded: number;
  activeMarketCapExceeded: number;
  categoryDisabled: number;
  countsByDecisionCode: Record<string, number>;
}

export interface CreatorReport {
  timestamp: number;
  summary: CreatorReportSummary;
  decisions: CreatorCandidateReport[];
}

/**
 * Evaluate a single candidate for admission and mode decision, producing a
 * structured report item with distinct decision codes and exact USDC arithmetic.
 */
export function evaluateCreatorCandidate(
  candidate: ClaimCandidate & {
    qualityScore?: number;
    subjectType?: SubjectType;
    targetAgentId?: string;
    parentClaimId?: number;
    parentIsSettled?: boolean;
    challengerPayoutBps?: number;
  },
  context: CandidateEvaluationContext,
  seenInRun: Set<string>,
): {
  report: CreatorCandidateReport;
  modeDecision: ModeDecision;
} {
  const policy = context.policy ?? defaultCreatorPolicy();
  const stakeUsdc = context.stakeUsdc ?? 2;
  const requestedMode: SettlementMode = context.requestedMode ?? "pool";
  const category = candidate.category ?? "unclassified";
  const normalizedCat = normalizeCategory(category) ?? "unclassified";

  const categoryBucket = context.categoryBuckets?.[normalizedCat] ?? {
    openMarkets: 0,
    openExposureUsdc: 0,
  };

  const exposure: CandidateExactExposure = {
    stakeUsdc,
    openExposureUsdc: context.openExposureUsdc,
    nextExposureUsdc: context.openExposureUsdc + stakeUsdc,
    maxOpenExposureUsdc: policy.maxOpenExposureUsdc,
    categoryOpenExposureUsdc: categoryBucket.openExposureUsdc,
    categoryNextExposureUsdc: categoryBucket.openExposureUsdc + stakeUsdc,
    categoryOpenMarkets: categoryBucket.openMarkets,
  };

  // 1. Deduplication against on-chain existing claims and previous items in batch
  const candidateLike: CandidateLike = {
    question: candidate.question,
    resolutionUrl: candidate.resolutionUrl,
    deadline: candidate.deadline,
  };
  const signature = buildCandidateSignature(candidateLike);

  if (context.existingSignatures?.has(signature) || seenInRun.has(signature)) {
    const report: CreatorCandidateReport = {
      question: candidate.question,
      category,
      resolutionUrl: candidate.resolutionUrl,
      deadline: candidate.deadline,
      disposition: "skip",
      decisionCode: "duplicate",
      rationale: "duplicate market detected against active claims or run batch",
      blockedBy: `duplicate signature ${signature}`,
      exposure,
    };
    const modeDecision: ModeDecision = {
      settlementMode: requestedMode,
      modifiers: [],
      disposition: "skip",
      decisionCode: "duplicate",
      rationale: report.rationale,
      blockedBy: report.blockedBy,
    };
    return { report, modeDecision };
  }
  seenInRun.add(signature);

  // 2. Source-quality checks (completeness, URL, threshold sanity, preflight score)
  if (!candidate.question || !candidate.resolutionUrl || !candidate.deadline) {
    const report: CreatorCandidateReport = {
      question: candidate.question ?? "(missing)",
      category,
      resolutionUrl: candidate.resolutionUrl,
      deadline: candidate.deadline,
      disposition: "skip",
      decisionCode: "source_quality_rejected",
      rationale: "missing required candidate fields",
      blockedBy: "question, resolutionUrl, and deadline are required",
      exposure,
    };
    const modeDecision: ModeDecision = {
      settlementMode: requestedMode,
      modifiers: [],
      disposition: "skip",
      decisionCode: "source_quality_rejected",
      rationale: report.rationale,
      blockedBy: report.blockedBy,
    };
    return { report, modeDecision };
  }

  if (candidate.threshold !== undefined) {
    const thresholdReason = cryptoThresholdReason(candidate.threshold);
    if (thresholdReason !== null) {
      const report: CreatorCandidateReport = {
        question: candidate.question,
        category,
        resolutionUrl: candidate.resolutionUrl,
        deadline: candidate.deadline,
        disposition: "skip",
        decisionCode: "source_quality_rejected",
        rationale: "source quality rejected due to unsafe threshold",
        blockedBy: `crypto threshold: ${thresholdReason}`,
        exposure,
      };
      const modeDecision: ModeDecision = {
        settlementMode: requestedMode,
        modifiers: [],
        disposition: "skip",
        decisionCode: "source_quality_rejected",
        rationale: report.rationale,
        blockedBy: report.blockedBy,
      };
      return { report, modeDecision };
    }
  }

  const qualityScore = typeof candidate.qualityScore === "number" ? candidate.qualityScore : 100;
  if (qualityScore < policy.minQualityScore) {
    const report: CreatorCandidateReport = {
      question: candidate.question,
      category,
      resolutionUrl: candidate.resolutionUrl,
      deadline: candidate.deadline,
      disposition: "skip",
      decisionCode: "source_quality_rejected",
      rationale: "source quality rejected: below preflight quality bar",
      blockedBy: `quality ${qualityScore} < ${policy.minQualityScore}`,
      exposure,
    };
    const modeDecision: ModeDecision = {
      settlementMode: requestedMode,
      modifiers: [],
      disposition: "skip",
      decisionCode: "source_quality_rejected",
      rationale: report.rationale,
      blockedBy: report.blockedBy,
    };
    return { report, modeDecision };
  }

  // 3. Global active market cap
  if (context.activeMarkets >= policy.maxActiveMarkets) {
    const report: CreatorCandidateReport = {
      question: candidate.question,
      category,
      resolutionUrl: candidate.resolutionUrl,
      deadline: candidate.deadline,
      disposition: "skip",
      decisionCode: "active_market_cap_exceeded",
      rationale: "active market cap reached",
      blockedBy: `${context.activeMarkets}/${policy.maxActiveMarkets} active`,
      exposure,
    };
    const modeDecision: ModeDecision = {
      settlementMode: requestedMode,
      modifiers: [],
      disposition: "skip",
      decisionCode: "active_market_cap_exceeded",
      rationale: report.rationale,
      blockedBy: report.blockedBy,
    };
    return { report, modeDecision };
  }

  // 4. Global open exposure check (exact arithmetic)
  const exposureGate = checkCreatorExposureCap({
    openExposureUsdc: context.openExposureUsdc,
    stakeUsdc,
    maxOpenExposureUsdc: policy.maxOpenExposureUsdc,
  });
  if (!exposureGate.allowed) {
    const report: CreatorCandidateReport = {
      question: candidate.question,
      category,
      resolutionUrl: candidate.resolutionUrl,
      deadline: candidate.deadline,
      disposition: "skip",
      decisionCode: "global_exposure_exceeded",
      rationale: "would exceed the creator's global open exposure ceiling",
      blockedBy: exposureGate.blockedBy,
      exposure,
    };
    const modeDecision: ModeDecision = {
      settlementMode: requestedMode,
      modifiers: [],
      disposition: "skip",
      decisionCode: "global_exposure_exceeded",
      rationale: report.rationale,
      blockedBy: report.blockedBy,
    };
    return { report, modeDecision };
  }

  // 5. Per-category cap check (exact USDC and market count arithmetic)
  const isCategoryEnabled = context.categoryEnabled ? context.categoryEnabled(category) : true;
  const categoryGate = checkCategoryCreatorCap({
    category,
    policy: policy.categoryCaps,
    openMarkets: categoryBucket.openMarkets,
    openExposureUsdc: categoryBucket.openExposureUsdc,
    stakeUsdc,
    categoryEnabled: isCategoryEnabled,
  });

  if (categoryGate.cap) {
    exposure.categoryMaxMarkets = categoryGate.cap.maxMarkets;
    exposure.categoryMaxExposureUsdc = categoryGate.cap.maxExposureUsdc;
  }
  if (categoryGate.limitedBy) {
    exposure.limitedBy = categoryGate.limitedBy;
  }

  if (!categoryGate.allowed) {
    const decisionCode: CreatorDecisionCode =
      categoryGate.reason === "category_disabled"
        ? "category_disabled"
        : "category_budget_exhausted";

    const report: CreatorCandidateReport = {
      question: candidate.question,
      category,
      resolutionUrl: candidate.resolutionUrl,
      deadline: candidate.deadline,
      disposition: "skip",
      decisionCode,
      rationale:
        decisionCode === "category_disabled"
          ? "category disabled by operational flag"
          : "category budget exhausted (per-category cap reached)",
      blockedBy: categoryGate.blockedBy,
      exposure,
    };
    const modeDecision: ModeDecision = {
      settlementMode: requestedMode,
      modifiers: [],
      disposition: "skip",
      decisionCode,
      rationale: report.rationale,
      blockedBy: report.blockedBy,
    };
    return { report, modeDecision };
  }

  // 6. Mode obligations & final disposition via decideMode
  const modeInput: CandidateInput = {
    subjectType: candidate.subjectType ?? "binary",
    category,
    targetAgentId: candidate.targetAgentId,
    parentClaimId: candidate.parentClaimId,
    parentIsSettled: candidate.parentIsSettled,
    availableLiquidityUsdc: context.availableLiquidityUsdc ?? 100,
    stakeUsdc,
    challengerPayoutBps: candidate.challengerPayoutBps,
    openExposureUsdc: context.openExposureUsdc,
    activeMarkets: context.activeMarkets,
    categoryOpen: {
      markets: categoryBucket.openMarkets,
      exposureUsdc: categoryBucket.openExposureUsdc,
    },
    qualityScore,
  };

  const modeDecision = decideMode(modeInput, requestedMode, policy);
  const report: CreatorCandidateReport = {
    question: candidate.question,
    category,
    resolutionUrl: candidate.resolutionUrl,
    deadline: candidate.deadline,
    disposition: modeDecision.disposition,
    decisionCode: modeDecision.decisionCode,
    rationale: modeDecision.rationale,
    blockedBy: modeDecision.blockedBy,
    exposure,
  };

  return { report, modeDecision };
}

/**
 * Generate a complete CreatorReport across a candidate batch.
 *
 * Tracks local optimistic exposure so subsequent candidates in the same batch
 * properly encounter category budget limits and exposure ceilings.
 */
export function generateCreatorReport(args: {
  candidates: readonly (ClaimCandidate & {
    qualityScore?: number;
    subjectType?: SubjectType;
    targetAgentId?: string;
    parentClaimId?: number;
    parentIsSettled?: boolean;
    challengerPayoutBps?: number;
  })[];
  context: CandidateEvaluationContext;
  maxCreates?: number;
}): CreatorReport {
  const seenInRun = new Set<string>();
  const decisions: CreatorCandidateReport[] = [];
  const countsByDecisionCode: Record<string, number> = {};

  let currentOpenExposureUsdc = args.context.openExposureUsdc;
  const currentCategoryBuckets: Record<string, { openMarkets: number; openExposureUsdc: number }> = {};

  if (args.context.categoryBuckets) {
    for (const [cat, bucket] of Object.entries(args.context.categoryBuckets)) {
      currentCategoryBuckets[cat] = {
        openMarkets: bucket.openMarkets,
        openExposureUsdc: bucket.openExposureUsdc,
      };
    }
  }

  const maxCreates = args.maxCreates ?? 5;
  let admittedCount = 0;

  for (const candidate of args.candidates) {
    const itemContext: CandidateEvaluationContext = {
      ...args.context,
      openExposureUsdc: currentOpenExposureUsdc,
      categoryBuckets: currentCategoryBuckets,
    };

    const { report } = evaluateCreatorCandidate(candidate, itemContext, seenInRun);
    decisions.push(report);

    countsByDecisionCode[report.decisionCode] = (countsByDecisionCode[report.decisionCode] ?? 0) + 1;

    if (report.disposition === "create" || report.disposition === "review") {
      admittedCount += 1;
      const stake = report.exposure.stakeUsdc;
      currentOpenExposureUsdc += stake;

      const normCat = normalizeCategory(report.category) ?? "unclassified";
      const bucket = currentCategoryBuckets[normCat] ?? { openMarkets: 0, openExposureUsdc: 0 };
      bucket.openMarkets += 1;
      bucket.openExposureUsdc += stake;
      currentCategoryBuckets[normCat] = bucket;

      if (admittedCount >= maxCreates) {
        break;
      }
    }
  }

  const summary: CreatorReportSummary = {
    totalEvaluated: decisions.length,
    totalAdmitted: decisions.filter((d) => d.disposition === "create" || d.disposition === "review").length,
    totalSkipped: decisions.filter((d) => d.disposition === "skip").length,
    categoryBudgetExhausted: countsByDecisionCode["category_budget_exhausted"] ?? 0,
    sourceQualityRejected: countsByDecisionCode["source_quality_rejected"] ?? 0,
    duplicates: countsByDecisionCode["duplicate"] ?? 0,
    globalExposureExceeded: countsByDecisionCode["global_exposure_exceeded"] ?? 0,
    activeMarketCapExceeded: countsByDecisionCode["active_market_cap_exceeded"] ?? 0,
    categoryDisabled: countsByDecisionCode["category_disabled"] ?? 0,
    countsByDecisionCode,
  };

  return {
    timestamp: Date.now(),
    summary,
    decisions,
  };
}

/**
 * Format a human-readable creator report for operator logging and test evidence.
 */
export function formatCreatorReport(report: CreatorReport): string {
  const lines: string[] = [
    `=== Market Creator Run Report (${new Date(report.timestamp).toISOString()}) ===`,
    `Total Evaluated : ${report.summary.totalEvaluated}`,
    `Admitted        : ${report.summary.totalAdmitted}`,
    `Skipped         : ${report.summary.totalSkipped}`,
    `Decision Codes Breakdown:`,
    `  category_budget_exhausted : ${report.summary.categoryBudgetExhausted}`,
    `  source_quality_rejected   : ${report.summary.sourceQualityRejected}`,
    `  duplicate                 : ${report.summary.duplicates}`,
    `  global_exposure_exceeded  : ${report.summary.globalExposureExceeded}`,
    `  active_market_cap_exceeded: ${report.summary.activeMarketCapExceeded}`,
  ];

  if (report.summary.categoryDisabled > 0) {
    lines.push(`  category_disabled         : ${report.summary.categoryDisabled}`);
  }

  lines.push(`Candidate Decisions:`);
  report.decisions.forEach((d, idx) => {
    const limitedInfo = d.exposure.limitedBy ? ` (limitedBy: ${d.exposure.limitedBy})` : "";
    const blockedInfo = d.blockedBy ? ` — ${d.blockedBy}` : "";
    lines.push(`  ${idx + 1}. [${d.decisionCode}] [${d.category}] "${d.question.slice(0, 50)}"${limitedInfo}${blockedInfo}`);
  });

  return lines.join("\n");
}
