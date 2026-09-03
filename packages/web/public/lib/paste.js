/**
 * Reading material lines out of a pasted spreadsheet.
 *
 * Somebody selects a block of a takeoff in Excel and pastes it into the draft
 * form. Excel puts tabs between cells; a CSV pasted from elsewhere uses commas.
 * Both arrive here as text, and this is the only place they are split — the
 * server is handed line objects, so a row dropped here is a row the server
 * never hears about and cannot warn anyone about.
 *
 * That makes the header-row guess the risky part. It used to be:
 *
 *     /commodity|code|desc|qty|quant/i.test(row) && !/^\d/.test(lastCell)
 *
 * which asks whether the row *mentions* one of those words. Real material
 * descriptions do: "5MG1, MODULAR GUIDE, SIZE CODE 1" and "CLAMP ON GUIDE
 * BERNECKER, SIZE CODE 1" are pipe supports, and 170 lines of the live project
 * carry one of these words in their description. Paste a block whose first row
 * is one of those and it was eaten as a heading — silently, with the line count
 * simply reading one lower than what was pasted.
 *
 * A heading row is not a row that mentions "code". It is a row where *every*
 * cell is a column label and none of them is data — no quantity, no size, no
 * part number. So that is what is asked here instead.
 *
 * This lives in its own file, with no DOM in it, so `paste.test.js` can run it
 * over the real descriptions from the project.
 */

/** The words a column heading is made of. */
const HEADING_WORDS = /^(commodity|commodity\s*code|code|item|item\s*no\.?|no\.?|#|size|npd|bore|desc|description|material|qty|quantity|quant|uom|unit|units|u\/m|loc|location|storage|storage\s*location|remarks|notes)$/i;

const splitRow = (row) => (row.includes('\t') ? row.split('\t') : row.split(','))
  .map((cell) => cell.trim());

/**
 * Is this row a set of column labels rather than a material line?
 *
 * Every non-empty cell has to be a heading word on its own. One cell of real
 * content — a part number, a quantity, a description — and it is a line, which
 * is the safe way round: mistaking a heading for a line shows the reviewer an
 * obviously wrong row they can delete, while mistaking a line for a heading
 * loses material with nothing on screen to say so.
 */
export function looksLikeHeading(cells) {
  const filled = cells.filter((cell) => cell !== '');
  if (filled.length < 2) return false;
  return filled.every((cell) => HEADING_WORDS.test(cell));
}

/**
 * Split pasted text into material lines.
 *
 * @param {string} text
 * @returns {Array<{commodityCode, size, description, quantity, uom, storageLocation}>}
 */
export function parsePaste(text) {
  const rows = String(text ?? '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (!rows.length) return [];

  const skipFirst = looksLikeHeading(splitRow(rows[0]));

  return rows.slice(skipFirst ? 1 : 0).map((row) => {
    const [commodityCode, size, description, quantity, uom, storageLocation] = splitRow(row);
    return { commodityCode, size, description, quantity, uom, storageLocation };
  });
}
