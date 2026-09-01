import pg from 'pg';

// Quantities are numeric(14,4). Postgres hands numerics back as strings to
// protect precision; the ledger works in numbers, so parse them on the way in.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) =>
  value === null ? null : Number(value)
);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000
});

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
