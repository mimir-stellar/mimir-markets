# Requirements Document

## Introduction

Mimir's money-moving paths (fee accounting, payout math, USDC formatting, subscription passes, payment revenue tracking, x402 buyer budget enforcement, and agent authorization) must ship with predictable, enforceable test coverage. Currently four source modules have no test files at all, and the CI pipeline has no coverage step — meaning these paths can silently regress with no automated signal. This feature closes that gap: it adds the missing test suites, configures a coverage tool that works with the existing tsx/TypeScript stack and Node built-in test runner, sets per-file thresholds on the money-moving modules, and adds a coverage step to CI that fails the build when thresholds are breached.

All work stays within the existing test infrastructure (Node built-in test runner, `node --import tsx --test`). No new test frameworks are introduced. No production secrets are required at test time.

## Glossary

- **Atomic units**: The smallest representable USDC denomination. On Stellar, 1 USDC = 10,000,000 atomic units (7 decimal places). All accounting in `lib/fees.ts` and `lib/payout.ts` uses `bigint` atomic units exclusively.
- **Conservation invariant**: The property that `sum(payouts) + fees + dust === escrowInflow` holds for every market settlement.
- **c8**: Node.js V8 native coverage reporter. Works with `--import tsx` without a separate instrumentation step. The coverage tool for this feature.
- **Threshold**: A minimum coverage percentage (lines, functions, branches, statements) below which the coverage step exits non-zero.
- **Kill switch**: An environment variable (`MIMIR_PAUSE_X402_BUYING`, `MIMIR_PAUSED_X402_BUYERS`, etc.) that disables a capability without a deployment. Must fail-closed: a paused path is always refused, never passes through.
- **In-memory fallback**: The ring buffer in `lib/paid-revenue.ts` that records up to 1,000 `PaymentEvent` entries when `DATABASE_URL` is unset.
- **PASS_SECRET**: The HMAC key used by `lib/paid-pass.ts` to sign and verify subscription passes. Must never be required at test time; tests inject their own value.
- **Ring buffer**: The `events` array in `lib/paid-revenue.ts` capped at `MAX = 1000`. When the cap is exceeded, the oldest entries are spliced out.
- **PaymentBudgetExceeded**: The error class thrown by `fetchWithBudget` in `lib/x402/buyer.ts` when the cheapest available quote exceeds the caller's `capUnits` limit.
- **StrKey**: Stellar's base32 address encoding. Case-sensitive — `GABC...` and `gabc...` are different and the latter is invalid. No `toLowerCase()` is ever applied to a StrKey in accounting or kill-switch comparisons.
- **Round-trip property**: A correctness property of the form `decode(encode(x)) == x`. Applied to pass signing: `verifyPass(issuePass(payer, plan, ttl).pass, plan)` must return the original claims.

## Requirements

### Requirement 1: USDC Display Formatting Tests (lib/money.ts)

**User Story:** As a maintainer, I want tests for `formatUsdc` and `formatUsdcBare` edge cases, so that display regressions in USDC formatting are caught before they reach users.

#### Acceptance Criteria

1. WHEN `formatUsdc` is called with `NaN`, THE `Money_Formatter` SHALL return `"0 USDC"`.
2. WHEN `formatUsdc` is called with `Infinity` or `-Infinity`, THE `Money_Formatter` SHALL return `"0 USDC"`.
3. WHEN `formatUsdc` is called with `0`, THE `Money_Formatter` SHALL return `"0 USDC"`.
4. WHEN `formatUsdc` is called with a value whose absolute magnitude is less than `0.000001`, THE `Money_Formatter` SHALL return `"<0.000001 USDC"`.
5. WHEN `formatUsdc` is called with a value whose absolute magnitude is between `0.000001` (inclusive) and `1` (exclusive), including negative values such as `-0.5`, THE `Money_Formatter` SHALL return a string ending in `" USDC"` with up to 6 decimal places and no trailing zeros.
6. WHEN `formatUsdc` is called with a value whose absolute magnitude is `1.0` or greater, THE `Money_Formatter` SHALL return a locale-formatted string with exactly 2 decimal places and the sign preserved (e.g., `"-1,234.50 USDC"` for `-1234.5`) followed by `" USDC"`.
7. WHEN `formatUsdc` is called with `1234.5`, THE `Money_Formatter` SHALL return `"1,234.50 USDC"`.
8. WHEN `formatUsdcBare` is called with `1234.5`, THE `Money_Formatter` SHALL return `"1,234.5"` with no trailing zero beyond the natural decimal.
9. WHEN `formatUsdcBare` is called with `1234`, THE `Money_Formatter` SHALL return `"1,234"` with no decimal point.
10. WHEN `formatUsdc` is called with a negative value whose absolute magnitude is less than `0.000001`, THE `Money_Formatter` SHALL return `"<0.000001 USDC"`.
11. WHEN `formatUsdcBare` is called with `NaN` or `Infinity`, THE `Money_Formatter` SHALL return `"0"`.
12. WHEN `formatUsdcBare` is called with a value whose absolute magnitude is less than `0.000001` (e.g., `0.0000001`), THE `Money_Formatter` SHALL return `"0"`.

### Requirement 2: Subscription Pass HMAC Tests (lib/paid-pass.ts)

**User Story:** As a maintainer, I want tests for `issuePass` and `verifyPass`, so that HMAC correctness, expiry enforcement, plan gating, and tamper resistance are all verified before a pass reaches production.

#### Acceptance Criteria

1. WHEN `issuePass` is called with a payer, plan, and positive `ttlMs` of at least 1ms, THEN the `Pass_Service` SHALL return a pass string and an `expiresAt` timestamp that is at least `ttlMs` milliseconds ahead of the current time.
2. WHEN `verifyPass` is called with a valid, unexpired pass and the matching plan, THEN the `Pass_Service` SHALL return a `PassClaims` object whose `payer` equals the lowercased input payer, `plan` matches the issued plan, and `exp` matches the issued `expiresAt` value.
3. WHEN `verifyPass` is called with a pass produced by `issuePass(payer, plan, ttl)` using the same plan, THEN the `Pass_Service` SHALL return a non-null result whose `payer` equals the lowercased input payer and whose `plan` equals the issued plan.
4. WHEN `verifyPass` is called with a pass whose `ttlMs` has elapsed, THEN the `Pass_Service` SHALL return `null`.
5. WHEN `verifyPass` is called with a pass for plan `"premium"` but verified against plan `"council"`, THEN the `Pass_Service` SHALL return `null`.
6. WHEN `verifyPass` is called with a token whose MAC portion has been altered by a single character, THEN the `Pass_Service` SHALL return `null`.
7. WHEN `verifyPass` is called with a token whose body has been modified after signing, THEN the `Pass_Service` SHALL return `null`.
8. WHEN `verifyPass` is called with `null` or `undefined`, THEN the `Pass_Service` SHALL return `null`.
9. WHEN `issuePass` is called without `PASS_SECRET` set in the environment, THEN the `Pass_Service` SHALL throw an error.
10. WHERE `PASS_SECRET` is set to a non-empty test value in the process environment before a test runs, THEN `issuePass` SHALL return a non-null pass string without throwing, and `verifyPass` called with that pass SHALL return a non-null `PassClaims` object.

### Requirement 3: In-Memory Revenue Ledger Tests (lib/paid-revenue.ts)

**User Story:** As a maintainer, I want tests for `recordPayment` and `getRevenueSummary` in-memory fallback path, so that the revenue ledger's idempotency, ring-buffer eviction, and aggregation are verified without a database.

#### Acceptance Criteria

1. WHEN `recordPayment` is called with a `PaymentEvent`, THEN the `Revenue_Ledger` SHALL include that event in the next `getRevenueSummary` result without requiring `DATABASE_URL`.
2. WHEN `recordPayment` is called twice with the same `paymentIdentifier`, THEN the `Revenue_Ledger` SHALL count it as one event, not two (idempotency).
3. WHEN `recordPayment` is called with N events sharing the same `paymentIdentifier` and M events with unique identifiers, THEN `getRevenueSummary().totalCalls` SHALL equal `M + 1` (one entry per unique identifier).
4. WHEN more than 1,000 payment events are recorded, THEN the `Revenue_Ledger` SHALL retain only the 1,000 most recent events, discarding the oldest (earliest recorded) entries first.
5. WHEN `getRevenueSummary` is called after recording events for multiple resources, THEN the `Revenue_Ledger` SHALL return a `byResource` array where each entry's `calls` count equals the number of events recorded for that resource.
6. WHEN `getRevenueSummary` is called after recording events for multiple sellers, THEN the `Revenue_Ledger` SHALL return a `bySeller` array where each entry's `usdc` equals the sum of each event's `amountAtomic` divided by `10,000,000` (10^7, the Stellar USDC decimal divisor) for that seller.
7. WHEN `PAYMENTS_BASELINE_CALLS` and `PAYMENTS_BASELINE_USDC` are set to positive numeric strings, THEN `getRevenueSummary` SHALL add those values to `totalCalls` and `totalUsdc` respectively.
8. WHEN `PAYMENTS_BASELINE_CALLS` is unset, set to `"0"`, or set to a non-positive value, THEN `getRevenueSummary` SHALL report `baselineCalls` as `0`.
9. IF `DATABASE_URL` is unset, THEN `getRevenueSummary` SHALL return an in-memory summary and SHALL NOT throw.
10. WHEN `recordPayment` encounters an error in its durable write, THEN the `Revenue_Ledger` SHALL retain the event in the in-memory buffer and return the in-memory summary without rethrowing the error.

### Requirement 4: x402 Buyer Budget Cap and Kill Switch Tests (lib/x402/buyer.ts)

**User Story:** As a maintainer, I want tests for `assertX402BuyingEnabled` and the budget enforcement in `fetchWithBudget`, so that the kill-switch fail-closed behavior and over-budget refusal are verified and cannot silently regress.

#### Acceptance Criteria

1. WHEN `assertX402BuyingEnabled` is called for a wallet address that appears in `MIMIR_PAUSED_X402_BUYERS`, THEN the `X402_Buyer` SHALL throw an error matching `/paused/`.
2. WHEN `assertX402BuyingEnabled` is called for a wallet address not in `MIMIR_PAUSED_X402_BUYERS`, THEN the `X402_Buyer` SHALL not throw.
3. WHEN `MIMIR_PAUSE_X402_BUYING` is set to `"1"`, THEN `assertX402BuyingEnabled` SHALL throw an error matching `/paused/` for any address.
4. WHEN a Stellar StrKey address is added to `MIMIR_PAUSED_X402_BUYERS` in lowercase, THEN `assertX402BuyingEnabled` called with the correctly-cased StrKey SHALL NOT throw, because a lowercased StrKey is a distinct invalid string and does not match the correctly-cased address.
5. WHEN `fetchWithBudget` encounters a 402 response whose cheapest quote on `X402_NETWORK` exceeds `capUnits`, THEN the `X402_Buyer` SHALL throw `PaymentBudgetExceeded` whose `priceUnits` property equals the cheapest quote amount and whose `capUnits` property equals the caller's cap.
6. WHEN `fetchWithBudget` encounters a 402 response whose `network` field on every entry does not match `X402_NETWORK`, THEN the `X402_Buyer` SHALL throw an error that is not `PaymentBudgetExceeded`, and no payment payload SHALL be created.
7. WHEN `fetchWithBudget` encounters a 402 response with a quote on `X402_NETWORK` whose amount is at or below `capUnits`, THEN the `X402_Buyer` SHALL NOT throw `PaymentBudgetExceeded` and SHALL proceed to the payment step.
8. WHEN `fetchWithBudget` is called with a `capUnits` value strictly less than all available quotes on `X402_NETWORK`, THEN the `X402_Buyer` SHALL throw `PaymentBudgetExceeded`.
9. WHEN `createPayingFetch` is called for a wallet address that appears in `MIMIR_PAUSED_X402_BUYERS`, THEN the `X402_Buyer` SHALL throw an error matching `/paused/` before returning the wrapped fetch function.
10. WHEN `PaymentBudgetExceeded` is thrown, THEN its `priceUnits` property SHALL equal the cheapest quote on `X402_NETWORK` and its `capUnits` property SHALL equal the value passed by the caller.

### Requirement 5: Coverage Tooling Configuration

**User Story:** As a maintainer, I want c8 coverage configured with per-file thresholds for money-moving modules, so that coverage drops on critical paths fail the build automatically.

#### Acceptance Criteria

1. THE `Coverage_Tool` SHALL be invocable via `npm run test:coverage` from a clean checkout that has no `.env` or `.env.local` file, with `c8` present in `devDependencies` so `npm ci` installs it.
2. THE `Coverage_Tool` SHALL use c8 (V8 native coverage) so that no additional instrumentation beyond the existing `node --import tsx` flag is required.
3. WHEN `npm run test:coverage` runs, THE `Coverage_Tool` SHALL restrict instrumentation to `lib/fees.ts`, `lib/payout.ts`, `lib/money.ts`, `lib/paid-pass.ts`, `lib/paid-revenue.ts`, `lib/x402/buyer.ts`, `lib/agents/registry.ts`, and `lib/agents/spend-permissions.ts`.
4. WHEN the line coverage of any module listed in criterion 3 falls below 80%, THE `Coverage_Tool` SHALL exit non-zero.
5. WHEN the branch coverage of any module listed in criterion 3 falls below 70%, THE `Coverage_Tool` SHALL exit non-zero.
6. WHEN all thresholds are met, THE `Coverage_Tool` SHALL exit zero so the CI step passes.
7. THE `Coverage_Tool` configuration SHALL be expressed in a `.c8rc` file at the workspace root, and `c8` SHALL be listed in `devDependencies` in `package.json`, so both threshold values and the dependency are visible in code review.
8. THE `Coverage_Tool` SHALL exclude `tests/**`, `scripts/**`, `agents/**` (top-level agent runners, not `lib/agents/`), and `app/**` from threshold enforcement so only the `lib/` modules are gated. `lib/agents/registry.ts` and `lib/agents/spend-permissions.ts` SHALL remain included.
9. WHEN `npm run test:coverage` completes, THE `Coverage_Tool` SHALL emit a text-summary report to stdout and an lcov report to `coverage/lcov.info` for CI artifact consumption.

### Requirement 6: CI Coverage Step

**User Story:** As a maintainer, I want a coverage step in CI that runs after the existing smoke tests, so that coverage regressions are caught on every pull request without breaking any existing CI steps.

#### Acceptance Criteria

1. WHEN a pull request is opened or updated, THE `CI_Pipeline` SHALL run a step named `test:coverage` that executes `npm run test:coverage`, positioned immediately after the `npm run test:smoke` step.
2. WHEN `npm run test:coverage` exits non-zero, THE `CI_Pipeline` SHALL mark the `verify` job as failed, which blocks merge on the pull request.
3. WHEN `npm run test:coverage` exits zero, THE `CI_Pipeline` SHALL continue to the `npm run build` step without interruption.
4. THE `CI_Pipeline` coverage step SHALL NOT require `PASS_SECRET`, `DATABASE_URL`, or any `STELLAR_*` or `ANTHROPIC_API_KEY` environment variable. `PASS_SECRET` MAY be set to any non-empty test value within the step if the test suite requires it, without using a production secret.
5. THE `CI_Pipeline` coverage step SHALL be added as a `run` step within the existing `verify` job, reusing the Node 22 setup and `npm ci` cache, without introducing a new job or a separate runner.
6. IF the coverage step is added after `test:smoke`, THEN all steps that were green before this change — `npm audit`, `check:terms`, `typecheck`, `test:contracts`, `cargo build`, and `build` — SHALL remain green.

### Requirement 7: Maintainer Documentation Update

**User Story:** As a contributor, I want the contributing or README documentation updated to describe the coverage workflow, so that I understand how to run coverage locally and what thresholds I need to keep green.

#### Acceptance Criteria

1. THE `Documentation` in `README.md` SHALL contain a section titled "Running tests & coverage" that describes `npm run test:coverage`, names the 8 covered modules, and states that no production secrets are needed to run it.
2. THE `Documentation` SHALL list the enforced threshold values: 80% lines and 70% branches per money-moving module, so contributors know exactly what must stay green.
3. THE `Documentation` SHALL state that `PASS_SECRET` must be set to any non-empty string when running `lib/paid-pass.ts` tests locally (e.g. `PASS_SECRET=test npm run test:coverage`), and that no production value is required.
4. THE `Documentation` SHALL note that `DATABASE_URL` is not required — the in-memory fallback is the default test path and the CI step does not set it.
5. WHEN any of the following observable changes occur — a new environment variable becomes required, the `npm run test:coverage` command is renamed or removed, or a step is added or reordered in `.github/workflows/ci.yml` — THEN the `README.md` "Running tests & coverage" section SHALL be updated in the same pull request as the code change.
