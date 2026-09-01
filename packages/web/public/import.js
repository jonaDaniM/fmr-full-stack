/**
 * Import.
 *
 * Two kinds of file arrive here. A workbook of FMRs, which is what the office
 * has always produced. And the CSV that extract_materials.py writes after
 * reading drawings — same destination, different reader, and the page picks
 * between them by looking at what was actually dropped.
 *
 * Either way nothing is created until a person has read it. That is the whole
 * point of this screen.
 */

import { api, upload as uploadWithProgress, idempotencyKey } from './lib/api.js';
import { $, esc, n } from './lib/dom.js';
import { confirmAction } from './lib/modal.js';
import { toast, toastError } from './lib/toast.js';
import { initShell } from './lib/shell.js';

const state = { batch: null, extraction: null };

// --- upload ----------------------------------------------------------------

function renderDrop(message = null) {
  $('view').innerHTML = `
    ${message ? `<div class="issue issue-error" style="margin-bottom:var(--s-4)">${esc(message)}</div>` : ''}
    <div class="drop" id="drop">
      <h2>Drop a file here</h2>
      <p>An FMR workbook, or the CSV that the drawing extractor writes.
         Nothing is created until you have reviewed it.</p>
      <input id="file" type="file" accept=".xlsx,.xls,.csv">
      <label for="file" class="btn btn-primary">Choose file</label>
    </div>
    <p class="hint">Workbooks are read one sheet per FMR. An extraction CSV is
       read one drawing per FMR, and every line carries the page it came from.</p>`;

  const drop = $('drop');
  const file = $('file');

  file.onchange = () => file.files[0] && send(file.files[0]);

  for (const event of ['dragenter', 'dragover']) {
    drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const event of ['dragleave', 'drop']) {
    drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }

  drop.addEventListener('drop', (e) => {
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) send(dropped);
  });
}

/**
 * Which reader this file needs.
 *
 * The extractor's CSV always names the PDF each row came from and scores its
 * own confidence. No FMR workbook has those columns, so the header settles it
 * without asking the user to classify their own file.
 */
function looksExtracted(text) {
  const header = text.slice(0, 400).split(/\r?\n/)[0]?.toLowerCase() ?? '';
  return header.includes('source_pdf') && header.includes('confidence');
}

async function send(file) {
  const buffer = await file.arrayBuffer();

  // A CSV could be either kind, so read the header before choosing a route.
  const extracted = /\.csv$/i.test(file.name)
    && looksExtracted(new TextDecoder().decode(buffer.slice(0, 400)));

  renderUploading(file.name, extracted);

  const path = extracted
    ? `/api/import/extracted?filename=${encodeURIComponent(file.name)}`
    : `/api/import/stage?filename=${encodeURIComponent(file.name)}`;

  try {
    const result = await uploadWithProgress(path, buffer, {
      onProgress: (fraction) => {
        const bar = $('progress');
        if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
        // Once the bytes are up, the server is still parsing. Say so, rather
        // than leaving a full bar sitting under a stale label.
        if (fraction === 1) $('uploadWhat').textContent = 'Reading it…';
      }
    });

    state.extraction = result.description ?? null;
    await loadBatch(result.batchId);
  } catch (failure) {
    // The message used to be wiped by a timer three seconds later, which is
    // not long enough to read "that file is too large" and act on it.
    renderDrop(failure.message);
  }
}

function renderUploading(filename, extracted) {
  $('view').innerHTML = `
    <div class="drop">
      <h2>${esc(filename)}</h2>
      <p id="uploadWhat">${extracted ? 'Sending the extraction…' : 'Sending the workbook…'}</p>
      <div class="progress"><i id="progress" style="width:0%"></i></div>
    </div>`;
}

// --- review ----------------------------------------------------------------

async function loadBatch(batchId) {
  state.batch = await api(`/api/import/${batchId}`);
  renderBatch();
}

function renderBatch() {
  const batch = state.batch;
  const selectable = batch.items.filter((i) => i.status !== 'Blocked');
  const selected = batch.items.filter((i) => i.selected).length;

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${batch.summary.sheets}</span><span class="l">Sheets</span></div>
      <div class="stat"><span class="n">${batch.summary.lines}</span><span class="l">Lines</span></div>
      <div class="stat ${batch.summary.errors ? 'stat-danger' : ''}">
        <span class="n">${batch.summary.errors}</span><span class="l">Errors</span></div>
      <div class="stat ${batch.summary.warnings ? 'stat-warn' : ''}">
        <span class="n">${batch.summary.warnings}</span><span class="l">Warnings</span></div>
    </div>

    ${state.extraction ? `<div class="extract-note">${esc(state.extraction)}</div>` : ''}

    <p class="source-line">
      <strong>${esc(batch.sourceName)}</strong> &middot; read with the
      "${esc(batch.profileName)}" profile
      ${batch.summary.errors
        ? '&middot; errors must be fixed before publishing'
        : ''}
    </p>

    ${batch.items.length
      ? batch.items.map(renderItem).join('')
      : `<div class="empty">
           <h2>Nothing to review</h2>
           <p>No FMRs were found in that file. Check it is the right one, or that
              the sheet names match what the profile expects.</p>
           <button type="button" class="btn btn-primary" id="again">Try another file</button>
         </div>`}

    ${batch.items.length ? `
      <div class="publishbar">
        <span>${selected} of ${selectable.length} selected</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-quiet" id="again">Start over</button>
        <button type="button" class="btn btn-primary" id="publish"
                ${batch.summary.errors || !selected ? 'disabled' : ''}>
          Publish ${selected} FMR${selected === 1 ? '' : 's'}
        </button>
      </div>` : ''}`;

  $('publish')?.addEventListener('click', publish);
  $('again')?.addEventListener('click', () => {
    state.batch = null;
    state.extraction = null;
    renderDrop();
  });
}

function renderItem(item) {
  const cls = item.status === 'Blocked' ? 'blocked' : item.isDuplicate ? 'dup' : '';

  return `<section class="item ${cls}" data-item="${esc(item.id)}">
    <div class="item-head">
      <input type="checkbox" data-select="${esc(item.id)}"
             ${item.selected ? 'checked' : ''}
             ${item.status === 'Blocked' ? 'disabled' : ''}
             aria-label="Include ${esc(item.fmrNumber ?? item.sheetName)}">
      <span class="name">${esc(item.fmrNumber ?? '(no FMR number)')}</span>
      <span class="dim">${esc(item.isoNumber ?? '')} sht ${esc(item.isoSheet ?? '')}
        &middot; ${item.lines.length} lines &middot; sheet "${esc(item.sheetName)}"</span>
      ${item.isDuplicate ? '<span class="pill pill-warn">Already exists</span>' : ''}
      ${item.status === 'Blocked' ? '<span class="pill pill-danger">Blocked</span>' : ''}
    </div>

    ${item.issues.length ? `<div class="issues">
      ${item.issues.map((issue) => `
        <div class="issue issue-${esc(issue.severity)}">
          ${issue.sourceRow ? `<span class="where">Row ${esc(issue.sourceRow)}</span>` : ''}
          <span>${esc(issue.message)}</span>
        </div>`).join('')}
    </div>` : ''}

    <div class="tw"><table>
      <thead><tr>
        <th class="w-tiny">#</th><th class="w-sm">Source row</th>
        <th class="w-md">Code</th><th class="w-sm">Size</th>
        <th class="w-grow">Description</th><th class="num w-sm">Qty</th><th class="w-sm">UOM</th>
      </tr></thead>
      <tbody>${item.lines.map((l) => `
        <tr data-line="${esc(l.id)}" ${rowIsFlagged(item, l) ? 'class="row-bad"' : ''}>
          <td class="num">${esc(l.lineNumber)}</td>
          <td class="dim num">${esc(l.sourceRow ?? '')}</td>
          <td class="mono" contenteditable data-field="commodityCode">${esc(l.commodityCode ?? '')}</td>
          <td class="mono" contenteditable data-field="size">${esc(l.size ?? '')}</td>
          <td contenteditable data-field="description">${esc(l.description ?? '')}</td>
          <td class="num" contenteditable data-field="quantity">${n(l.quantity)}</td>
          <td class="mono" contenteditable data-field="uom">${esc(l.uom ?? '')}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </section>`;
}

/** An issue names a source row; mark that row so it can be found by eye. */
const rowIsFlagged = (item, line) =>
  line.sourceRow != null
  && item.issues.some((i) => i.severity === 'error' && i.sourceRow === line.sourceRow);

// --- edits -----------------------------------------------------------------

// Scoped to the view, not the document: the old listeners fired on any change
// or blur anywhere on the page, including the project selector.
$('view').addEventListener('change', (event) => {
  const box = event.target.closest('input[data-select]');
  if (!box || !state.batch) return;

  const item = state.batch.items.find((i) => i.id === box.dataset.select);
  if (!item) return;

  item.selected = box.checked;

  // Update only the publish bar. Re-rendering everything used to destroy
  // scroll position and any half-typed cell.
  updatePublishBar();
});

function updatePublishBar() {
  const batch = state.batch;
  const selectable = batch.items.filter((i) => i.status !== 'Blocked');
  const selected = batch.items.filter((i) => i.selected).length;

  const bar = document.querySelector('.publishbar');
  if (!bar) return;

  bar.firstElementChild.textContent = `${selected} of ${selectable.length} selected`;

  const button = $('publish');
  button.disabled = Boolean(batch.summary.errors) || !selected;
  button.textContent = `Publish ${selected} FMR${selected === 1 ? '' : 's'}`;
}

/** Save a corrected cell when focus leaves it. */
$('view').addEventListener('focusout', async (event) => {
  const cell = event.target.closest('td[contenteditable]');
  if (!cell || !state.batch) return;

  const lineId = cell.closest('tr').dataset.line;
  const field = cell.dataset.field;
  const raw = cell.textContent.trim();
  const value = field === 'quantity' ? Number(raw.replace(/,/g, '')) : raw;

  if (field === 'quantity' && !Number.isFinite(value)) {
    cell.classList.add('bad');
    return;
  }
  cell.classList.remove('bad');
  cell.classList.add('saving');

  try {
    await api('/api/import/line', {
      method: 'POST',
      body: JSON.stringify({ lineId, patch: { [field]: value } })
    });

    for (const item of state.batch.items) {
      const line = item.lines.find((l) => l.id === lineId);
      if (line) line[field] = value;
    }

    cell.classList.remove('saving');
    cell.classList.add('saved');
    setTimeout(() => cell.classList.remove('saved'), 900);
  } catch (failure) {
    cell.classList.remove('saving');
    cell.classList.add('bad');
    toastError(failure.message);
  }
});

async function publish() {
  const items = state.batch.items.filter((i) => i.selected);

  const sure = await confirmAction({
    title: `Publish ${items.length} FMR${items.length === 1 ? '' : 's'}?`,
    lede: state.batch.sourceName,
    body: `<p class="dim">The crews will see ${items.length === 1 ? 'it' : 'them'}
           immediately and can start pulling material. Publishing cannot be undone —
           a mistake afterwards has to be corrected on the ledger.</p>`,
    confirmLabel: 'Publish'
  });
  if (!sure) return;

  const button = $('publish');
  button.disabled = true;
  button.textContent = 'Publishing…';

  try {
    const result = await api('/api/import/publish', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey() },
      body: JSON.stringify({
        batchId: state.batch.id,
        itemIds: items.map((i) => i.id)
      })
    });

    toast(`Published ${result.count} FMR${result.count === 1 ? '' : 's'}.`);
    renderPublished(result.count);
  } catch (failure) {
    toastError(failure.message);
    button.disabled = false;
    updatePublishBar();
  }
}

/** Say what happened, and offer somewhere to go, rather than a bare drop zone. */
function renderPublished(count) {
  state.batch = null;
  state.extraction = null;

  $('view').innerHTML = `
    <div class="empty">
      <h2>${count} FMR${count === 1 ? '' : 's'} published</h2>
      <p>They are live. The crews can search for this material now.</p>
      <div style="display:flex;gap:var(--s-3);justify-content:center;margin-top:var(--s-4)">
        <a class="btn btn-primary" href="/admin.html">See the register</a>
        <button type="button" class="btn btn-quiet" id="again">Import another</button>
      </div>
    </div>`;

  $('again').onclick = () => renderDrop();
}

await initShell({
  current: 'import',
  onProjectChange: async () => {
    // A staged batch belongs to the project it was uploaded against, so
    // switching projects abandons the review. Ask before it disappears, and
    // refuse the switch if the answer is no.
    if (state.batch) {
      const sure = await confirmAction({
        title: 'Leave this review?',
        lede: state.batch.sourceName,
        body: '<p class="dim">The file stays staged on the other project, but this ' +
              'page has no way back to it. You would need to upload it again.</p>',
        confirmLabel: 'Leave it',
        danger: true
      });
      if (!sure) return false;
    }
    state.batch = null;
    state.extraction = null;
    renderDrop();
  }
});

renderDrop();
