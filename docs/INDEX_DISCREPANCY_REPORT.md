# Chain-to-index discrepancy report

Compares a selected set of claims and their settlement projections in the
Postgres read index with a captured range of chain events. Soroban contract
state stays authoritative; every finding describes the index, never the chain.

```bash
DATABASE_URL=... npx tsx scripts/report-index-discrepancies.ts \
  --capture fixtures/ledger/funded-market-v1.json --claims 1,2,3 [--max-findings 200]
```

The command is read-only: two bounded `SELECT ... WHERE id IN (...)` queries,
no Postgres writes, no cursor movement, no RPC, no signing keys. The JSON report
goes to stdout; stderr carries only an actionable reason and never dumps capture
records, rows or environment values.

Exit codes: `0` no discrepancies, `2` discrepancies found, `1` invalid input or failure.

Code: `lib/server/index-discrepancy.ts` (`buildDiscrepancyReport` is pure;
`runIndexDiscrepancyReport` reads the selected rows), plus
`getMarketSettlementsByClaimIds` in `lib/db.ts`.

## Capture format

A saved ledger fixture (see [LEDGER_REPLAY.md](LEDGER_REPLAY.md)) with an
optional `settlements` array of captured `market_settled` events:

```json
{
  "claimId": 1, "transactionHash": "...", "ledger": 1005,
  "totalPaidAtomic": "0", "totalFeesAtomic": "0",
  "owedToChallengersAtomic": "25000000", "dustAtomic": "0",
  "pulledNetAtomic": "0"
}
```

Atomic USDC amounts are base-10 strings; numbers are rejected. Settlement ledgers
must be inside the declared capture range. `pulledNetAtomic` is the sum of the
captured `challenger_paid.net` for the claim (defaults to `"0"`). Two different
`market_settled` transactions for one claim refuse the report. Reorged-out events
(`reorgedOut`) never count as chain truth.

## Classification

| Class | Meaning | Examples |
| --- | --- | --- |
| `missing` | The capture proves the record exists; the index has no row. | Claim or settlement row absent. |
| `stale` | The index is behind the chain; a resync should fix it. | State earlier in the lifecycle (`open` vs `resolved`), fewer challengers, `payout_atomic` below paid + pulled. |
| `conflicting` | The chain contradicts the index and lag cannot explain it. | Different creator, category or winner; a state ahead of or off the chain's lifecycle; more challengers; a settlement tx hash, dust or gross volume mismatch; payout above the chain; a settlement row for a claim the capture shows unresolved. |

Selected ids with no captured events are listed in `unverifiedClaimIds` and
counted as `summary.unverified`. They are not discrepancies: their history may
predate the captured range.

Compared fields: claims `creator`, `category`, `state`, `winner_side` (when both
are resolved), `challenger_count`; settlements `transaction_hash`
(case-insensitive), `dust_atomic`, `gross_volume_atomic`
(paid + fees + owed + dust, as in `settlement-index`), and `payout_atomic`
(paid + pulled).

## Bounds

- At most **200** claim ids per run (`DISCREPANCY_REPORT_MAX_CLAIMS`). Callers can
  lower the cap, never raise it. Empty, duplicate, non-integer or non-positive ids
  fail closed.
- At most **1,000** findings listed (`DISCREPANCY_REPORT_MAX_FINDINGS`, lowerable
  with `--max-findings`). `summary` still counts every finding, and `truncated`
  is `true` when the list was cut.
- Only the selected ids' events are folded, so cost scales with the selection,
  not the size of the capture.
- Output is deterministic: findings are sorted by claim, record, class and field.
