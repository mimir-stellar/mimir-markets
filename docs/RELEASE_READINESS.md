# Release readiness checklist

Use this checklist before promoting a Mimir release or enabling a funded feature. It is designed to be reproducible from a clean checkout, to keep the chain as the source of truth, and to leave an auditable record without copying secrets into logs or tickets.

Do not mark a gate complete from source inspection alone. Record the command, commit, environment (for example, Stellar Testnet), timestamp, and durable artifact or transaction links for every completed item. If a required artifact is missing, mark the gate **BLOCKED** and keep the relevant feature disabled.

## 1. Prepare a clean candidate

- [ ] Record the release commit, tag or immutable build identifier.
- [ ] Create a fresh checkout at that exact revision.
- [ ] Install dependencies from the lockfile without copying `.env.local`, wallet seeds, API keys, or database credentials into the checkout.
- [ ] Confirm the expected Node and Rust toolchain versions.
- [ ] Confirm the working tree is clean before and after validation.

Run the repository checks that apply to the candidate:

```bash
npm ci
npm run typecheck
npm run check:terms
npm run test:smoke
npm run test:research
npm run test:squad
npm run test:baskets
npm run test:schema
npm run build
npm run test:contracts
```

Do not substitute a live credential or production deployment for a failed local check. Attach the failure and its owner to the release record.

## 2. Review the safety boundary

- [ ] `docs/LAUNCH_GATE_STATUS.md` has been reviewed against the candidate commit.
- [ ] Chain state remains authoritative; Neon is treated only as a read-index cache.
- [ ] XLM is used for ledger fees and reserve; USDC is used for stakes, payouts, and paid-agent transfers.
- [ ] No web or API process receives an agent signing seed.
- [ ] BYOA, copy trading, funded baskets, and other money-moving flags are **off** unless their named approval and evidence are attached.
- [ ] Contract changes have regenerated bindings and updated `lib/contract.ts` where required.
- [ ] The security review and any open critical findings have named owners and a disposition.

## 3. Verify the deployed Testnet contracts

Only run this section against the intended Stellar Testnet deployment. It is read-only until the separate deployment step is explicitly authorized.

- [ ] Build the exact contract artifacts from the release checkout.
- [ ] Run `npm run verify:deployment` with the intended deployment configuration.
- [ ] Confirm RPC health and the Stellar Testnet network passphrase.
- [ ] Confirm market and squad contract IDs, WASM hashes, owner, oracle, USDC SAC, fee policy, and pending fee policy.
- [ ] Record contract IDs, local artifact hashes, ledger sequences, and explorer links.
- [ ] Run `npm run smoke:onchain:full` only when the smoke account and Testnet budget are explicitly approved.
- [ ] Record create, stake/challenge, resolve, refund or payout, and pull-payout transaction links as applicable.
- [ ] Run `npm run smoke:x402` separately and record the payment transaction and verification result.

The verifier and smoke scripts must not be treated as proof of mainnet readiness. Mainnet requires its own network, custody, legal, eligibility, and provider review.

## 4. Check application and worker rollout

- [ ] Confirm the deployment points at the same commit and contract IDs verified above.
- [ ] Confirm redundant Soroban RPC and Horizon providers and their failure behavior.
- [ ] Confirm database migrations are applied before code paths that depend on them.
- [ ] Confirm worker secrets are present only in the worker environment and are not printed by startup, status, or error paths.
- [ ] Confirm oracle source failures, low-confidence results, RPC failures, Telegram failures, and restarts follow the documented fail-closed or loss-tolerant behavior.
- [ ] Confirm monitoring covers request failures, source failures, exposure, payment settlement, worker health, and chain lag.
- [ ] Perform a bounded read-only smoke of the public application and API surfaces.

## 5. Rollback and incident readiness

- [ ] Record the previous known-good application revision and contract configuration.
- [ ] Verify that the previous application revision can be redeployed without changing contract state.
- [ ] Confirm the operator knows which pause controls apply: `MIMIR_PAUSE_RESEARCH`, `MIMIR_PAUSE_X402_BUYING`, `MIMIR_PAUSE_COPY_EXECUTION`, and funded-action controls.
- [ ] Confirm the incident owner can revoke and rotate an operator wallet without exposing or reusing the old seed.
- [ ] Confirm withdrawals and read paths remain available when the affected surface is paused.
- [ ] Run the relevant steps in `docs/AGENT_INCIDENT_RUNBOOK.md` as a tabletop exercise for a funded release.
- [ ] Record the rollback decision, owner, timestamp, and observed recovery evidence.

## 6. Approval record

Copy this table into the release record and replace every `TBD`. A blank cell is not approval.

| Gate | Status | Evidence | Approver / owner | Timestamp |
| --- | --- | --- | --- | --- |
| Clean checkout and automated checks | BLOCKED | TBD | TBD | TBD |
| Safety boundary and feature flags | BLOCKED | TBD | TBD | TBD |
| Testnet deployment verification | BLOCKED | TBD | TBD | TBD |
| On-chain smoke and payment verification | BLOCKED | TBD | TBD | TBD |
| Application and worker rollout | BLOCKED | TBD | TBD | TBD |
| Rollback and incident readiness | BLOCKED | TBD | TBD | TBD |
| Product / legal / eligibility approval | BLOCKED | TBD | TBD | TBD |

Release is **READY** only when every applicable row is `PASS`, each evidence link is immutable or independently reproducible, and no money-moving feature is enabled without its required approval. Otherwise the release is **BLOCKED**.
