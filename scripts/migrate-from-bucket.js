/**
 * Load an FMRv3 export into the deployed database.
 *
 * The migrate package reads a directory of CSVs. In Cloud Run there is no
 * such directory and the export must not be baked into the image — it is a
 * client's live data, and an image sits in a registry indefinitely. This
 * fetches the export from a bucket into the container's own temp space,
 * loads it, and removes it.
 *
 *   node scripts/migrate-from-bucket.js gs://bucket/path PROJECT_CODE [--apply]
 *
 * Without --apply it validates and writes nothing, which is how to run it
 * first. Every count it reports is printed as it goes, so the run can be
 * followed in the logs rather than inspected afterwards.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../packages/migrate/src/index.js';

const [source, projectCode, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');

if (!source || !projectCode) {
  console.error('usage: node scripts/migrate-from-bucket.js gs://bucket PROJECT [--apply]');
  process.exit(1);
}

const SHEETS = [
  'Users', 'FMR_Header', 'FMR_Line_Items', 'Backorder_Requests',
  'Bag_Tag_Header', 'Bag_Tag_Items', 'Material_Transactions'
];

const bucket = source.replace(/^gs:\/\//, '').replace(/\/+$/, '');

/**
 * A token for the storage API, from the metadata server Cloud Run provides.
 * Nothing is installed for this — the service account the job already runs as
 * is the identity, and the bucket is private to the project.
 */
async function accessToken() {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!response.ok) throw new Error(`No credentials from the metadata server (${response.status}).`);
  return (await response.json()).access_token;
}

const directory = await mkdtemp(join(tmpdir(), 'fmr-migration-'));

try {
  const token = await accessToken();
  console.log(`fetching from gs://${bucket}`);

  for (const sheet of SHEETS) {
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}`
      + `/o/${encodeURIComponent(`${sheet}.csv`)}?alt=media`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });

    if (!response.ok) {
      // A missing sheet is not fatal — the migrator skips what is not there —
      // but it must be said out loud rather than discovered as a zero later.
      console.warn(`  ${sheet}.csv — not in the bucket (${response.status})`);
      continue;
    }

    const body = await response.text();
    await writeFile(join(directory, `${sheet}.csv`), body);
    console.log(`  ${sheet}.csv  ${body.length.toLocaleString()} bytes`);
  }

  console.log('');
  await migrate({ dir: directory, projectCode, projectName: 'FMR Operations', dryRun: !apply });

  if (!apply) console.log('\nrun again with --apply to write.');
} finally {
  // The export does not outlive the load, even if the load failed.
  await rm(directory, { recursive: true, force: true });
}

process.exit(0);
