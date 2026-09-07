/**
 * The review queue.
 *
 * Two jobs on one screen, because they are the same question asked of
 * different states: a planner decides whether a requisition suits the work
 * package, and a material manager gives the approved ones their official FMR
 * number and releases them.
 *
 * Nobody is shown work that is not theirs. The server decides what belongs in
 * each queue and which moves each person may make; this renders the answer
 * rather than deciding again in the browser.
 */

import { api, idempotencyKey } from './lib/api.js';
import { $, esc, n, isoLabel } from './lib/dom.js';
import { askReason, confirmAction, dialog } from './lib/modal.js';
import { toast, toastError } from './lib/toast.js';
import { initShell, session } from './lib/shell.js';
import { STATE_LABELS } from './lib/workflowStates.js';

const state = { queue: null, filter: null };

async function load() {
  const query = state.filter ? `?state=${encodeURIComponent(state.filter)}` : '';
  state.queue = await api(`/api/review${query}`);
  render();
}

function render() {
  const { items, states } = state.queue;

  if (!states.length) {
    return void ($('view').innerHTML = `
      <div class="empty">
        <h2>Nothing to review here</h2>
        <p>This screen is for planners and material managers. Ask an owner if
           you should have one of those roles.</p>
      </div>`);
  }

  $('view').innerHTML = `
    <div class="tabs" role="tablist" id="filters">
      ${renderFilterTab(null, 'Everything waiting')}
      ${states.map((name) => renderFilterTab(name, STATE_LABELS[name] ?? name)).join('')}
    </div>

    ${items.length ? items.map(renderCard).join('') : `
      <div class="empty">
        <h2>Nothing waiting</h2>
        <p>${state.filter
             ? 'Nothing is in that state right now.'
             : 'Everything that needed a decision has had one.'}</p>
      </div>`}`;

  $('filters').onclick = (event) => {
    const tab = event.target.closest('button[data-filter]');
    if (!tab) return;
    state.filter = tab.dataset.filter || null;
    load().catch((failure) => toastError(failure.message));
  };
}

const renderFilterTab = (name, label) => `
  <button type="button" role="tab" data-filter="${esc(name ?? '')}"
          aria-selected="${state.filter === name}">${esc(label)}</button>`;

/** One requisition waiting on somebody. */
function renderCard(item) {
  const waited = age(item.createdAt);

  return `<section class="review-card" data-item="${esc(item.id)}">
    <div class="review-head">
      <div>
        <!-- A planner reviews the work, which the drawing names; the FMR
             number arrives at the material manager's step after this one. -->
        <h3>${esc(item.fmrNumber
          || isoLabel(item.isoNumber, item.isoRevision) || 'No number yet')}</h3>
        <p class="dim">
          ${esc(isoLabel(item.isoNumber, item.isoRevision))}
          &middot; ${esc(item.lineCount)} line${item.lineCount === 1 ? '' : 's'}
          &middot; from ${esc(item.sourceName ?? 'a draft')}
          ${waited ? `&middot; waiting ${esc(waited)}` : ''}
        </p>
      </div>
      <span class="pill pill-state">${esc(STATE_LABELS[item.state] ?? item.state)}</span>
    </div>

    ${item.plannerNote ? `
      <p class="review-note">
        <b>Returned:</b> ${esc(item.plannerNote)}
        ${item.plannerName ? `<span class="dim">— ${esc(item.plannerName)}</span>` : ''}
      </p>` : ''}

    ${item.numberedByName ? `
      <p class="dim review-trail">Numbered by ${esc(item.numberedByName)}.</p>` : ''}

    ${renderLines(item)}

    <div class="review-actions">
      ${session.can('ownerEdit')
        ? `<a class="btn btn-quiet" href="/drafts.html?item=${encodeURIComponent(item.id)}">Open the draft</a>`
        : ''}
      ${renderActions(item)}
    </div>
  </section>`;
}

/**
 * The material being approved, read-only.
 *
 * A planner is asked whether a requisition suits the work package, and used to
 * be shown only how many lines it had — the button offering the draft went to a
 * screen their role cannot load, so they were deciding blind. Read-only because
 * this screen is a decision and not an editor: correcting a line is the
 * originator's job, which is what returning it for correction is for.
 */
function renderLines(item) {
  if (!item.lines?.length) return '';

  return `<details class="review-lines">
    <summary>${esc(item.lines.length)} material line${item.lines.length === 1 ? '' : 's'}</summary>
    <div class="tw"><table>
      <thead><tr>
        <th class="w-tiny">#</th><th class="w-sm">Code</th><th class="w-sm">Size</th>
        <th class="w-grow">Description</th><th class="num w-sm">Qty</th><th class="w-sm">UOM</th>
      </tr></thead>
      <tbody>${item.lines.map((l) => `
        <tr>
          <td class="num">${esc(l.lineNumber)}</td>
          <td class="mono">${esc(l.commodityCode ?? '')}</td>
          <td class="mono">${esc(l.size ?? '')}</td>
          <td>${esc(l.description ?? '')}</td>
          <td class="num">${esc(n(l.quantity))}</td>
          <td class="mono">${esc(l.uom ?? '')}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </details>`;
}

/** The moves this person can make on this requisition, as buttons. */
function renderActions(item) {
  return item.actions.map((action) => `
    <button type="button" class="btn ${esc(buttonClass(action.action))}"
            data-action="${esc(action.action)}" data-item="${esc(item.id)}">
      ${esc(actionLabel(action))}
    </button>`).join('');
}

/** Approving is the ordinary act here; returning something is not. */
const buttonClass = (action) =>
  (action === 'PLANNER_RETURN' ? 'btn-quiet' : 'btn-primary');

function actionLabel({ action, verb }) {
  if (action === 'ASSIGN_NUMBER') return 'Give it its number';
  if (action === 'PLANNER_APPROVE') return 'Approve';
  if (action === 'PLANNER_RETURN') return 'Return for correction';
  if (action === 'SEND_TO_MATERIAL') return 'Send to material management';
  if (action === 'SUBMIT') return 'Send for review';
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/** How long this has been sitting, said the way a person would say it. */
function age(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'since today';
  if (days === 1) return 'a day';
  if (days < 14) return `${days} days`;
  return `${Math.floor(days / 7)} weeks`;
}

$('view').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const { action, item: itemId } = button.dataset;
  const item = state.queue.items.find((i) => i.id === itemId);
  if (!item) return;

  try {
    if (action === 'ASSIGN_NUMBER') return await number(item);

    if (action === 'PLANNER_RETURN') {
      // The note is what the person correcting it reads, so it is the whole
      // point of a return rather than a formality.
      const reason = await askReason({
        title: 'Return this for correction?',
        lede: item.fmrNumber || item.isoNumber,
        label: 'What needs changing',
        confirmLabel: 'Return it'
      });
      if (!reason) return;

      await api('/api/review/advance', {
        method: 'POST',
        body: JSON.stringify({ itemId, action, reason })
      });
      toast('Returned for correction.');
      return void await load();
    }

    if (action === 'PLANNER_APPROVE') {
      const sure = await confirmAction({
        title: 'Approve this requisition?',
        lede: item.fmrNumber || item.isoNumber,
        body: 'It goes to material management for its FMR number. Nothing '
          + 'reaches a crew until then.',
        confirmLabel: 'Approve'
      });
      if (!sure) return;
    }

    // Publishing is not a state change. It creates the FMR, its lines and its
    // ledger — /api/review/advance would only move workflow_state, leaving an
    // item marked published that no crew can search for.
    if (action === 'PUBLISH') {
      const sure = await confirmAction({
        title: `Publish ${item.fmrNumber ?? 'this requisition'}?`,
        lede: isoLabel(item.isoNumber, item.isoRevision),
        body: 'The crew can search for it and start pulling material '
          + 'immediately. Publishing cannot be undone.',
        confirmLabel: 'Publish'
      });
      if (!sure) return;

      const result = await api('/api/import/publish', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({ batchId: item.batchId, itemIds: [itemId] })
      });
      toast(`Published ${result.count} FMR${result.count === 1 ? '' : 's'}.`);
      return void await load();
    }

    await api('/api/review/advance', {
      method: 'POST', body: JSON.stringify({ itemId, action })
    });
    toast('Done.');
    await load();
  } catch (failure) {
    toastError(failure.message);
  }
});

/**
 * Give a requisition its official number.
 *
 * Its own dialog because it is its own decision: the number is what the field
 * searches by and what purchasing quotes against, so it is typed deliberately
 * rather than edited in place among the other header fields.
 */
async function number(item) {
  const answer = await dialog({
    title: 'Assign the FMR number',
    lede: isoLabel(item.isoNumber, item.isoRevision),
    body: 'The next number is issued automatically — leave this empty to take '
      + 'it. Type one only to depart from the sequence; it must not already be '
      + 'in use. This is the number the field searches by and the one '
      + 'purchasing quotes against.',
    fields: [{
      // Not required: empty is the ordinary case now, and means "issue the
      // next one". The placeholder says so rather than showing a specimen
      // number, which would read as a format to copy.
      name: 'fmrNumber', label: 'FMR number', value: item.fmrNumber ?? '',
      placeholder: 'next in sequence', required: false
    }],
    confirmLabel: 'Assign and release',
    onSubmit: async ({ fmrNumber }) => {
      // The server answers with the number it issued, which is the only place
      // it exists when the sequence chose it.
      const { fmrNumber: issued } = await api('/api/review/number', {
        method: 'POST',
        body: JSON.stringify({ itemId: item.id, fmrNumber })
      });
      return issued ?? true;
    }
  });

  if (!answer) return;
  toast(typeof answer === 'string'
    ? `Numbered FMR ${answer}. It can be published now.`
    : 'Numbered. It can be published now.');
  await load();
}

await initShell({ current: 'review', onProjectChange: load });
load().catch((failure) => {
  $('view').innerHTML = `<div class="empty"><h2>Could not load the queue</h2>
    <p>${esc(failure.message)}</p></div>`;
});
