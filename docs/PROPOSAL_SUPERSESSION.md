# Proposal supersession

A market-creator proposal that needs changes is never edited in place. The
revised draft is inserted as a new proposal and then explicitly linked to the
draft it replaces. Logic lives in `lib/proposal-supersession.ts` (pure planner)
and `supersedeProposal` in `lib/db.ts` (transactional apply).

## Rules

- **Approved intent is immutable.** Linking writes only
  `market_proposals.superseded_by_proposal_id` on the predecessor and
  `supersedes_proposal_id` + `revision` on the successor. Question, positions,
  settlement rule, stake policy, review outcome, review status, reviewer and
  deadline of the predecessor are never touched.
- **Independent review.** The successor must be `queued`; it goes through its
  own claim -> approve/reject cycle. A predecessor's review never carries over,
  and an already-reviewed draft cannot be attached as a revision.
- **Independent expiry.** Each row keeps its own `deadline`; the stale sweep
  (`markStaleProposals`) treats every revision separately.
- **Linear history.** A proposal can be superseded once and can supersede one
  predecessor (unique index on `supersedes_proposal_id`). Cycles are refused.
  `revision` is 1 for an original draft and predecessor + 1 for each revision.

## Schema

```sql
ALTER TABLE market_proposals ADD COLUMN IF NOT EXISTS supersedes_proposal_id TEXT;
ALTER TABLE market_proposals ADD COLUMN IF NOT EXISTS superseded_by_proposal_id TEXT;
ALTER TABLE market_proposals ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_proposals_supersedes
  ON market_proposals(supersedes_proposal_id) WHERE supersedes_proposal_id IS NOT NULL;
```

Existing rows read as revision 1 with no links, so current behaviour is unchanged.

## API

`POST /api/proposals/review` (worker secret, same as the other actions):

```json
{ "action": "supersede", "proposalId": "<predecessor>", "successorId": "<queued revision>" }
```

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ success, proposalId, successorId, revision, status: "queued" }` | Linked |
| 400 | `{ error: { message } }` or `{ error: { code: "invalid_request" } }` | Missing ids, or a proposal superseding itself |
| 404 | `{ error: { code: "not_found" } }` | Either proposal does not exist |
| 409 | `{ error: { code } }` | `successor_not_queued`, `successor_already_linked`, `predecessor_already_superseded`, `cycle` |
