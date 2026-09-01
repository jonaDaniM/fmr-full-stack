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
import { $, esc, n, when } from './lib/dom.js';
import { dialog } from './lib/modal.js';
import { toast, toastError, toastSticky } from './lib/toast.js';
import { initShell, session } from './lib/shell.js';
import { ceilingFor } from './lib/ceilings.js';

// filters: what has been typed into each FMR's filter box, by fmrId. Kept
// here rather than read off the DOM so a re-render does not lose it.
const state = { results: [], searching: false, locked: null, filters: new Map() };

// --- actions available on a line ------------------------------------------

const ACTION_LABELS = {
  CONFIRM_AVAILABLE: 'Confirm found',
  BAG: 'Bag',
  DIRECT_ISSUE: 'Issue direct',
  ISSUE_FROM_AVAILABLE: 'Issue',
  ISSUE_FROM_BAG: 'Issue from bag',
  BACKORDER_REQUESTED: 'Backorder'
};

/** What a recorded movement is called when a crew reads it back. */
const movementLabel = (type) => ACTION_LABELS[type]
  ?? (type.startsWith('CORRECTION_')
    ? `Undone: ${(ACTION_LABELS[type.slice(11)] ?? type.slice(11)).toLowerCase()}`
    : type);

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
        <span class="ln">Line ${esc(line.lineNumber)}</span>
        <span class="iso">${esc(line.isoNumber)} sht ${esc(line.isoSheet)}</span>
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
      <button type="button" class="btn btn-quiet act-history"
              data-history="${esc(line.id)}">History</button>
    </div>
  </article>`;
}

/**
 * Group the flat result list back into the FMRs it came from.
 *
 * Search returns lines; a crew thinks in requisitions. Eight lines of one FMR
 * repeated its number eight times and gave no way to narrow a long one — a
 * 60-line FMR meant scrolling 60 cards to find one item.
 */
function groupByFmr(lines) {
  const groups = new Map();

  for (const line of lines) {
    const key = line.fmrId ?? line.fmrNumber;
    if (!groups.has(key)) {
      groups.set(key, {
        fmrId: line.fmrId,
        fmrNumber: line.fmrNumber,
        isoNumber: line.isoNumber,
        isoSheet: line.isoSheet,
        priority: line.priority,
        dateRequired: line.dateRequired,
        lines: []
      });
    }
    groups.get(key).lines.push(line);
  }

  // One drawing across the whole FMR is worth naming in the header; several
  // means the header cannot speak for them, so the line rows carry it.
  for (const group of groups.values()) {
    const drawings = new Set(group.lines.map((l) => `${l.isoNumber} sht ${l.isoSheet}`));
    group.drawing = drawings.size === 1 ? [...drawings][0] : `${drawings.size} drawings`;
    group.totals = group.lines.reduce(
      (acc, l) => ({
        requested: acc.requested + Number(l.quantities.requested ?? 0),
        issued: acc.issued + Number(l.quantities.issued ?? 0),
        remaining: acc.remaining + Number(l.quantities.remaining ?? 0)
      }),
      { requested: 0, issued: 0, remaining: 0 }
    );
    group.totals.fulfillmentPct = group.totals.requested > 0
      ? Math.round((group.totals.issued / group.totals.requested) * 100)
      : 0;
  }

  return [...groups.values()];
}

/** Does this line match what was typed into an FMR's filter box? */
function lineMatches(line, term) {
  if (!term) return true;
  const haystack = [
    line.description, line.commodityCode, line.size, line.lineNumber,
    line.isoNumber, line.isoSheet, line.status,
    ...(line.activeBags ?? []).map((bag) => bag.tagNumber)
  ].join(' ').toLowerCase();
  return haystack.includes(term.toLowerCase());
}

function renderGroup(group) {
  const term = state.filters.get(group.fmrId) ?? '';
  const shown = group.lines.filter((line) => lineMatches(line, term));
  const t = group.totals;

  const body = shown.length
    ? shown.map(renderCard).join('')
    : `<p class="no-match">Nothing in this FMR matches
         &ldquo;${esc(term)}&rdquo;.</p>`;

  // The filter only earns its space on an FMR long enough to need narrowing.
  const filter = group.lines.length > 3
    ? `<div class="fmr-tools">
         <label class="vh" for="filter-${esc(group.fmrId)}">Filter this FMR</label>
         <input class="fmr-filter" type="search" id="filter-${esc(group.fmrId)}"
                data-filter-for="${esc(group.fmrId)}" value="${esc(term)}"
                autocomplete="off" placeholder="Filter these lines">
         <span class="fmr-count">${shown.length === group.lines.length
           ? `${group.lines.length} lines`
           : `${shown.length} of ${group.lines.length}`}</span>
       </div>`
    : '';

  return `<section class="fmr-group" data-fmr="${esc(group.fmrId)}">
    <header class="fmr-head">
      <div class="fmr-id">
        <h2>${esc(group.fmrNumber)}</h2>
        <span class="fmr-drawing">${esc(group.drawing)}</span>
      </div>
      <div class="fmr-fill">
        <span class="fill-n">${Number(t.fulfillmentPct)}%</span>
        <span class="fill-l">issued</span>
        <div class="fill-bar" role="img"
             aria-label="${Number(t.fulfillmentPct)}% of this FMR issued">
          <i style="width:${Number(t.fulfillmentPct)}%"></i>
        </div>
      </div>
      <dl class="fmr-tot">
        <div><dt>Requested</dt><dd>${n(t.requested)}</dd></div>
        <div><dt>Issued</dt><dd>${n(t.issued)}</dd></div>
        <div><dt>Remaining</dt><dd>${n(t.remaining)}</dd></div>
      </dl>
      ${filter}
    </header>
    ${body}
  </section>`;
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
  container.innerHTML = groupByFmr(state.results).map(renderGroup).join('');
}

/**
 * Redraw one FMR after its filter changed, leaving the rest of the page alone.
 *
 * Re-rendering everything would take focus out of the box being typed into.
 */
function renderOneGroup(fmrId) {
  const group = groupByFmr(state.results).find((g) => g.fmrId === fmrId);
  const section = document.querySelector(`.fmr-group[data-fmr="${CSS.escape(fmrId)}"]`);
  if (!group || !section) return;

  section.outerHTML = renderGroup(group);

  // Put the caret back where it was — the node it was in has been replaced.
  const box = document.querySelector(`[data-filter-for="${CSS.escape(fmrId)}"]`);
  if (box) {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
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
    const isBagTag = field === 'bagTagNumber';
    // Location is optional on a direct issue: the material never sat anywhere.
    // A bag tag is optional because the server numbers the bag when it is left
    // blank — typing one is for bagging into a tag that is already printed.
    const optional = (isLocation && action === 'DIRECT_ISSUE') || isBagTag;

    return {
      name: field,
      label: labels[field] + (optional ? ' (optional)' : ''),
      value: isLocation ? (line.storageLocation ?? '') : '',
      required: !optional,
      ...(isBagTag ? { hint: 'Leave blank and the next tag number is assigned.' } : {}),
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

      // When the server numbered the bag, that number has to get onto the bag
      // in marker pen — so it leads the message and stays up long enough to
      // copy, rather than trailing a confirmation that fades in three seconds.
      if (!result.replayed && !values.bagTagNumber && result.bagTagNumber) {
        toastSticky(`Bagged. Write ${result.bagTagNumber} on the bag.`);
      } else {
        toast(result.replayed ? 'Already recorded.' : `${ACTION_LABELS[action]} recorded.`);
      }
      return result;
    }
  });
}

/**
 * Everything recorded against one line, newest first.
 *
 * A crew standing at the rack asks "has someone already pulled this?", and
 * the quantities alone do not say who or when. Corrections appear here as
 * their own entries with a negative quantity — the record is never rewritten,
 * so what actually happened stays readable.
 */
async function showHistory(lineId) {
  const line = state.results.find((l) => l.id === lineId);

  let history;
  try {
    ({ history } = await api(`/api/lines/${lineId}/history`));
  } catch (failure) {
    return toastError(failure.message);
  }

  const body = history.length
    ? `<ol class="hist">${renderHistoryEntries(history)}</ol>`
    : '<div class="empty"><p>Nothing has been recorded against this line yet.</p></div>';

  await dialog({
    title: 'What happened to this line',
    lede: line ? `${esc(line.fmrNumber)} · line ${esc(line.lineNumber)} · ${esc(line.description ?? '')}` : '',
    body,
    wide: true,
    confirmLabel: 'Close',
    cancelLabel: 'Done',
    onSubmit: () => null
  });
}

/** One <li> per recorded movement. */
function renderHistoryEntries(history) {
  return history.map((entry) => {
    const corrected = entry.type.startsWith('CORRECTION_');
    const detail = [
      entry.performedBy,
      entry.issuedTo ? `to ${entry.issuedTo}` : null,
      entry.storageLocation
    ].filter(Boolean).join(' · ');

    return `<li class="${corrected ? 'undone' : ''}">
      <div class="h-top">
        <span class="h-what">${esc(movementLabel(entry.type))}</span>
        <span class="h-qty">${n(entry.quantity)} ${esc(entry.uom ?? '')}</span>
      </div>
      <div class="h-who">${esc(detail)} &middot; ${when(entry.at)}</div>
      ${entry.notes ? `<div class="h-note">${esc(entry.notes)}</div>` : ''}
    </li>`;
  }).join('');
}

// --- wiring ----------------------------------------------------------------

// Narrowing one FMR redraws only that FMR, so a filter being typed into keeps
// focus and the other results on screen do not flicker.
$('results').addEventListener('input', (event) => {
  const box = event.target.closest('input[data-filter-for]');
  if (!box) return;

  const fmrId = box.dataset.filterFor;
  state.filters.set(fmrId, box.value);
  renderOneGroup(fmrId);
});

$('results').addEventListener('click', (event) => {
  const historyButton = event.target.closest('button[data-history]');
  if (historyButton) return showHistory(historyButton.dataset.history);

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
    state.filters.clear();   // they belonged to the results being replaced
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
    state.filters.clear();
    $('results').innerHTML = '';
    const hint = $('hint');
    hint.className = 'hint';
    hint.textContent = 'Search by FMR number, drawing, or what the material is.';
    hint.hidden = false;
    loadOptions();
  }
});

/**
 * Someone with no project membership had a working-looking search box that
 * failed on every query. Say so before they type, not after — the page
 * already knows, because the shell told it.
 */
if (!session.projectId) {
  $('searchForm').hidden = true;
  const hint = $('hint');
  hint.className = 'empty';
  hint.innerHTML = `<h2>No project yet</h2>
    <p>This account is not on a project, so there is nothing to search.
       An owner can add you from the Owner screen.</p>`;
  hint.hidden = false;
} else {
  await loadOptions();
}
