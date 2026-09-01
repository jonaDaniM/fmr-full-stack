/**
 * Owner interface.
 *
 * Three things only an owner does: see whether the project is healthy, pause
 * it, and correct a mistake in the ledger.
 *
 * Corrections are previewed before they are applied — this is the one place
 * quantities move without a physical event behind them, so the owner sees
 * exactly what would change first.
 */

const state = { projectId: null, tab: 'health' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const when = (d) => d ? new Date(d).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

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

// --- health and controls ---------------------------------------------------

async function renderHealth() {
  const health = await api('/api/project-health');
  const locked = health.controls.fieldLocked;

  $('view').innerHTML = `
    <div class="lockbar ${locked ? 'on' : ''}">
      <h3>${locked ? 'Material movement is paused' : 'Material movement is running'}</h3>
      <p>${locked
        ? `Paused ${when(health.controls.lockedAt)}${health.controls.lockedBy
            ? ` by ${esc(health.controls.lockedBy)}` : ''}. The crew is shown: "${esc(health.controls.reason ?? '')}"`
        : 'Pause during a cutover or a stock count. Crews see the reason you give.'}</p>
      <div class="row">
        ${locked
          ? '<button id="unlock">Resume work</button>'
          : `<input id="reason" type="text" placeholder="Why are you pausing? The crew sees this.">
             <button id="lock" class="danger">Pause</button>`}
      </div>
    </div>

    <h3 style="font-size:15px;margin:0 0 10px">Checks</h3>
    ${health.checks.map((c) => `
      <div class="check ${c.ok ? '' : 'bad'}">
        <span class="dot"></span>
        <span>
          <span class="name">${esc(c.name)}</span>
          <div class="detail">${esc(c.detail)}</div>
        </span>
        <span class="n">${c.count}</span>
      </div>
    `).join('')}

    <p class="hint" style="text-align:left;padding:14px 0 0">
      Last material movement: ${when(health.lastActivityAt)}.
      Backups and uptime are handled by the database, not here.
    </p>
  `;

  $('lock')?.addEventListener('click', async () => {
    const reason = $('reason').value.trim();
    if (!reason) return toast('Give a reason — the crew sees it.');
    try {
      await api('/api/controls', {
        method: 'POST',
        body: JSON.stringify({ fieldLocked: true, importLocked: true, reason })
      });
      toast('Paused.');
      renderHealth();
    } catch (failure) { toast(failure.message); }
  });

  $('unlock')?.addEventListener('click', async () => {
    try {
      await api('/api/controls', {
        method: 'POST',
        body: JSON.stringify({ fieldLocked: false, importLocked: false })
      });
      toast('Work resumed.');
      renderHealth();
    } catch (failure) { toast(failure.message); }
  });
}

// --- corrections -----------------------------------------------------------

async function renderCorrections() {
  const { corrections } = await api('/api/corrections');

  $('view').innerHTML = `
    <div class="lockbar">
      <h3>Correct a mistake</h3>
      <p>Search for the line, then choose which action to undo. Nothing is
         edited — a correction writes the opposite entry, so the original
         record stands.</p>
      <div class="row">
        <input id="q" type="text" placeholder="FMR number or drawing">
        <button id="find">Find</button>
      </div>
    </div>
    <div id="found"></div>

    <h3 style="font-size:15px;margin:24px 0 10px">Corrections applied</h3>
    ${corrections.length ? `<div class="tw"><table>
      <thead><tr><th>FMR</th><th>Line</th><th>Material</th><th>Undid</th>
                 <th>Reason</th><th>By</th><th>When</th></tr></thead>
      <tbody>${corrections.map((c) => `<tr>
        <td class="mono">${esc(c.fmrNumber)}</td>
        <td class="mono">${c.lineNumber}</td>
        <td>${esc(c.description ?? '')}</td>
        <td class="dim">${esc((c.types ?? []).join(', '))}</td>
        <td>${esc(c.reason)}</td>
        <td class="dim">${esc(c.appliedBy ?? '')}</td>
        <td class="dim">${when(c.appliedAt)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="hint">None yet.</p>'}
  `;

  $('find').onclick = findLines;
  $('q').onkeydown = (e) => { if (e.key === 'Enter') findLines(); };
}

async function findLines() {
  const query = $('q').value.trim();
  if (!query) return;

  $('found').innerHTML = '<p class="hint">Searching…</p>';

  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (!results.length) {
      $('found').innerHTML = '<p class="hint">Nothing matched.</p>';
      return;
    }

    $('found').innerHTML = `<div class="tw"><table>
      <thead><tr><th>FMR</th><th>Line</th><th>Drawing</th><th>Material</th>
                 <th class="num">Issued</th><th class="num">Remaining</th><th></th></tr></thead>
      <tbody>${results.map((l) => `<tr>
        <td class="mono">${esc(l.fmrNumber)}</td>
        <td class="mono">${l.lineNumber}</td>
        <td class="mono">${esc(l.isoNumber)} sht ${esc(l.isoSheet)}</td>
        <td>${esc(l.description ?? '')}</td>
        <td class="num">${n(l.quantities.issued)}</td>
        <td class="num">${n(l.quantities.remaining)}</td>
        <td><div class="rowacts">
          <button data-history="${l.id}">History</button>
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (failure) {
    $('found').innerHTML = `<p class="hint">${esc(failure.message)}</p>`;
  }
}

async function showHistory(lineId) {
  const { groups } = await api(`/api/lines/${lineId}/corrections`);

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-bg';
  backdrop.innerHTML = `<div class="sheet" style="max-width:720px" role="dialog" aria-modal="true"
       aria-label="Line history">
    <h2>What happened to this line</h2>
    <div class="for">Choose an action to undo. The record of it stays; the ledger moves back.</div>
    ${groups.length ? groups.map((g) => `
      <div class="check" style="align-items:flex-start">
        <span>
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
        <span style="margin-left:auto">
          ${g.corrected ? '' :
            `<button class="ok" data-undo="${esc(g.correlationId)}"
               style="font:inherit;font-size:13px;font-weight:600;padding:6px 11px;
                      border-radius:7px;cursor:pointer;background:var(--accent);
                      color:var(--accent-ink);border:0">Undo</button>`}
        </span>
      </div>
    `).join('') : '<p class="hint">Nothing recorded on this line yet.</p>'}
    <div class="sheet-acts"><button type="button" id="close">Close</button></div>
  </div>`;

  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  $('close').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelectorAll('[data-undo]').forEach((button) => {
    button.onclick = () => { close(); previewUndo(button.dataset.undo); };
  });
}

/** Show the before and after, and only then offer to apply it. */
async function previewUndo(correlationId) {
  let preview;
  try {
    preview = await api('/api/corrections/preview', {
      method: 'POST',
      body: JSON.stringify({ correlationId })
    });
  } catch (failure) { return toast(failure.message); }

  const fields = [
    ['requested', 'Requested'], ['confirmed', 'Located'], ['available', 'Available'],
    ['bagged', 'Bagged'], ['issued', 'Issued'], ['remaining', 'Remaining'],
    ['pendingBackorder', 'Pending BO'], ['confirmedBackorder', 'Confirmed BO']
  ];

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-bg';
  backdrop.innerHTML = `<div class="sheet" style="max-width:640px" role="dialog" aria-modal="true"
       aria-label="Confirm correction">
    <h2>Undo this?</h2>
    <div class="for">${esc(preview.line.fmrNumber)} &middot; line ${preview.line.lineNumber}
      &middot; ${esc(preview.line.description ?? '')}</div>
    <div class="err" id="err" hidden></div>

    <p style="font-size:14px;margin:0 0 4px">Reversing:</p>
    <div class="detail" style="font-size:13px;color:var(--muted);margin-bottom:6px">
      ${preview.reverses.map((r) =>
        `${esc(r.type)} ${n(r.quantity)} &middot; ${when(r.at)}`).join('<br>')}
    </div>

    <div class="diff">
      <div class="col"><h4>Now</h4>
        ${fields.map(([k, label]) => `<div class="r ${preview.before[k] !== preview.after[k] ? 'changed' : ''}">
          <span>${label}</span><span>${n(preview.before[k])}</span></div>`).join('')}
      </div>
      <div class="arrow">&rarr;</div>
      <div class="col"><h4>After</h4>
        ${fields.map(([k, label]) => `<div class="r ${preview.before[k] !== preview.after[k] ? 'changed' : ''}">
          <span>${label}</span><span>${n(preview.after[k])}</span></div>`).join('')}
      </div>
    </div>

    <p style="font-size:13px;color:var(--muted);margin:0 0 14px">
      Line becomes <strong>${esc(preview.resultingStatus)}</strong>.
    </p>

    <div class="field">
      <label for="reason">Why are you correcting this?</label>
      <input id="reason" type="text" required
             placeholder="e.g. quantity keyed wrong, issued against the wrong line">
    </div>

    <div class="sheet-acts">
      <button type="button" id="cancel">Cancel</button>
      <button type="button" class="primary" id="apply">Apply correction</button>
    </div>
  </div>`;

  document.body.appendChild(backdrop);
  $('reason').focus();

  const close = () => backdrop.remove();
  $('cancel').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  $('apply').onclick = async () => {
    const reason = $('reason').value.trim();
    if (!reason) {
      $('err').textContent = 'A correction needs a reason — it goes in the record.';
      $('err').hidden = false;
      return;
    }

    const button = $('apply');
    button.disabled = true;
    button.textContent = 'Applying…';

    try {
      await api('/api/corrections/apply', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ correlationId, reason })
      });
      close();
      toast('Corrected.');
      renderCorrections();
    } catch (failure) {
      $('err').textContent = failure.message;
      $('err').hidden = false;
      button.disabled = false;
      button.textContent = 'Apply correction';
    }
  };
}

// --- notices ---------------------------------------------------------------

async function renderNotices() {
  const { notices } = await api('/api/notices');

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${notices.length}</div><div class="l">Outstanding</div></div>
      <div class="stat warn">
        <div class="n">${notices.filter((x) => x.severity === 'critical').length}</div>
        <div class="l">Need action</div></div>
    </div>
    ${notices.length ? `<div class="tw"><table>
      <thead><tr><th>FMR</th><th>Line</th><th>Material</th><th>Notice</th>
                 <th class="num">Outstanding</th><th>Raised</th></tr></thead>
      <tbody>${notices.map((x) => `<tr>
        <td class="mono">${esc(x.fmrNumber)}</td>
        <td class="mono">${x.lineNumber}</td>
        <td>${esc(x.description ?? '')}<div class="dim">${esc(x.isoNumber)} sht ${esc(x.isoSheet)}</div></td>
        <td><span class="pill ${x.severity === 'critical' ? 'danger' : x.severity === 'warning' ? 'warn' : ''}">${esc(x.kind)}</span>
            <div class="dim">${esc(x.headline)}</div></td>
        <td class="num">${n(x.qtyOutstanding)}</td>
        <td class="dim">${when(x.raisedAt)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="hint">Nothing outstanding — the crews are up to date.</p>'}
  `;
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

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat ${report.ok ? '' : 'warn'}">
        <div class="n">${report.ok ? 'OK' : report.problemCount}</div>
        <div class="l">${report.ok ? 'All consistent' : 'Rows to look at'}</div></div>
      <div class="stat"><div class="n">${report.checks.length}</div><div class="l">Checks run</div></div>
    </div>

    ${broken.some((c) => c.code === 'BACKORDER_LEDGER_MISMATCH') ? `
      <div class="lockbar on">
        <h3>Backorder totals disagree with their requests</h3>
        <p>The requests are the record of what the office was asked and what it
           decided, so they are treated as correct. This resets the line totals
           to match them.</p>
        <div class="row"><button id="repair" class="danger">Reset totals from requests</button></div>
      </div>` : ''}

    ${report.checks.map((c) => `
      <div class="check ${c.ok ? '' : 'bad'}">
        <span class="dot"></span>
        <span>
          <span class="name">${esc(c.name)}</span>
          <div class="detail">${esc(c.detail)}</div>
          ${c.examples?.length ? `<div class="detail" style="margin-top:6px">
            ${c.examples.slice(0, 5).map((e) =>
              `${esc(e.fmr_number ?? '')}${e.line_number ? ` line ${e.line_number}` : ''}`
            ).join(' &middot; ')}${c.count > 5 ? ` … and ${c.count - 5} more` : ''}
          </div>` : ''}
        </span>
        <span class="n">${c.count}</span>
      </div>
    `).join('')}

    <p class="hint" style="text-align:left;padding:14px 0 0">
      Single-row rules are enforced by the database itself and cannot be broken.
      These are the checks that span tables.
    </p>
  `;

  $('repair')?.addEventListener('click', async () => {
    try {
      const result = await api('/api/integrity/repair', {
        method: 'POST', body: JSON.stringify({})
      });
      toast(`Reset ${result.repaired} line${result.repaired === 1 ? '' : 's'}.`);
      renderIntegrity();
    } catch (failure) { toast(failure.message); }
  });
}

// --- users -----------------------------------------------------------------

async function renderUsers() {
  const { members, profiles } = await api('/api/admin/members');
  const active = members.filter((m) => m.active);

  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="n">${active.length}</div><div class="l">Active</div></div>
      <div class="stat"><div class="n">${active.filter((m) => m.permissions.fieldTransact).length}</div>
        <div class="l">Can move material</div></div>
      <div class="stat"><div class="n">${active.filter((m) => m.permissions.ownerEdit).length}</div>
        <div class="l">Owners</div></div>
    </div>

    <div class="lockbar">
      <h3>Add someone to this project</h3>
      <p>They sign in with the Google account you name here. Changing a role
         takes effect the next time they load a screen.</p>
      <div class="row">
        <input id="email" type="email" placeholder="name@company.com" style="min-width:220px">
        <input id="name" type="text" placeholder="Full name" style="min-width:160px">
        <select id="profile" style="font:inherit;padding:9px 12px;border-radius:8px;
                border:1px solid var(--rule);background:var(--ground);color:var(--ink)">
          ${profiles.map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join('')}
        </select>
        <button id="add" class="danger" style="background:var(--accent);
                color:var(--accent-ink);border-color:var(--accent)">Add</button>
      </div>
      <p class="hint" style="text-align:left;padding:10px 0 0;font-size:13px">
        ${profiles.map((p) => `<strong>${esc(p.label)}</strong> — ${esc(p.description)}`).join('<br>')}
      </p>
    </div>

    <div class="tw"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Can</th>
                 <th>Last signed in</th><th>Status</th><th></th></tr></thead>
      <tbody>${members.map(renderMemberRow).join('')}</tbody>
    </table></div>
  `;

  $('add').onclick = async () => {
    try {
      await api('/api/admin/members', {
        method: 'POST',
        body: JSON.stringify({
          email: $('email').value.trim(),
          name: $('name').value.trim(),
          profile: $('profile').value
        })
      });
      toast('Added.');
      renderUsers();
    } catch (failure) { toast(failure.message); }
  };
}

function renderMemberRow(m) {
  const can = Object.entries({
    Search: m.permissions.search,
    Field: m.permissions.fieldTransact,
    Backorders: m.permissions.adminBackorder,
    Owner: m.permissions.ownerEdit
  }).filter(([, on]) => on).map(([label]) => label);

  return `<tr data-user="${m.id}">
    <td>${esc(m.name)}</td>
    <td class="dim mono">${esc(m.email)}</td>
    <td>${esc(m.profile)}${m.profile === 'CUSTOM'
      ? '<div class="dim">Permissions set by hand</div>' : ''}</td>
    <td class="dim">${can.join(' · ') || 'nothing'}</td>
    <td class="dim">${m.lastLoginAt ? when(m.lastLoginAt) : 'never'}</td>
    <td>${m.active
      ? '<span class="pill">Active</span>'
      : `<span class="pill danger">Inactive</span>${m.deactivatedReason
          ? `<div class="dim">${esc(m.deactivatedReason)}</div>` : ''}`}</td>
    <td><div class="rowacts">
      ${m.active
        ? `<button class="no" data-deactivate="${m.id}">Deactivate</button>`
        : `<button data-reactivate="${m.id}">Reactivate</button>`}
    </div></td>
  </tr>`;
}

// --- lists -----------------------------------------------------------------

async function renderLists() {
  const { lists } = await api('/api/admin/lists');

  const LABELS = {
    BACKORDER_REASON: 'Backorder reasons',
    UOM: 'Units of measure',
    PRIORITY: 'Priorities',
    STORAGE_LOCATION: 'Storage locations'
  };

  $('view').innerHTML = `
    <p class="hint" style="text-align:left;padding:0 0 16px">
      These are the choices the crews see. Retiring a value hides it from new
      entries; anything already recorded against it keeps it.
    </p>

    ${Object.entries(LABELS).map(([name, label]) => {
      const values = lists[name] ?? [];
      return `<section class="group">
        <h3><span class="n">${esc(label)}</span>
            <span class="sub">${values.filter((v) => v.active).length} in use</span></h3>
        <div class="tw"><table>
          <thead><tr><th>Value</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${values.map((v) => `<tr>
              <td>${esc(v.value)}${v.shared ? '<span class="dim"> · all projects</span>' : ''}</td>
              <td>${v.active ? '<span class="pill">In use</span>'
                              : '<span class="pill warn">Retired</span>'}</td>
              <td><div class="rowacts">
                ${v.shared ? '<span class="dim">—</span>'
                  : `<button data-list-toggle="${v.id}" data-active="${!v.active}">
                       ${v.active ? 'Retire' : 'Restore'}</button>`}
              </div></td>
            </tr>`).join('')}
            <tr>
              <td colspan="3">
                <div class="row" style="display:flex;gap:8px">
                  <input data-new-value="${name}" type="text" placeholder="Add a value"
                         style="flex:1;font:inherit;padding:8px 11px;border-radius:7px;
                                border:1px solid var(--rule);background:var(--ground);
                                color:var(--ink)">
                  <button data-list-add="${name}" style="font:inherit;font-size:13px;
                          font-weight:600;padding:7px 14px;border-radius:7px;cursor:pointer;
                          background:var(--accent);color:var(--accent-ink);border:0">Add</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table></div>
      </section>`;
    }).join('')}
  `;
}

// --- wiring ----------------------------------------------------------------

const VIEWS = {
  health: renderHealth, correct: renderCorrections,
  notices: renderNotices, integrity: renderIntegrity,
  users: renderUsers, lists: renderLists
};

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

$('view').addEventListener('click', async (event) => {
  const history = event.target.closest('button[data-history]');
  if (history) return showHistory(history.dataset.history);

  const deactivate = event.target.closest('button[data-deactivate]');
  if (deactivate) {
    const reason = prompt('Why are you deactivating this account?');
    if (reason === null) return;

    try {
      await api('/api/admin/members/active', {
        method: 'POST',
        body: JSON.stringify({ userId: deactivate.dataset.deactivate, active: false, reason })
      });
      toast('Deactivated.');
      renderUsers();
    } catch (failure) { toast(failure.message); }
    return;
  }

  const reactivate = event.target.closest('button[data-reactivate]');
  if (reactivate) {
    try {
      await api('/api/admin/members/active', {
        method: 'POST',
        body: JSON.stringify({ userId: reactivate.dataset.reactivate, active: true })
      });
      toast('Reactivated.');
      renderUsers();
    } catch (failure) { toast(failure.message); }
    return;
  }

  const toggle = event.target.closest('button[data-list-toggle]');
  if (toggle) {
    try {
      await api('/api/admin/lists', {
        method: 'POST',
        body: JSON.stringify({
          id: toggle.dataset.listToggle,
          setActive: toggle.dataset.active === 'true'
        })
      });
      renderLists();
    } catch (failure) { toast(failure.message); }
    return;
  }

  const add = event.target.closest('button[data-list-add]');
  if (add) {
    const listName = add.dataset.listAdd;
    const input = document.querySelector(`input[data-new-value="${listName}"]`);
    const value = input?.value.trim();
    if (!value) return;

    try {
      await api('/api/admin/lists', {
        method: 'POST',
        body: JSON.stringify({ listName, value })
      });
      toast('Added.');
      renderLists();
    } catch (failure) { toast(failure.message); }
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
