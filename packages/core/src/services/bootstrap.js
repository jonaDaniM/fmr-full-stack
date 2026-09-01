/**
 * What the field screen needs to know when it starts.
 *
 * Backorder reasons and units are closed lists — a crew picks one so the
 * office gets a consistent answer. Storage locations are not: a warehouse
 * invents new ones faster than anyone maintains a list, so those are free text
 * with the known ones offered as suggestions.
 *
 * FMRv3 called this FREE_TEXT_WITH_SUGGESTIONS and served the same three
 * lists (FieldMetadataService.gs).
 */

const LIMITS = Object.freeze({
  storageLocation: 100,
  notes: 500,
  issuedToName: 120,
  bagTagNumber: 40
});

/**
 * @param {object} client   pooled pg client
 * @param {string} projectId
 * @param {object} ctx      { user, permissions } from authenticate()
 */
export async function getBootstrap(client, projectId, ctx) {
  const { rows } = await client.query(
    `SELECT list_name, value FROM lists
      WHERE (project_id = $1 OR project_id IS NULL)
        AND active
        AND list_name = ANY($2::text[])
      ORDER BY list_name, sort_order, value`,
    [projectId, ['BACKORDER_REASON', 'UOM', 'PRIORITY', 'STORAGE_LOCATION']]
  );

  const lists = {};
  for (const row of rows) (lists[row.list_name] ??= []).push(row.value);

  // Locations the crews have actually used recently are better suggestions
  // than a list somebody curated once, so fold them in.
  const { rows: used } = await client.query(
    `SELECT DISTINCT storage_location FROM fmr_lines
      WHERE project_id = $1 AND storage_location IS NOT NULL
        AND storage_location <> ''
      ORDER BY storage_location
      LIMIT 100`,
    [projectId]
  );

  const locations = [...new Set([
    ...(lists.STORAGE_LOCATION ?? []),
    ...used.map((r) => r.storage_location)
  ])].sort();

  const { rows: controls } = await client.query(
    'SELECT field_locked, lock_reason FROM project_controls WHERE project_id = $1',
    [projectId]
  );

  return {
    user: {
      id: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.display_name
    },
    permissions: ctx.permissions,
    options: {
      backorderReasons: lists.BACKORDER_REASON ?? [],
      uoms: lists.UOM ?? [],
      priorities: lists.PRIORITY ?? [],
      storageLocations: locations
    },
    policy: {
      // Suggestions, not a constraint: a crew can type a location nobody
      // has recorded before.
      storageLocationMode: 'FREE_TEXT_WITH_SUGGESTIONS',
      storageLocationRequiredFor: ['CONFIRM_AVAILABLE', 'BAG'],
      storageLocationOptionalFor: ['DIRECT_ISSUE'],
      limits: LIMITS
    },
    controls: {
      fieldLocked: controls[0]?.field_locked ?? false,
      lockReason: controls[0]?.lock_reason ?? null
    }
  };
}

export { LIMITS };
