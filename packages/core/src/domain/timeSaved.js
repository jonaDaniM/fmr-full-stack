/**
 * What reading a package of drawings would have cost by hand.
 *
 * These are not guesses. They were measured against a technically proficient
 * operator typing a real FMR from real drawings, and the model deliberately
 * excludes everything around the work — finding the email, downloading the
 * package, waiting for a machine, checking it afterwards — so the number is a
 * floor rather than a flattering estimate.
 *
 * It exists because the case for this system is made in hours, not features.
 * Ported from the extractor's time_savings.py, which is where the measurements
 * were taken; the constants and the version string are kept identical so the
 * two never quietly disagree.
 */

export const TIME_MODEL_VERSION = 'manual-active-v1';

/** Opening the package, reading the cover, setting up the workbook. */
const PACKAGE_SECONDS = 17.30;

/** Per drawing: finding it, reading its number and revision, starting a sheet. */
const ISO_SECONDS = 33.36;

/** Per material row, typed and checked. */
const ROW_SECONDS = 20.00;

/**
 * A row whose description overruns its cell costs more: it has to be
 * retyped or wrapped by hand rather than pasted.
 */
const OVERFLOW_ROW_SECONDS = 26.00;
const OVERFLOW_DESCRIPTION_LENGTH = 52;

/** Does this description overrun the cell it has to fit in? */
export function isOverflowDescription(description) {
  return String(description ?? '').length > OVERFLOW_DESCRIPTION_LENGTH;
}

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

/**
 * Seconds of manual work a read package replaced.
 *
 * @param {{drawings: number, rows: number, overflowRows: number}} counts
 * @returns {{seconds: number|null, available: boolean, ...}}
 */
export function timeSaved({ drawings, rows, overflowRows = 0 } = {}) {
  const isoCount = whole(drawings);
  const rowCount = whole(rows);
  const overflow = Math.min(whole(overflowRows), rowCount);
  const normal = rowCount - overflow;

  const breakdown = { drawings: isoCount, rows: rowCount, overflowRows: overflow };

  // Nothing was read, so nothing was saved. Reported rather than shown as zero,
  // because "0 hours saved" and "we could not tell" are different claims.
  if (!isoCount) {
    return {
      version: TIME_MODEL_VERSION,
      available: false,
      reason: 'no drawings were read',
      seconds: null,
      ...breakdown
    };
  }

  const seconds = PACKAGE_SECONDS
    + ISO_SECONDS * isoCount
    + ROW_SECONDS * normal
    + OVERFLOW_ROW_SECONDS * overflow;

  return {
    version: TIME_MODEL_VERSION,
    available: true,
    reason: '',
    seconds: Math.round(seconds * 100) / 100,
    ...breakdown
  };
}

/**
 * The same number, said the way a person would say it.
 *
 * Rounded honestly: a measured estimate reported to the minute would claim a
 * precision the model does not have.
 */
export function describeTimeSaved(estimate) {
  if (!estimate?.available) return null;

  const minutes = estimate.seconds / 60;
  if (minutes < 1) return 'under a minute of typing';
  if (minutes < 90) {
    const rounded = Math.round(minutes / 5) * 5 || 1;
    return rounded === 1
      ? 'about a minute of typing'
      : `about ${rounded} minutes of typing`;
  }

  const hours = Math.round(minutes / 30) / 2;
  return `about ${hours} hours of typing`;
}
