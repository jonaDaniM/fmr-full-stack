/**
 * The approval chain an FMR passes before the field can act on it.
 *
 *   DRAFT ─submit→ PENDING_PLANNER_REVIEW ─approve→ PLANNER_APPROVED
 *                            │                            │
 *                            └─return→ PLANNER_RETURNED   ↓
 *                                          │      PENDING_MATERIAL_MANAGER
 *                                    resubmit│              │
 *                                          └──┘        number│
 *                                                            ↓
 *                                                    NUMBER_ASSIGNED
 *                                                            │
 *                                                     publish│
 *                                                            ↓
 *                                                        PUBLISHED
 *
 * Two decisions by two different people. The planner checks the request suits
 * the work package; the material manager owns the official FMR number, which
 * is the release identifier the field searches by and purchasing quotes
 * against. Publishing is what makes an FMR real to a crew, so it is the last
 * gate rather than the only one.
 *
 * Pure, per the domain rule: no database import, so the transitions can be
 * read and tested on their own.
 */

export const STATES = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_PLANNER_REVIEW: 'PENDING_PLANNER_REVIEW',
  PLANNER_APPROVED: 'PLANNER_APPROVED',
  PLANNER_RETURNED: 'PLANNER_RETURNED',
  PENDING_MATERIAL_MANAGER: 'PENDING_MATERIAL_MANAGER',
  NUMBER_ASSIGNED: 'NUMBER_ASSIGNED',
  PUBLISHED: 'PUBLISHED'
});

/** What each state means to the person looking at the queue. */
export const STATE_LABELS = Object.freeze({
  DRAFT: 'Draft',
  PENDING_PLANNER_REVIEW: 'With the planner',
  PLANNER_APPROVED: 'Planner approved',
  PLANNER_RETURNED: 'Returned for correction',
  PENDING_MATERIAL_MANAGER: 'Waiting for a number',
  NUMBER_ASSIGNED: 'Numbered, ready to publish',
  PUBLISHED: 'Published'
});

/**
 * Every move, and who may make it.
 *
 * `permission` names the flag on the member. `from` is every state the move
 * is legal in — anything else is refused with the state it is actually in,
 * because "that is not allowed" without saying why is the message people
 * bring to the office.
 */
export const TRANSITIONS = Object.freeze({
  SUBMIT: {
    from: [STATES.DRAFT, STATES.PLANNER_RETURNED],
    to: STATES.PENDING_PLANNER_REVIEW,
    permission: 'ownerEdit',
    verb: 'send for review'
  },
  PLANNER_APPROVE: {
    from: [STATES.PENDING_PLANNER_REVIEW],
    to: STATES.PLANNER_APPROVED,
    permission: 'planReview',
    verb: 'approve'
  },
  PLANNER_RETURN: {
    from: [STATES.PENDING_PLANNER_REVIEW],
    to: STATES.PLANNER_RETURNED,
    permission: 'planReview',
    verb: 'return',
    needsReason: true
  },
  SEND_TO_MATERIAL: {
    from: [STATES.PLANNER_APPROVED],
    to: STATES.PENDING_MATERIAL_MANAGER,
    permission: 'planReview',
    verb: 'send to material management'
  },
  ASSIGN_NUMBER: {
    from: [STATES.PENDING_MATERIAL_MANAGER, STATES.NUMBER_ASSIGNED],
    to: STATES.NUMBER_ASSIGNED,
    permission: 'assignNumber',
    verb: 'assign the FMR number'
  },
  PUBLISH: {
    from: [STATES.NUMBER_ASSIGNED],
    to: STATES.PUBLISHED,
    permission: 'assignNumber',
    verb: 'publish'
  }
});

export class WorkflowError extends Error {
  constructor(message, code = 'WORKFLOW') {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

/** Is this a state the chain knows? */
export const isState = (value) => Object.hasOwn(STATES, String(value ?? ''));

/**
 * Check a move before it is made.
 *
 * Returns the state to move to, or throws with a message written for whoever
 * is holding the phone rather than for a developer.
 */
export function planTransition(action, { state, permissions, reason } = {}) {
  const move = TRANSITIONS[action];
  if (!move) throw new WorkflowError(`Unknown action: ${action}.`, 'BAD_ACTION');

  if (!permissions?.[move.permission]) {
    throw new WorkflowError(
      `You do not have permission to ${move.verb}.`, 'FORBIDDEN'
    );
  }

  if (!move.from.includes(state)) {
    // Naming both states is what turns this from a wall into an instruction.
    throw new WorkflowError(
      `This FMR is ${labelFor(state)}, so it cannot be ${pastTense(move.verb)} now.`,
      'BAD_STATE'
    );
  }

  if (move.needsReason && String(reason ?? '').trim().length < 3) {
    throw new WorkflowError(
      'Say what needs correcting, so whoever picks this up knows what to change.',
      'MISSING_REASON'
    );
  }

  return move.to;
}

/** The moves available from here, for the buttons a screen should offer. */
export function availableTransitions(state, permissions) {
  return Object.entries(TRANSITIONS)
    .filter(([, move]) => move.from.includes(state) && permissions?.[move.permission])
    .map(([action, move]) => ({ action, verb: move.verb, to: move.to }));
}

/**
 * Can the field see this yet?
 *
 * The one question the whole chain exists to answer, and the reason publish
 * is not merely a status change.
 */
export const isFieldExecutable = (state) => state === STATES.PUBLISHED;

/** Whether an FMR number may be edited in this state. */
export function mayEditNumber(state, permissions) {
  if (state === STATES.PUBLISHED) return false;
  return Boolean(permissions?.assignNumber);
}

function labelFor(state) {
  return (STATE_LABELS[state] ?? String(state ?? 'in an unknown state')).toLowerCase();
}

function pastTense(verb) {
  if (verb.endsWith('e')) return `${verb}d`;
  return `${verb}ed`;
}
