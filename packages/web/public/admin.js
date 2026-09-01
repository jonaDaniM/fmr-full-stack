/**
 * Office interface.
 *
 * Four views: today's movements and what is waiting, the backorder queue the
 * expeditor works from, a register of every FMR, and a roll-up by drawing.
 * Denser than the field screen — this one is read at a desk.
 */

import { api, idempotencyKey } from './lib/api.js';
import { $, esc, n, day, skeleton, emptyRow } from './lib/dom.js';
import { dialog, confirmAction } from './lib/modal.js';
import { toast, toastError } from './lib/toast.js';
import { initShell } from './lib/shell.js';

const state = { tab: 'today', filter: 'Pending', data: null, filters: null };

// --- backorder queue -------------------------------------------------------

// The statuses a request can be in. Fetched from the domain via /api/bootstrap
// rather than hardcoded, so renaming one cannot silently empty this queue.
// Ordered the way an expeditor works: what needs deciding, then what was.
const FILTER_ORDER = ['Pending', 'Returned for Review', 'Confirmed',
                      'Partially Confirmed', 'Rejected', 'Fulfilled'];
const FALLBACK_FILTERS = FILTER_ORDER;

const orderFilters = (statuses) =>
  [...statuses].sort((a, b) => {
    const ia = FILTER_ORDER.indexOf(a);
    const ib = FILTER_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

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

  const filters = [...(state.filters ?? FALLBACK_FILTERS), 'All'];

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${requests.length}</span><span class="l">Requests</span></div>
      <div class="stat stat-warn"><span class="n">${n(totals.pending)}</span><span class="l">Qty pending</span></div>
      <div class="stat"><span class="n">${n(totals.confirmed)}</span><span class="l">Qty committed</span></div>
      <div class="stat"><span class="n">${Object.keys(groups).length}</span><span class="l">FMRs affected</span></div>
    </div>

    <div class="filters" role="group" aria-label="Filter by status">
      ${filters.map((f) =>
        `<button type="button" data-filter="${esc(f)}"
                 aria-pressed="${f === state.filter}">${esc(f)}</button>`
      ).join('')}
    </div>

    ${Object.entries(groups).map(([fmr, rows]) => `
      <section class="group">
        <h3><span class="num">${esc(fmr)}</span>
            <span class="sub">${rows.length} line${rows.length === 1 ? '' : 's'}
            &middot; needed ${day(rows[0].dateRequired)}
            ${rows[0].priority ? `&middot; ${esc(rows[0].priority)} priority` : ''}</span></h3>
        <div class="tw"><table>
          <thead><tr>
            <th class="w-tiny">Line</th><th class="w-md">Drawing</th><th class="w-grow">Material</th>
            <th class="num w-sm">Asked</th><th class="num w-sm">Pending</th><th class="num w-sm">Committed</th>
            <th class="w-lg">Reason</th><th class="w-md">Raised</th><th class="w-lg"></th>
          </tr></thead>
          <tbody>${rows.map(renderQueueRow).join('')}</tbody>
        </table></div>
      </section>
    `).join('') || emptyQueue()}
  `;
}

const emptyQueue = () => `
  <div class="empty">
    <h2>Nothing ${state.filter === 'All' ? 'in the queue' : `marked ${esc(state.filter).toLowerCase()}`}</h2>
    <p>${state.filter === 'Pending'
      ? 'Every backorder has been decided. The crews are not waiting on the office.'
      : 'Try another filter to see requests in a different state.'}</p>
  </div>`;

function renderQueueRow(r) {
  const decidable = r.qtyPending > 0;
  return `<tr data-request="${esc(r.id)}">
    <td class="num">${esc(r.lineNumber)}</td>
    <td class="mono">${esc(r.isoNumber)}<span class="dim"> sht ${esc(r.isoSheet)}</span></td>
    <td>${esc(r.description ?? '')}<div class="dim">${esc(r.commodityCode ?? '')} &middot; ${esc(r.size ?? '')}</div></td>
    <td class="num">${n(r.qtyRequested)}</td>
    <td class="num">${n(r.qtyPending)}</td>
    <td class="num">${n(r.qtyConfirmed)}</td>
    <td>${esc(r.reason)}${r.fieldNotes ? `<div class="dim">${esc(r.fieldNotes)}</div>` : ''}</td>
    <td class="dim">${esc(r.reportedByName ?? '')}<br>${day(r.reportedAt)}</td>
    <td><div class="rowacts">
      ${decidable ? `
        <button type="button" class="btn btn-sm btn-primary" data-decide="CONFIRM">Confirm</button>
        <button type="button" class="btn btn-sm" data-decide="RETURN">Return</button>
        <button type="button" class="btn btn-sm" data-decide="REJECT">Reject</button>
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

async function decide(request, decision) {
  const copy = DECISION_COPY[decision];
  const destructive = decision === 'REJECT';

  // Rejecting means the crew does not get the material. It used to fire
  // straight from the row with its submit styled as the affirmative action.
  if (destructive) {
    const sure = await confirmAction({
      title: 'Reject this request?',
      lede: `${request.fmrNumber} · line ${request.lineNumber}`,
      body: `<p>${esc(request.description ?? '')}</p>
             <p class="dim">${n(request.qtyPending)} pending will be released and
             the crew told it is not coming. They will have to source it another way.</p>`,
      confirmLabel: 'Yes, reject it',
      danger: true
    });
    if (!sure) return;
  }

  await dialog({
    title: copy.title,
    lede: `${request.fmrNumber} · line ${request.lineNumber} · ${request.description ?? ''}`,
    confirmLabel: copy.verb,
    danger: destructive,
    fields: [
      {
        name: 'quantity', label: 'Quantity', type: 'number', required: true,
        value: request.qtyPending, min: 0.0001, max: request.qtyPending, step: 'any',
        hint: `${n(request.qtyPending)} pending. Decide less to split the request.`
      },
      {
        name: 'notes',
        label: `Notes${decision === 'RETURN' ? '' : ' (optional)'}`,
        type: 'textarea', rows: 3,
        required: decision === 'RETURN',
        placeholder: decision === 'RETURN' ? 'What does the crew need to provide?' : '',
        hint: copy.help
      }
    ],
    onSubmit: async (values) => {
      const result = await api('/api/backorders/decide', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({
          requestId: request.id,
          decision,
          quantity: Number(values.quantity),
          notes: values.notes || undefined
        })
      });

      await show();
      toast(result.splitRequestId
        ? `${copy.verb}ed — the remainder became its own request.`
        : `${copy.verb}ed.`);
      return result;
    }
  });
}

// --- register --------------------------------------------------------------

async function renderRegister() {
  const { fmrs, totals } = await api('/api/register');

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${fmrs.length}</span><span class="l">FMRs</span></div>
      <div class="stat"><span class="n">${n(totals.lines)}</span><span class="l">Lines</span></div>
      <div class="stat stat-ok"><span class="n">${n(totals.fulfillmentPct)}%</span><span class="l">Fulfilled</span></div>
      <div class="stat stat-warn"><span class="n">${n(totals.backordered)}</span><span class="l">On backorder</span></div>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th class="w-md">FMR</th><th class="w-md">IWP</th><th class="w-lg">Requested by</th>
        <th class="w-sm">Needed</th><th class="w-sm">Priority</th><th class="num w-tiny">Lines</th>
        <th class="num w-sm">Requested</th><th class="num w-sm">Issued</th>
        <th class="num w-sm">Remaining</th><th class="w-md">Progress</th><th class="w-md"></th>
      </tr></thead>
      <tbody>${fmrs.map(renderRegisterRow).join('')
        || emptyRow(11, 'No FMRs on this project yet. Publish one from Drafts or Import.')}
      </tbody>
    </table></div>`;
}

const renderRegisterRow = (f) => `
  <tr data-fmr="${esc(f.id)}" data-number="${esc(f.fmrNumber)}">
    <td class="mono"><strong>${esc(f.fmrNumber)}</strong></td>
    <td class="mono dim">${esc(f.iwpNumber ?? '—')}</td>
    <td>${esc(f.requestedBy ?? '')}</td>
    <td class="dim">${day(f.dateRequired)}</td>
    <td>${esc(f.priority ?? '')}</td>
    <td class="num">${esc(f.lineCount)}</td>
    <td class="num">${n(f.qtyRequested)}</td>
    <td class="num">${n(f.qtyIssued)}</td>
    <td class="num">${n(f.qtyRemaining)}</td>
    <td>
      <div class="bar"><i style="width:${Number(f.fulfillmentPct)}%"></i></div>
      <span class="vh">${esc(f.fulfillmentPct)}% fulfilled</span>
    </td>
    <td><div class="rowacts">
      <button type="button" class="btn btn-sm" data-open="${esc(f.id)}">Open</button>
      <button type="button" class="btn btn-sm" data-renumber="${esc(f.id)}">Renumber</button>
    </div></td>
  </tr>`;

/**
 * Everything on one FMR, without leaving the register.
 *
 * The register says how much of an FMR is outstanding but not which lines are
 * holding it up. FMRv3 opened the same detail inline from its register row;
 * the endpoint was ported and then had nothing calling it.
 */
async function openFmr(fmrId) {
  let fmr;
  try {
    fmr = await api(`/api/fmr/${fmrId}`);
  } catch (failure) {
    return toastError(failure.message);
  }

  const rows = renderFmrLineRows(fmr.lines);

  await dialog({
    title: fmr.fmrNumber,
    lede: [
      fmr.iwpNumber ? `IWP ${fmr.iwpNumber}` : null,
      fmr.requestedBy ? `requested by ${fmr.requestedBy}` : null,
      fmr.status,
      `${Number(fmr.totals.fulfillmentPct)}% issued`
    ].filter(Boolean).join(' · '),
    wide: true,
    body: `<div class="tw"><table>
        <thead><tr>
          <th class="w-tiny">Line</th><th class="w-md">Drawing</th><th class="w-grow">Material</th>
          <th class="num w-sm">Requested</th><th class="num w-sm">Available</th>
          <th class="num w-sm">Bagged</th><th class="num w-sm">Issued</th>
          <th class="num w-sm">Remaining</th><th class="w-md">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`,
    confirmLabel: 'Close',
    cancelLabel: 'Done',
    onSubmit: () => null
  });
}

/** One row per line of an FMR, for the detail dialog. */
function renderFmrLineRows(lines) {
  if (!lines.length) return emptyRow(9, 'This FMR has no active lines.');

  return lines.map((l) => {
    const q = l.quantities;
    const bags = (l.activeBags ?? []).map((b) => b.tagNumber).join(', ');
    return `<tr>
      <td class="num">${esc(l.lineNumber)}</td>
      <td class="mono">${esc(l.isoNumber)}<span class="dim"> sht ${esc(l.isoSheet)}</span></td>
      <td>${esc(l.description ?? '')}
          <div class="dim">${esc(l.commodityCode ?? '')} &middot; ${esc(l.size ?? '')}</div></td>
      <td class="num">${n(q.requested)}</td>
      <td class="num">${n(q.available)}</td>
      <td class="num">${n(q.bagged)}${bags ? `<div class="dim">${esc(bags)}</div>` : ''}</td>
      <td class="num">${n(q.issued)}</td>
      <td class="num">${n(q.remaining)}</td>
      <td>${esc(l.status)}</td>
    </tr>`;
  }).join('');
}

/**
 * Rename a published FMR.
 *
 * Material Management does reassign official numbers after issue. Everything
 * already recorded against the FMR follows it — the number is stored once.
 */
async function renumber(fmrId, currentNumber) {
  await dialog({
    title: `Renumber ${currentNumber}`,
    lede: 'Everything recorded against this FMR keeps its history and follows the new number.',
    confirmLabel: 'Renumber',
    fields: [
      { name: 'newNumber', label: 'New FMR number', required: true, placeholder: 'FMR-2026-0418' },
      { name: 'reason', label: 'Why is it changing?', required: true, minLength: 3,
        placeholder: 'e.g. reissued by Material Management' }
    ],
    onSubmit: async (values) => {
      const result = await api('/api/fmr/renumber', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({ fmrId, newNumber: values.newNumber, reason: values.reason })
      });
      toast(`${result.from} is now ${result.to}.`);
      show();
      return result;
    }
  });
}

// --- by drawing ------------------------------------------------------------

async function renderIso() {
  const { drawings } = await api('/api/iso-summary');

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${drawings.length}</span><span class="l">Drawings</span></div>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th class="w-md">Drawing</th><th class="w-sm">Sheet</th>
        <th class="num w-tiny">Lines</th><th class="num w-tiny">FMRs</th>
        <th class="num w-sm">Requested</th><th class="num w-sm">Issued</th>
        <th class="num w-sm">Backordered</th><th class="w-md">Progress</th>
      </tr></thead>
      <tbody>${drawings.map((d) => `
        <tr>
          <td class="mono"><strong>${esc(d.isoNumber)}</strong></td>
          <td class="mono">${esc(d.isoSheet)}</td>
          <td class="num">${esc(d.lineCount)}</td>
          <td class="num">${esc(d.fmrCount)}</td>
          <td class="num">${n(d.qtyRequested)}</td>
          <td class="num">${n(d.qtyIssued)}</td>
          <td class="num">${n(d.qtyBackordered)}</td>
          <td>
            <div class="bar"><i style="width:${Number(d.fulfillmentPct)}%"></i></div>
            <span class="vh">${esc(d.fulfillmentPct)}% fulfilled</span>
          </td>
        </tr>`).join('')
        || emptyRow(8, 'No material on this project yet.')}
      </tbody>
    </table></div>`;
}

// --- today -----------------------------------------------------------------

/** What each transaction type is called when a person reads it back. */
const MOVEMENT_LABELS = {
  CONFIRM_AVAILABLE: 'Confirmed found',
  BAG: 'Bagged',
  DIRECT_ISSUE: 'Issued direct',
  ISSUE_FROM_AVAILABLE: 'Issued',
  ISSUE_FROM_BAG: 'Issued from bag',
  BACKORDER_REQUESTED: 'Backorders raised'
};

const movementLabel = (type) => MOVEMENT_LABELS[type]
  ?? (type.startsWith('CORRECTION_')
    ? `Corrected ${(MOVEMENT_LABELS[type.slice(11)] ?? type.slice(11)).toLowerCase()}`
    : type);

/**
 * The shift in one screen.
 *
 * FMRv3 opened the admin view on a KPI panel; the port had queues but no
 * headline, so an expeditor could not tell whether anything had moved today
 * without reading the register.
 */
async function renderToday() {
  const data = await api('/api/dashboard');

  const pending = data.backorders?.Pending ?? { count: 0, quantity: 0 };
  const returned = data.backorders?.['Returned for Review'] ?? { count: 0, quantity: 0 };
  const bags = data.activeBags ?? { count: 0, quantity: 0 };

  const movements = Object.entries(data.last24h ?? {})
    .sort(([, a], [, b]) => b.count - a.count);
  const moved = movements.reduce((total, [, v]) => total + v.count, 0);

  // Pending work is the number an expeditor is answerable for, so it leads and
  // is the only tile that changes colour when it is not zero.
  $('view').innerHTML = `
    <div class="stats">
      <div class="stat${pending.count ? ' stat-warn' : ''}">
        <span class="n">${n(pending.count)}</span>
        <span class="l">Awaiting your decision</span>
        <span class="s">${n(pending.quantity)} on backorder</span>
      </div>
      <div class="stat">
        <span class="n">${n(returned.count)}</span>
        <span class="l">Returned to the crew</span>
        <span class="s">${n(returned.quantity)} outstanding</span>
      </div>
      <div class="stat">
        <span class="n">${n(bags.count)}</span>
        <span class="l">Bags holding material</span>
        <span class="s">${n(bags.quantity)} reserved</span>
      </div>
      <div class="stat">
        <span class="n">${n(moved)}</span>
        <span class="l">Movements today</span>
        <span class="s">last 24 hours</span>
      </div>
    </div>

    <h2 class="sec">What the crews did today</h2>
    ${movements.length
      ? `<div class="tw"><table>
          <thead><tr><th>Movement</th><th class="num">Times</th><th class="num">Quantity</th></tr></thead>
          <tbody>${movements.map(([type, v]) => `
            <tr>
              <td>${esc(movementLabel(type))}</td>
              <td class="num">${n(v.count)}</td>
              <td class="num">${n(v.quantity)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`
      : `<div class="empty">
           <h2>Nothing moved today</h2>
           <p>No material has been located, bagged or issued in the last 24 hours.</p>
         </div>`}`;
}

// --- wiring ----------------------------------------------------------------

const VIEWS = {
  today: renderToday, queue: renderQueue, register: renderRegister, iso: renderIso
};
const SKELETONS = {
  today: { stats: 4, rows: 6 },
  queue: { stats: 4, rows: 8 },
  register: { stats: 4, rows: 10 },
  iso: { stats: 1, rows: 10 }
};

async function show() {
  // A skeleton in the shape of what is coming, rather than a blank page.
  $('view').innerHTML = skeleton(SKELETONS[state.tab]);
  try {
    await VIEWS[state.tab]();
  } catch (failure) {
    $('view').innerHTML = `
      <div class="empty">
        <h2>Could not load this</h2>
        <p>${esc(failure.message)}</p>
        <button type="button" class="btn btn-primary" id="retry">Try again</button>
      </div>`;
    $('retry').onclick = show;
  }
}

$('tabs').onclick = (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;

  state.tab = button.dataset.tab;
  for (const tab of $('tabs').querySelectorAll('button')) {
    tab.setAttribute('aria-selected', String(tab === button));
  }
  show();
};

$('view').addEventListener('click', (event) => {
  const filter = event.target.closest('button[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    return show();
  }

  const openButton = event.target.closest('button[data-open]');
  if (openButton) return openFmr(openButton.dataset.open);

  const renumberButton = event.target.closest('button[data-renumber]');
  if (renumberButton) {
    const row = renumberButton.closest('tr');
    return renumber(renumberButton.dataset.renumber, row.dataset.number);
  }

  const decideButton = event.target.closest('button[data-decide]');
  if (decideButton) {
    const requestId = decideButton.closest('tr').dataset.request;
    const request = state.data?.find((r) => r.id === requestId);
    if (request) decide(request, decideButton.dataset.decide);
  }
});

/** Statuses to filter by, so a domain rename cannot empty the queue silently. */
async function loadFilters() {
  try {
    const bootstrap = await api('/api/bootstrap');
    const statuses = bootstrap.options?.backorderStatuses;
    if (statuses?.length) state.filters = orderFilters(statuses);
  } catch {
    // The fallback list still works.
  }
}

await initShell({ current: 'office', onProjectChange: show });
await loadFilters();
show();
