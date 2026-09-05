import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_PROFILES, CUSTOM, RoleError, permissionsFor, profileFromPermissions,
  listProfiles, validEmail, normalizeEmail
} from '../src/domain/roles.js';

test('each profile grants what its name implies', () => {
  assert.deepEqual(permissionsFor('READ_ONLY'), {
    search: true, fieldTransact: false, adminBackorder: false, ownerEdit: false,
    planReview: false, assignNumber: false
  });
  assert.deepEqual(permissionsFor('FIELD'), {
    search: true, fieldTransact: true, adminBackorder: false, ownerEdit: false,
    planReview: false, assignNumber: false
  });
  assert.deepEqual(permissionsFor('OWNER'), {
    search: true, fieldTransact: true, adminBackorder: true, ownerEdit: true,
    planReview: true, assignNumber: true
  });
});

test('a planner reviews packages and touches no material', () => {
  // The planner's job is whether a requisition suits the work package. They
  // do not issue, do not decide backorders, and — per the client's process —
  // deliberately do not own the FMR number.
  const planner = permissionsFor('PLANNER');
  assert.equal(planner.planReview, true);
  assert.equal(planner.assignNumber, false);
  assert.equal(planner.fieldTransact, false);
  assert.equal(planner.adminBackorder, false);
});

test('the material admin owns the FMR number', () => {
  // "The option to change the FMR number shouldn't be so easily available —
  // it should be something that only a Material Admin can do."
  const admin = permissionsFor('ADMIN');
  assert.equal(admin.assignNumber, true);
  assert.equal(permissionsFor('FIELD').assignNumber, false);
  assert.equal(permissionsFor('PLANNER').assignNumber, false);
});

test('an office admin cannot move material', () => {
  // ADMIN is deliberately not a superset of FIELD: deciding backorders from a
  // desk is a different job from issuing pipe in the warehouse.
  const admin = permissionsFor('ADMIN');
  assert.equal(admin.adminBackorder, true);
  assert.equal(admin.fieldTransact, false);
});

test('profile lookup is case-insensitive and rejects unknowns', () => {
  assert.deepEqual(permissionsFor('field'), permissionsFor('FIELD'));
  assert.throws(() => permissionsFor('SUPERVISOR'), RoleError);
  assert.throws(() => permissionsFor(''), /must be one of/);
});

test('permissions map back to the profile that granted them', () => {
  for (const profile of Object.values(ROLE_PROFILES)) {
    assert.equal(
      profileFromPermissions(profile.permissions),
      profile.key,
      `${profile.key} did not round-trip`
    );
  }
});

test('an off-menu combination reports as CUSTOM, not the nearest profile', () => {
  // FMRv3 coerced this to READ_ONLY when opening the user, so saving them
  // silently stripped their access.
  const odd = { search: true, fieldTransact: true, adminBackorder: true, ownerEdit: false };
  assert.equal(profileFromPermissions(odd), CUSTOM);
});

test('no permissions at all is CUSTOM — even read-only can search', () => {
  assert.equal(profileFromPermissions({}), CUSTOM);
  assert.equal(profileFromPermissions({
    search: false, fieldTransact: false, adminBackorder: false, ownerEdit: false
  }), CUSTOM);
});

test('missing flags are treated as not granted', () => {
  assert.equal(profileFromPermissions({ search: true }), 'READ_ONLY');
});

test('the returned permissions cannot mutate the profile table', () => {
  const permissions = permissionsFor('FIELD');
  permissions.ownerEdit = true;
  assert.equal(permissionsFor('FIELD').ownerEdit, false);
});

test('profiles list in order of increasing access', () => {
  // PLANNER sits between FIELD and ADMIN: it decides nothing about material,
  // only whether a requisition suits the work package.
  const keys = listProfiles().map((p) => p.key);
  assert.deepEqual(keys, ['READ_ONLY', 'FIELD', 'PLANNER', 'ADMIN', 'OWNER']);
  assert.ok(listProfiles().every((p) => p.label && p.description));
});

test('sign-in addresses are validated and normalised', () => {
  assert.ok(validEmail('rita@example.com'));
  assert.ok(validEmail('  Rita@Example.COM  '));
  assert.equal(validEmail('rita'), false);
  assert.equal(validEmail('rita@example'), false);
  assert.equal(validEmail('rita @example.com'), false);
  assert.equal(validEmail(''), false);
  assert.equal(normalizeEmail('  Rita@Example.COM '), 'rita@example.com');
});
