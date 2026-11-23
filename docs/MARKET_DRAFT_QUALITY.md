# Market draft quality report

`agents/market-creator/draft-quality.ts` explains why a drafted market candidate is, or is not, fit to become a market. It is a pure, read-only report: it does not change what `draftClaimCandidates` or `filterDuplicateCandidates` keep, and it performs no network I/O.

## API

```ts
import { explainDraftQuality, explainDraftBatchQuality } from "./agents/market-creator/draft-quality";

const report = explainDraftQuality(candidate, {
  nowMs: Date.now(),                       // required, keeps reports deterministic
  evidence: { state: "available" },        // or "unknown" (default) / { state: "unavailable", detail }
  minDeadlineLeadMs: 60 * 60 * 1000,       // default 1 hour
  maxDeadlineHorizonMs: 90 * 86_400_000,   // default 90 days
  requireSourceSnapshot: false,            // require sourceId + captureVersion
});
```

`explainDraftBatchQuality(candidates, { ...options, evidenceByUrl })` reports a whole batch, takes evidence availability per resolution URL, marks each duplicate with `duplicateOf` (the index of the draft the dedupe layer keeps, using `buildCandidateSignature`), and returns a `summary` of counts.

## Checks

Each report has three checks, always in this order. Each check has a `status` of `pass`, `fail` or `unavailable`, at most `MAX_REASONS_PER_CHECK` (4) reasons from a closed set of codes, and a `truncatedReasons` count. Reason messages are capped at `MAX_REASON_MESSAGE_LENGTH` (160) characters.

| Check | Reason codes |
| --- | --- |
| `objective_wording` | `question_missing`, `question_too_short`, `question_too_long`, `question_not_interrogative`, `question_compound`, `question_subjective_term`, `threshold_unsafe` |
| `source` | `source_url_missing`, `source_url_malformed`, `source_url_insecure`, `source_url_has_credentials`, `source_url_local_host`, `source_snapshot_missing`, `source_evidence_unavailable` |
| `deadline` | `deadline_missing`, `deadline_unparseable`, `deadline_in_past`, `deadline_too_soon`, `deadline_too_far` |

`threshold_unsafe` reuses `cryptoThresholdReason` from `thresholds.ts`.

## Verdicts

| Verdict | Meaning | `retryable` |
| --- | --- | --- |
| `accepted` | every check passed | `false` |
| `invalid` | at least one check failed; the draft itself is wrong and a retry will not fix it | `false` |
| `evidence_unavailable` | the draft is well formed, but its evidence could not be fetched right now | `true` |

A draft that is both wrong and has unavailable evidence is `invalid`. A malformed source URL is always `fail`, never `unavailable`. Unknown evidence availability is not a failure, because the oracle fetches evidence again at settlement.

The report version is `draft-quality-v1` (`DRAFT_QUALITY_REPORT_VERSION`). Adding a reason code or changing a default bound is an interface change and should bump it.
