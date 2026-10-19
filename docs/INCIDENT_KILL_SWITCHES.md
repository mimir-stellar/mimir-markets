# Incident kill switches

Every switch in `lib/ops/flags.ts` → `PAUSABLE`, where it is enforced, and what an
operator should expect when it is flipped. For the step-by-step response to a compromised agent key, see [`AGENT_INCIDENT_RUNBOOK.md`](AGENT_INCIDENT_RUNBOOK.md).

## The switches

Set `MIMIR_PAUSE_<CAPABILITY>=1` to pause one capability, or `MIMIR_PAUSE_ALL=1` to
pause every one of them. Only the exact value `1` pauses; `true`, `yes` or a typo is a no-op. Optional: `MIMRR_PAUSE_<CAPABILITY_REASON`, or `MIMIR_PAUSE_REASON`) for all of them, is shown to callers in place of the default message.

| Capability | Enforced at | Stops | Keeps running |
| --- | --- | --- | --- |
| `create_market` | `createClaim`, `createRematch`, `createSquadMarket` (`lib/contract.ts`); agent API `createMarket` | New binary markets, rematches and squad pools, including the demo relay and the market-creator worker | Staking into existing markets, settlement, cancel, withdraw |
| `stake` | `challengeClaim`, `squadDeposit` (`lib/contract.ts`); agent API `stake`, `vote` | Every new position: browser, demo relay, oracle auto-challenge, council and trader personas | Creating markets, settlement, payouts, withdraw |
| `oracle_settlement` | `resolveClaim` (`lib/contract.ts`); the oracle poll skips its settle loop | Resolution of expired markets. The oracle also stops researching and calling the LLM for them | Oracle auto-challenge (governed by `stake`), payouts of markets that are already resolved, withdraw |
| `copy_execution` | `evaluateCopy` (`lib/copy-trading.ts`), which reads the switch itself | Every copied position (skip reason `global_paused`) | Creating and revoking copy permissions |
| `x402_selling` | `paidRoute` via `lib/x402/kill-switch.ts` | Paid endpoints answer `503` with `Retry-After: 60` rather than `402` | Free endpoints, council-pass requests |
| `x402_buying` | `assertX402BuyingEnabled` (`lib/x402/buyer.ts`) | Agent purchases, refused before a paying client is built. `MIMIR_PAUSED_X402_BUYERS` pauses individual `G` wallets | Callers treat a refused purchase as missing input and carry on without it |
| `research` | `gatewayFetch` (`lib/research/gateway.ts`) | Outbound source fetches. `RESEARCH_PAUSED_AGENT_IDs` pauses individual agents | Cached results already fetched |
| `agent_registration` | Agent API `register` | New BYOA registrations | Every call by already-registered agents |
| `market_creator_worker` | `reportingPoll` in `agents/market-creator` | The whole creation cycle | The process itself, plus its heartbeat |
| `council_worker` | `reportingPoll` in `agents/council` | The whole persona cycle | The process itself, plus its heartbeat |

**No switch on purpose:** `withdraw`, `claimChallengerPayout`, `claimFees`,
`squadClaim`, `squadWithdrawBeforeDeadline`, `cancelClaim`, every read path, and the
agent API's `revoke`, `revokeKey`, `revokeSpend`, `dryRun`, `proposeMarket` and
`heartbeat`. Users can always pull funds out, and owners can always contain a
 compromised agent, including during the incident that paused everything else.

## Behavior

- `cron_calls` (default enabled). Set `MIMIR_PAUSE_CRON_CALLS=1` to pause the
  scheduled cron endpoints (`api/cron/*`). Unlike the other switches, this one fails
  closed on authorization before it ever reaches the pause check: a cron request
  with a missing, malformed, stale, duplicated, expired or unknown credential is
  rejected with `401` and never runs the job. The check is constant-time and
  does not leak whether the secret exists. A valid credential that is replayed
  within the window is rejected as `duplicate` instead of running twice. When the
  auth dependency (secret or ready index) is unavailable the route fails closed
  with `503` and does not fall back to an unauthenticated run. If the cron
  capability is paused, authorized calls answer the standard `503` pause response
  and the job is not executed. The auth check runs first, so an unauthorized
  caller learns nothing about the pause state. Authorized cron calls are audited
  as `rejected / cron_unauthorized` or `run / cron` with the job name and a
  hashed credential fingerprint, never the raw secret.
- `cron_calls` authorization is derived from `MIMRR_CRON_SECRET`. If it is missing,
  too short, or malformed, the route fails closed with `503` for every caller,
  including the scheduler. Rotating the secret invalidates all in-flight
  credentials immediately; the read-index of used nonces is the only state that
  survives a restart, and it is treated as the source of truth for replay.
- **Failure.** A paused contract write throws with the operator's reason or
  `"<capability> is temporarily paused" `. Paid endpoints answer `503`. The agent
  API answers the standard retryable `agent_paused` error from
  `lib/server/pause-registry.ts`, which carries `capability` and `viaGlobal`, so an
  agent can branch without parsing the message. No response contains env names,
  addresses or keys. A paused agent API call is audited as `rejected / paused` and
  is checked before idempotent replay, so a cached success cannot be served while
  paused. A paused worker logs one line per cycle
  (`paused by MIMRR_PAUSE_…`) and records a healthy heartbeat. It does not exit,
  because `npm run workers` runs with `--kill-others-on-fail` and one exit would
  stop every worker.
- `cron_calls` authorization is derived from `MIMRR_CRON_SECRET`. If it is missing,
  too short, or malformed, the route fails closed with `503` for every caller,
  including the scheduler. Rotating the secret invalidates all in-flight
  credentials immediately; the read-index of used nonces is the only state that
  survives a restart, and it is treated as the source of truth for replay.
- **Rollback.** Unset the variable, or set it to anything other than `1`. Nothing is
  cached: the first call after the process sees the new environment goes through.
  A paused settlement is delayed, never lost. Expired markets are settled on the
  first oracle poll after the switch clears. A paused cron job resumes on the
  next scheduled tick after the switch clears; nothing is backfilled and no
  missed tick is replayed.
- **Environment.** Switches are read from `process.env` at call time, so a flip
  needs no code change or build. It takes effect once the service has the new
  environment, which on Railway or Vercel means the restart or redeploy that
  changing a variable triggers. Workers and the web app each need their own copy
  of the variable. The cron secret is separate from the pause flags and is rotated
  independently.
- `cron_calls` operational notes: flip `MIMRR_PAUSE_CRON_CALLS=1` to stop all
  scheduled jobs without touching the secret; rotate `MIMIR_CRON_SECRET` to
  invalidate credentials without pausing jobs. To recover from a leaked cron
  secret, rotate the secret first, then clear the pause flag. The read-index
  nonce table is append-only and retained for at least the replay window.
- **Secrets.** None for the pause switches. A switch is a plain boolean, and no
  switch reads, logs or needs a key. The cron secret is only read by the cron
  auth guard, is compared in constant time, and is never logged or returned to
  callers.
- `cron_calls` migration and rollback impact: no migration is required. The
  read-index nonce table is the only state that must exist before the first
  authorized cron call; if it is missing the route fails closed rather than
  running unauthenticated. Rolling back the code change is safe because the
  pause flag is ignored by older builds and the nonce table is additive.
- **Artifacts.** None. No build output, migration or contract change is involved.
  The Soroban contracts are not aware of these switches: they stop Mimir's own
  off-chain callers, not a user who calls the contract directly.

## Verifying

From a clean checkout, with no `.env.local` and no network:

```sh
npm ci
npm run test:kill-switches
```

`tests/node/incident-kill-switches.test.ts` drives each switch at its enforcement
point. It checks that the capability runs when nothing is paused, stops under its
own switch and under `MIMRR_PAUSE_ALL`, and that pausing it leaves every other
capability running. It also checks that the exit paths above stay open with
everything paused. The probe table is typed as `Record<Pausable, Probe>`, so adding a
capability to `PAUSABLE` without wiring and testing it fails `npm run typecheck`.
The suite also runs as part of `npm run test:smoke` in CI.

`tests/node/cron-auth.test.ts` covers the cron auth guard directly: missing,
malformed, stale, duplicated, expired and unknown credentials are rejected with
`401`; a missing or malformed secret fails closed with `503`; a valid credential
runs the job exactly once; and a paused cron capability answers `503` without
running the job. Route fixtures assert the exact Stellar addresses and integer
money math in the response body are unchanged for funded user flows.
