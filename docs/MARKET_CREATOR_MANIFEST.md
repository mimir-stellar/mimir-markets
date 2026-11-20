# Dry-run market generation batch manifest

Export a captured drafting response for review without credentials, a live LLM,
chain access, payments, or publishing:

```sh
npm run market-creator:manifest -- \
  --input tests/fixtures/market-creator-manifest/batch.json \
  --out /tmp/market-creator-manifest.json
```

Omit `--out` to print JSON to stdout. An existing output file is refused;
the input is never overwritten. New output files use mode `0600`.
This is a separate offline command; the existing live worker's flags and
behavior remain supported. No `.env` file or production credentials are needed.

## Input

`--input` is a JSON object with:

| Field | Meaning |
| --- | --- |
| `draftResponse` | String containing the captured JSON candidate array; code fences and surrounding prose are tolerated by the existing parser. |
| `evaluatedAt` | Explicit ISO timestamp with timezone, used instead of the current clock. |
| `budget.stakeAtomic` | Positive canonical integer string for the proposed stake of each market. |
| `budget.maxTotalStakeAtomic` | Nonnegative canonical integer string capping the batch's planned stakes. |
| `budget.maxMarkets` | Nonnegative safe integer capping the number of proposed markets. |
| `existingCandidates` | Optional array of supplied existing markets, each with `question` (or `title`), `resolutionUrl`, and `deadline`. |

USDC uses Stellar's **7 decimals**: `"20000000"` is 2 USDC. All budget
arithmetic uses integers and amounts stay strings in JSON, including above
JavaScript's safe-integer range. Atomic inputs may not exceed Soroban's signed
i128 maximum. XLM is only for fees/reserve; the manifest estimates USDC stakes
and does not estimate XLM costs or authorize spending.

Candidates use the existing drafting shape: `question`, `resolutionUrl`,
`deadline`, optional `category`, and optional numeric USD `threshold`.
The captured source/model payload itself and unknown candidate fields are not
copied to the output. Each candidate receives its original array index,
statement, stake, decision and rejection reason, including malformed entries.
Rejected source URLs are exported as `resolutionUrl: null` when malformed,
non-HTTP(S), or containing a username/password. The `invalid_resolution_url`
code and statement remain available without copying credentials into the
manifest. Valid source URLs retain their spelling, including when another rule
rejects the candidate; captured input files are never modified.

## Output and rejection rules

The version-1 JSON reports `dryRun: true`, `stateSource: "supplied_snapshot"`,
`executionReady: false`, and false creation/payment/publishing side effects.
`budget` includes planned and remaining atomic USDC; only proposed entries
consume the planning budget. Entries remain in draft order.

Checks run in this order: required fields, HTTP(S) URL without embedded
credentials, valid future ISO deadline, existing threshold safety, duplicates,
market limit, and total budget. Rejections have a stable code and detail:

| Code | Meaning |
| --- | --- |
| `invalid_candidate` | Required draft fields are missing or empty. |
| `invalid_resolution_url` | URL is malformed, uses another protocol, or embeds credentials. |
| `invalid_deadline` | Deadline is not a real ISO date/time with timezone. |
| `deadline_elapsed` | Deadline is at or before `evaluatedAt`. |
| `unsafe_crypto_threshold` | The existing numeric threshold guard refuses the value. |
| `duplicate_existing` | Existing signature matches the supplied market snapshot. |
| `duplicate_batch` | An earlier eligible draft has the same signature. |
| `market_limit` | Proposing the entry would exceed `maxMarkets`. |
| `budget_exceeded` | Proposing the entry would exceed the USDC budget. |

Dedupe reuses the existing question/URL/deadline normalization. The first
eligible occurrence wins, including when rejected by a planning cap. The
caller-supplied snapshot is never mutated. Malformed snapshot/configuration
inputs fail instead of silently disabling safeguards. A malformed draft
response produces an empty manifest with `error: "invalid_draft_response"`
and CLI exit 1; a valid empty array has `error: null`. Candidate rejections
alone do not make export fail. Configuration and file errors exit 1.

The manifest is a **proposal for review**, not an execution approval. Supplied
existing-market state is hypothetical and may be stale; Postgres remains a
read index, and Soroban state is authoritative. Before any future live create,
the worker must re-read authoritative state and apply its supported source,
quality, exposure/category-cap, signing and contract checks. This command does
not fetch resolution URLs or run paid preflight.

## Before/after example

Before, drafting and dedupe returned only surviving candidates; removed
statements had no structured batch record or budget summary. The fixture now
renders the following decisions (the full artifact is `manifest.json` alongside
the fixture):

```text
DRY RUN — 3 drafted, 1 proposed, 2 rejected
USDC planned: 20000000 atomic; remaining: 0 atomic
1. Will the temperature exceed 30 C?       proposed       stake=20000000
2. WILL the temperature exceed 30 C!!!    duplicate_batch stake=20000000
3. Will the launch occur tomorrow?       budget_exceeded stake=20000000
Market creation: false; payments: false; live publishing: false
```

Focused verification:

```sh
node --import tsx --test tests/node/market-creator-manifest.test.ts
npm ci
npm run test:node
```

The tests use synthetic captured responses and temporary directories. They
cover duplicate compatibility, malformed drafts, invalid dates/snapshots,
exact and large-integer budget boundaries, deterministic replay, no network,
and local output refusal/permissions.
