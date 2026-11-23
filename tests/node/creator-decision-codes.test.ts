import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCreatorCandidates,
  type ClaimCandidate,
} from "../../agents/market-creator/drafting";
import {
  decideMode,
  type CandidateInput,
  type CreatorPolicy,
} from "../../lib/market-creator/mode-matrix";
import {
  unresolvedCategoryCapPolicy,
  type CategoryCapPolicy,
  type CategoryExposureBucket,
} from "../../lib/market-creator/category-caps";

function makeCategoryCaps(overrides: Partial<CategoryCapPolicy> = {}): CategoryCapPolicy {
  return {
    perCategory: {},
    defaultCap: { maxMarkets: 5, maxExposureUsdc: 100 },
    ...overrides,
  };
}

function makePolicy(overrides: Partial<CreatorPolicy> = {}): CreatorPolicy {
  return {
    maxActiveMarkets: 30,
    maxOpenExposureUsdc: 100,
    minQualityScore: 70,
    shadowMode: false,
    maxPerCategoryPerRun: 2,
    maxPerModePerRun: 3,
    maxPerCreatorPerRun: 3,
    categoryCaps: makeCategoryCaps(),
    ...overrides,
  };
}

function makeModeCandidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    subjectType: "binary",
    category: "crypto",
    availableLiquidityUsdc: 50,
    stakeUsdc: 5,
    openExposureUsdc: 10,
    activeMarkets: 2,
    qualityScore: 85,
    ...overrides,
  };
}

function makeDraftCandidate(overrides: Partial<ClaimCandidate> = {}): ClaimCandidate {
  return {
    question: "Will BTC close above $95,000 by Friday?",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    deadline: "2026-12-01T12:00:00.000Z",
    category: "crypto",
    qualityScore: 85,
    ...overrides,
  };
}

// ── decideMode distinct decision codes ────────────────────────────────────────

test("decideMode separates category_budget_exhausted from source_quality_rejected", () => {
  const qualityDecision = decideMode(
    makeModeCandidate({ qualityScore: 40, categoryOpen: { markets: 5, exposureUsdc: 100 } }),
    "pool",
    makePolicy(),
  );
  assert.equal(qualityDecision.disposition, "skip");
  assert.equal(qualityDecision.decisionCode, "source_quality_rejected");
  assert.equal(qualityDecision.categoryBudgetLimitedBy, undefined);

  const marketCapDecision = decideMode(
    makeModeCandidate({ qualityScore: 85, categoryOpen: { markets: 5, exposureUsdc: 10 } }),
    "pool",
    makePolicy(),
  );
  assert.equal(marketCapDecision.disposition, "skip");
  assert.equal(marketCapDecision.decisionCode, "category_budget_exhausted");
  assert.equal(marketCapDecision.categoryBudgetLimitedBy, "markets");

  const exposureCapDecision = decideMode(
    makeModeCandidate({
      qualityScore: 85,
      stakeUsdc: 5,
      categoryOpen: { markets: 1, exposureUsdc: 96 },
    }),
    "pool",
    makePolicy(),
  );
  assert.equal(exposureCapDecision.disposition, "skip");
  assert.equal(exposureCapDecision.decisionCode, "category_budget_exhausted");
  assert.equal(exposureCapDecision.categoryBudgetLimitedBy, "exposure");
});

test("decideMode preserves exact USDC exposure boundary checks", () => {
  // Exact global exposure cap equality: 95 + 5 === 100 -> allowed
  const exactGlobal = decideMode(
    makeModeCandidate({ openExposureUsdc: 95, stakeUsdc: 5 }),
    "pool",
    makePolicy({ maxOpenExposureUsdc: 100 }),
  );
  assert.equal(exactGlobal.disposition, "create");
  assert.equal(exactGlobal.decisionCode, "approved");

  // 1 USDC over global cap: 96 + 5 > 100 -> exposure_cap_exceeded
  const overGlobal = decideMode(
    makeModeCandidate({ openExposureUsdc: 96, stakeUsdc: 5 }),
    "pool",
    makePolicy({ maxOpenExposureUsdc: 100 }),
  );
  assert.equal(overGlobal.disposition, "skip");
  assert.equal(overGlobal.decisionCode, "exposure_cap_exceeded");

  // Exact category exposure cap equality: 15 + 5 === 20 -> allowed
  const exactCategory = decideMode(
    makeModeCandidate({
      openExposureUsdc: 15,
      stakeUsdc: 5,
      categoryOpen: { markets: 2, exposureUsdc: 15 },
    }),
    "pool",
    makePolicy({
      categoryCaps: makeCategoryCaps({
        perCategory: { crypto: { maxMarkets: 3, maxExposureUsdc: 20 } },
      }),
    }),
  );
  assert.equal(exactCategory.disposition, "create");
  assert.equal(exactCategory.decisionCode, "approved");
});

// ── evaluateCreatorCandidates report ──────────────────────────────────────────

test("evaluateCreatorCandidates reports distinct decision codes across a mixed batch", () => {
  const initialByCategory: Record<string, CategoryExposureBucket> = {
    crypto: { openMarkets: 1, openExposureUsdc: 8, claimIds: [1] },
  };

  const candidates: ClaimCandidate[] = [
    // 1. Accepted: crypto goes from 8 -> 10 USDC (exact cap = 10 USDC).
    makeDraftCandidate({
      question: "Will BTC close above $95,000?",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
      category: "crypto",
      qualityScore: 88,
    }),
    // 2. Rejected: crypto USDC budget exhausted (10 + 2 > 10), NOT source_quality_rejected.
    makeDraftCandidate({
      question: "Will ETH close above $3,500?",
      resolutionUrl: "https://www.coingecko.com/en/coins/ethereum",
      category: "crypto",
      qualityScore: 92,
    }),
    // 3. Rejected: low quality score -> source_quality_rejected.
    makeDraftCandidate({
      question: "Will NYC exceed 25C tomorrow?",
      resolutionUrl: "https://api.open-meteo.com/v1/forecast?city=nyc",
      category: "weather",
      qualityScore: 55,
    }),
    // 4. Rejected: URL not in allowlist -> source_quality_rejected.
    makeDraftCandidate({
      question: "Will Lakers win tonight?",
      resolutionUrl: "https://untrusted.example.com/game/1",
      category: "sports",
      qualityScore: 90,
    }),
    // 5. Rejected: duplicate of candidate #1 -> duplicate_candidate.
    makeDraftCandidate({
      question: "Will BTC close above $95,000?",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
      category: "crypto",
      qualityScore: 88,
    }),
    // 6. Accepted: weather still has budget even though crypto is exhausted.
    makeDraftCandidate({
      question: "Will London exceed 18C tomorrow?",
      resolutionUrl: "https://api.open-meteo.com/v1/forecast?city=london",
      category: "weather",
      qualityScore: 82,
    }),
  ];

  const report = evaluateCreatorCandidates(candidates, {
    stakeUsdc: 2,
    openExposureUsdc: 8,
    maxOpenExposureUsdc: 20,
    categoryCaps: makeCategoryCaps({
      perCategory: {
        crypto: { maxMarkets: 5, maxExposureUsdc: 10 },
        weather: { maxMarkets: 3, maxExposureUsdc: 10 },
      },
    }),
    byCategory: initialByCategory,
    minQualityScore: 70,
    allowedResolutionUrls: [
      "https://www.coingecko.com/en/coins/bitcoin",
      "https://www.coingecko.com/en/coins/ethereum",
      "https://api.open-meteo.com/v1/forecast?city=nyc",
      "https://api.open-meteo.com/v1/forecast?city=london",
    ],
  });

  assert.equal(report.accepted.length, 2);
  assert.equal(report.rejected.length, 4);
  assert.deepEqual(
    report.decisions.map((d) => d.decisionCode),
    [
      "approved",
      "category_budget_exhausted",
      "source_quality_rejected",
      "source_quality_rejected",
      "duplicate_candidate",
      "approved",
    ],
  );
  assert.equal(report.decisions[1]?.limitedBy, "exposure");
  assert.equal(report.summary.sourceQualityRejected, 2);
  assert.equal(report.summary.categoryBudgetExhausted, 1);
  assert.equal(report.summary.duplicateRejected, 1);
  assert.equal(report.summary.exposureCapExceeded, 0);

  // Exact USDC accounting: started at 8, accepted 2 * 2 = 4 -> 12 USDC open, 8 remaining.
  assert.equal(report.openExposureUsdc, 12);
  assert.equal(report.remainingExposureUsdc, 8);
  assert.equal(report.categoryUsage.crypto?.openExposureUsdc, 10);
  assert.equal(report.categoryUsage.weather?.openExposureUsdc, 2);

  // Caller's initialByCategory was not mutated.
  assert.equal(initialByCategory.crypto.openExposureUsdc, 8);
});

test("evaluateCreatorCandidates enforces exact global USDC exposure cap and fail-closed category policies", () => {
  const candidates: ClaimCandidate[] = [
    makeDraftCandidate({ question: "Market A", category: "weather" }),
    makeDraftCandidate({ question: "Market B", category: "sports" }),
  ];

  // Global cap = 10, open = 8, stake = 2 -> Market A fits exactly (10 === 10), Market B exceeds (12 > 10).
  const globalReport = evaluateCreatorCandidates(candidates, {
    stakeUsdc: 2,
    openExposureUsdc: 8,
    maxOpenExposureUsdc: 10,
    categoryCaps: makeCategoryCaps(),
  });
  assert.deepEqual(
    globalReport.decisions.map((d) => d.decisionCode),
    ["approved", "exposure_cap_exceeded"],
  );
  assert.equal(globalReport.openExposureUsdc, 10);
  assert.equal(globalReport.remainingExposureUsdc, 0);

  // Fail-closed invalid category cap policy -> category_cap_invalid.
  const invalidPolicyReport = evaluateCreatorCandidates([candidates[0]!], {
    stakeUsdc: 2,
    openExposureUsdc: 0,
    maxOpenExposureUsdc: 100,
    categoryCaps: unresolvedCategoryCapPolicy("malformed json"),
  });
  assert.equal(invalidPolicyReport.decisions[0]?.decisionCode, "category_cap_invalid");

  // Operational kill switch -> category_disabled.
  const disabledReport = evaluateCreatorCandidates([candidates[0]!], {
    stakeUsdc: 2,
    openExposureUsdc: 0,
    maxOpenExposureUsdc: 100,
    categoryCaps: makeCategoryCaps(),
    isCategoryEnabled: () => false,
  });
  assert.equal(disabledReport.decisions[0]?.decisionCode, "category_disabled");
});
