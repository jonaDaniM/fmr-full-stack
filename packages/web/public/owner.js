/**
 * Owner console.
 *
 * The screens with the most consequence per click: pausing every crew on site,
 * resetting ledger totals, taking away someone's access, undoing a movement of
 * material that physically happened.
 *
 * So the rule here is that nothing irreversible fires on one click, and that
 * a refusal the page could have predicted is shown before the work of filling
 * a form — not after.
 */

import { api, idempotencyKey } from './lib/api.js';
import { $, esc, n, when, skeleton, emptyRow, isoLabel } from './lib/dom.js';
import { dialog, confirmAction, askReason } from './lib/modal.js';
import { toast, toastError } from './lib/toast.js';
import { initShell, session, refuseUnless } from './lib/shell.js';
import { destinationFor } from './lib/checkRoutes.js';

const state = { tab: 'health' };

// --- health and controls ---------------------------------------------------

async function renderHealth() {
  const health = await api('/api/project-health');
  const locked = health.controls.fieldLocked;

  $('view').innerHTML = `
    <div class="panel ${locked ? 'alert' : ''}">
      <h3>${locked ? 'Material movement is paused' : 'Material movement is running'}</h3>
      <p>${locked
        ? `Paused ${when(health.controls.lockedAt)}${health.controls.lockedBy
            ? ` by ${esc(health.controls.lockedBy)}` : ''}. The crew is shown:
           "${esc(health.controls.reason ?? '')}"`
        : 'Pause during a cutover or a stock count. Crews see the reason you give.'}</p>
      <div class="row row-entry">
        ${locked
          ? '<button type="button" class="btn btn-primary" id="unlock">Resume work</button>'
          : `<label class="vh" for="reason">Why are you pausing?</label>
             <input id="reason" type="text" autocomplete="off"
                    placeholder="Why are you pausing? The crew sees this.">
             <button type="button" class="btn btn-danger btn-fit" id="lock">Pause</button>`}
      </div>
    </div>

    <h3>Checks</h3>
    <div style="margin-top:var(--s-3)">
      ${health.checks.map(renderCheck).join('')
        || '<div class="check"><span class="dot"></span><span>No checks ran.</span></div>'}
    </div>

    <p class="hint" style="text-align:left;padding:var(--s-4) 0 0">
      Last material movement: ${when(health.lastActivityAt)}.
      Backups and uptime are handled by the database, not here.
    </p>`;

  $('lock')?.addEventListener('click', async () => {
    const reason = $('reason').value.trim();
    if (reason.length < 3) return toastError('Give a reason of at least 3 characters — the crew sees it.');

    const sure = await confirmAction({
      title: 'Pause all material movement?',
      lede: session.project?.name,
      body: `<p class="dim">Every crew on this project stops being able to record
             anything until it is resumed. They will be shown:</p>
             <p><strong>${esc(reason)}</strong></p>`,
      confirmLabel: 'Pause work',
      danger: true
    });
    if (!sure) return;

    await run($('lock'), 'Pausing…', async () => {
      await api('/api/controls', {
        method: 'POST',
        body: JSON.stringify({ fieldLocked: true, importLocked: true, reason })
      });
      toast('Paused.');
      show();
    });
  });

  $('unlock')?.addEventListener('click', async () => {
    // Resuming used to need neither a confirmation nor a reason, while pausing
    // needed both — the same switch, thrown the other way.
    const sure = await confirmAction({
      title: 'Resume work?',
      lede: session.project?.name,
      body: '<p class="dim">Crews can record material again immediately, and imports reopen.</p>',
      confirmLabel: 'Resume'
    });
    if (!sure) return;

    await run($('unlock'), 'Resuming…', async () => {
      await api('/api/controls', {
        method: 'POST',
        body: JSON.stringify({ fieldLocked: false, importLocked: false })
      });
      toast('Work resumed.');
      show();
    });
  });
}

/** A check that found nothing needs no route; one that found something does. */
function renderDestination(check) {
  const to = destinationFor(check);
  if (!to) return '';

  return to.tab
    ? `<button type="button" class="linkish" data-goto-tab="${esc(to.tab)}">${esc(to.label)}</button>`
    : `<a class="linkish" href="${esc(to.href)}">${esc(to.label)}</a>`;
}

const renderCheck = (c) => `
  <div class="check ${c.ok ? '' : 'bad'}">
    <span class="dot"></span>
    <span class="grow">
      <span class="name">${esc(c.name)}</span>
      <div class="detail">${esc(c.detail)}</div>
      ${renderExamples(c)}
      ${renderDestination(c)}
    </span>
    <span class="n">${esc(c.count)}</span>
  </div>`;

/** A few of the rows a check found, named so they can be looked up. */
function renderExamples(check) {
  if (!check.examples?.length) return '';

  const shown = check.examples.slice(0, 5).map((e) =>
    `${esc(e.fmr_number ?? '')}${e.line_number ? ` line ${esc(e.line_number)}` : ''}`
  ).join(' &middot; ');

  const more = check.count > 5 ? ` … and ${esc(check.count - 5)} more` : '';

  return `<div class="detail examples">${shown}${more}</div>`;
}

/** Run a mutation with the button showing that it is running. */
async function run(button, workingLabel, work) {
  if (!button) return work();

  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = workingLabel;

  try {
    await work();
  } catch (failure) {
    toastError(failure.message);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = original;
    }
  }
}

// --- corrections -----------------------------------------------------------

async function renderCorrections() {
  const { corrections } = await api('/api/corrections');

  $('view').innerHTML = `
    <div class="panel">
      <h3>Correct a mistake</h3>
      <p>Search for the line, then choose which action to undo. Nothing is
         edited — a correction writes the opposite entry, so the original
         record stands.</p>
      <div class="row">
        <input id="q" type="text" placeholder="FMR number or drawing">
        <button type="button" class="btn btn-primary" id="find">Find</button>
      </div>
    </div>
    <div id="found"></div>

    <h3 style="margin:var(--s-5) 0 var(--s-3)">Corrections applied</h3>
    <div class="tw"><table>
      <thead><tr>
        <th class="w-md">FMR</th><th class="w-tiny">Line</th><th class="w-grow">Material</th>
        <th class="w-md">Undid</th><th class="w-lg">Reason</th>
        <th class="w-md">By</th><th class="w-md">When</th>
      </tr></thead>
      <tbody>${corrections.map((c) => `<tr>
        <td class="mono">${esc(c.fmrNumber)}</td>
        <td class="num">${esc(c.lineNumber)}</td>
        <td>${esc(c.description ?? '')}</td>
        <td class="dim">${esc((c.types ?? []).join(', '))}</td>
        <td>${esc(c.reason)}</td>
        <td class="dim">${esc(c.appliedBy ?? '')}</td>
        <td class="dim">${when(c.appliedAt)}</td>
      </tr>`).join('')
        || emptyRow(7, 'No corrections have been applied on this project.')}
      </tbody>
    </table></div>`;

  $('find').onclick = findLines;
  $('q').onkeydown = (e) => { if (e.key === 'Enter') findLines(); };
}

async function findLines() {
  const query = $('q').value.trim();
  if (!query) return;

  $('found').innerHTML = skeleton({ rows: 3 });

  try {
    const { results, truncated, limit } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (!results.length) {
      $('found').innerHTML = '<div class="empty"><p>Nothing matched that search.</p></div>';
      return;
    }

    // The server caps what it will send. Somebody looking for the one line
    // they need to correct has to know the list is not all of it — otherwise
    // "it isn't here" is indistinguishable from "it is on the next page that
    // was never sent".
    const capped = truncated
      ? `<p class="hint" style="text-align:left;padding:0 0 var(--s-3)">
           The first ${esc(limit)} lines. Narrow the search to reach the rest.</p>`
      : '';

    $('found').innerHTML = `${capped}<div class="tw"><table>
      <thead><tr>
        <th class="w-md">FMR</th><th class="w-tiny">Line</th><th class="w-md">Drawing</th>
        <th class="w-grow">Material</th><th class="num w-sm">Issued</th>
        <th class="num w-sm">Remaining</th><th class="w-sm"></th>
      </tr></thead>
      <tbody>${results.map((l) => `<tr>
        <td class="mono">${esc(l.fmrNumber)}</td>
        <td class="num">${esc(l.lineNumber)}</td>
        <td class="mono">${esc(isoLabel(l.isoNumber, l.isoRevision))}</td>
        <td>${esc(l.description ?? '')}</td>
        <td class="num">${n(l.quantities.issued)}</td>
        <td class="num">${n(l.quantities.remaining)}</td>
        <td><div class="rowacts">
          <button type="button" class="btn btn-sm" data-history="${esc(l.id)}">History</button>
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (failure) {
    $('found').innerHTML = `<div class="empty"><p>${esc(failure.message)}</p></div>`;
  }
}

async function showHistory(lineId) {
  // This used to have no catch at all, so a failed fetch showed nothing and
  // the History button looked broken.
  let groups;
  try {
    ({ groups } = await api(`/api/lines/${lineId}/corrections`));
  } catch (failure) {
    return toastError(failure.message);
  }

  const body = groups.length
    ? groups.map((g) => `
        <div class="check">
          <span class="grow">
            <span class="name">${esc(g.transactions.map((t) => t.type).join(' + '))}</span>
            <div class="detail">
              ${g.transactions.map((t) => `${n(t.quantity)} ${esc(t.uom ?? '')}`).join(', ')}
              &middot; ${esc(g.performedBy ?? '')} &middot; ${when(g.at)}
              ${g.transactions[0].issuedTo ? `&middot; to ${esc(g.transactions[0].issuedTo)}` : ''}
            </div>
            ${g.corrected ? `<div class="detail" style="color:var(--warn)">
              Already corrected ${when(g.correctedAt)}: ${esc(g.correctionReason ?? '')}
            </div>` : ''}
          </span>
          ${g.corrected ? '' :
            `<button type="button" class="btn btn-sm"
                     data-pick="${esc(g.correlationId)}">Undo</button>`}
        </div>`).join('')
    : '<div class="empty"><p>Nothing recorded on this line yet.</p></div>';

  // This dialog is a list to choose from, not a form: picking an entry closes
  // it and hands back which one, and the preview opens on top of that.
  const chosen = await dialog({
    title: 'What happened to this line',
    lede: 'Choose an action to undo. The record of it stays; the ledger moves back.',
    body,
    wide: true,
    confirmLabel: 'Close',
    readOnly: true
  });

  if (chosen?.pick) previewUndo(chosen.pick);
}

/** Show the before and after, and only then offer to apply it. */
async function previewUndo(correlationId) {
  let preview;
  try {
    preview = await api('/api/corrections/preview', {
      method: 'POST',
      body: JSON.stringify({ correlationId })
    });
  } catch (failure) {
    return toastError(failure.message);
  }

  const fields = [
    ['requested', 'Requested'], ['confirmed', 'Located'], ['available', 'Available'],
    ['bagged', 'Bagged'], ['issued', 'Issued'], ['remaining', 'Remaining'],
    ['pendingBackorder', 'Pending BO'], ['confirmedBackorder', 'Confirmed BO']
  ];

  const column = (which) => fields.map(([key, label]) =>
    `<div class="r ${preview.before[key] !== preview.after[key] ? 'changed' : ''}">
       <span>${label}</span><span>${n(preview[which][key])}</span>
     </div>`).join('');

  await dialog({
    title: 'Undo this?',
    lede: `${preview.line.fmrNumber} · line ${preview.line.lineNumber} · ${preview.line.description ?? ''}`,
    wide: true,
    confirmLabel: 'Apply correction',
    workingLabel: 'Applying…',
    body: `
      <p class="reverses">Reversing:<br>${preview.reverses.map((r) =>
        `${esc(r.type)} ${n(r.quantity)} &middot; ${when(r.at)}`).join('<br>')}</p>

      <div class="diff">
        <div class="col"><h4>Now</h4>${column('before')}</div>
        <div class="arrow">&rarr;</div>
        <div class="col"><h4>After</h4>${column('after')}</div>
      </div>

      <p class="dim" style="margin:var(--s-3) 0 0">
        Line becomes <strong>${esc(preview.resultingStatus)}</strong>.
      </p>`,
    fields: [{
      name: 'reason',
      label: 'Why are you correcting this?',
      required: true,
      minLength: 3,
      placeholder: 'e.g. quantity keyed wrong, issued against the wrong line',
      hint: 'This goes in the record against your name.'
    }],
    onSubmit: async ({ reason }) => {
      await api('/api/corrections/apply', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({ correlationId, reason })
      });
      toast('Corrected.');
      show();
    }
  });
}

// --- notices ---------------------------------------------------------------

async function renderNotices() {
  const { notices } = await api('/api/notices');

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${notices.length}</span><span class="l">Outstanding</span></div>
      <div class="stat stat-warn">
        <span class="n">${notices.filter((x) => x.severity === 'critical').length}</span>
        <span class="l">Need action</span></div>
    </div>
    ${notices.length ? `<div class="tw"><table>
      <thead><tr>
        <th class="w-md">FMR</th><th class="w-tiny">Line</th><th class="w-grow">Material</th>
        <th class="w-lg">Notice</th><th class="num w-sm">Outstanding</th><th class="w-md">Raised</th>
      </tr></thead>
      <tbody>${notices.map((x) => `<tr>
        <td class="mono">${esc(x.fmrNumber)}</td>
        <td class="num">${esc(x.lineNumber)}</td>
        <td>${esc(x.description ?? '')}<div class="dim">${esc(isoLabel(x.isoNumber, x.isoRevision))}</div></td>
        <td><span class="pill ${x.severity === 'critical' ? 'pill-danger'
                                : x.severity === 'warning' ? 'pill-warn' : 'pill-quiet'}"
            >${esc(x.kind)}</span>
            <div class="dim">${esc(x.headline)}</div></td>
        <td class="num">${n(x.qtyOutstanding)}</td>
        <td class="dim">${when(x.raisedAt)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`
    : `<div class="empty">
         <h2>Nothing outstanding</h2>
         <p>Every rejected and returned backorder has been dealt with. The crews are up to date.</p>
       </div>`}`;
}

// --- integrity -------------------------------------------------------------

/**
 * Cross-row checks. The schema stops one row going wrong; these catch the
 * cases only visible across tables — a line's backorder total disagreeing
 * with the requests behind it, bagged quantities not matching the bags.
 */
async function renderIntegrity() {
  const report = await api('/api/integrity');
  const broken = report.checks.filter((c) => !c.ok);
  const mismatch = broken.find((c) => c.code === 'BACKORDER_LEDGER_MISMATCH');

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat ${report.ok ? 'stat-ok' : 'stat-warn'}">
        <span class="n">${report.ok ? 'OK' : report.problemCount}</span>
        <span class="l">${report.ok ? 'All consistent' : 'Rows to look at'}</span></div>
      <div class="stat"><span class="n">${report.checks.length}</span><span class="l">Checks run</span></div>
    </div>

    ${mismatch ? `
      <div class="panel alert">
        <h3>Backorder totals disagree with their requests</h3>
        <p>The requests are the record of what the office was asked and what it
           decided, so they are treated as correct. This resets the line totals
           to match them.</p>
        <div class="row">
          <button type="button" class="btn btn-danger" id="repair"
                  data-count="${esc(mismatch.count)}">Reset totals from requests</button>
        </div>
      </div>` : ''}

    <div>${report.checks.map(renderCheck).join('')
      || '<div class="empty"><p>No checks are defined.</p></div>'}</div>

    <p class="hint" style="text-align:left;padding:var(--s-4) 0 0">
      Single-row rules are enforced by the database itself and cannot be broken.
      These are the checks that span tables.
    </p>`;

  $('repair')?.addEventListener('click', async () => {
    // This writes to the ledger across every mismatched line, and used to fire
    // on a single click — while correcting one line two tabs over demands a
    // diff and a typed reason.
    const count = $('repair').dataset.count;
    const sure = await confirmAction({
      title: 'Reset backorder totals?',
      lede: `${count} line${count === '1' ? '' : 's'} will be rewritten`,
      body: `<p class="dim">Each line's pending and confirmed backorder totals are
             replaced with the sum of its requests. This is a ledger write and is
             not itself undoable — the requests behind it are unchanged.</p>`,
      confirmLabel: 'Reset them',
      danger: true
    });
    if (!sure) return;

    await run($('repair'), 'Resetting…', async () => {
      const result = await api('/api/integrity/repair', {
        method: 'POST', body: JSON.stringify({})
      });
      toast(`Reset ${result.repaired} line${result.repaired === 1 ? '' : 's'}.`);
      show();
    });
  });
}

// --- users -----------------------------------------------------------------

let profiles = [];

async function renderUsers() {
  const data = await api('/api/admin/members');
  const members = data.members;
  profiles = data.profiles;

  const active = members.filter((m) => m.active);
  const owners = active.filter((m) => m.permissions.ownerEdit);

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n">${active.length}</span><span class="l">Active</span></div>
      <div class="stat"><span class="n">${active.filter((m) => m.permissions.fieldTransact).length}</span>
        <span class="l">Can move material</span></div>
      <div class="stat"><span class="n">${owners.length}</span><span class="l">Owners</span></div>
    </div>

    <div class="panel">
      <h3>Add someone to this project</h3>
      <p>They sign in with the Google account you name here. Changing a role
         takes effect the next time they load a screen.</p>
      <div class="row">
        <input id="email" type="email" placeholder="name@company.com" autocomplete="off">
        <input id="name" type="text" placeholder="Full name" autocomplete="off">
        <select id="profile" aria-label="Role">
          ${profiles.map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-primary" id="add">Add</button>
      </div>
      <p class="dim" style="margin-top:var(--s-3);font-size:var(--t-sm)">
        ${profiles.map((p) => `<strong>${esc(p.label)}</strong> — ${esc(p.description)}`).join('<br>')}
      </p>
    </div>

    <div class="tw"><table>
      <thead><tr>
        <th class="w-lg">Name</th><th class="w-lg">Email</th><th class="w-md">Role</th>
        <th class="w-grow">Can</th><th class="w-md">Last signed in</th>
        <th class="w-md">Status</th><th class="w-lg"></th>
      </tr></thead>
      <tbody>${members.map((m) => renderMemberRow(m, owners)).join('')}</tbody>
    </table></div>`;

  $('add').onclick = async () => {
    const email = $('email').value.trim();
    const name = $('name').value.trim();

    // Checks the page can make itself, rather than spending a round trip to
    // be told the same thing.
    if (!email.includes('@')) return toastError('That does not look like an email address.');
    if (!name) return toastError('Give them a name — it is what the crews see.');

    await run($('add'), 'Adding…', async () => {
      await api('/api/admin/members', {
        method: 'POST',
        body: JSON.stringify({ email, name, profile: $('profile').value })
      });
      toast('Added.');
      show();
    });
  };
}

/**
 * One member.
 *
 * Two guards are applied here rather than left to the server: you cannot
 * deactivate yourself, and the last active owner cannot be removed or demoted.
 * Both used to be discoverable only by typing a reason and being refused.
 */
function renderMemberRow(m, owners) {
  const can = Object.entries({
    Search: m.permissions.search,
    Field: m.permissions.fieldTransact,
    Backorders: m.permissions.adminBackorder,
    Owner: m.permissions.ownerEdit
  }).filter(([, on]) => on).map(([label]) => label);

  const isMe = session.isMe(m.id);
  const isLastOwner = m.active && m.permissions.ownerEdit && owners.length === 1;

  const blocked = isMe
    ? 'You cannot deactivate your own account.'
    : isLastOwner
      ? 'The last active owner must stay — promote someone else first.'
      : null;

  // Email and profile ride on the row rather than being read back out of the
  // cells. The Role cell renders more than the profile — a CUSTOM member also
  // gets "Permissions set by hand" — so its textContent was "CUSTOMPermissions
  // set by hand", which matched no option and left the dialog showing the
  // first one, Read Only. Saving from there stripped a hand-set permission
  // set down to read-only access, which is precisely the FMRv3 bug the CUSTOM
  // profile exists to prevent.
  return `<tr data-user="${esc(m.id)}" data-name="${esc(m.name)}"
              data-email="${esc(m.email)}" data-profile="${esc(m.profile)}"
              class="${isMe ? 'is-me' : ''}">
    <td>${esc(m.name)}</td>
    <td class="dim mono">${esc(m.email)}</td>
    <td>${esc(m.profile)}${m.profile === 'CUSTOM'
      ? '<div class="dim">Permissions set by hand</div>' : ''}</td>
    <td class="dim">${can.join(' · ') || 'nothing'}</td>
    <td class="dim">${m.lastLoginAt ? when(m.lastLoginAt) : 'never'}</td>
    <td>${m.active
      ? '<span class="pill">Active</span>'
      : `<span class="pill pill-danger">Inactive</span>${m.deactivatedReason
          ? `<div class="dim">${esc(m.deactivatedReason)}</div>` : ''}`}</td>
    <td><div class="rowacts">
      ${m.active ? `
        <button type="button" class="btn btn-sm" data-role="${esc(m.id)}"
                ${isLastOwner ? 'disabled title="The last owner cannot be demoted"' : ''}>Role</button>
        <button type="button" class="btn btn-sm" data-deactivate="${esc(m.id)}"
                ${blocked ? `disabled title="${esc(blocked)}"` : ''}>Deactivate</button>`
        : `<button type="button" class="btn btn-sm" data-reactivate="${esc(m.id)}">Reactivate</button>`}
    </div></td>
  </tr>`;
}

/**
 * Change someone's role.
 *
 * saveMember has always been an upsert, and the server's last-owner guard on
 * demotion has always existed — but there was no way to reach either from the
 * UI except by retyping the person into the Add form.
 */
async function changeRole(userId, name) {
  const row = document.querySelector(`tr[data-user="${CSS.escape(userId)}"]`);
  const { email, profile: currentProfile } = row.dataset;

  // A hand-set permission set matches no named role, so there is nothing to
  // preselect and every option in the list is a change. Say so, rather than
  // letting the dialog open on whichever role happens to sort first.
  const isCustom = !profiles.some((p) => p.key === currentProfile);

  await dialog({
    title: `Role for ${name}`,
    lede: email,
    confirmLabel: 'Save role',
    body: isCustom
      ? `<p class="dim">This account has permissions set by hand, which no named
         role matches. Choosing one <strong>replaces</strong> them — close this
         instead to leave them as they are.</p>`
      : '',
    fields: [{
      name: 'profile',
      label: 'Role',
      type: 'select',
      value: currentProfile,
      options: [
        // Chosen by default for a custom set, so opening the dialog and saving
        // without touching the list changes nothing.
        ...(isCustom ? [{ value: '', label: 'Keep the permissions set by hand' }] : []),
        ...profiles.map((p) => ({ value: p.key, label: p.label }))
      ],
      hint: profiles.map((p) => `${p.label}: ${p.description}`).join(' · ')
    }],
    onSubmit: async ({ profile }) => {
      // The "keep" option, or the role they already have: nothing to send.
      if (!profile || profile === currentProfile) {
        toast('Left unchanged.');
        return;
      }

      await api('/api/admin/members', {
        method: 'POST',
        body: JSON.stringify({ email, name, profile })
      });
      toast('Role changed.');
      show();
    }
  });
}

// --- lists -----------------------------------------------------------------

const LIST_LABELS = {
  BACKORDER_REASON: 'Backorder reasons',
  UOM: 'Units of measure',
  PRIORITY: 'Priorities',
  STORAGE_LOCATION: 'Storage locations'
};

async function renderLists() {
  const { lists } = await api('/api/admin/lists');

  // Show every list the server holds, labelled where a label is known. The
  // hardcoded map used to be an allowlist, so a new list type was fetched and
  // then silently dropped.
  const names = [...new Set([...Object.keys(LIST_LABELS), ...Object.keys(lists)])];

  $('view').innerHTML = `
    <p class="hint" style="text-align:left;padding:0 0 var(--s-4)">
      These are the choices the crews see. Retiring a value hides it from new
      entries; anything already recorded against it keeps it. Values marked
      shared belong to every project and are not edited here.
    </p>

    ${names.map((name) => {
      const values = lists[name] ?? [];
      const label = LIST_LABELS[name] ?? name.replace(/_/g, ' ').toLowerCase();

      return `<section class="group">
        <h3><span>${esc(label)}</span>
            <span class="sub">${values.filter((v) => v.active).length} in use</span></h3>
        <div class="tw"><table>
          <thead><tr>
            <th class="w-grow">Value</th><th class="w-md">Status</th><th class="w-md"></th>
          </tr></thead>
          <tbody>
            ${values.map((v) => `<tr>
              <td>${esc(v.value)}${v.shared ? '<span class="dim"> · all projects</span>' : ''}</td>
              <td>${v.active ? '<span class="pill">In use</span>'
                              : '<span class="pill pill-warn">Retired</span>'}</td>
              <td><div class="rowacts">
                ${v.shared
                  ? '<span class="dim" title="Shared values are the same on every project. '
                    + 'This screen edits only the values belonging to this one.'
                    + '">Shared &mdash; not editable here</span>'
                  : `<button type="button" class="btn btn-sm" data-list-toggle="${esc(v.id)}"
                             data-active="${!v.active}" data-value="${esc(v.value)}">
                       ${v.active ? 'Retire' : 'Restore'}</button>`}
              </div></td>
            </tr>`).join('')
              || emptyRow(3, 'Nothing here yet. Add the first value below.')}
            <tr>
              <td colspan="3">
                <div style="display:flex;gap:var(--s-2)">
                  <input data-new-value="${esc(name)}" type="text" placeholder="Add a value"
                         aria-label="New ${esc(label)} value"
                         style="flex:1;font:inherit;padding:8px var(--s-3);border-radius:var(--r-sm);
                                border:1px solid var(--rule-2);background:var(--sunk);color:var(--ink)">
                  <button type="button" class="btn btn-sm btn-primary"
                          data-list-add="${esc(name)}">Add</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table></div>
      </section>`;
    }).join('')}`;
}

// --- wiring ----------------------------------------------------------------

const VIEWS = {
  health: renderHealth, correct: renderCorrections,
  notices: renderNotices, integrity: renderIntegrity,
  users: renderUsers, lists: renderLists
};

const SKELETONS = {
  health: { rows: 6 }, correct: { rows: 5 }, notices: { stats: 2, rows: 6 },
  integrity: { stats: 2, rows: 7 }, users: { stats: 3, rows: 6 }, lists: { rows: 8 }
};

async function show() {
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

/**
 * Move to a tab and draw it.
 *
 * One place, so a jump from a failing check leaves the tab strip in the same
 * state a click on it would have — the strip used to be updated only by its
 * own handler, so anything else that changed `state.tab` left the highlight
 * behind on the tab you had left.
 */
function switchTab(name) {
  if (!VIEWS[name]) return;

  state.tab = name;
  for (const tab of $('tabs').querySelectorAll('button')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    // Only the selected tab is a tab stop; the arrow keys move between them.
    tab.tabIndex = on ? 0 : -1;
  }
  show();
}

$('tabs').onclick = (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) switchTab(button.dataset.tab);
};

/**
 * Arrow keys move along the tab strip, which is what a tablist promises.
 *
 * The buttons carry role="tab", so a screen reader tells the user to use the
 * arrow keys — and nothing was listening for them.
 */
$('tabs').addEventListener('keydown', (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' }[event.key];
  if (!step) return;

  const tabs = [...$('tabs').querySelectorAll('button[data-tab]')];
  const here = tabs.findIndex((t) => t.dataset.tab === state.tab);

  const next = step === 'first' ? tabs[0]
    : step === 'last' ? tabs[tabs.length - 1]
      : tabs[(here + step + tabs.length) % tabs.length];

  event.preventDefault();
  next.focus();
  switchTab(next.dataset.tab);
});

$('view').addEventListener('click', async (event) => {
  // A failing check that names work should be able to go to it.
  const goto = event.target.closest('button[data-goto-tab]');
  if (goto) return switchTab(goto.dataset.gotoTab);

  const history = event.target.closest('button[data-history]');
  if (history) return showHistory(history.dataset.history);

  const role = event.target.closest('button[data-role]');
  if (role) {
    const row = role.closest('tr');
    return changeRole(role.dataset.role, row.dataset.name);
  }

  const deactivate = event.target.closest('button[data-deactivate]');
  if (deactivate) {
    const row = deactivate.closest('tr');
    return askReason({
      title: `Deactivate ${row.dataset.name}?`,
      lede: 'They lose access to every project, not only this one.',
      label: 'Why are you deactivating this account?',
      confirmLabel: 'Deactivate',
      danger: true,
      onSubmit: async (reason) => {
        await api('/api/admin/members/active', {
          method: 'POST',
          body: JSON.stringify({ userId: deactivate.dataset.deactivate, active: false, reason })
        });
        toast('Deactivated.');
        show();
      }
    });
  }

  const reactivate = event.target.closest('button[data-reactivate]');
  if (reactivate) {
    const row = reactivate.closest('tr');
    const sure = await confirmAction({
      title: `Reactivate ${row.dataset.name}?`,
      body: '<p class="dim">They get their access back on every project they belong to.</p>',
      confirmLabel: 'Reactivate'
    });
    if (!sure) return;

    return run(reactivate, 'Working…', async () => {
      await api('/api/admin/members/active', {
        method: 'POST',
        body: JSON.stringify({ userId: reactivate.dataset.reactivate, active: true })
      });
      toast('Reactivated.');
      show();
    });
  }

  const toggle = event.target.closest('button[data-list-toggle]');
  if (toggle) {
    const retiring = toggle.dataset.active === 'false';

    if (retiring) {
      const sure = await confirmAction({
        title: `Retire "${toggle.dataset.value}"?`,
        body: '<p class="dim">It disappears from the crews\' dropdowns. Anything already ' +
              'recorded against it keeps it, and you can restore it later.</p>',
        confirmLabel: 'Retire it'
      });
      if (!sure) return;
    }

    return run(toggle, '…', async () => {
      await api('/api/admin/lists', {
        method: 'POST',
        body: JSON.stringify({
          id: toggle.dataset.listToggle,
          setActive: toggle.dataset.active === 'true'
        })
      });
      // This was the one mutation in the file that said nothing either way.
      toast(retiring ? 'Retired.' : 'Restored.');
      show();
    });
  }

  const add = event.target.closest('button[data-list-add]');
  if (add) {
    const listName = add.dataset.listAdd;
    const input = document.querySelector(`input[data-new-value="${CSS.escape(listName)}"]`);
    const value = input?.value.trim();
    if (!value) return toastError('Type a value first.');

    return run(add, '…', async () => {
      await api('/api/admin/lists', {
        method: 'POST',
        body: JSON.stringify({ listName, value })
      });
      toast('Added.');
      show();
    });
  }
});

await initShell({ current: 'owner', onProjectChange: show });
if (!refuseUnless('ownerEdit', { what: 'The owner screens' })) show();
