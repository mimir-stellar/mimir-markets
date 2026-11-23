# Copy executor threat model

- Compromised executor key: it cannot raise signed limits, change token/spender,
  bypass the on-chain USDC allowance, or act after immediate revoke/global pause.
- Replay: permission/source-position uniqueness and execution IDs make a repeated
  signal a skip. Nonces protect signed API requests.
- Frontrun/race: the executor re-reads deadline, slots, liquidity, payout and
  allowance, then simulates against Soroban RPC at a recorded ledger immediately
  before submission.
- Stale odds: payout below the signed floor or an expired deadline is skipped.
- Copy loop: source depth is capped at one; self-copy and ancestry cycle checks
  reject A→B→A. Signal and execution agent IDs remain separate.
- Fee loop: one immutable `sourceAttributionId` follows the original signal.
  Downstream copies do not mint new fee ancestry, and recipient transfers are not
  interpreted as additional revenue.
- Changed spender: v1 permissions allow only the configured deployed Mimir contract
  id. A different `C…` target requires a new, visibly signed permission; UI/database
  allowlists alone are insufficient.
- Address fidelity: `G…`/`C…` strkeys are case-sensitive base32, so the token and
  spender are compared exactly. A `toLowerCase()` normalisation would silently
  break the match — and an allowlist written the wrong way round would break it
  *open*.
- Allowance shape: the on-chain leg is the USDC Stellar Asset Contract's SEP-41
  `approve(from, spender, amount, expiration_ledger)` — a single decreasing bucket
  with an expiry, which does not refresh. The rolling-period budget the follower
  actually signed for is Mimir's own accounting on top; both must pass, so
  exceeding either is a skip.
- Simultaneous signals: `tests/node/copy-permission-fixtures.ts` models a batch as
  one shared preview snapshot followed by a stable claim-id-ordered execution pass.
  Every execution re-reads usage, claim ids, allowance and revocation from a
  temporary state directory, so a preview can never be replayed as approval and two
  signals cannot both spend the same signed budget.
- Revocation between preview and execution: the fixture applies an owner-signed
  `copyRevokeMessage` before the execution pass (or from an `afterExecution` hook)
  and expects `permission_revoked`, not a stale preview verdict. A revocation is a
  separate signed lifecycle action; it does not re-sign the economic policy, so the
  fixture checks the policy hash with `status` normalised to `active`.
- Policy integrity: before each execution the fixture recomputes the active-form
  `signedPolicyHash`. A mutated cap, allowance or allowlist fails closed with
  `policy_hash_mismatch` before any stake is reserved. Every executed row records
  that hash, and the fixture's invariant check re-derives atomic 7-decimal USDC
  caps from the signed policy and the decreasing on-chain allowance.

- Pre-signature review digest: before owner signing, `POST /api/copy/permissions/review`
  (backed by `buildCopyPermissionReviewDigest` in `lib/copy-trading.ts`) exposes a
  canonical SHA-256 `reviewDigest` binding the execution/signal agents, allowed
  categories/modes, thresholds, expiry, and every spending limit (per-position, daily,
  weekly, open-exposure, realized-loss, and delegated spend permission). Submitting a
  signed grant to `POST /api/copy/permissions` with `reviewDigest` re-verifies the
  digest via `verifyCopyPermissionReviewDigest` and rejects with `409 review_digest_mismatch`
  if any bound field changed between review and signature.

Every decision writes source position, permission, simulation ledger, attribution,
stake, fee lines, tx hash and status/skip reason to the audit ledger.

- Allowance reconciliation: `lib/copy-allowance-reconciliation.ts` compares the
  owner-signed copy policy, the authoritative Soroban SAC allowance (and
  optional `SpendPermissionRecord`), and observed rolling consumption to emit a
  read-only discrepancy report (`mode: "read_only"`, `remediationApplied: false`)
  before any remediation action is taken. Malformed or non-atomic inputs fail
  closed with a `malformed_input` critical discrepancy.
