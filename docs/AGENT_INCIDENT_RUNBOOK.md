# Agent key and tool incident runbook
Every switch, where it is enforced and how it rolls back: [`INCIDENT_KILL_SWITCHES.md`](INCIDENT_KILL_SWITCHES.md). Switches take only the value `1.

Every switch, where it is enforced and how it rolls back: [`INCIDENT_KILL_SWITCHES.md`](INCIDENT_KILL_SWITCHES.md). Switches take only the value `1`.
For common contributor errors, runtime fixes, and Soroban contract error code mappings, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Oracle backlog health report

To inspect the oracle settlement backlog without signing or submitting anything, use the backlog health report. It summarizes, for each unresolved claim:

- unresolved age (time since the claim became eligible for settlement);
- evidence status (fetched, missing, stale or failed);
- counts of uncertain transactions (ambiguous submission outcomes awaiting reconciliation).

The report is read-only and contains no private source data, evidence payloads, or signing seeds. Only identifiers, timestamps, statuses, and counts are emitted. It never loads a signer and cannot trigger a transaction. Soroban contract state remains authoritative; the report reflects the read index and fresh `get_claim` state where available.

Use it to decide whether a backlog needs attention, for example when unresolved age grows or uncertain transaction counts are non-zero. Resolve uncertain transactions by reconciling the retained transaction hash as described above, not by editing the report or the read index.

1. Pause only the affected surface: `MIMIR_PAUSE_RESEARCH`, `MIMIR_PAUSE_X402_BUYING`, `MIMIR_PAUSE_COPY_EXECUTION`, or funded actions. For one actor use `RESEARCH_PAUSED_AGENT_IDS`, `MIMIR_PAUSED_X402_BUYERS`, or the wallet policy's `paused` bit. Withdrawal/read paths stay available.
2. Owner revokes the compromised operator immediately. Nonces and outstanding sessions are invalidated; do not rotate from the operator key.
3. Owner registers/rotates to a fresh operator wallet, re-grants the minimum capabilities and sets conservative daily/session/position limits. Never reuse or upload the old private key.
4. Reconcile agent request audit, copy execution attribution, x402 payment identifiers and onchain events from the last known-good timestamp. Duplicate idempotency keys and unknown targets are incident indicators.
5. Run dry-run/simulation for create, stake and copy with the replacement key. Re-enable one capability at a time and watch request, source-failure and exposure counters.
6. Check operational posture via `/api/health/status` or `npm run verify:status` to ensure capability pause states and invariants reflect expected mitigation without leaking secrets.

## Oracle settlement transaction incident

For an end-to-end explanation of the settlement sequence, decision points, environment knobs, and failure paths, see [`ORACLE_PIPELINE.md`](ORACLE_PIPELINE.md).

`resolve_claim` is the only funded write retried by the oracle. The worker classifies
failures before retrying:

- malformed verdict/input: aborts; it is never converted into a refund or replayed;
- stale / `NotYetExpired` / inactive snapshot: refreshes Soroban state and defers;
- duplicate / already resolved: no-op, because the chain is already final;
- cancelled: no-op, because cancelled claims are refunded by the contract;
- `MIMIR_PAUSE_ORACLE_SETTLEMENT=1`: defers before evidence, LLM, or signing;
- dependency / RPC / timeout failures: bounded exponential retry, then defer to the
  next poll. The worker never retries from a stale snapshot.

If a submission outcome is ambiguous, reconcile the retained transaction hash and
fresh `get_claim` state before any manual action. Do not issue a manual payout,
edit the read index, or delete a claim to make a retry appear successful. Soroban
state is authoritative; a later poll is the rollback mechanism for a deferred
attempt. To roll back this change, disable `MIMIR_PAUSE_ORACLE_SETTLEMENT` only
after the RPC and oracle balance are healthy, or deploy the previous worker; no
contract migration or ledger reversal is required.

### Dry-running a settlement decision

To inspect what the oracle would decide for a claim without signing anything, run:

```
npx tsx scripts/oracle-dry-run.ts <claimId>
```

The script reuses the same evaluation pipeline as the worker (evidence fetch,
`evaluateClaim`, confidence tiers, unresolvable policy and optional council voting)
and prints the evidence hash, verdict, tier, confidence and the transaction it
would send. It never loads a signer and never builds a transaction for submission:
passing `--submit` is refused. It needs only a public testnet RPC URL and an LLM key.

### Credential-free outage and recovery scenarios

Run the deterministic scenarios before changing settlement handling or during an
incident review:

```
npm run oracle:scenarios
npm run oracle:scenarios -- --json
```

The harness composes the worker's existing helpers (`isSportsEventFinal`,
`applySettlementPolicy`/`tierVerdict`, and
`classifySettlementError`/`settlementRetryDecision`) and asserts these outcomes:

| Scenario | Outage | Conservative outcome |
| --- | --- | --- |
| `source-outage` | every source unreachable | defer, settle after a source recovers |
| `contradictory-sources` | reachable sources disagree | refund `UNRESOLVABLE`, never a side |
| `delayed-finality` | sports event still live | defer inside the grace window; refund after it |
| `uncertain-submission` | `resolve_claim` times out | reconcile the chain, retry within budget, or defer |

It reads no environment variables, opens no RPC or source connection, loads no
signer and makes no LLM call. Focused coverage lives in
`tests/node/oracle-outage-recovery.test.ts` and runs with
`npm run test:node -- oracle-outage-recovery`.

Compromise never permits editing historical owner-fee attribution. A revoked agent remains terminal; re-admission is a new registration.
