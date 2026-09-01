/**
 * Field interface.
 *
 * One screen: search, read the quantities, act. Everything the crew needs to
 * decide is on the card — what is left to find, what is on the shelf, what
 * the office has said about a backorder.
 *
 * No framework: this runs on old phones over site wifi.
 */

const state = { projects: [], projectId: null, results: [], sheet: null };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

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
  setTimeout(() => el.remove(), 3200);
}

// --- actions available on a line ------------------------------------------

const ACTION_LABELS = {
  CONFIRM_AVAILABLE: 'Confirm found',
  BAG: 'Bag',
  DIRECT_ISSUE: 'Issue direct',
  ISSUE_FROM_AVAILABLE: 'Issue',
  ISSUE_FROM_BAG: 'Issue from bag',
  BACKORDER_REQUESTED: 'Backorder'
};

/** Which actions make sense for this line right now. */
function availableActions(line) {
  const q = line.quantities;
  const actions = [];

  if (q.notYetLocated > 0 && q.remaining > 0) {
    actions.push('CONFIRM_AVAILABLE', 'DIRECT_ISSUE');
  }
  if (q.available > 0 || q.notYetLocated > 0) actions.push('BAG');
  if (q.available > 0 && q.remaining > 0) actions.push('ISSUE_FROM_AVAILABLE');
  if (line.activeBags?.length && q.remaining > 0) actions.push('ISSUE_FROM_BAG');
  if (q.remaining > q.available + q.bagged + q.pendingBackorder + q.confirmedBackorder) {
    actions.push('BACKORDER_REQUESTED');
  }

  return actions;
}

function statusClass(status) {
  if (status === 'Issued') return '';
  if (status.includes('Backorder')) return 'warn';
  if (status === 'Open') return 'danger';
  return '';
}

// --- rendering -------------------------------------------------------------

function renderCard(line) {
  const q = line.quantities;
  const actions = availableActions(line);

  const notices = (line.notices ?? []).map((notice) => {
    const rejected = notice.status === 'Rejected';
    return `<div class="notice ${rejected ? 'rejected' : ''}">
      <b>${rejected ? 'Rejected' : 'Returned'}:</b>
      ${n(rejected ? notice.qtyRequested : notice.qtyPending)} ${esc(line.uom ?? '')}
      &mdash; ${esc(notice.adminNotes || notice.returnedReviewReason || 'see the office')}
    </div>`;
  }).join('');

  const bags = line.activeBags?.length
    ? `<div class="bags">${line.activeBags.map((bag) =>
        `<span class="bag">${esc(bag.tagNumber)} &middot; ${n(bag.qtyRemaining)} ${esc(line.uom ?? '')}</span>`
      ).join('')}</div>`
    : '';

  return `<article class="card" data-line="${line.id}">
    <div class="card-head">
      <div class="card-top">
        <span class="fmr">${esc(line.fmrNumber)}</span>
        <span class="iso">${esc(line.isoNumber)} sht ${esc(line.isoSheet)} &middot; line ${line.lineNumber}</span>
        <span class="pill ${statusClass(line.status)}">${esc(line.status)}</span>
      </div>
      <div class="desc">${esc(line.description ?? '')}</div>
      <div class="spec">${esc(line.commodityCode ?? '')} &middot; ${esc(line.size ?? '')}</div>
    </div>

    <div class="qty">
      <div><span class="n">${n(q.requested)}</span><span class="l">Requested</span></div>
      <div><span class="n">${n(q.available)}</span><span class="l">Available</span></div>
      <div><span class="n">${n(q.issued)}</span><span class="l">Issued</span></div>
      <div class="rem"><span class="n">${n(q.remaining)}</span><span class="l">Remaining</span></div>
    </div>

    ${q.pendingBackorder + q.confirmedBackorder > 0 ? `<div class="qty">
      <div class="bo"><span class="n">${n(q.pendingBackorder)}</span><span class="l">Pending BO</span></div>
      <div class="bo"><span class="n">${n(q.confirmedBackorder)}</span><span class="l">Confirmed BO</span></div>
      <div><span class="n">${n(q.bagged)}</span><span class="l">Bagged</span></div>
      <div><span class="n">${n(q.notYetLocated)}</span><span class="l">To find</span></div>
    </div>` : ''}

    ${notices}
    ${bags}

    <div class="acts">
      ${actions.map((action, i) =>
        `<button data-action="${action}" class="${i === 0 ? 'primary' : ''}">${ACTION_LABELS[action]}</button>`
      ).join('') || '<span class="hint" style="padding:4px">Nothing outstanding on this line.</span>'}
    </div>
  </article>`;
}

function renderResults() {
  const container = $('results');

  if (!state.results.length) {
    container.innerHTML = '';
    $('hint').textContent = 'No lines matched that search.';
    $('hint').hidden = false;
    return;
  }

  $('hint').hidden = true;
  container.innerHTML = state.results.map(renderCard).join('');
}

// --- action sheet ----------------------------------------------------------

const NEEDS = {
  CONFIRM_AVAILABLE: ['quantity', 'storageLocation'],
  BAG: ['quantity', 'bagTagNumber', 'storageLocation'],
  DIRECT_ISSUE: ['quantity', 'issuedToName', 'storageLocation'],
  ISSUE_FROM_AVAILABLE: ['quantity', 'issuedToName'],
  ISSUE_FROM_BAG: ['quantity', 'bagTagId', 'issuedToName'],
  BACKORDER_REQUESTED: ['quantity', 'reason']
};

// Filled from /api/bootstrap so the office can add a reason without a deploy.
// The fallback covers the case where bootstrap has not answered yet.
let REASONS = ['Not in stock', 'Wrong size received', 'Damaged',
               'Short shipped', 'Cannot locate'];
let STORAGE_LOCATIONS = [];

/** The most this action may move, mirroring the rules the server enforces. */
function ceilingFor(line, action) {
  const q = line.quantities;
  const locatable = Math.max(0, Math.min(q.notYetLocated, q.remaining) - q.pendingBackorder);

  switch (action) {
    case 'CONFIRM_AVAILABLE': return locatable;
    case 'BAG': return q.available + locatable;
    case 'DIRECT_ISSUE': return Math.min(locatable, q.remaining);
    case 'ISSUE_FROM_AVAILABLE': return Math.min(q.available, q.remaining);
    case 'ISSUE_FROM_BAG': return Math.min(q.bagged, q.remaining);
    case 'BACKORDER_REQUESTED':
      return Math.max(0, q.remaining - q.available - q.bagged
        - q.pendingBackorder - q.confirmedBackorder);
    default: return 0;
  }
}

function openSheet(line, action) {
  const needs = NEEDS[action];
  const max = ceilingFor(line, action);

  const fields = needs.map((field) => {
    if (field === 'quantity') {
      return `<div class="field">
        <label for="f-quantity">Quantity (${esc(line.uom ?? '')})</label>
        <input id="f-quantity" type="number" inputmode="decimal" min="0.0001"
               max="${max}" step="any" value="${max}" required>
        <div class="max">Up to ${n(max)} ${esc(line.uom ?? '')}</div>
      </div>`;
    }
    if (field === 'reason') {
      return `<div class="field">
        <label for="f-reason">Reason</label>
        <select id="f-reason" required>
          ${REASONS.map((r) => `<option>${esc(r)}</option>`).join('')}
        </select>
      </div>`;
    }
    if (field === 'bagTagId') {
      return `<div class="field">
        <label for="f-bagTagId">Bag</label>
        <select id="f-bagTagId" required>
          ${line.activeBags.map((b) =>
            `<option value="${b.bagTagId}">${esc(b.tagNumber)} — ${n(b.qtyRemaining)} left</option>`
          ).join('')}
        </select>
      </div>`;
    }

    const labels = {
      storageLocation: 'Storage location',
      issuedToName: 'Issued to',
      bagTagNumber: 'Bag tag number'
    };
    const isLocation = field === 'storageLocation';
    const prefill = isLocation ? (line.storageLocation ?? '') : '';
    const optional = isLocation && action === 'DIRECT_ISSUE';

    // Locations are free text with suggestions: a warehouse invents new ones
    // faster than anyone maintains a list.
    const suggestions = isLocation && STORAGE_LOCATIONS.length
      ? `<datalist id="locations">${STORAGE_LOCATIONS
          .map((l) => `<option value="${esc(l)}">`).join('')}</datalist>`
      : '';

    return `<div class="field">
      <label for="f-${field}">${labels[field]}${optional ? ' (optional)' : ''}</label>
      <input id="f-${field}" type="text" value="${esc(prefill)}"
             ${isLocation && suggestions ? 'list="locations"' : ''}
             ${optional ? '' : 'required'}>
      ${suggestions}
    </div>`;
  }).join('');

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-bg';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${ACTION_LABELS[action]}">
    <h2>${ACTION_LABELS[action]}</h2>
    <div class="for">${esc(line.fmrNumber)} &middot; line ${line.lineNumber} &middot; ${esc(line.description ?? '')}</div>
    <div class="err" id="sheetErr" hidden></div>
    <form id="sheetForm">
      ${fields}
      <div class="field">
        <label for="f-notes">Notes (optional)</label>
        <textarea id="f-notes" rows="2"></textarea>
      </div>
      <div class="sheet-acts">
        <button type="button" id="cancel">Cancel</button>
        <button type="submit" class="primary" id="confirm">${ACTION_LABELS[action]}</button>
      </div>
    </form>
  </div>`;

  document.body.appendChild(backdrop);
  state.sheet = backdrop;
  $('f-quantity')?.focus();

  const close = () => { backdrop.remove(); state.sheet = null; };
  $('cancel').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  $('sheetForm').onsubmit = async (event) => {
    event.preventDefault();
    await submit(line, action, needs, close);
  };
}

async function submit(line, action, needs, close) {
  const button = $('confirm');
  const error = $('sheetErr');

  const payload = { action, lineId: line.id };
  for (const field of needs) {
    const el = $(`f-${field}`);
    payload[field] = field === 'quantity' ? Number(el.value) : el.value.trim();
  }
  const notes = $('f-notes').value.trim();
  if (notes) payload.notes = notes;

  button.disabled = true;
  button.textContent = 'Working…';
  error.hidden = true;

  try {
    // One key per attempt: a retry after a dropped connection replays the
    // original result instead of moving the material twice.
    const result = await api('/api/field/action', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(payload)
    });

    // Swap the updated line back into the list in place.
    const index = state.results.findIndex((l) => l.id === line.id);
    if (index >= 0) {
      state.results[index] = { ...state.results[index], ...result.line };
    }

    close();
    renderResults();
    toast(result.replayed
      ? 'Already recorded.'
      : `${ACTION_LABELS[action]} recorded.`);
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    button.disabled = false;
    button.textContent = ACTION_LABELS[action];
  }
}

// --- wiring ----------------------------------------------------------------

$('results').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const lineId = button.closest('.card').dataset.line;
  const line = state.results.find((l) => l.id === lineId);
  if (line) openSheet(line, button.dataset.action);
});

$('searchForm').onsubmit = async (event) => {
  event.preventDefault();
  const query = $('q').value.trim();
  if (!query) return;

  $('hint').textContent = 'Searching…';
  $('hint').hidden = false;

  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    state.results = results;
    renderResults();
  } catch (failure) {
    $('results').innerHTML = '';
    $('hint').textContent = failure.message;
    $('hint').hidden = false;
  }
};

$('project').onchange = (event) => {
  state.projectId = event.target.value;
  localStorage.setItem('fmr.project', state.projectId);
  state.results = [];
  renderResults();
};

async function start() {
  try {
    const { projects } = await api('/api/me');
    state.projects = projects;

    const remembered = localStorage.getItem('fmr.project');
    state.projectId = projects.find((p) => p.projectId === remembered)?.projectId
      ?? projects[0]?.projectId;

    $('project').innerHTML = projects
      .map((p) => `<option value="${p.projectId}"${p.projectId === state.projectId ? ' selected' : ''}>${esc(p.name)}</option>`)
      .join('');

    await loadOptions();
  } catch {
    location.href = '/signin.html';
  }
}

/**
 * Dropdown values, and whether the project is paused.
 *
 * Failing here is not fatal — the built-in reasons still work — so a slow
 * connection does not stop a crew recording material.
 */
async function loadOptions() {
  try {
    const bootstrap = await api('/api/bootstrap');

    if (bootstrap.options?.backorderReasons?.length) {
      REASONS = bootstrap.options.backorderReasons;
    }
    STORAGE_LOCATIONS = bootstrap.options?.storageLocations ?? [];

    if (bootstrap.controls?.fieldLocked) {
      $('hint').textContent = bootstrap.controls.lockReason
        ? `Material movement is paused: ${bootstrap.controls.lockReason}`
        : 'Material movement is paused on this project.';
      $('hint').hidden = false;
    }
  } catch {
    // Keep the defaults.
  }
}

start();
