/**
 * Role profiles.
 *
 * Permissions are stored as four independent flags, but people are given a
 * role. These are the four combinations that have names, ported from FMRv3
 * SystemControlService.gs.
 *
 * Note that ADMIN is not a superset of FIELD: someone who reviews backorders
 * from the office is not thereby allowed to move material in the warehouse.
 * That separation is deliberate.
 */

export const ROLE_PROFILES = Object.freeze({
  READ_ONLY: Object.freeze({
    key: 'READ_ONLY',
    label: 'Read Only',
    description: 'Can look material up, but not record anything.',
    permissions: Object.freeze({
      search: true, fieldTransact: false, adminBackorder: false, ownerEdit: false
    })
  }),

  FIELD: Object.freeze({
    key: 'FIELD',
    label: 'Field User',
    description: 'Locates, bags and issues material, and raises backorders.',
    permissions: Object.freeze({
      search: true, fieldTransact: true, adminBackorder: false, ownerEdit: false
    })
  }),

  ADMIN: Object.freeze({
    key: 'ADMIN',
    label: 'Material Admin',
    description: 'Decides backorders from the office. Does not move material.',
    permissions: Object.freeze({
      search: true, fieldTransact: false, adminBackorder: true, ownerEdit: false
    })
  }),

  OWNER: Object.freeze({
    key: 'OWNER',
    label: 'System Owner',
    description: 'Everything, plus users, drafts, corrections and controls.',
    permissions: Object.freeze({
      search: true, fieldTransact: true, adminBackorder: true, ownerEdit: true
    })
  })
});

/** A permission set that matches no named profile. */
export const CUSTOM = 'CUSTOM';

export class RoleError extends Error {
  constructor(message, code = 'ROLE') {
    super(message);
    this.name = 'RoleError';
    this.code = code;
  }
}

/** The permissions a profile grants. */
export function permissionsFor(profileKey) {
  const key = String(profileKey ?? '').toUpperCase();
  const profile = ROLE_PROFILES[key];

  if (!profile) {
    throw new RoleError(
      `Role must be one of: ${Object.keys(ROLE_PROFILES).join(', ')}.`,
      'BAD_PROFILE'
    );
  }

  return { ...profile.permissions };
}

/**
 * The profile a permission set corresponds to, or CUSTOM.
 *
 * FMRv3's editor silently coerced CUSTOM to READ_ONLY when opening such a
 * user, so saving them quietly stripped their access. Returning CUSTOM
 * honestly lets the caller show it and leave it alone.
 */
export function profileFromPermissions(permissions) {
  const given = {
    search: !!permissions?.search,
    fieldTransact: !!permissions?.fieldTransact,
    adminBackorder: !!permissions?.adminBackorder,
    ownerEdit: !!permissions?.ownerEdit
  };

  for (const profile of Object.values(ROLE_PROFILES)) {
    const p = profile.permissions;
    if (p.search === given.search
      && p.fieldTransact === given.fieldTransact
      && p.adminBackorder === given.adminBackorder
      && p.ownerEdit === given.ownerEdit) {
      return profile.key;
    }
  }

  return CUSTOM;
}

/** Profiles for a picker, in order of increasing access. */
export function listProfiles() {
  return Object.values(ROLE_PROFILES).map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    permissions: { ...p.permissions }
  }));
}

/** Sign-in is by Google account, so the address has to look like one. */
export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim().toLowerCase());
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}
