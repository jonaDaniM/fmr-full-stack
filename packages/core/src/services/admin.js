/**
 * Administration: who can use the system, what the dropdowns offer, and
 * renaming a published FMR.
 *
 * Three guards matter here, and all three are enforced on the server. FMRv3
 * checked two of them in the browser only, which meant they held for anyone
 * using the screen and not for anyone calling the API:
 *
 *   - the last active owner cannot be demoted or deactivated
 *   - nobody can deactivate themselves
 *   - deactivation needs a reason
 *
 * The second is new. FMRv3 had no such check, so an owner could lock
 * themselves out as long as one other owner existed.
 */

import { withTransaction } from '../db/pool.js';
import { LedgerError } from '../domain/ledger.js';
import {
  permissionsFor, profileFromPermissions, listProfiles,
  validEmail, normalizeEmail, RoleError
} from '../domain/roles.js';

const MIN_REASON = 3;
const clean = (v) => String(v ?? '').trim();

async function audit(client, projectId, user, entityType, entityId, action, payload) {
  await client.query(
    `INSERT INTO audit_log
       (project_id, entity_type, entity_id, action, payload, user_id,
        user_email, source_interface)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'OWNER')`,
    [projectId, entityType, String(entityId), action, payload, user.id, user.email]
  );
}

/** How many active owners this project has, and whether one of them is theirs. */
async function ownerCount(client, projectId, excludingUserId = null) {
  const { rows } = await client.query(
    `SELECT count(*) AS n
       FROM project_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1
        AND m.can_owner_edit
        AND u.active
        AND ($2::uuid IS NULL OR m.user_id <> $2)`,
    [projectId, excludingUserId]
  );
  return Number(rows[0].n);
}

/** Everyone with access to this project. */
export async function listMembers(client, projectId) {
  const { rows } = await client.query(
    `SELECT u.id, u.email, u.display_name, u.active, u.last_login_at,
            u.deactivated_at, u.deactivated_reason,
            d.display_name AS deactivated_by_name,
            m.role, m.can_search, m.can_field_transact,
            m.can_admin_backorder, m.can_owner_edit, m.created_at
       FROM project_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN users d ON d.id = u.deactivated_by
      WHERE m.project_id = $1
      ORDER BY u.active DESC, u.display_name`,
    [projectId]
  );

  return {
    profiles: listProfiles(),
    members: rows.map((row) => {
      const permissions = {
        search: row.can_search,
        fieldTransact: row.can_field_transact,
        adminBackorder: row.can_admin_backorder,
        ownerEdit: row.can_owner_edit
      };

      return {
        id: row.id,
        email: row.email,
        name: row.display_name,
        active: row.active,
        // Reported honestly as CUSTOM when the flags match no named profile,
        // rather than silently rounded down to the nearest one.
        profile: profileFromPermissions(permissions),
        role: row.role,
        permissions,
        lastLoginAt: row.last_login_at,
        deactivatedAt: row.deactivated_at,
        deactivatedBy: row.deactivated_by_name,
        deactivatedReason: row.deactivated_reason,
        memberSince: row.created_at
      };
    })
  };
}

/**
 * Add someone to the project, or change what they can do.
 *
 * Identity is the email address, since that is what Google signs them in with.
 * A user unknown to the system is created; an existing one is added to this
 * project or has their permissions changed.
 */
export async function saveMember(ctx, { email, name, profile }) {
  const { user, projectId } = ctx;
  const address = normalizeEmail(email);

  if (!validEmail(address)) {
    throw new LedgerError('Enter a valid Google account email address.', 'BAD_EMAIL');
  }

  let permissions;
  try {
    permissions = permissionsFor(profile);
  } catch (error) {
    if (error instanceof RoleError) throw new LedgerError(error.message, error.code);
    throw error;
  }

  const displayName = clean(name);
  if (!displayName) throw new LedgerError('A name is required.', 'MISSING_NAME');

  return withTransaction(async (client) => {
    const { rows: userRows } = await client.query(
      `INSERT INTO users (email, display_name)
       VALUES ($1,$2)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, email, display_name, active`,
      [address, displayName]
    );
    const member = userRows[0];

    const { rows: existing } = await client.query(
      'SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, member.id]
    );

    // Demoting the last owner would leave the project unadministrable.
    if (existing[0]?.can_owner_edit && !permissions.ownerEdit) {
      if (await ownerCount(client, projectId, member.id) === 0) {
        throw new LedgerError(
          'At least one active owner must remain on this project.', 'LAST_OWNER'
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO project_members
         (project_id, user_id, role, can_search, can_field_transact,
          can_admin_backorder, can_owner_edit)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         can_search = EXCLUDED.can_search,
         can_field_transact = EXCLUDED.can_field_transact,
         can_admin_backorder = EXCLUDED.can_admin_backorder,
         can_owner_edit = EXCLUDED.can_owner_edit
       RETURNING *`,
      [
        projectId, member.id, String(profile).toUpperCase(),
        permissions.search, permissions.fieldTransact,
        permissions.adminBackorder, permissions.ownerEdit
      ]
    );

    await audit(client, projectId, user, 'USER', member.id,
      existing[0] ? 'MEMBER_UPDATED' : 'MEMBER_ADDED',
      { email: address, profile: String(profile).toUpperCase(), permissions });

    return {
      ok: true,
      member: {
        id: member.id,
        email: member.email,
        name: member.display_name,
        active: member.active,
        profile: profileFromPermissions(permissions),
        permissions
      }
    };
  });
}

/**
 * Deactivate or reactivate someone.
 *
 * Never a delete: their name has to keep resolving on every transaction they
 * ever performed.
 */
export async function setMemberActive(ctx, { userId, active, reason }) {
  const { user, projectId } = ctx;
  const why = clean(reason);

  if (!active) {
    if (userId === user.id) {
      throw new LedgerError(
        'You cannot deactivate your own account. Ask another owner.', 'SELF_DEACTIVATE'
      );
    }
    if (why.length < MIN_REASON) {
      throw new LedgerError(
        `Deactivating someone needs a reason of at least ${MIN_REASON} characters.`,
        'MISSING_REASON'
      );
    }
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT u.*, m.can_owner_edit
         FROM users u
         JOIN project_members m ON m.user_id = u.id AND m.project_id = $2
        WHERE u.id = $1
        FOR UPDATE OF u`,
      [userId, projectId]
    );

    const member = rows[0];
    if (!member) throw new LedgerError('That user is not on this project.', 'NOT_FOUND');

    if (!active && member.can_owner_edit
      && await ownerCount(client, projectId, userId) === 0) {
      throw new LedgerError(
        'At least one active owner must remain on this project.', 'LAST_OWNER'
      );
    }

    await client.query(
      `UPDATE users
          SET active = $2,
              deactivated_by     = CASE WHEN $2 THEN NULL ELSE $3 END,
              deactivated_at     = CASE WHEN $2 THEN NULL ELSE now() END,
              deactivated_reason = CASE WHEN $2 THEN NULL ELSE $4 END
        WHERE id = $1`,
      [userId, active, user.id, why || null]
    );

    await audit(client, projectId, user, 'USER', userId,
      active ? 'MEMBER_REACTIVATED' : 'MEMBER_DEACTIVATED',
      { email: member.email, reason: why || null, wasOwner: member.can_owner_edit });

    return { ok: true, active };
  });
}

// --- lists -----------------------------------------------------------------

/**
 * The dropdown values the crews see.
 *
 * In FMRv3 these could only be changed by editing the spreadsheet directly, so
 * adding a backorder reason meant finding someone with access to it.
 */
export async function listValues(client, projectId, listName) {
  const { rows } = await client.query(
    `SELECT * FROM lists
      WHERE (project_id = $1 OR project_id IS NULL)
        AND ($2::text IS NULL OR list_name = $2)
      ORDER BY list_name, sort_order, value`,
    [projectId, listName ?? null]
  );

  const byName = {};
  for (const row of rows) {
    (byName[row.list_name] ??= []).push({
      id: row.id,
      value: row.value,
      sortOrder: row.sort_order,
      active: row.active,
      // A value with no project applies everywhere and is not editable here.
      shared: row.project_id === null
    });
  }
  return byName;
}

export async function saveListValue(ctx, { id, listName, value, sortOrder }) {
  const { user, projectId } = ctx;
  const name = clean(listName).toUpperCase();
  const text = clean(value);

  if (!name) throw new LedgerError('A list name is required.', 'MISSING_FIELD');
  if (!text) throw new LedgerError('A value is required.', 'MISSING_FIELD');

  return withTransaction(async (client) => {
    if (id) {
      const { rows } = await client.query(
        `UPDATE lists SET value = $2, sort_order = coalesce($3, sort_order)
          WHERE id = $1 AND project_id = $4
          RETURNING *`,
        [id, text, sortOrder ?? null, projectId]
      );
      if (!rows[0]) {
        throw new LedgerError(
          'That value was not found, or is shared across projects and cannot be edited here.',
          'NOT_FOUND'
        );
      }

      await audit(client, projectId, user, 'LIST', id, 'LIST_VALUE_UPDATED',
        { listName: name, value: text });
      return { ok: true, value: rows[0] };
    }

    const { rows } = await client.query(
      `INSERT INTO lists (project_id, list_name, value, sort_order)
       VALUES ($1,$2,$3,coalesce($4, (
         SELECT coalesce(max(sort_order), -1) + 1 FROM lists
          WHERE list_name = $2 AND (project_id = $1 OR project_id IS NULL)
       )))
       ON CONFLICT (project_id, list_name, value)
         DO UPDATE SET active = true
       RETURNING *`,
      [projectId, name, text, sortOrder ?? null]
    );

    await audit(client, projectId, user, 'LIST', rows[0].id, 'LIST_VALUE_ADDED',
      { listName: name, value: text });

    return { ok: true, value: rows[0] };
  });
}

/**
 * Retire a value, or bring it back.
 *
 * Retiring hides it from the dropdowns going forward; anything already
 * recorded against it keeps its value.
 */
export async function setListValueActive(ctx, { id, active }) {
  const { user, projectId } = ctx;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE lists SET active = $2
        WHERE id = $1 AND project_id = $3
        RETURNING *`,
      [id, !!active, projectId]
    );
    if (!rows[0]) {
      throw new LedgerError(
        'That value was not found, or is shared across projects.', 'NOT_FOUND'
      );
    }

    await audit(client, projectId, user, 'LIST', id,
      active ? 'LIST_VALUE_RESTORED' : 'LIST_VALUE_RETIRED',
      { listName: rows[0].list_name, value: rows[0].value });

    return { ok: true, value: rows[0] };
  });
}

// --- renumber --------------------------------------------------------------

/**
 * Rename a published FMR.
 *
 * Material Management does reassign official numbers after issue. In FMRv3
 * this had to rewrite the number across six sheets that each carried a copy;
 * here it is stored once, so this is a single guarded update plus an audit row.
 */
export async function renumberFmr(ctx, { fmrId, newNumber, reason }) {
  const { user, projectId } = ctx;
  const number = clean(newNumber).toUpperCase();
  const why = clean(reason);

  if (!fmrId) throw new LedgerError('Which FMR?', 'MISSING_FIELD');
  if (!number) throw new LedgerError('A new FMR number is required.', 'MISSING_FIELD');
  if (why.length < MIN_REASON) {
    throw new LedgerError(
      `Renumbering needs a reason of at least ${MIN_REASON} characters.`,
      'MISSING_REASON'
    );
  }

  return withTransaction(async (client) => {
    const { rows: current } = await client.query(
      `SELECT * FROM fmr_headers WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [fmrId, projectId]
    );
    const header = current[0];
    if (!header) throw new LedgerError('That FMR was not found.', 'NOT_FOUND');

    if (header.fmr_number.toUpperCase() === number) {
      throw new LedgerError('That is already its number.', 'NO_CHANGE');
    }

    try {
      await client.query(
        `UPDATE fmr_headers
            SET fmr_number = $2, updated_by = $3,
                updated_at = now(), last_activity_at = now()
          WHERE id = $1`,
        [fmrId, number, user.id]
      );
    } catch (error) {
      // UNIQUE (project_id, fmr_number)
      if (error.code === '23505') {
        throw new LedgerError(`FMR ${number} already exists.`, 'NUMBER_IN_USE');
      }
      throw error;
    }

    await audit(client, projectId, user, 'FMR', fmrId, 'FMR_RENUMBERED',
      { from: header.fmr_number, to: number, reason: why });

    return { ok: true, fmrId, from: header.fmr_number, to: number };
  });
}
