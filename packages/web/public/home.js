/**
 * Home — the launcher.
 *
 * Shows only the screens this account can open on the project it has selected.
 * That last part used to be wrong: home read projects[0] regardless of what
 * you had chosen elsewhere, so it could name one project while every other
 * screen worked against another.
 */

import { $, esc } from './lib/dom.js';
import { initShell, session, SCREENS } from './lib/shell.js';

function render() {
  $('greet').textContent = session.user?.name ?? '';

  const project = session.project;
  $('sub').textContent = session.projects.length > 1
    ? `${project?.name ?? '—'} · ${session.projects.length} projects available`
    : project?.name ?? 'No project access yet.';

  const open = SCREENS.filter((screen) => session.can(screen.need));

  $('cards').innerHTML = open.map((screen) => `
    <a class="tile" href="${screen.href}">
      <div class="t">${esc(screen.label)}</div>
      <div class="d">${esc(screen.detail)}</div>
    </a>`).join('')
    || `<div class="empty">
          <h2>Nothing to open yet</h2>
          <p>This account has no permissions on ${esc(project?.name ?? 'this project')}.
             An owner can grant them from the Owner screen.</p>
        </div>`;
}

await initShell({ current: 'home', onProjectChange: render });
render();
