/**
 * Office interface.
 *
 * Three views: the backorder queue the expeditor works from, a register of
 * every FMR, and a roll-up by drawing. Denser than the field screen — this
 * one is read at a desk.
 */

const state = { projects: [], projectId: null, tab: 'queue', filter: 'Pending', data: null };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
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
  setTimeout(() => el.remove(), 3200);
}

// --- backorder queue -------------------------------------------------------

const FILTERS = ['Pending', 'Confirmed', 'Returned for Review', 'Rejected', 'All'];

async function renderQueue() {
  const status = state.filter === 'All' ? '' : `?status=${encodeURIComponent(state.filter)}`;
  const { requests } = await api(`/api/backorders${status}`);
  state.data = requests;

  // Group by FMR: an expeditor chases a whole requisition, not one line.
  const groups = {};
  for (const request of requests) {
    (groups[request.fmrNumber] ??= []).push(request);
  }

  const totals = requests.reduce((acc, r) => ({
    pending: acc.pending + r.qtyPending,
    confirmed: acc.confirmed + r.qtyConfirmed
  }), { pending: 0, confirmed: 0 });

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${requests.length}</div><div class="l">Requests</div></div>
      <div class="stat warn"><div class="n">${n(totals.pending)}</div><div class="l">Qty pending</div></div>
      <div class="stat"><div class="n">${n(totals.confirmed)}</div><div class="l">Qty committed</div></div>
      <div class="stat"><div class="n">${Object.keys(groups).length}</div><div class="l">FMRs affected</div></div>
    </div>

    <div class="filters">
      ${FILTERS.map((f) =>
        `<button data-filter="${esc(f)}" class="${f === state.filter ? 'on' : ''}">${esc(f)}</button>`
      ).join('')}
    </div>

    ${Object.entries(groups).map(([fmr, rows]) => `
      <section class="group">
        <h3><span class="n">${esc(fmr)}</span>
            <span class="sub">${rows.length} line${rows.length === 1 ? '' : 's'}
            &middot; needed ${day(rows[0].dateRequired)}
            ${rows[0].priority ? `&middot; ${esc(rows[0].priority)} priority` : ''}</span></h3>
        <div class="tw"><table>
          <thead><tr>
            <th>Line</th><th>Drawing</th><th>Material</th>
            <th class="num">Asked</th><th class="num">Pending</th><th class="num">Committed</th>
            <th>Reason</th><th>Raised</th><th></th>
          </tr></thead>
          <tbody>${rows.map(renderQueueRow).join('')}</tbody>
        </table></div>
      </section>
    `).join('') || '<p class="hint">Nothing in this queue.</p>'}
  `;
}

function renderQueueRow(r) {
  const decidable = r.qtyPending > 0;
  return `<tr data-request="${r.id}">
    <td class="mono">${r.lineNumber}</td>
    <td class="mono">${esc(r.isoNumber)}<span class="dim"> sht ${esc(r.isoSheet)}</span></td>
    <td>${esc(r.description ?? '')}<div class="dim">${esc(r.commodityCode ?? '')} &middot; ${esc(r.size ?? '')}</div></td>
    <td class="num">${n(r.qtyRequested)}</td>
    <td class="num">${n(r.qtyPending)}</td>
    <td class="num">${n(r.qtyConfirmed)}</td>
    <td>${esc(r.reason)}${r.fieldNotes ? `<div class="dim">${esc(r.fieldNotes)}</div>` : ''}</td>
    <td class="dim">${esc(r.reportedByName ?? '')}<br>${day(r.reportedAt)}</td>
    <td><div class="rowacts">
      ${decidable ? `
        <button class="ok" data-decide="CONFIRM">Confirm</button>
        <button data-decide="RETURN">Return</button>
        <button class="no" data-decide="REJECT">Reject</button>
      ` : `<span class="dim">${esc(r.status)}</span>`}
    </div></td>
  </tr>`;
}

// --- decision dialog -------------------------------------------------------

const DECISION_COPY = {
  CONFIRM: { title: 'Confirm supply', verb: 'Confirm',
             help: 'The office will supply this. The crew sees it as committed.' },
  REJECT:  { title: 'Reject request', verb: 'Reject',
             help: 'This will not be supplied. The quantity is released and the crew is told.' },
  RETURN:  { title: 'Return for review', verb: 'Return',
             help: 'Send it back for more information. The quantity stays reserved.' }
};

function openDecision(request, decision) {
  const copy = DECISION_COPY[decision];
  const notesRequired = decision === 'RETURN';

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-bg';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${copy.title}">
    <h2>${copy.title}</h2>
    <div class="for">${esc(request.fmrNumber)} &middot; line ${request.lineNumber} &middot;
      ${esc(request.description ?? '')}</div>
    <div class="err" id="err" hidden></div>
    <form id="form">
      <div class="field">
        <label for="qty">Quantity</label>
        <input id="qty" type="number" min="0.0001" max="${request.qtyPending}"
               step="any" value="${request.qtyPending}" required>
        <div class="max">${n(request.qtyPending)} pending. Decide less to split the request.</div>
      </div>
      <div class="field">
        <label for="notes">Notes${notesRequired ? '' : ' (optional)'}</label>
        <textarea id="notes" rows="3" ${notesRequired ? 'required' : ''}
          placeholder="${notesRequired ? 'What does the crew need to provide?' : ''}"></textarea>
        <div class="max">${copy.help}</div>
      </div>
      <div class="sheet-acts">
        <button type="button" id="cancel">Cancel</button>
        <button type="submit" class="primary" id="go">${copy.verb}</button>
      </div>
    </form>
  </div>`;

  document.body.appendChild(backdrop);
  $('qty').focus();

  const close = () => backdrop.remove();
  $('cancel').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  $('form').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('go');
    const error = $('err');

    button.disabled = true;
    button.textContent = 'Working…';
    error.hidden = true;

    try {
      const result = await api('/api/backorders/decide', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          requestId: request.id,
          decision,
          quantity: Number($('qty').value),
          notes: $('notes').value.trim() || undefined
        })
      });

      close();
      await renderQueue();
      toast(result.splitRequestId
        ? `${copy.verb}ed — the remainder became its own request.`
        : `${copy.verb}ed.`);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = copy.verb;
    }
  };
}

// --- register --------------------------------------------------------------

async function renderRegister() {
  const { fmrs, totals } = await api('/api/register');

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${fmrs.length}</div><div class="l">FMRs</div></div>
      <div class="stat"><div class="n">${n(totals.lines)}</div><div class="l">Lines</div></div>
      <div class="stat"><div class="n">${totals.fulfillmentPct}%</div><div class="l">Fulfilled</div></div>
      <div class="stat warn"><div class="n">${n(totals.backordered)}</div><div class="l">On backorder</div></div>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th>FMR</th><th>IWP</th><th>Requested by</th><th>Needed</th>
        <th>Priority</th><th class="num">Lines</th>
        <th class="num">Requested</th><th class="num">Issued</th>
        <th class="num">Remaining</th><th>Progress</th><th></th>
      </tr></thead>
      <tbody>${fmrs.map((f) => `
        <tr data-fmr="${f.id}" data-number="${esc(f.fmrNumber)}">
          <td class="mono"><strong>${esc(f.fmrNumber)}</strong></td>
          <td class="mono dim">${esc(f.iwpNumber ?? '—')}</td>
          <td>${esc(f.requestedBy ?? '')}</td>
          <td class="dim">${day(f.dateRequired)}</td>
          <td>${esc(f.priority ?? '')}</td>
          <td class="num">${f.lineCount}</td>
          <td class="num">${n(f.qtyRequested)}</td>
          <td class="num">${n(f.qtyIssued)}</td>
          <td class="num">${n(f.qtyRemaining)}</td>
          <td><div class="bar" title="${f.fulfillmentPct}%"><i style="width:${f.fulfillmentPct}%"></i></div></td>
          <td><div class="rowacts"><button data-renumber="${f.id}">Renumber</button></div></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  `;
}

// --- renumber --------------------------------------------------------------

/**
 * Rename a published FMR.
 *
 * Material Management does reassign official numbers after issue. Everything
 * already recorded against the FMR follows it — the number is stored once.
 */
function openRenumber(fmrId, currentNumber) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-bg';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Renumber FMR">
    <h2>Renumber ${esc(currentNumber)}</h2>
    <div class="for">Everything recorded against this FMR keeps its history and
      follows the new number.</div>
    <div class="err" id="err" hidden></div>
    <form id="form">
      <div class="field">
        <label for="newNumber">New FMR number</label>
        <input id="newNumber" type="text" required placeholder="FMR-2026-0418">
      </div>
      <div class="field">
        <label for="why">Why is it changing?</label>
        <input id="why" type="text" required placeholder="e.g. reissued by Material Management">
      </div>
      <div class="sheet-acts">
        <button type="button" id="cancel">Cancel</button>
        <button type="submit" class="primary" id="go">Renumber</button>
      </div>
    </form>
  </div>`;

  document.body.appendChild(backdrop);
  $('newNumber').focus();

  const close = () => backdrop.remove();
  $('cancel').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  $('form').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('go');
    button.disabled = true;
    button.textContent = 'Working…';

    try {
      const result = await api('/api/fmr/renumber', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          fmrId,
          newNumber: $('newNumber').value.trim(),
          reason: $('why').value.trim()
        })
      });
      close();
      toast(`${result.from} is now ${result.to}.`);
      show();
    } catch (failure) {
      $('err').textContent = failure.message;
      $('err').hidden = false;
      button.disabled = false;
      button.textContent = 'Renumber';
    }
  };
}

// --- by drawing ------------------------------------------------------------

async function renderIso() {
  const { drawings } = await api('/api/iso-summary');

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${drawings.length}</div><div class="l">Drawings</div></div>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th>Drawing</th><th>Sheet</th><th class="num">Lines</th><th class="num">FMRs</th>
        <th class="num">Requested</th><th class="num">Issued</th>
        <th class="num">Backordered</th><th>Progress</th>
      </tr></thead>
      <tbody>${drawings.map((d) => `
        <tr>
          <td class="mono"><strong>${esc(d.isoNumber)}</strong></td>
          <td class="mono">${esc(d.isoSheet)}</td>
          <td class="num">${d.lineCount}</td>
          <td class="num">${d.fmrCount}</td>
          <td class="num">${n(d.qtyRequested)}</td>
          <td class="num">${n(d.qtyIssued)}</td>
          <td class="num">${n(d.qtyBackordered)}</td>
          <td><div class="bar" title="${d.fulfillmentPct}%"><i style="width:${d.fulfillmentPct}%"></i></div></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  `;
}

// --- wiring ----------------------------------------------------------------

const VIEWS = { queue: renderQueue, register: renderRegister, iso: renderIso };

async function show() {
  $('view').innerHTML = '<p class="hint">Loading…</p>';
  try {
    await VIEWS[state.tab]();
  } catch (failure) {
    $('view').innerHTML = `<p class="hint">${esc(failure.message)}</p>`;
  }
}

document.querySelector('.tabs').onclick = (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;

  state.tab = button.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === button));
  show();
};

$('view').addEventListener('click', (event) => {
  const filter = event.target.closest('button[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    return show();
  }

  const renumber = event.target.closest('button[data-renumber]');
  if (renumber) {
    const row = renumber.closest('tr');
    return openRenumber(renumber.dataset.renumber, row.dataset.number);
  }

  const decide = event.target.closest('button[data-decide]');
  if (decide) {
    const requestId = decide.closest('tr').dataset.request;
    const request = state.data?.find((r) => r.id === requestId);
    if (request) openDecision(request, decide.dataset.decide);
  }
});

$('project').onchange = (event) => {
  state.projectId = event.target.value;
  localStorage.setItem('fmr.project', state.projectId);
  show();
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

    show();
  } catch {
    $('view').innerHTML = '<p class="hint">Please sign in to continue.</p>';
  }
}

start();
