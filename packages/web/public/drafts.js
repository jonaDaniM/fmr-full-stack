/**
 * Draft FMRs.
 *
 * An FMR typed in by hand, sitting where it can be corrected before the crews
 * see it. Imported ones land in the same queue — where an FMR came from stops
 * mattering once it is waiting to be published.
 */

const state = { projectId: null, tab: 'queue', drafts: null, editing: null, options: {} };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
const day = (d) => d ? new Date(d).toLocaleDateString(undefined,
  { month: 'short', day: 'numeric' }) : '—';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.projectId ? { 'x-project-id': state.projectId } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// --- the queue -------------------------------------------------------------

async function renderQueue() {
  const drafts = await api('/api/drafts');
  state.drafts = drafts;

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${drafts.active.length}</div><div class="l">Waiting</div></div>
      <div class="stat ${drafts.active.some((d) => d.errorCount) ? 'warn' : ''}">
        <div class="n">${drafts.active.filter((d) => d.errorCount).length}</div>
        <div class="l">With errors</div></div>
      <div class="stat"><div class="n">${drafts.archived.length}</div><div class="l">Archived</div></div>
    </div>

    ${drafts.active.length
      ? drafts.active.map(renderDraft).join('')
      : '<p class="hint">Nothing waiting. Use New FMR to start one.</p>'}

    ${drafts.archived.length ? `
      <details style="margin-top:24px">
        <summary style="cursor:pointer;font-weight:600;padding:8px 0">
          Archived (${drafts.archived.length})
        </summary>
        <p class="hint" style="text-align:left;padding:6px 0 12px">
          Archived drafts keep their id and their history. Restoring one puts it
          back in the queue.
        </p>
        ${drafts.archived.map(renderDraft).join('')}
      </details>` : ''}
  `;
}

function renderDraft(draft) {
  const blocked = draft.errorCount > 0;

  return `<div class="draft ${draft.archived ? 'archived' : ''}" data-batch="${draft.batchId}"
             data-item="${draft.itemId}">
    <div class="who">
      <span class="num">${esc(draft.fmrNumber || '(no number yet)')}</span>
      ${draft.source === 'import' ? '<span class="pill">Imported</span>' : ''}
      ${draft.isDuplicate ? '<span class="pill warn">Number already published</span>' : ''}
      ${blocked ? `<span class="pill danger">${draft.errorCount} error${draft.errorCount === 1 ? '' : 's'}</span>` : ''}
      <div class="meta">
        ${esc(draft.isoNumber ?? '')} ${draft.isoSheet ? `sht ${esc(draft.isoSheet)}` : ''}
        &middot; ${draft.lineCount} line${draft.lineCount === 1 ? '' : 's'}
        ${draft.iwpNumber ? `&middot; IWP ${esc(draft.iwpNumber)}` : ''}
        ${draft.dateRequired ? `&middot; needed ${day(draft.dateRequired)}` : ''}
        &middot; ${esc(draft.createdBy ?? '')} ${day(draft.createdAt)}
      </div>
      ${draft.archiveReason
        ? `<div class="meta">Archived: ${esc(draft.archiveReason)}</div>` : ''}
    </div>
    <div class="acts">
      ${draft.archived
        ? `<button data-restore="${draft.batchId}">Restore</button>`
        : `<button data-edit="${draft.itemId}">Edit</button>
           <button class="ok" data-publish="${draft.batchId}" ${blocked ? 'disabled' : ''}>Publish</button>
           <button data-archive="${draft.batchId}">Archive</button>`}
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
        <div><label for="fmrNumber">FMR number</label>
          <input id="fmrNumber" value="${esc(h.fmrNumber ?? '')}"
                 placeholder="FMR-2026-0417"></div>
        <div><label for="iwpNumber">IWP number</label>
          <input id="iwpNumber" value="${esc(h.iwpNumber ?? '')}"></div>
        <div><label for="isoNumber">Drawing</label>
          <input id="isoNumber" value="${esc(h.isoNumber ?? '')}" placeholder="D-4410"></div>
        <div><label for="isoSheet">Sheet</label>
          <input id="isoSheet" value="${esc(h.isoSheet ?? '')}" placeholder="01"></div>
        <div><label for="requestedBy">Requested by</label>
          <input id="requestedBy" value="${esc(h.requestedBy ?? '')}"></div>
        <div><label for="dateRequired">Needed by</label>
          <input id="dateRequired" type="date" value="${esc(h.dateRequired ?? '')}"></div>
        <div><label for="priority">Priority</label>
          <select id="priority">
            <option value="">—</option>
            ${priorities.map((p) =>
              `<option ${p === h.priority ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select></div>
      </div>

      ${draft ? '' : `
        <label for="paste" style="display:block;font-size:12px;font-weight:700;
               text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);
               margin:16px 0 5px">Material lines</label>
        <textarea id="paste" rows="10" placeholder="Paste from a spreadsheet, or type one line each:

Commodity code | Size | Description | Qty | UOM | Location
PF-A106	6&quot;	PIPE, CS A106 GR B	120	FT	Rack 12
EL90-A234	6&quot;	ELBOW 90 LR, A234 WPB	18	EA	Rack 12"></textarea>
        <p class="hint" style="text-align:left;padding:6px 0 0;font-size:13px">
          Tabs or commas both work. Sizes written as fractions, decimals, or
          mangled into dates by Excel are all read correctly.
        </p>`}

      <div class="row">
        <button class="ok" id="save">${draft ? 'Save changes' : 'Create draft'}</button>
        <button id="cancel">Cancel</button>
      </div>
    </div>

    <div id="issues"></div>
    <div id="lines">${draft ? renderLines(draft.lines) : ''}</div>
  `;

  $('save').onclick = draft ? () => saveHeader(draft) : createDraft;
  $('cancel').onclick = () => { state.editing = null; switchTab('queue'); };
}

function renderLines(lines) {
  return `
    <h3 style="font-size:15px;margin:22px 0 10px">Lines</h3>
    <div class="tw"><table>
      <thead><tr>
        <th>#</th><th>Code</th><th>Size</th><th>Description</th>
        <th class="num">Qty</th><th>UOM</th><th>Location</th><th></th>
      </tr></thead>
      <tbody>
        ${lines.map((l) => `<tr data-line="${l.id}">
          <td class="mono">${l.lineNumber}</td>
          <td class="mono" contenteditable data-field="commodityCode">${esc(l.commodityCode ?? '')}</td>
          <td class="mono" contenteditable data-field="size">${esc(l.size ?? '')}</td>
          <td contenteditable data-field="description">${esc(l.description ?? '')}</td>
          <td class="num" contenteditable data-field="quantity">${n(l.quantity)}</td>
          <td class="mono" contenteditable data-field="uom">${esc(l.uom ?? '')}</td>
          <td contenteditable data-field="storageLocation">${esc(l.storageLocation ?? '')}</td>
          <td><div class="rowacts"><button data-drop="${l.id}">Remove</button></div></td>
        </tr>`).join('')}
        <tr data-line="new">
          <td class="dim">+</td>
          <td class="mono" contenteditable data-field="commodityCode"></td>
          <td class="mono" contenteditable data-field="size"></td>
          <td contenteditable data-field="description"></td>
          <td class="num" contenteditable data-field="quantity"></td>
          <td class="mono" contenteditable data-field="uom"></td>
          <td contenteditable data-field="storageLocation"></td>
          <td><div class="rowacts"><button data-add>Add</button></div></td>
        </tr>
      </tbody>
    </table></div>`;
}

function renderIssues(issues) {
  const box = $('issues');
  if (!box) return;

  box.innerHTML = issues?.length
    ? issues.map((i) => `<div class="issue ${esc(i.severity)}">${esc(i.message)}</div>`).join('')
    : '';
}

async function createDraft() {
  const header = readHeader();
  const lines = parsePaste($('paste').value);

  if (!lines.length) return toast('Add at least one material line.');

  try {
    const result = await api('/api/drafts', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ header, lines })
    });

    toast(result.valid ? 'Draft created.' : 'Saved — some details still need fixing.');
    state.editing = null;
    switchTab('queue');
  } catch (failure) {
    toast(failure.message);
  }
}

async function saveHeader(draft) {
  try {
    const result = await api('/api/drafts/header', {
      method: 'POST',
      body: JSON.stringify({ itemId: draft.itemId, patch: readHeader() })
    });
    renderIssues(result.issues);
    toast(result.valid ? 'Saved.' : 'Saved — some details still need fixing.');
  } catch (failure) {
    toast(failure.message);
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

/** Same shape the server parses; kept here so the count can be shown first. */
function parsePaste(text) {
  const rows = String(text ?? '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (!rows.length) return [];

  const split = (row) => (row.includes('\t') ? row.split('\t') : row.split(','))
    .map((cell) => cell.trim());

  const first = split(rows[0]);
  const header = /commodity|code|desc|qty|quant/i.test(first.join(' '))
    && !/^\d/.test(first[first.length - 1] ?? '');

  return rows.slice(header ? 1 : 0).map((row) => {
    const [commodityCode, size, description, quantity, uom, storageLocation] = split(row);
    return { commodityCode, size, description, quantity, uom, storageLocation };
  });
}

async function openDraft(itemId) {
  try {
    const drafts = state.drafts ?? await api('/api/drafts');
    const summary = [...drafts.active, ...drafts.archived].find((d) => d.itemId === itemId);
    if (!summary) return toast('That draft is no longer in the queue.');

    const batch = await api(`/api/import/${summary.batchId}`);
    const item = batch.items[0];

    state.editing = { itemId, batchId: summary.batchId };
    switchTab('new', false);
    renderForm({ itemId, header: item, lines: item.lines });
    renderIssues(item.issues);
  } catch (failure) {
    toast(failure.message);
  }
}

// --- actions ---------------------------------------------------------------

async function publish(batchId) {
  const draft = state.drafts.active.find((d) => d.batchId === batchId);

  // Ask the server what publishing would actually decide, rather than trusting
  // the counts this page was rendered with.
  try {
    const check = await api(`/api/drafts/${draft.itemId}/check`);
    if (!check.canPublish) {
      renderIssues(check.issues);
      return toast('This FMR is not ready to publish.');
    }
  } catch (failure) {
    return toast(failure.message);
  }

  if (!confirm(`Publish ${draft.fmrNumber}? The crews will see it immediately.`)) return;

  try {
    const result = await api('/api/import/publish', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ batchId })
    });
    toast(`Published ${result.count} FMR${result.count === 1 ? '' : 's'}.`);
    renderQueue();
  } catch (failure) {
    toast(failure.message);
  }
}

async function archive(batchId, restore = false) {
  const reason = prompt(restore
    ? 'Why are you restoring this draft?'
    : 'Why are you archiving this draft?');

  if (reason === null) return;
  if (reason.trim().length < 3) return toast('Give a reason of at least 3 characters.');

  try {
    await api('/api/drafts/archive', {
      method: 'POST',
      body: JSON.stringify({ batchId, reason, restore })
    });
    toast(restore ? 'Restored to the queue.' : 'Archived.');
    renderQueue();
  } catch (failure) {
    toast(failure.message);
  }
}

async function saveLine(row, isNew) {
  const line = {};
  for (const cell of row.querySelectorAll('td[contenteditable]')) {
    line[cell.dataset.field] = cell.textContent.trim();
  }

  if (isNew && !line.description && !line.quantity) return;

  try {
    const result = await api('/api/drafts/line', {
      method: 'POST',
      body: JSON.stringify({
        itemId: state.editing.itemId,
        line: isNew ? line : { ...line, id: row.dataset.line }
      })
    });
    renderIssues(result.issues);
    if (isNew) openDraft(state.editing.itemId);
  } catch (failure) {
    toast(failure.message);
  }
}

// --- wiring ----------------------------------------------------------------

document.querySelector('.tabs').onclick = (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) switchTab(button.dataset.tab);
};

function switchTab(tab, render = true) {
  state.tab = tab;
  document.querySelectorAll('.tabs button')
    .forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));

  if (!render) return;
  if (tab === 'queue') { state.editing = null; renderQueue(); }
  else renderForm();
}

$('view').addEventListener('click', (event) => {
  const target = (name) => event.target.closest(`button[data-${name}]`);

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
  if (drop && confirm('Remove this line?')) {
    api('/api/drafts/line', {
      method: 'DELETE',
      body: JSON.stringify({ lineId: drop.dataset.drop })
    })
      .then(() => openDraft(state.editing.itemId))
      .catch((failure) => toast(failure.message));
  }
});

/** Save an edited cell when focus leaves it. */
$('view').addEventListener('focusout', (event) => {
  const cell = event.target.closest('td[contenteditable]');
  if (!cell || !state.editing) return;

  const row = cell.closest('tr');
  if (row.dataset.line !== 'new') saveLine(row, false);
});

$('project').onchange = (event) => {
  state.projectId = event.target.value;
  localStorage.setItem('fmr.project', state.projectId);
  switchTab('queue');
};

async function start() {
  try {
    const { projects } = await api('/api/me');
    const remembered = localStorage.getItem('fmr.project');
    state.projectId = projects.find((p) => p.projectId === remembered)?.projectId
      ?? projects[0]?.projectId;

    $('project').innerHTML = projects
      .map((p) => `<option value="${p.projectId}"${p.projectId === state.projectId ? ' selected' : ''}>${esc(p.name)}</option>`)
      .join('');

    try {
      const bootstrap = await api('/api/bootstrap');
      state.options = bootstrap.options;
    } catch { /* the form falls back to sensible defaults */ }

    renderQueue();
  } catch {
    $('view').innerHTML = '<p class="hint">Please sign in to continue.</p>';
  }
}

start();
