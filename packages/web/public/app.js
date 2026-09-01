/**
 * Field interface.
 *
 * One screen: search, read the quantities, act. Everything the crew needs to
 * decide is on the card — what is left to find, what is on the shelf, what
 * the office has said about a backorder.
 *
 * This runs on old phones over site wifi, so it stays small and the type
 * stack starts with system-ui: text must not wait on a font request.
 */

import { api, idempotencyKey } from './lib/api.js';
import { $, esc, n } from './lib/dom.js';
import { dialog } from './lib/modal.js';
import { toast } from './lib/toast.js';
import { initShell } from './lib/shell.js';
import { ceilingFor } from './lib/ceilings.js';

const state = { results: [], searching: false, locked: null };

// --- actions available on a line ------------------------------------------

const ACTION_LABELS = {
  CONFIRM_AVAILABLE: 'Confirm found',
  BAG: 'Bag',
  DIRECT_ISSUE: 'Issue direct',
  ISSUE_FROM_AVAILABLE: 'Issue',
  ISSUE_FROM_BAG: 'Issue from bag',
  BACKORDER_REQUESTED: 'Backorder'
};

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

const statusPill = (status) => {
  if (status === 'Issued') return 'pill';
  if (status.includes('Backorder')) return 'pill pill-warn';
  if (status === 'Open') return 'pill pill-danger';
  return 'pill pill-quiet';
};

// --- rendering -------------------------------------------------------------

function renderCard(line) {
  const q = line.quantities;
  const actions = availableActions(line);

  const notices = (line.notices ?? []).map((notice) => {
    const rejected = notice.status === 'Rejected';
    return `<div class="notice ${rejected ? 'notice-rejected' : ''}">
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

  return `<article class="card" data-line="${esc(line.id)}">
    <div class="card-head">
      <div class="card-top">
        <span class="fmr">${esc(line.fmrNumber)}</span>
        <span class="iso">${esc(line.isoNumber)} sht ${esc(line.isoSheet)} &middot; line ${esc(line.lineNumber)}</span>
        <span class="${statusPill(line.status)}">${esc(line.status)}</span>
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
        `<button type="button" data-action="${action}"
                 class="btn ${i === 0 ? 'btn-primary' : ''}">${ACTION_LABELS[action]}</button>`
      ).join('') || '<span class="dim">Nothing outstanding on this line.</span>'}
    </div>
  </article>`;
}

function renderResults() {
  const container = $('results');
  const hint = $('hint');

  if (!state.results.length) {
    container.innerHTML = '';
    hint.className = 'empty';
    hint.innerHTML = `<h2>Nothing matched</h2>
      <p>Try the FMR number, the drawing number, or a word from the description.</p>`;
    hint.hidden = false;
    return;
  }

  hint.hidden = true;
  container.innerHTML = state.results.map(renderCard).join('');
}

/** A failure looks like a failure, not like an empty result. */
function renderSearchError(message) {
  $('results').innerHTML = '';
  const hint = $('hint');
  hint.className = 'empty';
  hint.innerHTML = `<h2>Search did not run</h2><p>${esc(message)}</p>`;
  hint.hidden = false;
}

// --- acting on a line ------------------------------------------------------

function fieldsFor(line, action) {
  const max = ceilingFor(line, action);

  return NEEDS[action].map((field) => {
    if (field === 'quantity') {
      return {
        name: 'quantity', label: `Quantity (${line.uom ?? ''})`, type: 'number',
        value: max, min: 0.0001, max, step: 'any', inputmode: 'decimal', required: true,
        hint: `Up to ${n(max)} ${line.uom ?? ''}`
      };
    }
    if (field === 'reason') {
      return { name: 'reason', label: 'Reason', type: 'select', options: REASONS, required: true };
    }
    if (field === 'bagTagId') {
      return {
        name: 'bagTagId', label: 'Bag', type: 'select', required: true,
        options: line.activeBags.map((bag) => ({
          value: bag.bagTagId, label: `${bag.tagNumber} — ${n(bag.qtyRemaining)} left`
        }))
      };
    }

    const labels = {
      storageLocation: 'Storage location',
      issuedToName: 'Issued to',
      bagTagNumber: 'Bag tag number'
    };
    const isLocation = field === 'storageLocation';
    // Location is optional on a direct issue: the material never sat anywhere.
    const optional = isLocation && action === 'DIRECT_ISSUE';

    return {
      name: field,
      label: labels[field] + (optional ? ' (optional)' : ''),
      value: isLocation ? (line.storageLocation ?? '') : '',
      required: !optional,
      // A warehouse invents locations faster than anyone maintains a list, so
      // these are suggestions over free text, not a closed set.
      ...(isLocation && STORAGE_LOCATIONS.length
        ? { list: 'locations', suggestions: STORAGE_LOCATIONS }
        : {})
    };
  });
}

async function act(line, action) {
  await dialog({
    title: ACTION_LABELS[action],
    lede: `${line.fmrNumber} · line ${line.lineNumber} · ${line.description ?? ''}`,
    confirmLabel: ACTION_LABELS[action],
    workingLabel: 'Working…',
    fields: [
      ...fieldsFor(line, action),
      { name: 'notes', label: 'Notes (optional)', type: 'textarea', rows: 2 }
    ],
    onSubmit: async (values) => {
      const payload = { action, lineId: line.id };
      for (const field of NEEDS[action]) {
        payload[field] = field === 'quantity' ? Number(values.quantity) : values[field];
      }
      if (values.notes) payload.notes = values.notes;

      // One key per attempt: a retry after a dropped connection replays the
      // original result instead of moving the material twice.
      const result = await api('/api/field/action', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey() },
        body: JSON.stringify(payload)
      });

      // Swap the updated line back into the list in place.
      const index = state.results.findIndex((l) => l.id === line.id);
      if (index >= 0) state.results[index] = { ...state.results[index], ...result.line };

      renderResults();
      toast(result.replayed ? 'Already recorded.' : `${ACTION_LABELS[action]} recorded.`);
      return result;
    }
  });
}

// --- wiring ----------------------------------------------------------------

$('results').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const lineId = button.closest('.card').dataset.line;
  const line = state.results.find((l) => l.id === lineId);
  if (line) act(line, button.dataset.action);
});

$('searchForm').onsubmit = async (event) => {
  event.preventDefault();
  const query = $('q').value.trim();
  if (!query || state.searching) return;   // a gloved double-tap raced itself

  const button = $('searchGo');
  state.searching = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');

  const hint = $('hint');
  hint.className = 'hint';
  hint.textContent = 'Searching…';
  hint.hidden = false;

  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    state.results = results;
    renderResults();
  } catch (failure) {
    renderSearchError(failure.message);
  } finally {
    state.searching = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
};

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

    state.locked = bootstrap.controls?.fieldLocked ? bootstrap.controls : null;
    if (state.locked) {
      const hint = $('hint');
      hint.className = 'empty';
      hint.innerHTML = `<h2>Material movement is paused</h2>
        <p>${esc(state.locked.lockReason || 'The office has paused work on this project.')}</p>`;
      hint.hidden = false;
    }
  } catch {
    // Keep the defaults.
  }
}

await initShell({
  current: 'field',
  onProjectChange: () => {
    state.results = [];
    $('results').innerHTML = '';
    const hint = $('hint');
    hint.className = 'hint';
    hint.textContent = 'Search by FMR number, drawing, or what the material is.';
    hint.hidden = false;
    loadOptions();
  }
});

await loadOptions();
