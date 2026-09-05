/**
 * What each state of the approval chain is called on screen.
 *
 * The server sends the state name; this is how a person reads it. Kept beside
 * the other shared pieces rather than in review.js so the drafts screen can
 * show the same words for the same thing — a requisition that says "with the
 * planner" in one place and "PENDING_PLANNER_REVIEW" in another reads as two
 * different systems.
 *
 * Mirrors STATE_LABELS in core/src/domain/workflow.js, which is the authority.
 */

export const STATE_LABELS = Object.freeze({
  DRAFT: 'Draft',
  PENDING_PLANNER_REVIEW: 'With the planner',
  PLANNER_APPROVED: 'Planner approved',
  PLANNER_RETURNED: 'Returned for correction',
  PENDING_MATERIAL_MANAGER: 'Waiting for a number',
  NUMBER_ASSIGNED: 'Numbered, ready to publish',
  PUBLISHED: 'Published'
});

/** Where a requisition sits, said the way a person would say it. */
export const stateLabel = (state) => STATE_LABELS[state] ?? String(state ?? 'Unknown');
