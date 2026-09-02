/**
 * Running the drawing extractor.
 *
 * This is the only place in the system that starts another process or writes
 * to disk, and both are deliberately confined here. The extractor is Python —
 * reading a PDF's text layer well is work Node has no real equivalent for — so
 * it is handed a directory of PDFs and prints back what it found as JSON.
 *
 * Everything it needs is passed as arguments, never through a shell: a
 * drawing's filename comes from an upload and must not be able to become part
 * of a command.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { LedgerError } from '../../core/src/domain/ledger.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the extractor lives and how to run it.
 *
 * Read at the point of use rather than held in a config object, which is how
 * the rest of the system reads its environment.
 */
const python = () => process.env.FMR_PYTHON || 'python3';
const extractorHome = () =>
  process.env.FMR_EXTRACT_HOME || join(here, '../../extract-iso');
const timeoutMs = () => Number(process.env.FMR_EXTRACT_TIMEOUT_MS) || 300_000;

/**
 * A name safe to write to disk.
 *
 * The extractor reads a drawing number off the page rather than the filename,
 * so nothing depends on this being faithful — only on it being harmless.
 */
function safeName(name, index) {
  const cleaned = basename(String(name ?? ''))
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${index + 1}_drawing.pdf`;
}

/** Every PDF is written into one directory, which is what the extractor reads. */
async function writePackage(dir, files) {
  await Promise.all(files.map((file, index) =>
    writeFile(join(dir, safeName(file.name, index)), file.data)));
}

/**
 * Start the extractor and collect what it prints.
 *
 * stdout carries JSON and nothing else; anything the parser wants to say goes
 * to stderr, which is kept for the failure message and otherwise ignored.
 */
function runExtractor(dir, iwpNumber) {
  return new Promise((resolve, reject) => {
    const args = ['-m', 'iso_bom.fmr_json', '--input', dir];
    if (iwpNumber) args.push('--iwp-number', iwpNumber);

    const child = spawn(python(), args, {
      cwd: extractorHome(),
      // Arguments as an array and no shell, so a filename cannot become part
      // of a command however it is spelled.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs());

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });

    child.on('error', (cause) => {
      clearTimeout(timer);
      // The usual cause is no Python on the host, which is a deployment
      // problem and not something the person uploading can fix.
      reject(new LedgerError(
        'The drawing reader is not installed on this server. Tell whoever set it up.',
        'NO_EXTRACTOR'
      ));
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        return reject(new LedgerError(
          'Reading those drawings took too long and was stopped. '
            + 'Try a smaller package.',
          'EXTRACT_TIMEOUT'
        ));
      }

      // Exit 2 means it read the package and found no drawings in it. That is
      // an answer, not a crash, and deserves its own message.
      if (code === 2) {
        return reject(new LedgerError(
          'No drawings were found in those files.',
          'NO_DRAWINGS'
        ));
      }

      if (code !== 0) {
        console.error('drawing extractor failed:', err.trim());
        return reject(new LedgerError(
          'Those drawings could not be read. Check they are the right files.',
          'EXTRACT_FAILED'
        ));
      }

      try {
        resolve(JSON.parse(out));
      } catch {
        console.error('drawing extractor wrote unparseable output:', out.slice(0, 400));
        reject(new LedgerError(
          'The drawing reader returned something unexpected.',
          'EXTRACT_BAD_OUTPUT'
        ));
      }
    });
  });
}

/**
 * Read a package of drawing PDFs.
 *
 * @param {Array<{name: string, data: Buffer}>} files
 * @param {{ iwpNumber?: string }} options
 * @returns {Promise<object>} the payload `toDraftSheets` expects
 */
export async function extractDrawings(files, { iwpNumber } = {}) {
  if (!files?.length) throw new LedgerError('No drawings were uploaded.', 'NO_FILE');

  const dir = await mkdtemp(join(tmpdir(), 'fmr-drawings-'));
  try {
    await writePackage(dir, files);
    return await runExtractor(dir, iwpNumber);
  } finally {
    // The uploads are somebody's project documents; they do not outlive the
    // read on any path, including a timeout or a crash in the parser.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
