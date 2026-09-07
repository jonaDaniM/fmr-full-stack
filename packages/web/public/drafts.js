/**
 * Drafts.
 *
 * An FMR waiting for someone to say it is right. They arrive three ways —
 * typed here, uploaded as a workbook, or read out of a drawing — and all three
 * land in the same queue, because the judgement is the same either way.
 *
 * Nothing published from here can be taken back, so publish re-checks with the
 * server rather than trusting the counts this page was drawn with.
 */

import { api, idempotencyKey } from './lib/api.js';
import { $, esc, n, day, skeleton, editableNumber, isoLabel } from './lib/dom.js';
import { dialog, confirmAction, askReason } from './lib/modal.js';
import { toast, toastError } from './lib/toast.js';
import { initShell, refuseUnless } from './lib/shell.js';
import { parsePaste } from './lib/paste.js';

const state = { tab: 'queue', drafts: null, editing: null, options: {} };

// --- the queue -------------------------------------------------------------

async function renderQueue() {
  const drafts = await api('/api/drafts');
  state.drafts = drafts;

  const withErrors = drafts.active.filter((d) => d.errorCount).length;

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${drafts.active.length}</span><span class="l">Waiting</span></div>
      <div class="stat ${withErrors ? 'stat-danger' : ''}">
        <span class="n">${withErrors}</span><span class="l">With errors</span></div>
      <div class="stat"><span class="n">${drafts.archived.length}</span><span class="l">Archived</span></div>
    </div>

    ${drafts.active.length
      ? drafts.active.map(renderDraft).join('')
      : `<div class="empty">
           <h2>Nothing waiting</h2>
           <p>Every draft has been published or archived. Start one with New FMR,
              or bring in a workbook or drawing from Import.</p>
         </div>`}

    ${drafts.archived.length ? `
      <details class="archived-box">
        <summary>Archived (${drafts.archived.length})</summary>
        <p>Archived drafts keep their id and their history. Restoring one puts it
           back in the queue.</p>
        ${drafts.archived.map(renderDraft).join('')}
      </details>` : ''}`;
}

function renderDraft(draft) {
  const blocked = draft.errorCount > 0;

  return `<div class="draft ${draft.archived ? 'archived' : ''} ${blocked ? 'blocked' : ''}"
             data-batch="${esc(draft.batchId)}" data-item="${esc(draft.itemId)}">
    <div class="who">
      <!-- Until the office issues a number the drawing is what names it. -->
      <span class="num">${esc(draft.fmrNumber
        || isoLabel(draft.isoNumber, draft.isoRevision) || '(no number yet)')}</span>
      ${draft.source === 'import' ? '<span class="pill pill-quiet">Imported</span>' : ''}
      ${draft.isDuplicate ? '<span class="pill pill-warn">Number already published</span>' : ''}
      ${blocked ? `<span class="pill pill-danger">${draft.errorCount} error${draft.errorCount === 1 ? '' : 's'}</span>` : ''}
      <div class="meta">
        <!-- Only when the heading is not already the drawing. An unnumbered
             card is headed by its ISO, and printing it twice reads as a bug. -->
        ${draft.fmrNumber
          ? `${esc(isoLabel(draft.isoNumber, draft.isoRevision))} &middot; ` : ''}
        ${esc(draft.lineCount)} line${draft.lineCount === 1 ? '' : 's'}
        ${draft.iwpNumber ? `&middot; IWP ${esc(draft.iwpNumber)}` : ''}
        ${draft.dateRequired ? `&middot; needed ${day(draft.dateRequired)}` : ''}
        &middot; ${esc(draft.createdBy ?? '')} ${day(draft.createdAt)}
      </div>
      ${draft.archiveReason
        ? `<div class="meta">Archived: ${esc(draft.archiveReason)}</div>` : ''}
    </div>
    <div class="acts">
      ${draft.archived
        ? `<button type="button" class="btn btn-sm" data-restore="${esc(draft.batchId)}">Restore</button>`
        : `<button type="button" class="btn btn-sm" data-edit="${esc(draft.itemId)}">
             ${blocked ? 'Fix' : 'Edit'}</button>
           <button type="button" class="btn btn-sm btn-primary" data-publish="${esc(draft.batchId)}"
                   ${blocked ? 'disabled title="Fix the errors first"' : ''}>Publish</button>
           <button type="button" class="btn btn-sm" data-archive="${esc(draft.batchId)}">Archive</button>`}
    </div>
  </div>`;
}

// --- new / edit ------------------------------------------------------------

function renderForm(draft = null) {
  const h = draft?.header ?? {};
  const priorities = state.options.priorities ?? ['Routine', 'High', 'Urgent'];

  $('view').innerHTML = `
    <div class="form">
      <h3>${draft ? `Editing ${esc(h.fmrNumber || 'draft')}` : 'New FMR'}</h3>
      <div class="grid">
        ${textField('fmrNumber', 'FMR number', h.fmrNumber, 'FMR-2026-0417')}
        ${textField('iwpNumber', 'IWP number', h.iwpNumber)}
        ${textField('isoNumber', 'Drawing', h.isoNumber, 'D-4410')}
        ${textField('isoSheet', 'Sheet', h.isoSheet, '01')}
        ${textField('requestedBy', 'Requested by', h.requestedBy)}
        <div class="field">
          <label for="dateRequired">Needed by</label>
          <input id="dateRequired" type="date" value="${esc(h.dateRequired ?? '')}">
        </div>
        <div class="field">
          <label for="priority">Priority</label>
          <select id="priority">
            <option value="">—</option>
            ${priorities.map((p) =>
              `<option ${p === h.priority ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select>
        </div>
      </div>

      ${draft ? '' : `
        <div class="field" style="margin-top:var(--s-4)">
          <label for="paste">Material lines</label>
          <textarea id="paste" rows="10" placeholder="Paste from a spreadsheet, or type one line each:

Commodity code | Size | Description | Qty | UOM | Location
PF-A106	6&quot;	PIPE, CS A106 GR B	120	FT	Rack 12
EL90-A234	6&quot;	ELBOW 90 LR, A234 WPB	18	EA	Rack 12"></textarea>
          <div class="paste-count" id="pasteCount">
            Tabs or commas both work. Sizes written as fractions, decimals, or
            mangled into dates by Excel are all read correctly.
          </div>
        </div>`}

      <div class="row">
        <button type="button" class="btn btn-primary" id="save">
          ${draft ? 'Save changes' : 'Create draft'}</button>
        <button type="button" class="btn btn-quiet" id="cancel">Cancel</button>
      </div>
    </div>

    <div class="issues" id="issues"></div>
    <div id="lines">${draft ? renderLines(draft.lines) : ''}</div>`;

  $('save').onclick = draft ? () => saveHeader(draft) : createDraft;
  $('cancel').onclick = () => { state.editing = null; switchTab('queue'); };

  // Say what the paste box parsed before anything is sent, not after.
  $('paste')?.addEventListener('input', showPasteCount);
}

const textField = (id, label, value, placeholder = '') => `
  <div class="field">
    <label for="${id}">${esc(label)}</label>
    <input id="${id}" value="${esc(value ?? '')}"
           ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}>
  </div>`;

function showPasteCount() {
  const lines = parsePaste($('paste').value);
  const box = $('pasteCount');

  box.innerHTML = lines.length
    ? `<strong>${lines.length}</strong> line${lines.length === 1 ? '' : 's'} read
       &middot; first: ${esc(lines[0].description || lines[0].commodityCode || '(blank)')}`
    : 'Tabs or commas both work. Sizes written as fractions, decimals, or ' +
      'mangled into dates by Excel are all read correctly.';
}

function renderLines(lines) {
  return `
    <div class="lines-head">
      <h3>Lines</h3>
      <span class="sub">${lines.length} line${lines.length === 1 ? '' : 's'}
        &middot; edits save when you leave a cell</span>
    </div>
    <div class="tw tw-sticky"><table>
      <thead><tr>
        <th class="w-tiny">#</th><th class="w-md">Code</th><th class="w-sm">Size</th>
        <th class="w-grow">Description</th><th class="num w-sm">Qty</th>
        <th class="w-sm">UOM</th><th class="w-md">Location</th><th class="w-sm"></th>
      </tr></thead>
      <tbody>
        ${lines.map((l) => `<tr data-line="${esc(l.id)}" data-number="${esc(l.lineNumber)}">
          <td class="num">${esc(l.lineNumber)}</td>
          <td class="mono" contenteditable data-field="commodityCode">${esc(l.commodityCode ?? '')}</td>
          <td class="mono" contenteditable data-field="size">${esc(l.size ?? '')}</td>
          <td contenteditable data-field="description">${esc(l.description ?? '')}</td>
          <td class="num" contenteditable data-field="quantity">${esc(editableNumber(l.quantity))}</td>
          <td class="mono" contenteditable data-field="uom">${esc(l.uom ?? '')}</td>
          <td contenteditable data-field="storageLocation">${esc(l.storageLocation ?? '')}</td>
          <td><div class="rowacts">
            <button type="button" class="btn btn-sm" data-drop="${esc(l.id)}">Remove</button>
          </div></td>
        </tr>`).join('')}
        <tr data-line="new">
          <td>+</td>
          <td class="mono" contenteditable data-field="commodityCode"></td>
          <td class="mono" contenteditable data-field="size"></td>
          <td contenteditable data-field="description"></td>
          <td class="num" contenteditable data-field="quantity"></td>
          <td class="mono" contenteditable data-field="uom"></td>
          <td contenteditable data-field="storageLocation"></td>
          <td><div class="rowacts">
            <button type="button" class="btn btn-sm" data-add>Add</button>
          </div></td>
        </tr>
      </tbody>
    </table></div>`;
}

/**
 * Which line an issue is about.
 *
 * The two paths name it differently: validating a save answers with
 * `lineNumber`, while reading the draft back gives `sourceRow`, because that
 * is the column it is stored in. Same number, so accept either.
 */
const issueLine = (issue) => issue.lineNumber ?? issue.sourceRow ?? null;

/**
 * Show what is wrong, attached to where it is wrong.
 *
 * The server tags every line issue with the line it is about and every header
 * issue with its field. Both used to be discarded, so an error on line 37 of a
 * 40-line draft appeared as text at the top of the page with nothing marking
 * the row it meant.
 */
function renderIssues(issues) {
  const box = $('issues');
  if (!box) return;

  // Clear previous marks before applying the current ones.
  for (const row of document.querySelectorAll('tr.row-bad')) row.classList.remove('row-bad');
  for (const field of document.querySelectorAll('.field.bad')) field.classList.remove('bad');

  if (!issues?.length) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = issues.map((issue) => {
    const line = issueLine(issue);

    if (line != null) {
      const row = document.querySelector(`tr[data-number="${CSS.escape(String(line))}"]`);
      row?.classList.add('row-bad');
    } else if (issue.field) {
      $(issue.field)?.closest('.field')?.classList.add('bad');
    }

    // An issue that names a row is a way to reach it, not just a label. The
    // message already begins "Line N:", so the tag does not repeat it.
    const tag = line != null ? `<span class="where">Line ${esc(line)}</span>` : '';
    const text = String(issue.message ?? '').replace(/^Line\s+\d+:\s*/, '');
    const body = `${tag}<span>${esc(text)}</span>`;

    return line != null
      ? `<button type="button" class="issue issue-${esc(issue.severity)}"
                 data-goto="${esc(line)}">${body}</button>`
      : `<div class="issue issue-${esc(issue.severity)}">${body}</div>`;
  }).join('');
}

async function createDraft() {
  const button = $('save');
  const header = readHeader();
  const lines = parsePaste($('paste').value);

  if (!lines.length) return toastError('Add at least one material line.');

  button.disabled = true;
  button.textContent = 'Creating…';

  try {
    const result = await api('/api/drafts', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey() },
      body: JSON.stringify({ header, lines })
    });

    toast(result.valid ? 'Draft created.' : 'Saved — some details still need fixing.');
    state.editing = null;
    switchTab('queue');
  } catch (failure) {
    toastError(failure.message);
    button.disabled = false;
    button.textContent = 'Create draft';
  }
}

async function saveHeader(draft) {
  const button = $('save');
  button.disabled = true;
  button.textContent = 'Saving…';

  try {
    const result = await api('/api/drafts/header', {
      method: 'POST',
      body: JSON.stringify({ itemId: draft.itemId, patch: readHeader() })
    });
    renderIssues(result.issues);
    toast(result.valid ? 'Saved.' : 'Saved — some details still need fixing.');
  } catch (failure) {
    toastError(failure.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Save changes';
  }
}

function readHeader() {
  return {
    fmrNumber: $('fmrNumber').value.trim(),
    iwpNumber: $('iwpNumber').value.trim(),
    isoNumber: $('isoNumber').value.trim(),
    isoSheet: $('isoSheet').value.trim(),
    requestedBy: $('requestedBy').value.trim(),
    dateRequired: $('dateRequired').value || null,
    priority: $('priority').value || null
  };
}

async function openDraft(itemId, { keepScroll = false } = {}) {
  const scroll = keepScroll ? window.scrollY : 0;

  try {
    const drafts = state.drafts ?? await api('/api/drafts');
    const summary = [...drafts.active, ...drafts.archived].find((d) => d.itemId === itemId);
    if (!summary) return toastError('That draft is no longer in the queue.');

    const batch = await api(`/api/import/${summary.batchId}`);
    // A batch holds every FMR read out of one package, so the one being opened
    // has to be picked by id. Taking items[0] opened the first FMR of the
    // package whichever card was clicked — a planner editing the 14th drawing
    // was shown, and would have edited, the 1st.
    const item = batch.items.find((i) => i.id === itemId);
    if (!item) return toastError('That draft is no longer in the queue.');

    state.editing = { itemId, batchId: summary.batchId };
    switchTab('new', false);
    renderForm({ itemId, header: item, lines: item.lines });
    renderIssues(item.issues);

    // Adding line 40 of 60 used to return you to the top of the page.
    if (keepScroll) window.scrollTo({ top: scroll });
  } catch (failure) {
    toastError(failure.message);
  }
}

// --- actions ---------------------------------------------------------------

async function publish(batchId) {
  const draft = state.drafts?.active.find((d) => d.batchId === batchId);
  if (!draft) return toastError('That draft is no longer in the queue.');

  // Ask the server what publishing would actually decide, rather than trusting
  // the counts this page was rendered with.
  let check;
  try {
    check = await api(`/api/drafts/${draft.itemId}/check`);
  } catch (failure) {
    return toastError(failure.message);
  }

  if (!check.canPublish) {
    // The queue has nowhere to put issues, so say why here rather than leaving
    // the reasons invisible behind a generic refusal.
    const problems = check.issues.filter((i) => i.severity === 'error');
    const sure = await confirmAction({
      title: 'Not ready to publish',
      lede: draft.fmrNumber || 'This draft',
      body: `<div class="issues">${problems.map((issue) => `
        <div class="issue issue-error">
          ${issueLine(issue) != null ? `<span class="where">Line ${esc(issueLine(issue))}</span>` : ''}
          <span>${esc(issue.message)}</span>
        </div>`).join('')}</div>`,
      confirmLabel: 'Open and fix'
    });
    if (sure) openDraft(draft.itemId);
    return;
  }

  const sure = await confirmAction({
    title: `Publish ${draft.fmrNumber}?`,
    lede: 'The crews will see it immediately and can start pulling material.',
    body: `<p class="dim">${esc(draft.lineCount)} line${draft.lineCount === 1 ? '' : 's'}
           on ${esc(draft.isoNumber ?? 'this drawing')}. Publishing cannot be undone —
           a mistake afterwards has to be corrected on the ledger.</p>`,
    confirmLabel: 'Publish it'
  });
  if (!sure) return;

  try {
    const result = await api('/api/import/publish', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey() },
      body: JSON.stringify({ batchId })
    });
    toast(`Published ${result.count} FMR${result.count === 1 ? '' : 's'}.`);
    switchTab('queue');
  } catch (failure) {
    toastError(failure.message);
  }
}

async function archive(batchId, restore = false) {
  const draft = [...(state.drafts?.active ?? []), ...(state.drafts?.archived ?? [])]
    .find((d) => d.batchId === batchId);

  await askReason({
    title: restore ? 'Restore this draft' : 'Archive this draft',
    lede: draft?.fmrNumber || 'Draft',
    label: restore ? 'Why are you restoring it?' : 'Why are you archiving it?',
    confirmLabel: restore ? 'Restore' : 'Archive',
    onSubmit: async (reason) => {
      await api('/api/drafts/archive', {
        method: 'POST',
        body: JSON.stringify({ batchId, reason, restore })
      });
      toast(restore ? 'Restored to the queue.' : 'Archived.');
      switchTab('queue');
    }
  });
}

/**
 * Save one edited row.
 *
 * The whole row is sent, not just the cell that changed — the server validates
 * a line as a unit, and a quantity is only wrong in the context of its UOM.
 */
async function saveLine(row, isNew) {
  const line = {};
  for (const cell of row.querySelectorAll('td[contenteditable]')) {
    line[cell.dataset.field] = cell.textContent.trim();
  }

  if (isNew && !line.description && !line.quantity) return;

  const cells = [...row.querySelectorAll('td[contenteditable]')];
  for (const cell of cells) cell.classList.add('saving');

  try {
    const result = await api('/api/drafts/line', {
      method: 'POST',
      body: JSON.stringify({
        itemId: state.editing.itemId,
        line: isNew ? line : { ...line, id: row.dataset.line }
      })
    });

    for (const cell of cells) {
      cell.classList.remove('saving');
      cell.classList.add('saved');
      setTimeout(() => cell.classList.remove('saved'), 900);
    }

    renderIssues(result.issues);
    if (isNew) openDraft(state.editing.itemId, { keepScroll: true });
  } catch (failure) {
    for (const cell of cells) cell.classList.remove('saving');
    toastError(failure.message);
  }
}

// --- wiring ----------------------------------------------------------------

$('tabs').onclick = (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) switchTab(button.dataset.tab);
};

function switchTab(tab, render = true) {
  state.tab = tab;
  for (const button of $('tabs').querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }

  if (!render) return;
  if (tab === 'queue') { state.editing = null; show(); }
  else renderForm();
}

async function show() {
  $('view').innerHTML = skeleton({ stats: 3, rows: 5 });
  try {
    await renderQueue();
  } catch (failure) {
    $('view').innerHTML = `
      <div class="empty">
        <h2>Could not load the queue</h2>
        <p>${esc(failure.message)}</p>
        <button type="button" class="btn btn-primary" id="retry">Try again</button>
      </div>`;
    $('retry').onclick = show;
  }
}

$('view').addEventListener('click', async (event) => {
  const target = (name) => event.target.closest(`button[data-${name}]`);

  const goto = target('goto');
  if (goto) {
    // Take the reader to the row the issue is about.
    const row = document.querySelector(`tr[data-number="${CSS.escape(goto.dataset.goto)}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.querySelector('td[contenteditable]')?.focus();
    return;
  }

  const edit = target('edit');
  if (edit) return openDraft(edit.dataset.edit);

  const pub = target('publish');
  if (pub) return publish(pub.dataset.publish);

  const arc = target('archive');
  if (arc) return archive(arc.dataset.archive, false);

  const res = target('restore');
  if (res) return archive(res.dataset.restore, true);

  const add = target('add');
  if (add) return saveLine(add.closest('tr'), true);

  const drop = target('drop');
  if (drop) {
    const row = drop.closest('tr');
    const description = row.querySelector('[data-field="description"]')?.textContent.trim();
    const sure = await confirmAction({
      title: 'Remove this line?',
      lede: `Line ${row.dataset.number}`,
      body: `<p>${esc(description || '(no description)')}</p>`,
      confirmLabel: 'Remove it',
      danger: true
    });
    if (!sure) return;

    try {
      await api('/api/drafts/line', {
        method: 'DELETE',
        body: JSON.stringify({ lineId: drop.dataset.drop })
      });
      openDraft(state.editing.itemId, { keepScroll: true });
    } catch (failure) {
      toastError(failure.message);
    }
  }
});

/** Save an edited cell when focus leaves it. */
$('view').addEventListener('focusout', (event) => {
  const cell = event.target.closest('td[contenteditable]');
  if (!cell || !state.editing) return;

  const row = cell.closest('tr');
  if (row.dataset.line !== 'new') saveLine(row, false);
});

/** Enter commits the row and moves down, the way a spreadsheet does. */
$('view').addEventListener('keydown', (event) => {
  const cell = event.target.closest('td[contenteditable]');
  if (!cell) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    const row = cell.closest('tr');
    const index = [...row.children].indexOf(cell);
    const next = row.nextElementSibling;
    (next ? next.children[index] : null)?.focus();
    cell.blur();
  }

  if (event.key === 'Escape') {
    // Leave the cell without committing whatever was half-typed.
    event.preventDefault();
    cell.blur();
  }
});

async function loadOptions() {
  try {
    const bootstrap = await api('/api/bootstrap');
    state.options = bootstrap.options;
  } catch { /* the form falls back to sensible defaults */ }
}

await initShell({
  current: 'drafts',
  onProjectChange: () => { state.editing = null; switchTab('queue'); }
});
if (!refuseUnless('ownerEdit', { what: 'The drafts queue' })) {
  await loadOptions();
  show();

  // Arriving from the review queue with a particular requisition in mind: open
  // that one rather than dropping the reader into the list to find it again.
  const wanted = new URLSearchParams(location.search).get('item');
  if (wanted) await openDraft(wanted);
}
