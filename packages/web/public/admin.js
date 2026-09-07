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
import { initShell, session, refuseUnless } from './lib/shell.js';

const REGISTER_DEFAULTS = Object.freeze({
  query: '', queryType: 'AUTO', status: '', priority: '',
  exception: 'ALL', sort: 'LAST_ACTIVITY', direction: 'DESC',
  page: 1, pageSize: 25
});

const state = {
  tab: 'today', filter: 'Pending', data: null, filters: null,
  bagReadiness: 'ALL', bagQuery: '', swapsAll: false,
  // Each paged tab keeps its own place, so moving between them does not put
  // somebody back at page 1 of the queue they were working through.
  queuePage: 1, queuePages: null,
  bagPage: 1, bagPages: null,
  isoPage: 1, isoPages: null, isoQuery: '',
  register: { ...REGISTER_DEFAULTS }, registerPages: null
};

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
  const params = new URLSearchParams({ page: String(state.queuePage ?? 1) });
  if (state.filter !== 'All') params.set('status', state.filter);

  const { requests, pagination } = await api(`/api/backorders?${params}`);
  state.data = requests;
  state.queuePages = pagination;

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

  // The request count is the whole queue; the quantities are this page's, and
  // say so. A tile that read "25 requests" when 166 are waiting would be
  // worse than no tile.
  const paged = pagination.totalRecords > requests.length;
  const perPage = paged ? `<span class="s">on this page</span>` : '';

  // A quantity of zero because nothing has been committed yet is not worth a
  // tile — on the Pending filter it is zero by definition. Showing each only
  // where it carries something keeps the row honest.
  const showPending = totals.pending > 0 || !paged;
  const showConfirmed = totals.confirmed > 0 || !paged;
  const fmrCount = Object.keys(groups).length;

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat${totals.pending > 0 ? ' stat-warn' : ''}">
        <span class="n">${n(pagination.totalRecords)}</span>
        <span class="l">Request${pagination.totalRecords === 1 ? '' : 's'}</span>
        <span class="s">${esc(state.filter === 'All' ? 'all states' : state.filter.toLowerCase())}</span>
      </div>
      ${showPending ? `<div class="stat">
        <span class="n">${n(totals.pending)}</span>
        <span class="l">Qty pending</span>
        ${totals.pending > 0 ? perPage : ''}</div>` : ''}
      ${showConfirmed ? `<div class="stat">
        <span class="n">${n(totals.confirmed)}</span>
        <span class="l">Qty committed</span>
        ${totals.confirmed > 0 ? perPage : ''}</div>` : ''}
      <div class="stat"><span class="n">${n(fmrCount)}</span>
        <span class="l">FMR${fmrCount === 1 ? '' : 's'}</span>
        ${paged ? '<span class="s">on this page</span>' : ''}</div>
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
            ${rows[0].dateRequired ? `&middot; needed ${day(rows[0].dateRequired)}` : ''}
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

    ${renderPager(pagination)}
  `;
}

const emptyQueue = () => `
  <div class="empty">
    <h2>Nothing ${state.filter === 'All' ? 'in the queue' : `marked ${esc(state.filter).toLowerCase()}`}</h2>
    <p>${state.filter === 'Pending'
      ? 'Every backorder has been decided. The crews are not waiting on the office.'
      : 'Try another filter to see requests in a different state.'}</p>
  </div>`;

/**
 * What a crew's note adds to the reason they already picked.
 *
 * They typically type the reason back and then append the detail — "Not found
 * in laydown yard" chosen from the list, "Not found in laydown yard 1 and 2"
 * typed underneath. Printing both put the same sentence twice on every row of
 * a 166-row queue and hid the only part that mattered: which yards.
 *
 * Returns the remainder, or '' when the note says nothing new.
 */
function extraNote(request) {
  const notes = String(request.fieldNotes ?? '').trim();
  if (!notes) return '';

  const reason = String(request.reason ?? '').trim();
  if (!reason) return notes;

  const tidy = (value) => value.toLowerCase().replace(/[\s.,;:-]+$/, '');
  if (tidy(notes) === tidy(reason)) return '';

  // Only when the note actually opens with the reason. A note that merely
  // mentions it partway through is a sentence of its own and stays whole.
  if (notes.toLowerCase().startsWith(reason.toLowerCase())) {
    const rest = notes.slice(reason.length).replace(/^[\s.,;:-]+/, '').trim();
    return rest || '';
  }
  return notes;
}

function renderQueueRow(r) {
  const decidable = r.qtyPending > 0;
  const note = extraNote(r);
  return `<tr data-request="${esc(r.id)}">
    <td class="num">${esc(r.lineNumber)}</td>
    <td class="mono">${esc(r.isoNumber)}${r.isoRevision ? `<span class="dim"> rev ${esc(r.isoRevision)}</span>` : ''}</td>
    <td>${esc(r.description ?? '')}<div class="dim">${esc(r.commodityCode ?? '')} &middot; ${esc(r.size ?? '')}</div></td>
    <td class="num">${n(r.qtyRequested)}</td>
    <td class="num">${n(r.qtyPending)}</td>
    <td class="num">${n(r.qtyConfirmed)}</td>
    <td>${esc(r.reason)}${note ? `<div class="dim">${esc(note)}</div>` : ''}</td>
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

// --- active bags -----------------------------------------------------------

/**
 * Bags with material still in them.
 *
 * The mirror of the backorder queue. A backorder is material the office owes
 * the field; an unissued bag is material the field is owed and cannot see —
 * packed, labelled, and sitting on a rack while somebody waits for it. FMRv3
 * ran these as two tabs of one workspace for that reason, and the dashboard
 * count alone never told anyone which bag to go and look for.
 *
 * Oldest first: age is the signal. A bag packed this morning is work in
 * progress; one packed three weeks ago is a problem.
 */
const BAG_FILTERS = [
  ['ALL', 'All'],
  ['READY_FOR_FIELD', 'Ready for field'],
  ['PARTIALLY_ISSUED', 'Partially issued']
];

async function renderBags() {
  // 100 rows arrived at once with no way to reach the 101st. The tiles above
  // still count every bag — those come from the summary, not the page.
  const params = new URLSearchParams({
    readiness: state.bagReadiness, page: String(state.bagPage ?? 1)
  });
  if (state.bagQuery) params.set('q', state.bagQuery);

  const { summary, records, pagination } = await api(`/api/active-bags?${params}`);
  state.bagPages = pagination;

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${n(summary.activeTags)}</span><span class="l">Bag tags</span></div>
      <div class="stat"><span class="n">${n(summary.quantity)}</span><span class="l">Units bagged</span></div>
      <div class="stat stat-ok"><span class="n">${n(summary.readyForField)}</span><span class="l">Ready for field</span></div>
      <div class="stat ${summary.stale ? 'stat-warn' : ''}"><span class="n">${n(summary.stale)}</span><span class="l">Over ${n(summary.staleAfterDays)} days</span></div>
    </div>
    <div class="filters">
      ${BAG_FILTERS.map(([value, label]) => `
        <button type="button" data-bag-filter="${esc(value)}"
                aria-pressed="${value === state.bagReadiness}">${esc(label)}</button>`).join('')}
      <input type="search" id="bagSearch" class="bag-search"
        placeholder="Tag, FMR, drawing or material" value="${esc(state.bagQuery)}">
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th class="w-md">Tag</th><th class="w-md">FMR</th><th class="w-md">Drawing</th>
        <th class="w-grow">Material</th><th class="w-md">Where</th>
        <th class="num w-sm">In bag</th><th class="w-md">Bagged</th><th class="w-md">State</th>
      </tr></thead>
      <tbody>${records.map(renderBagRow).join('')
        || emptyRow(8, state.bagQuery || state.bagReadiness !== 'ALL'
          ? 'No bags match that.'
          : 'Nothing is sitting in a bag. Everything packed has been issued.')}
      </tbody>
    </table></div>

    ${renderPager(pagination)}`;
}

const renderBagRow = (b) => `
  <tr data-fmr="${esc(b.fmrId)}" data-number="${esc(b.fmrNumber)}">
    <td class="mono"><strong>${esc(b.tagNumber)}</strong></td>
    <td class="mono">${esc(b.fmrNumber)}<span class="dim"> ln ${esc(b.lineNumber)}</span></td>
    <td class="mono dim">${esc(b.isoKey ?? '')}</td>
    <td>${esc(b.description ?? '')}
        <div class="dim">${esc(b.commodityCode ?? '')} &middot; ${esc(b.size ?? '')}</div></td>
    <td>${esc(b.storageLocation ?? '—')}</td>
    <td class="num">${n(b.qtyRemaining)} ${esc(b.uom ?? '')}${
      b.qtyIssued > 0 ? `<div class="dim">${n(b.qtyIssued)} drawn</div>` : ''}</td>
    <td class="dim">${day(b.baggedAt)}${
      b.baggedBy ? `<div>${esc(b.baggedBy)}</div>` : ''}</td>
    <td>${esc(b.readinessLabel)}${
      b.stale ? '<div class="dim">sitting a while</div>' : ''}</td>
  </tr>`;

// --- register --------------------------------------------------------------

/**
 * How the register can be narrowed.
 *
 * A register grows without limit — the real system has hundreds of FMRs — so
 * these are how somebody finds the one they are being asked about, not
 * decoration. Ported from FMRv3's register, which had all of this and was the
 * screen the office lived in.
 */
const QUERY_TYPES = [
  ['AUTO', 'Anything'], ['FMR', 'FMR number'], ['ISO', 'Drawing'], ['IWP', 'Work package']
];

const EXCEPTIONS = [
  ['ALL', 'Everything'],
  ['HAS_REMAINING', 'Still outstanding'],
  ['NOT_FULLY_LOCATED', 'Not all found'],
  ['HAS_AVAILABLE', 'On the shelf'],
  ['HAS_BAGGED', 'Bagged, not issued'],
  ['PENDING_BACKORDER', 'Waiting on the office'],
  ['CONFIRMED_BACKORDER', 'On order']
];

const SORTS = [
  ['LAST_ACTIVITY', 'Last touched'], ['DATE_REQUIRED', 'Needed by'],
  ['FMR_NUMBER', 'FMR number'], ['REMAINING', 'Remaining'],
  ['FULFILLMENT', 'Progress'], ['REQUESTED', 'Requested']
];

const option = (value, label, chosen) =>
  `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${esc(label)}</option>`;

async function renderRegister() {
  const r = state.register;
  const params = new URLSearchParams({
    type: r.queryType, exception: r.exception,
    sort: r.sort, direction: r.direction,
    page: String(r.page), pageSize: String(r.pageSize)
  });
  if (r.query) params.set('q', r.query);
  if (r.status) params.set('status', r.status);
  if (r.priority) params.set('priority', r.priority);

  const { fmrs, totals, filters, pagination } = await api(`/api/register?${params}`);
  state.registerPages = pagination;

  const narrowed = r.query || r.status || r.priority || r.exception !== 'ALL';

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${n(pagination.totalRecords)}</span><span class="l">${
        narrowed ? 'Matching FMRs' : 'FMRs'}</span></div>
      <div class="stat"><span class="n">${n(totals.lines)}</span><span class="l">Lines</span></div>
      <div class="stat stat-ok"><span class="n">${n(totals.fulfillmentPct)}%</span><span class="l">Fulfilled</span></div>
      <div class="stat stat-warn"><span class="n">${n(totals.backordered)}</span><span class="l">On backorder</span></div>
    </div>

    <div class="regfilters">
      <label class="regsearch">
        <span class="vh">Search the register</span>
        <input type="search" id="regQuery" value="${esc(r.query)}"
               placeholder="FMR, drawing, work package or who asked">
      </label>
      <label><span class="vh">Search in</span>
        <select id="regType">${QUERY_TYPES.map(([v, l]) => option(v, l, r.queryType)).join('')}</select>
      </label>
      <label><span class="vh">Status</span>
        <select id="regStatus">${
          [option('', 'Any status', r.status)].concat(
            (filters.statuses ?? []).map((v) => option(v, v, r.status))).join('')}</select>
      </label>
      <label><span class="vh">Priority</span>
        <select id="regPriority">${
          [option('', 'Any priority', r.priority)].concat(
            (filters.priorities ?? []).map((v) => option(v, v, r.priority))).join('')}</select>
      </label>
      <label><span class="vh">Show only</span>
        <select id="regException">${EXCEPTIONS.map(([v, l]) => option(v, l, r.exception)).join('')}</select>
      </label>
      <label><span class="vh">Sort by</span>
        <select id="regSort">${SORTS.map(([v, l]) => option(v, l, r.sort)).join('')}</select>
      </label>
      <button type="button" id="regDirection" class="btn btn-sm"
              title="${r.direction === 'DESC' ? 'Largest first' : 'Smallest first'}">
        ${r.direction === 'DESC' ? '↓' : '↑'}</button>
      ${narrowed ? '<button type="button" id="regReset" class="btn btn-sm">Clear</button>' : ''}
    </div>

    <div class="tw"><table>
      <thead><tr>
        <th class="w-md">FMR</th><th class="w-md">IWP</th><th class="w-lg">Requested by</th>
        <th class="w-sm">Needed</th><th class="w-sm">Priority</th><th class="num w-tiny">Lines</th>
        <th class="num w-sm">Requested</th><th class="num w-sm">Issued</th>
        <th class="num w-sm">Remaining</th><th class="w-md">Progress</th><th class="w-md"></th>
      </tr></thead>
      <tbody>${fmrs.map(renderRegisterRow).join('')
        || emptyRow(11, narrowed
          ? 'Nothing matches that. Clear the filters to see the whole register.'
          : 'No FMRs on this project yet. Publish one from Drafts or Import.')}
      </tbody>
    </table></div>
    ${renderPager(pagination)}`;
}

/** Where you are in the register, and how to move. */
function renderPager(p) {
  if (p.totalRecords === 0) return '';

  return `
    <div class="pager">
      <span class="dim">${n(p.firstRecord)}–${n(p.lastRecord)} of ${n(p.totalRecords)}</span>
      <button type="button" class="btn btn-sm" data-page="${esc(p.page - 1)}"
        ${p.hasPrevious ? '' : 'disabled'}>Previous</button>
      <span class="dim">Page ${n(p.page)} of ${n(p.totalPages)}</span>
      <button type="button" class="btn btn-sm" data-page="${esc(p.page + 1)}"
        ${p.hasNext ? '' : 'disabled'}>Next</button>
    </div>`;
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
      ${session.can('ownerEdit')
        ? `<button type="button" class="btn btn-sm" data-renumber="${esc(f.id)}">Renumber</button>`
        : ''}
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
    readOnly: true
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
      <td class="mono">${esc(l.isoNumber)}${l.isoRevision ? `<span class="dim"> rev ${esc(l.isoRevision)}</span>` : ''}</td>
      <td>${esc(l.description ?? '')}
          <div class="dim">${esc(l.commodityCode ?? '')} &middot; ${esc(l.size ?? '')}</div>
          ${renderFieldNotes(l.fieldNotes)}</td>
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
 * What the crew wrote on this line.
 *
 * The quantities say what happened; these say why. "Rack 12 empty — checked 14
 * as well" is the difference between an office deciding a backorder blind and
 * deciding it knowing where somebody already looked. FMRv3 put these in the
 * same drill-down and it is the reason the drill-down was worth opening.
 */
function renderFieldNotes(fieldNotes) {
  const notes = fieldNotes?.notes ?? [];
  if (!notes.length) return '';

  const more = fieldNotes.truncated
    ? `<li class="dim">…and ${n(fieldNotes.count - notes.length)} older</li>`
    : '';

  return `<ul class="notes">${notes.map((note) => `
    <li>
      <span class="note-what">${esc(note.actionLabel)} ${n(note.quantity)}${
        note.uom ? ` ${esc(note.uom)}` : ''}</span>
      <span class="note-text">${esc(note.notes)}</span>
      <span class="dim">${esc(note.performedBy ?? '')}${
        note.at ? ` · ${day(note.at)}` : ''}</span>
    </li>`).join('')}${more}</ul>`;
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
  const params = new URLSearchParams({ page: String(state.isoPage ?? 1) });
  if (state.isoQuery) params.set('q', state.isoQuery);

  const { drawings, pagination } = await api(`/api/iso-summary?${params}`);
  state.isoPages = pagination;

  const paged = pagination.totalRecords > drawings.length;

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${n(pagination.totalRecords)}</span>
        <span class="l">Drawing${pagination.totalRecords === 1 ? '' : 's'}</span>
        ${state.isoQuery ? '<span class="s">matching</span>' : ''}</div>
    </div>

    <div class="filters">
      <input type="search" id="isoSearch" class="search-inline"
        placeholder="Drawing number" value="${esc(state.isoQuery ?? '')}"
        autocomplete="off" enterkeyhint="search">
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
            <div class="barline">
              <div class="bar"><i style="width:${Number(d.fulfillmentPct)}%"></i></div>
              <span class="barpct">${esc(d.fulfillmentPct)}%</span>
            </div>
          </td>
        </tr>`).join('')
        || emptyRow(8, state.isoQuery
          ? 'No drawing matches that.'
          : 'No material on this project yet.')}
      </tbody>
    </table></div>

    ${paged || pagination.totalPages > 1 ? renderPager(pagination) : ''}`;
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
           <p>No material has been located, bagged or issued in the last 24 hours.
              ${pending.count
                ? `There ${pending.count === 1 ? 'is' : 'are'} still
                   ${n(pending.count)} backorder${pending.count === 1 ? '' : 's'}
                   waiting on a decision.`
                : ''}</p>
           ${pending.count
             ? '<button type="button" class="btn btn-primary" data-tab-jump="queue">Open the queue</button>'
             : ''}
         </div>`}`;
}

// --- wiring ----------------------------------------------------------------

// --- open line swaps -------------------------------------------------------

/**
 * Material one line borrowed from another, and has not replaced.
 *
 * The third thing the office chases, beside backorders and unissued bags.
 * A backorder is material the office owes the field; an unissued bag is
 * material the field is owed and cannot see; an open swap is material one
 * line owes another. Without this queue a shortage moves quietly from one
 * drawing to the next and lives in somebody's text messages.
 *
 * Oldest first, because age is the signal here too.
 */
async function renderSwaps() {
  const { swaps } = await api(`/api/swaps?all=${state.swapsAll ? '1' : '0'}`);

  const owing = swaps.filter((s) => Number(s.qty_outstanding) > 0);
  const outstanding = owing.reduce((sum, s) => sum + Number(s.qty_outstanding), 0);
  const oldest = owing.length ? Math.max(...owing.map((s) => Number(s.age_days) || 0)) : 0;

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${n(owing.length)}</span><span class="l">Open swaps</span></div>
      <div class="stat"><span class="n">${n(outstanding)}</span><span class="l">Units owed</span></div>
      <div class="stat ${oldest > 14 ? 'stat-warn' : ''}"><span class="n">${n(oldest)}</span><span class="l">Oldest, days</span></div>
    </div>
    <div class="filters">
      <button type="button" data-swap-filter="0"
              class="chip ${state.swapsAll ? '' : 'chip-on'}">Still owed</button>
      <button type="button" data-swap-filter="1"
              class="chip ${state.swapsAll ? 'chip-on' : ''}">All</button>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th>Borrowed from</th><th>Given to</th><th>Material</th>
        <th class="num w-sm">Borrowed</th><th class="num w-sm">Repaid</th>
        <th class="num w-sm">Owed</th><th class="num w-sm">Age</th><th></th>
      </tr></thead>
      <tbody>
        ${swaps.length ? swaps.map(renderSwapRow).join('') : emptyRow(8,
          'No material has been borrowed between lines.')}
      </tbody>
    </table></div>`;
}

function renderSwapRow(swap) {
  const owed = Number(swap.qty_outstanding);
  return `
    <tr>
      <td><strong>${esc(swap.donor_fmr_number)}</strong> line ${esc(String(swap.donor_line_number))}
          <span class="s">${esc(swap.donor_iso ?? '')}</span></td>
      <td><strong>${esc(swap.receiver_fmr_number)}</strong> line ${esc(String(swap.receiver_line_number))}
          <span class="s">${esc(swap.receiver_iso ?? '')}</span></td>
      <td>${esc(swap.donor_description ?? '')}
          <span class="s">${esc(swap.commodity_code ?? '')} ${esc(swap.size ?? '')}</span></td>
      <td class="num">${n(swap.qty_borrowed)} ${esc(swap.uom ?? '')}</td>
      <td class="num">${n(swap.qty_repaid)}</td>
      <td class="num ${owed > 0 ? 'warn' : ''}">${n(owed)}</td>
      <td class="num">${n(swap.age_days)}</td>
      <td>${owed > 0
        ? `<button type="button" class="btn btn-sm" data-repay="${esc(swap.id)}"
                   data-owed="${esc(String(owed))}">Record replacement</button>`
        : `<span class="s">${esc(swap.status)}</span>`}</td>
    </tr>`;
}


/**
 * Record replacement material arriving for a line that lent some away.
 *
 * This settles the debt only — it does not put material back on the donor's
 * shelf. The crew does that by locating it, when the steel is physically
 * there. Crediting a shelf from a paperwork screen would show material that
 * nobody has actually seen.
 */
async function recordReplacement(swapId, owed) {
  await dialog({
    title: 'Record replacement material',
    confirmLabel: 'Record it',
    fields: [
      {
        name: 'quantity', label: 'Quantity received', type: 'number',
        required: true, value: owed, min: 0.0001, max: owed, step: 'any',
        hint: `${n(owed)} still owed. Record less if only part of it arrived.`
      },
      {
        name: 'notes', label: 'Notes (optional)', type: 'textarea', rows: 2,
        placeholder: 'Purchase order, delivery note, who received it'
      }
    ],
    onSubmit: async (values) => {
      const result = await api(`/api/swaps/${encodeURIComponent(swapId)}/repay`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({
          quantity: Number(values.quantity),
          notes: values.notes || undefined
        })
      });

      await show();
      toast(Number(result.qty_outstanding) > 0
        ? `Recorded — ${n(result.qty_outstanding)} still owed.`
        : 'Recorded. This swap is settled.');
      return result;
    }
  });
}

const VIEWS = {
  today: renderToday, queue: renderQueue, bags: renderBags,
  register: renderRegister, iso: renderIso, swaps: renderSwaps
};
const SKELETONS = {
  today: { stats: 4, rows: 6 },
  queue: { stats: 4, rows: 8 },
  bags: { stats: 4, rows: 8 },
  register: { stats: 4, rows: 10 },
  iso: { stats: 1, rows: 10 },
  swaps: { stats: 3, rows: 8 }
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

/**
 * The active-bag search.
 *
 * Delegated and bound once. Binding it inside the render meant every keystroke
 * rebuilt the timer and re-rendered the input being typed into — the caret
 * jumped, and a pending request from the previous render could land after the
 * current one and show the wrong rows.
 *
 * The caret is put back after the re-render, because replacing the table
 * replaces the box with it.
 */
$('view').addEventListener('input', debounce(async (event) => {
  const box = event.target.closest('#bagSearch, #regQuery, #isoSearch');
  if (!box) return;

  const id = box.id;
  const query = box.value.trim();

  if (id === 'isoSearch') {
    if (query === state.isoQuery) return;
    state.isoQuery = query;
    state.isoPage = 1;
  } else if (id === 'bagSearch') {
    if (query === state.bagQuery) return;
    state.bagQuery = query;
    state.bagPage = 1;
  } else {
    if (query === state.register.query) return;
    // A new search starts at the first page; staying on page 4 of a result
    // set that no longer has four pages shows nothing.
    state.register = { ...state.register, query, page: 1 };
  }

  const caret = box.selectionStart;
  await show();

  const again = $(id);
  if (again) {
    again.focus();
    again.setSelectionRange(caret, caret);
  }
}));

/**
 * The register's dropdowns.
 *
 * Delegated like everything else here, so the listeners survive the re-render
 * that each change causes. Any change resets to page one, for the same reason
 * a new search does.
 */
const REGISTER_CONTROLS = {
  regType: 'queryType', regStatus: 'status', regPriority: 'priority',
  regException: 'exception', regSort: 'sort'
};

$('view').addEventListener('change', (event) => {
  const field = REGISTER_CONTROLS[event.target.id];
  if (!field) return;

  state.register = { ...state.register, [field]: event.target.value, page: 1 };
  show();
});

/** Wait until the typing stops, so a search is one request and not eight. */
function debounce(run, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => run(...args), wait);
  };
}

$('view').addEventListener('click', (event) => {
  // An empty screen that names the work should be able to go to it.
  const jump = event.target.closest('button[data-tab-jump]');
  if (jump) {
    const target = jump.dataset.tabJump;
    state.tab = target;
    for (const tab of $('tabs').querySelectorAll('button')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === target));
    }
    return show();
  }

  const filter = event.target.closest('button[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    state.queuePage = 1;      // page 7 of the old filter is not page 7 of this one
    return show();
  }

  const bagFilter = event.target.closest('button[data-bag-filter]');
  if (bagFilter) {
    state.bagReadiness = bagFilter.dataset.bagFilter;
    state.bagPage = 1;
    return show();
  }

  const swapFilter = event.target.closest('button[data-swap-filter]');
  if (swapFilter) {
    state.swapsAll = swapFilter.dataset.swapFilter === '1';
    return show();
  }

  const repay = event.target.closest('button[data-repay]');
  if (repay) return recordReplacement(repay.dataset.repay, Number(repay.dataset.owed));

  if (event.target.closest('#regDirection')) {
    state.register = {
      ...state.register,
      direction: state.register.direction === 'DESC' ? 'ASC' : 'DESC',
      page: 1
    };
    return show();
  }

  if (event.target.closest('#regReset')) {
    state.register = { ...REGISTER_DEFAULTS };
    return show();
  }

  // Three tabs draw the same pager, so it moves whichever one is showing.
  const pager = event.target.closest('button[data-page]');
  if (pager && !pager.disabled) {
    const page = Number(pager.dataset.page);
    if (state.tab === 'queue') state.queuePage = page;
    else if (state.tab === 'bags') state.bagPage = page;
    else if (state.tab === 'iso') state.isoPage = page;
    else state.register = { ...state.register, page };
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

if (!refuseUnless('adminBackorder', { what: 'The office screens' })) {
  await loadFilters();
  show();
}
