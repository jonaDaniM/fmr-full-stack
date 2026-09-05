/**
 * Per-project import profiles.
 *
 * The built-in profiles are files beside the code and stay that way — they are
 * the baselines a new project starts from. Anything a person tunes is a row in
 * `import_profiles`, because the deployment's filesystem does not survive a
 * deploy and a profile that vanishes is worse than one that never existed.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LedgerError } from '../../core/src/domain/ledger.js';
import { validateProfile } from './profileFit.js';

const BUILT_IN_DIR = join(dirname(fileURLToPath(import.meta.url)), '../profiles');

/** The baselines that ship with the code. */
export const BUILT_IN = Object.freeze(['default', 'takeoff', 'extracted']);

const safeName = (name) => String(name ?? 'default').replace(/[^a-z0-9_-]/gi, '');

/** Read one of the built-in profiles, falling back to the baseline. */
export async function builtInProfile(name) {
  try {
    return JSON.parse(await readFile(join(BUILT_IN_DIR, `${safeName(name)}.json`), 'utf8'));
  } catch {
    return JSON.parse(await readFile(join(BUILT_IN_DIR, 'default.json'), 'utf8'));
  }
}

/**
 * Every profile this project can import with: the built-ins, plus its own.
 *
 * A project's profile shadows a built-in of the same name, so a project can
 * adjust "default" without every other project inheriting the change.
 */
export async function listProfiles(client, projectId) {
  const { rows } = await client.query(
    `SELECT id, name, description, based_on, updated_at
       FROM import_profiles WHERE project_id = $1 ORDER BY name`,
    [projectId]
  );

  const owned = rows.map((row) => ({
    id: row.id, name: row.name, description: row.description,
    basedOn: row.based_on, updatedAt: row.updated_at, builtIn: false
  }));

  const shadowed = new Set(owned.map((p) => p.name.toLowerCase()));
  const builtIns = BUILT_IN
    .filter((name) => !shadowed.has(name))
    .map((name) => ({
      id: null, name, description: null, basedOn: name,
      updatedAt: null, builtIn: true
    }));

  return [...owned, ...builtIns];
}

/**
 * The profile an import should use.
 *
 * A project's own row wins; otherwise the built-in file of that name; failing
 * both, the baseline. Never throws — an import with a missing profile should
 * read the drawings with the baseline rather than refuse the file outright.
 */
export async function resolveProfile(client, projectId, name) {
  const { rows } = await client.query(
    `SELECT definition FROM import_profiles
      WHERE project_id = $1 AND lower(name) = lower($2)`,
    [projectId, String(name ?? 'default')]
  );

  if (rows[0]) return rows[0].definition;
  return builtInProfile(name);
}

export async function getProfile(client, projectId, id) {
  const { rows } = await client.query(
    `SELECT * FROM import_profiles WHERE id = $1 AND project_id = $2`,
    [id, projectId]
  );
  if (!rows[0]) throw new LedgerError('That profile was not found.', 'NOT_FOUND');
  return rows[0];
}

/**
 * Create or replace a project's profile.
 *
 * Refuses one that could not produce a usable import — saving it would hand
 * the next person an empty batch with no reason for it.
 */
export async function saveProfile(client, ctx, { id, name, description, definition, basedOn }) {
  const problems = validateProfile(definition);
  if (problems.length) {
    throw new LedgerError(problems.join(' '), 'INVALID_PROFILE');
  }

  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new LedgerError('Give the profile a name.', 'NAME_REQUIRED');

  try {
    if (id) {
      const { rows } = await client.query(
        `UPDATE import_profiles
            SET name = $3, description = $4, definition = $5,
                updated_by = $6, updated_at = now()
          WHERE id = $1 AND project_id = $2
          RETURNING *`,
        [id, ctx.projectId, trimmed, description ?? null, definition, ctx.user.id]
      );
      if (!rows[0]) throw new LedgerError('That profile was not found.', 'NOT_FOUND');
      return rows[0];
    }

    const { rows } = await client.query(
      `INSERT INTO import_profiles
         (project_id, name, description, definition, based_on, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       RETURNING *`,
      [ctx.projectId, trimmed, description ?? null, definition,
        basedOn ?? 'default', ctx.user.id]
    );
    return rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw new LedgerError(
        `This project already has a profile called "${trimmed}". `
        + 'Open that one to change it, or pick a different name.',
        'NAME_IN_USE'
      );
    }
    throw error;
  }
}

export async function deleteProfile(client, ctx, id) {
  const { rowCount } = await client.query(
    `DELETE FROM import_profiles WHERE id = $1 AND project_id = $2`,
    [id, ctx.projectId]
  );
  if (!rowCount) throw new LedgerError('That profile was not found.', 'NOT_FOUND');
  return { deleted: true };
}
