/**
 * Import review.
 *
 * A workbook is parsed into proposed FMRs, and nothing reaches the ledger
 * until someone has looked at it. Anything the parser could not read is shown
 * against the row it came from, and quantities can be corrected in place.
 */

const state = { projectId: null, batch: null };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body instanceof ArrayBuffer || options.raw
        ? {} : { 'content-type': 'application/json' }),
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

// --- upload ----------------------------------------------------------------

function renderDrop() {
  $('view').innerHTML = `
    <div class="drop" id="drop">
      <p>Drop an FMR workbook here, or choose a file.<br>
         <span style="font-size:13px">Nothing is created until you have reviewed it.</span></p>
      <label for="file">Choose file<input id="file" type="file" accept=".xlsx,.xls,.csv"></label>
    </div>
    <p class="hint">Accepts .xlsx and .csv. Sheets are read one per FMR.</p>
  `;

  const drop = $('drop');
  const file = $('file');

  file.onchange = () => file.files[0] && upload(file.files[0]);

  ['dragenter', 'dragover'].forEach((event) =>
    drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((event) =>
    drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('over'); }));

  drop.addEventListener('drop', (e) => {
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) upload(dropped);
  });
}

async function upload(file) {
  $('view').innerHTML = `<p class="hint">Reading ${esc(file.name)}…</p>`;

  try {
    const { batchId } = await api(
      `/api/import/stage?filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: await file.arrayBuffer(), raw: true }
    );
    await loadBatch(batchId);
  } catch (failure) {
    $('view').innerHTML = `<p class="hint">${esc(failure.message)}</p>`;
    setTimeout(renderDrop, 3000);
  }
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
      <div class="stat"><div class="n">${batch.summary.sheets}</div><div class="l">Sheets</div></div>
      <div class="stat"><div class="n">${batch.summary.lines}</div><div class="l">Lines</div></div>
      <div class="stat ${batch.summary.errors ? 'warn' : ''}">
        <div class="n">${batch.summary.errors}</div><div class="l">Errors</div></div>
      <div class="stat"><div class="n">${batch.summary.warnings}</div><div class="l">Warnings</div></div>
    </div>

    <p class="hint" style="text-align:left;padding:0 0 14px">
      ${esc(batch.sourceName)} &middot; profile "${esc(batch.profileName)}"
      ${batch.summary.errors
        ? '&middot; errors must be fixed in the source file before publishing'
        : ''}
    </p>

    ${batch.items.map(renderItem).join('')}

    <div class="publishbar">
      <span>${selected} of ${selectable.length} selected</span>
      <span style="margin-left:auto"></span>
      <button id="publish" ${batch.summary.errors || !selected ? 'disabled' : ''}>
        Publish ${selected} FMR${selected === 1 ? '' : 's'}
      </button>
    </div>
  `;

  $('publish').onclick = publish;
}

function renderItem(item) {
  const cls = item.status === 'Blocked' ? 'blocked' : item.isDuplicate ? 'dup' : '';

  return `<section class="item ${cls}" data-item="${item.id}">
    <div class="item-head">
      <input type="checkbox" data-select="${item.id}"
             ${item.selected ? 'checked' : ''}
             ${item.status === 'Blocked' ? 'disabled' : ''}
             aria-label="Include ${esc(item.fmrNumber ?? item.sheetName)}">
      <span class="name">${esc(item.fmrNumber ?? '(no FMR number)')}</span>
      <span class="dim">${esc(item.isoNumber ?? '')} sht ${esc(item.isoSheet ?? '')}
        &middot; ${item.lines.length} lines &middot; sheet "${esc(item.sheetName)}"</span>
      ${item.isDuplicate ? '<span class="pill warn">Already exists</span>' : ''}
      ${item.status === 'Blocked' ? '<span class="pill danger">Blocked</span>' : ''}
    </div>

    ${item.issues.length ? `<div style="padding:10px 14px;background:var(--card);border:1px solid var(--rule);border-bottom:0">
      ${item.issues.map((i) => `<div class="issue ${esc(i.severity)}">
        ${i.sourceRow ? `<span class="where">Row ${i.sourceRow}</span>` : ''}${esc(i.message)}
      </div>`).join('')}
    </div>` : ''}

    <div class="tw"><table>
      <thead><tr>
        <th>#</th><th>Source row</th><th>Code</th><th>Size</th>
        <th>Description</th><th class="num">Qty</th><th>UOM</th>
      </tr></thead>
      <tbody>${item.lines.map((l) => `
        <tr data-line="${l.id}">
          <td class="mono">${l.lineNumber}</td>
          <td class="dim mono">${l.sourceRow ?? ''}</td>
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

// --- edits -----------------------------------------------------------------

document.addEventListener('change', (event) => {
  const box = event.target.closest('input[data-select]');
  if (!box) return;

  const item = state.batch.items.find((i) => i.id === box.dataset.select);
  if (item) { item.selected = box.checked; renderBatch(); }
});

/** Save a corrected cell when focus leaves it. */
document.addEventListener('focusout', async (event) => {
  const cell = event.target.closest('td[contenteditable]');
  if (!cell) return;

  const lineId = cell.closest('tr').dataset.line;
  const field = cell.dataset.field;
  const raw = cell.textContent.trim();
  const value = field === 'quantity' ? Number(raw.replace(/,/g, '')) : raw;

  if (field === 'quantity' && !Number.isFinite(value)) {
    cell.style.color = 'var(--danger)';
    return;
  }
  cell.style.color = '';

  try {
    await api('/api/import/line', {
      method: 'POST',
      body: JSON.stringify({ lineId, patch: { [field]: value } })
    });

    for (const item of state.batch.items) {
      const line = item.lines.find((l) => l.id === lineId);
      if (line) line[field] = value;
    }
  } catch (failure) {
    toast(failure.message);
  }
});

async function publish() {
  const button = $('publish');
  button.disabled = true;
  button.textContent = 'Publishing…';

  try {
    const result = await api('/api/import/publish', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        batchId: state.batch.id,
        itemIds: state.batch.items.filter((i) => i.selected).map((i) => i.id)
      })
    });

    toast(`Published ${result.count} FMR${result.count === 1 ? '' : 's'}.`);
    setTimeout(renderDrop, 1500);
  } catch (failure) {
    toast(failure.message);
    button.disabled = false;
    button.textContent = 'Publish';
  }
}

// --- start -----------------------------------------------------------------

$('project').onchange = (event) => {
  state.projectId = event.target.value;
  localStorage.setItem('fmr.project', state.projectId);
  renderDrop();
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

    renderDrop();
  } catch {
    location.href = '/signin.html';
  }
}

start();
