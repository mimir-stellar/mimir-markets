# Proposal Review History

Proposal review decisions are persisted in the `proposal_review_history` Postgres read-index table with stable machine-readable reason codes and exposed through a sanitized public read endpoint.

## Decisions

Every terminal review outcome is recorded with one of four decisions:

- `accepted` — proposal passed review and was approved.
- `rejected` — proposal was rejected, cancelled by an operator, or failed a downstream dependency.
- `superseded` — proposal was replaced by a newer proposal (`supersededByProposalId`).
- `expired` — proposal passed its review deadline or signed request window without a decision.

## Stable Reason Codes

| Reason Code | Typical Decision | Description |
| --- | --- | --- |
| `REVIEW_APPROVED` | `accepted` | Proposal approved during review. |
| `REVIEW_REJECTED` | `rejected` | Proposal rejected during review. |
| `POLICY_VIOLATION` | `rejected` | Proposal violated market creation policy. |
| `INVALID_RESOLUTION_SOURCE` | `rejected` | Resolution source was invalid or unverifiable. |
| `LOW_QUALITY` | `rejected` | Proposal did not meet quality bar. |
| `DEPENDENCY_FAILED` | `rejected` | Downstream oracle or preflight dependency failed. |
| `CANCELLED_BY_OPERATOR` | `rejected` | Cancelled by operator before completion. |
| `SUPERSEDED_BY_NEWER_PROPOSAL` | `superseded` | Replaced by a newer proposal. |
| `DUPLICATE_PROPOSAL` | `superseded` | Duplicate of an existing proposal. |
| `REVIEW_DEADLINE_EXPIRED` | `expired` | Proposal review deadline elapsed. |
| `SIGNED_WINDOW_EXPIRED` | `expired` | Signed request freshness window expired. |

## Public Read Endpoint

`GET /api/proposals/review/history`

Query parameters:

- `proposalId` (optional) — filter by proposal ID.
- `decision` (optional) — one of `accepted`, `rejected`, `superseded`, `expired`.
- `reasonCode` (optional) — one of the stable reason codes above.
- `limit` (optional, default `50`, clamped to `1..200`).
- `offset` (optional, default `0`).

Response:

```json
{
  "history": [
    {
      "id": 1,
      "proposalId": "prop-1",
      "decision": "accepted",
      "reasonCode": "REVIEW_APPROVED",
      "recordedAt": 1700000000000,
      "supersededByProposalId": null
    }
  ],
  "limit": 50,
  "offset": 0
}
```

### Redaction Guarantees

Public responses are projected through `toPublicProposalReviewHistoryEntry` using an explicit allowlist. Privileged actor credentials (`actorId` / reviewer identities) and internal `privateNote` values are never included in public views.

## Internal Operator Write Extensions

`POST /api/proposals/review` and `PATCH /api/proposals/review` (gated by `internal_worker` / `CRON_SECRET`) accept optional `reasonCode`, `privateNote`, and `supersededByProposalId` fields and additionally support `action: "supersede"` and `action: "expire"` while remaining backwards-compatible with existing actions.
