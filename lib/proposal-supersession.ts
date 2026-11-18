/**
 * Proposal supersession — linking a revised market-creator draft to the draft it
 * replaces.
 *
 * A revision is a NEW proposal row, never an edit of the old one. Supersession
 * only writes two link columns (`supersedes_proposal_id` on the successor,
 * `superseded_by_proposal_id` on the predecessor) plus the successor's
 * `revision` number. That keeps three properties true:
 *
 *   1. **Approved intent is immutable.** The predecessor's question, positions,
 *      settlement rule, stake policy, review outcome and review status are never
 *      touched, so an approval keeps meaning exactly what the reviewer approved.
 *   2. **Each revision is reviewed independently.** The successor must still be
 *      `queued` — it goes through its own claim -> approve/reject cycle with its
 *      own reviewer. Nothing about the predecessor's review carries over.
 *   3. **Each revision expires independently.** Deadlines are per row; the
 *      stale sweep (`markStaleProposals`) keeps operating on each row's own
 *      deadline, and linking never extends or copies one.
 *
 * History is linear: a proposal can be superseded at most once and can
 * supersede at most one predecessor, and cycles are refused.
 *
 * This module is pure; `supersedeProposal` in `lib/db.ts` applies the plan
 * inside a transaction.
 */

/** Longest lineage we will walk when checking for cycles. */
export const MAX_SUPERSESSION_DEPTH = 64;

export interface SupersessionNode {
  proposal_id: string;
  review_status: string;
  supersedes_proposal_id: string | null;
  superseded_by_proposal_id: string | null;
  revision: number;
}

export type SupersessionErrorCode =
  | "invalid_request"
  | "not_found"
  | "successor_not_queued"
  | "successor_already_linked"
  | "predecessor_already_superseded"
  | "cycle";

export type SupersessionPlan =
  | { ok: true; predecessorId: string; successorId: string; revision: number }
  | { ok: false; code: SupersessionErrorCode; message: string };

/**
 * Decide whether `successor` may supersede `predecessor`.
 *
 * `predecessorAncestors` is the chain of ids the predecessor itself supersedes
 * (oldest last), used to refuse cycles.
 */
export function planSupersession(
  predecessor: SupersessionNode | null,
  successor: SupersessionNode | null,
  predecessorAncestors: readonly string[] = [],
): SupersessionPlan {
  if (!predecessor) return { ok: false, code: "not_found", message: "predecessor proposal not found" };
  if (!successor) return { ok: false, code: "not_found", message: "successor proposal not found" };
  if (predecessor.proposal_id === successor.proposal_id) {
    return { ok: false, code: "invalid_request", message: "a proposal cannot supersede itself" };
  }
  if (successor.review_status !== "queued") {
    return {
      ok: false,
      code: "successor_not_queued",
      message: `successor must be queued for its own review (is ${successor.review_status})`,
    };
  }
  if (successor.supersedes_proposal_id) {
    return {
      ok: false,
      code: "successor_already_linked",
      message: `successor already supersedes ${successor.supersedes_proposal_id}`,
    };
  }
  if (predecessor.superseded_by_proposal_id) {
    return {
      ok: false,
      code: "predecessor_already_superseded",
      message: `predecessor is already superseded by ${predecessor.superseded_by_proposal_id}`,
    };
  }
  if (predecessorAncestors.includes(successor.proposal_id)) {
    return { ok: false, code: "cycle", message: "linking would create a supersession cycle" };
  }
  const base = Number.isInteger(predecessor.revision) && predecessor.revision > 0 ? predecessor.revision : 1;
  return { ok: true, predecessorId: predecessor.proposal_id, successorId: successor.proposal_id, revision: base + 1 };
}

/** HTTP status for a refused plan. */
export function supersessionErrorStatus(code: SupersessionErrorCode): number {
  if (code === "invalid_request") return 400;
  if (code === "not_found") return 404;
  return 409;
}
