/**
 * The approval chain.
 *
 * An FMR is not something the field can act on until a planner has approved
 * it and the material manager has given it its official number. Before this
 * existed, anyone who could edit a draft could put material in front of a
 * crew — which is the gap the client's process document describes.
 *
 * These are the rules on their own, with no database: what may move where,
 * who may move it, and what a person is told when they cannot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATES, TRANSITIONS, planTransition, availableTransitions,
  isFieldExecutable, mayEditNumber, WorkflowError
} from '../src/domain/workflow.js';

const planner = { planReview: true, assignNumber: false, ownerEdit: false };
const material = { planReview: false, assignNumber: true, ownerEdit: false };
const owner = { planReview: true, assignNumber: true, ownerEdit: true };
const field = { planReview: false, assignNumber: false, ownerEdit: false };

test('the happy path runs create to published', () => {
  let state = STATES.DRAFT;
  state = planTransition('SUBMIT', { state, permissions: owner });
  assert.equal(state, STATES.PENDING_PLANNER_REVIEW);

  state = planTransition('PLANNER_APPROVE', { state, permissions: planner });
  assert.equal(state, STATES.PLANNER_APPROVED);

  state = planTransition('SEND_TO_MATERIAL', { state, permissions: planner });
  assert.equal(state, STATES.PENDING_MATERIAL_MANAGER);

  state = planTransition('ASSIGN_NUMBER', { state, permissions: material });
  assert.equal(state, STATES.NUMBER_ASSIGNED);

  state = planTransition('PUBLISH', { state, permissions: material });
  assert.equal(state, STATES.PUBLISHED);
});

test('nothing is field-executable until it is published', () => {
  // The single question the whole chain exists to answer.
  for (const state of Object.values(STATES)) {
    assert.equal(isFieldExecutable(state), state === STATES.PUBLISHED,
      `${state} was readable by the field`);
  }
});

test('a draft cannot skip the planner and go straight to a number', () => {
  const failure = check('ASSIGN_NUMBER', { state: STATES.DRAFT, permissions: material });
  assert.equal(failure.code, 'BAD_STATE');
  assert.match(failure.message, /draft/i, 'the message has to name where it actually is');
});

test('an approved request cannot be published without a number', () => {
  const failure = check('PUBLISH', { state: STATES.PLANNER_APPROVED, permissions: owner });
  assert.equal(failure.code, 'BAD_STATE');
});

test('a planner cannot assign the number', () => {
  // The client's rule: the material manager owns the release identifier, and
  // the planner explicitly does not.
  const failure = check('ASSIGN_NUMBER', {
    state: STATES.PENDING_MATERIAL_MANAGER, permissions: planner
  });
  assert.equal(failure.code, 'FORBIDDEN');
  assert.match(failure.message, /permission/i);
});

test('the material manager cannot approve on the planner\'s behalf', () => {
  const failure = check('PLANNER_APPROVE', {
    state: STATES.PENDING_PLANNER_REVIEW, permissions: material
  });
  assert.equal(failure.code, 'FORBIDDEN');
});

test('a field user moves nothing through the chain', () => {
  for (const action of Object.keys(TRANSITIONS)) {
    const move = TRANSITIONS[action];
    const failure = check(action, { state: move.from[0], permissions: field, reason: 'x'.repeat(5) });
    assert.equal(failure.code, 'FORBIDDEN', `${action} was allowed for a field user`);
  }
});

test('returning a request needs a reason, because somebody has to act on it', () => {
  const failure = check('PLANNER_RETURN', {
    state: STATES.PENDING_PLANNER_REVIEW, permissions: planner, reason: ' '
  });
  assert.equal(failure.code, 'MISSING_REASON');

  const ok = planTransition('PLANNER_RETURN', {
    state: STATES.PENDING_PLANNER_REVIEW, permissions: planner,
    reason: 'wrong work package'
  });
  assert.equal(ok, STATES.PLANNER_RETURNED);
});

test('a returned request goes back to the planner, not around them', () => {
  // Correcting and resubmitting must re-enter review — otherwise a return is
  // a suggestion rather than a gate.
  const state = planTransition('SUBMIT', {
    state: STATES.PLANNER_RETURNED, permissions: owner
  });
  assert.equal(state, STATES.PENDING_PLANNER_REVIEW);
});

test('a rejected request never becomes field-executable', () => {
  assert.equal(isFieldExecutable(STATES.PLANNER_RETURNED), false);
  for (const action of ['PUBLISH', 'ASSIGN_NUMBER', 'SEND_TO_MATERIAL']) {
    assert.equal(
      check(action, { state: STATES.PLANNER_RETURNED, permissions: owner }).code,
      'BAD_STATE',
      `${action} was allowed on a returned request`
    );
  }
});

test('a number can be corrected before publishing, but not after', () => {
  assert.equal(mayEditNumber(STATES.NUMBER_ASSIGNED, material), true);
  assert.equal(mayEditNumber(STATES.PUBLISHED, material), false,
    'a published number is what the field searches by');
  assert.equal(mayEditNumber(STATES.NUMBER_ASSIGNED, planner), false);
});

test('a screen is told only the moves this person can make from here', () => {
  const forPlanner = availableTransitions(STATES.PENDING_PLANNER_REVIEW, planner)
    .map((t) => t.action);
  assert.deepEqual(forPlanner.sort(), ['PLANNER_APPROVE', 'PLANNER_RETURN']);

  assert.deepEqual(availableTransitions(STATES.PENDING_PLANNER_REVIEW, material), []);
  assert.deepEqual(availableTransitions(STATES.PUBLISHED, owner), [],
    'a published FMR has left the chain');
});

test('an unknown action is refused rather than silently doing nothing', () => {
  assert.equal(check('DELETE_EVERYTHING', { state: STATES.DRAFT, permissions: owner }).code,
    'BAD_ACTION');
});

/** Run a transition that is expected to fail, and hand back the error. */
function check(action, options) {
  try {
    planTransition(action, options);
  } catch (error) {
    assert.ok(error instanceof WorkflowError, `${action} threw a ${error.name}`);
    return error;
  }
  assert.fail(`${action} was allowed from ${options.state}`);
}
