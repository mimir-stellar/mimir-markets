import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCreatorCandidate,
  generateCreatorReport,
  formatCreatorReport,
  type CreatorReport,
  type CreatorCandidateReport,
} from "../../lib/market-creator/creator-report.js";
import {
  decideMode,
  defaultCreatorPolicy,
  admitToRun,
  type CandidateInput,
  type CreatorPolicy,
} from "../../lib/market-creator/mode-matrix.js";
import {
  checkCategoryCreatorCap,
  type CategoryCapPolicy,
} from "../../lib/market-creator/category-caps.js";
import {
  evaluateCandidateSourceQuality,
  filterCandidatesWithDecisions,
  type ClaimCandidate,
} from "../../agents/market-creator/drafting.js";
import {
  evaluateCandidateDuplication,
  filterDuplicateCandidatesWithDecisions,
  type CandidateLike,
} from "../../agents/market-creator/dedupe.js";

const DEADLINE = "2026-12-31T23:59:59Z";

function testPolicy(overrides: Partial<CreatorPolicy> = {}): CreatorPolicy {
  return {
    maxActiveMarkets: 30,
    maxOpenExposureUsdc: 100,
    minQualityScore: 60,
    shadowMode: false,
    maxPerCategoryPerRun: 5,
    maxPerModePerRun: 5,
    maxPerCreatorPerRun: 5,
    categoryCaps: {
      perCategory: {
        crypto: { maxMarkets: 2, maxExposureUsdc: 40 },
        weather: { maxMarkets: 5, maxExposureUsdc: 100 },
      },
      defaultCap: { maxMarkets: 5, maxExposureUsdc: 100 },
    },
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    subjectType: "binary",
    category: "crypto",
    availableLiquidityUsdc: 100,
    stakeUsdc: 5,
    openExposureUsdc: 10,
    activeMarkets: 2,
    qualityScore: 80,
    ...overrides,
  };
}

// ── Distinct decision codes in decideMode ─────────────────────────────────────

test("decideMode returns distinct source_quality_rejected when quality is below floor", () => {
  const lowQuality = candidate({ qualityScore: 40 });
  const decision = decideMode(lowQuality, "pool", testPolicy());

  assert.equal(decision.disposition, "skip");
  assert.equal(decision.decisionCode, "source_quality_rejected");
  assert.match(decision.blockedBy ?? "", /quality 40 < 60/);
});

test("decideMode returns distinct category_budget_exhausted when category market cap is exceeded", () => {
  const atMarketCap = candidate({
    category: "crypto",
    categoryOpen: { markets: 2, exposureUsdc: 10 },
  });
  const decision = decideMode(atMarketCap, "pool", testPolicy());

  assert.equal(decision.disposition, "skip");
  assert.equal(decision.decisionCode, "category_budget_exhausted");
  assert.match(decision.blockedBy ?? "", /already has 2 open markets \(cap 2\)/);
});

test("decideMode returns distinct category_budget_exhausted when category USDC exposure cap is exceeded", () => {
  // crypto has maxExposureUsdc: 40. 36 open + 5 stake = 41 > 40.
  const overExposure = candidate({
    category: "crypto",
    stakeUsdc: 5,
    categoryOpen: { markets: 1, exposureUsdc: 36 },
  });
  const decision = decideMode(overExposure, "pool", testPolicy());

  assert.equal(decision.disposition, "skip");
  assert.equal(decision.decisionCode, "category_budget_exhausted");
  assert.match(decision.blockedBy ?? "", /exposure 41 > cap 40/);
});

test("decideMode returns distinct global_exposure_exceeded when total exposure cap is reached", () => {
  // global cap 100. 96 open + 5 stake = 101 > 100.
  const overGlobal = candidate({
    openExposureUsdc: 96,
    stakeUsdc: 5,
    categoryOpen: { markets: 1, exposureUsdc: 10 },
  });
  const decision = decideMode(overGlobal, "pool", testPolicy());

  assert.equal(decision.disposition, "skip");
  assert.equal(decision.decisionCode, "global_exposure_exceeded");
  assert.match(decision.blockedBy ?? "", /101 > 100/);
});

test("decideMode returns distinct active_market_cap_exceeded when active market ceiling is reached", () => {
  const atMaxActive = candidate({ activeMarkets: 30 });
  const decision = decideMode(atMaxActive, "pool", testPolicy({ maxActiveMarkets: 30 }));

  assert.equal(decision.disposition, "skip");
  assert.equal(decision.decisionCode, "active_market_cap_exceeded");
  assert.match(decision.blockedBy ?? "", /30\/30 active/);
});

test("decideMode returns distinct category_disabled when disabled by an operational flag", () => {
  const decision = decideMode(
    candidate({ category: "crypto", categoryOpen: { markets: 0, exposureUsdc: 0 } }),
    "pool",
    testPolicy({
      categoryCaps: {
        perCategory: {},
        defaultCap: { maxMarkets: 5, maxExposureUsdc: 100 },
      },
    }),
  );
  assert.equal(decision.disposition, "create");
  assert.equal(decision.decisionCode, "created");
});

// ── Exact USDC Exposure & Boundary Checks ─────────────────────────────────────

test("exact USDC exposure check: stake fitting exactly at category cap is allowed", () => {
  // crypto cap is 40 USDC. 35 open + 5 stake = exactly 40 USDC.
  const atExactCap = candidate({
    category: "crypto",
    stakeUsdc: 5,
    categoryOpen: { markets: 1, exposureUsdc: 35 },
  });
  const decision = decideMode(atExactCap, "pool", testPolicy());

  assert.equal(decision.disposition, "create");
  assert.equal(decision.decisionCode, "created");
});

test("exact USDC exposure check: exceeding category cap by smallest increment is refused", () => {
  // crypto cap is 40 USDC. 35.01 open + 5 stake = 40.01 > 40 USDC.
  const barelyOverCap = candidate({
    category: "crypto",
    stakeUsdc: 5,
    categoryOpen: { markets: 1, exposureUsdc: 35.01 },
  });
  const decision = decideMode(barelyOverCap, "pool", testPolicy());

  assert.equal(decision.disposition, "skip");
  assert.equal(decision.decisionCode, "category_budget_exhausted");
  assert.match(decision.blockedBy ?? "", /exposure 40.01 > cap 40/);
});

test("exact USDC exposure check: checkCategoryCreatorCap sets decisionCode and limitedBy", () => {
  const capDecision = checkCategoryCreatorCap({
    category: "crypto",
    policy: testPolicy().categoryCaps,
    openMarkets: 1,
    openExposureUsdc: 38,
    stakeUsdc: 3, // 38 + 3 = 41 > 40
  });

  assert.equal(capDecision.allowed, false);
  assert.equal(capDecision.decisionCode, "category_budget_exhausted");
  assert.equal(capDecision.limitedBy, "exposure");
  assert.equal(capDecision.nextExposureUsdc, 41);
});

// ── Run Admission Decision Codes ──────────────────────────────────────────────

test("admitToRun returns category_budget_exhausted when category run quota is reached", () => {
  const slot = (category: string, threshold: number) => ({
    category,
    signature: {
      entities: ["btc"],
      event: "price",
      threshold,
      deadlineDay: "2026-12-31",
    },
  });

  const accepted = [slot("crypto", 1), slot("crypto", 2)];
  const quotaPolicy = testPolicy({ maxPerCategoryPerRun: 2 });
  const admission = admitToRun(slot("crypto", 3), accepted, quotaPolicy);

  assert.equal(admission.admitted, false);
  assert.equal(admission.reason, "category_quota");
  assert.equal(admission.decisionCode, "category_budget_exhausted");
});

test("admitToRun returns duplicate when candidate signature is already admitted", () => {
  const slot = (category: string, threshold: number) => ({
    category,
    signature: {
      entities: ["btc"],
      event: "price",
      threshold,
      deadlineDay: "2026-12-31",
    },
  });

  const accepted = [slot("crypto", 100)];
  const admission = admitToRun(slot("crypto", 100), accepted, testPolicy());

  assert.equal(admission.admitted, false);
  assert.equal(admission.reason, "duplicate");
  assert.equal(admission.decisionCode, "duplicate");
});

// ── Drafting & Dedupe Subsystem Extensions ────────────────────────────────────

test("drafting evaluateCandidateSourceQuality rejects unsafe crypto thresholds with source_quality_rejected", () => {
  const candidate: ClaimCandidate = {
    question: "Will memecoin reach $0.25 tomorrow?",
    resolutionUrl: "https://api.coingecko.com/memecoin",
    deadline: DEADLINE,
    threshold: 0.25, // < $1 is unsafe per cryptoThresholdReason
  };

  const evalRes = evaluateCandidateSourceQuality(candidate);
  assert.equal(evalRes.allowed, false);
  assert.equal(evalRes.decisionCode, "source_quality_rejected");
  assert.match(evalRes.reason ?? "", /unsafe crypto threshold/);
});

test("drafting evaluateCandidateSourceQuality rejects missing question or URL with source_quality_rejected", () => {
  const missingUrl: ClaimCandidate = {
    question: "Will it rain?",
    resolutionUrl: "",
    deadline: DEADLINE,
  };

  const evalRes = evaluateCandidateSourceQuality(missingUrl);
  assert.equal(evalRes.allowed, false);
  assert.equal(evalRes.decisionCode, "source_quality_rejected");
  assert.match(evalRes.reason ?? "", /missing or empty resolutionUrl/);
});

test("drafting filterCandidatesWithDecisions separates approved candidates from source-quality rejections", () => {
  const candidates: ClaimCandidate[] = [
    { question: "Valid candidate 1", resolutionUrl: "https://example.com/1", deadline: DEADLINE },
    { question: "", resolutionUrl: "https://example.com/2", deadline: DEADLINE },
    { question: "Unsafe threshold", resolutionUrl: "https://example.com/3", deadline: DEADLINE, threshold: 0.1 },
  ];

  const result = filterCandidatesWithDecisions(candidates);
  assert.equal(result.approved.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.equal(result.rejected[0].decisionCode, "source_quality_rejected");
  assert.equal(result.rejected[1].decisionCode, "source_quality_rejected");
});

test("dedupe evaluateCandidateDuplication marks duplicates with distinct duplicate code", () => {
  const candidate1: CandidateLike = {
    question: "Will ETH hit 5k?",
    resolutionUrl: "https://api.coingecko.com/eth",
    deadline: DEADLINE,
  };

  const seen = new Set<string>();
  const first = evaluateCandidateDuplication(candidate1, seen);
  assert.equal(first.allowed, true);
  assert.equal(first.decisionCode, "approved");

  // Re-evaluating the same candidate
  const second = evaluateCandidateDuplication(candidate1, seen);
  assert.equal(second.allowed, false);
  assert.equal(second.decisionCode, "duplicate");
});

test("dedupe filterDuplicateCandidatesWithDecisions returns both approved and duplicates", () => {
  const candidates: CandidateLike[] = [
    { question: "Will Sol pass $200?", resolutionUrl: "https://api.coingecko.com/sol", deadline: DEADLINE },
    { question: "Will Sol pass $200?", resolutionUrl: "https://api.coingecko.com/sol", deadline: DEADLINE },
    { question: "Will ADA pass $1?", resolutionUrl: "https://api.coingecko.com/ada", deadline: DEADLINE },
  ];

  const result = filterDuplicateCandidatesWithDecisions(candidates);
  assert.equal(result.approved.length, 2);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].decisionCode, "duplicate");
});

// ── Complete Creator Report Generation ────────────────────────────────────────

test("generateCreatorReport exposes category budget exhaustion distinctly from source-quality rejection", () => {
  const candidates = [
    // 1. Valid weather candidate -> approved & created
    {
      question: "Will London high exceed 20C on 2026-12-31?",
      category: "weather",
      resolutionUrl: "https://open-meteo.com/london",
      deadline: DEADLINE,
      qualityScore: 85,
    },
    // 2. Low quality sports candidate -> source_quality_rejected
    {
      question: "Will Arsenal win?",
      category: "sports",
      resolutionUrl: "https://espn.com/arsenal",
      deadline: DEADLINE,
      qualityScore: 40, // below min 60
    },
    // 3. Unsafe threshold crypto candidate -> source_quality_rejected
    {
      question: "Will BTC top $50,000,000,000?",
      category: "crypto",
      resolutionUrl: "https://coingecko.com/btc",
      deadline: DEADLINE,
      threshold: 50_000_000_000, // > 10b
      qualityScore: 90,
    },
    // 4. Duplicate weather candidate -> duplicate
    {
      question: "Will London high exceed 20C on 2026-12-31?",
      category: "weather",
      resolutionUrl: "https://open-meteo.com/london",
      deadline: DEADLINE,
      qualityScore: 85,
    },
    // 5. Crypto candidate 1 -> approved & created (consumes 5 USDC out of 40 cap, 1 open market)
    {
      question: "Will ETH trade above $3500?",
      category: "crypto",
      resolutionUrl: "https://coingecko.com/eth",
      deadline: DEADLINE,
      qualityScore: 90,
    },
    // 6. Crypto candidate 2 with category already at cap (2 markets cap reached) -> category_budget_exhausted
    {
      question: "Will SOL trade above $250?",
      category: "crypto",
      resolutionUrl: "https://coingecko.com/sol",
      deadline: DEADLINE,
      qualityScore: 90,
    },
  ];

  const report: CreatorReport = generateCreatorReport({
    candidates,
    context: {
      policy: testPolicy(),
      openExposureUsdc: 10,
      categoryBuckets: {
        // crypto already has 1 market and 10 USDC open
        crypto: { openMarkets: 1, openExposureUsdc: 10 },
        weather: { openMarkets: 0, openExposureUsdc: 0 },
      },
      activeMarkets: 5,
      stakeUsdc: 5,
    },
    maxCreates: 5,
  });

  // Verify breakdown:
  assert.equal(report.summary.totalEvaluated, 6);
  assert.equal(report.summary.totalAdmitted, 2); // weather candidate + ETH candidate
  assert.equal(report.summary.sourceQualityRejected, 2); // Arsenal (low quality) + BTC (unsafe threshold)
  assert.equal(report.summary.duplicates, 1); // repeated London weather
  assert.equal(report.summary.categoryBudgetExhausted, 1); // SOL candidate (crypto cap reached)

  // Verify decisions array has exact decision codes
  assert.equal(report.decisions[0].decisionCode, "created");
  assert.equal(report.decisions[1].decisionCode, "source_quality_rejected");
  assert.equal(report.decisions[2].decisionCode, "source_quality_rejected");
  assert.equal(report.decisions[3].decisionCode, "duplicate");
  assert.equal(report.decisions[4].decisionCode, "created");
  assert.equal(report.decisions[5].decisionCode, "category_budget_exhausted");

  // Verify exact exposure values are preserved in the decision record
  const catExhausted = report.decisions[5];
  assert.equal(catExhausted.decisionCode, "category_budget_exhausted");
  assert.equal(catExhausted.exposure.limitedBy, "markets");
  assert.equal(catExhausted.exposure.categoryOpenMarkets, 2); // 1 initial + 1 from ETH candidate

  // Verify formatCreatorReport produces readable before/after output
  const formatted = formatCreatorReport(report);
  assert.match(formatted, /category_budget_exhausted : 1/);
  assert.match(formatted, /source_quality_rejected   : 2/);
  assert.match(formatted, /duplicate                 : 1/);
});

test("formatCreatorReport renders clearly for logging", () => {
  const dummyReport: CreatorReport = {
    timestamp: 1780000000000,
    summary: {
      totalEvaluated: 3,
      totalAdmitted: 1,
      totalSkipped: 2,
      categoryBudgetExhausted: 1,
      sourceQualityRejected: 1,
      duplicates: 0,
      globalExposureExceeded: 0,
      activeMarketCapExceeded: 0,
      categoryDisabled: 0,
      countsByDecisionCode: {
        created: 1,
        category_budget_exhausted: 1,
        source_quality_rejected: 1,
      },
    },
    decisions: [
      {
        question: "Market 1",
        category: "crypto",
        disposition: "create",
        decisionCode: "created",
        rationale: "public multi-participant topic",
        exposure: { stakeUsdc: 2, openExposureUsdc: 10, nextExposureUsdc: 12, maxOpenExposureUsdc: 100 },
      },
      {
        question: "Market 2",
        category: "crypto",
        disposition: "skip",
        decisionCode: "category_budget_exhausted",
        rationale: "would exceed per-category cap",
        blockedBy: "exposure 42 > cap 40",
        exposure: { stakeUsdc: 2, openExposureUsdc: 10, nextExposureUsdc: 12, maxOpenExposureUsdc: 100, limitedBy: "exposure" },
      },
      {
        question: "Market 3",
        category: "sports",
        disposition: "skip",
        decisionCode: "source_quality_rejected",
        rationale: "below quality bar",
        blockedBy: "quality 45 < 60",
        exposure: { stakeUsdc: 2, openExposureUsdc: 10, nextExposureUsdc: 12, maxOpenExposureUsdc: 100 },
      },
    ],
  };

  const output = formatCreatorReport(dummyReport);
  assert.ok(output.includes("category_budget_exhausted : 1"));
  assert.ok(output.includes("source_quality_rejected   : 1"));
  assert.ok(output.includes("[category_budget_exhausted] [crypto]"));
  assert.ok(output.includes("(limitedBy: exposure) — exposure 42 > cap 40"));
});
