/**
 * The frame every screen sits in.
 *
 * Before this there was no way out of any screen but Home — no nav, no sign
 * out, nothing. A crew member who opened Office had to edit the URL to get
 * back. This renders one topbar for all seven pages.
 *
 * It also keeps `me.user`, which every page used to fetch and throw away. That
 * one value is what lets a screen grey out your own Deactivate button instead
 * of letting you type a reason and then learning the server refuses.
 */

import { api, ApiError, setProjectId } from './api.js';
import { esc } from './dom.js';

const PROJECT_KEY = 'fmr.project';

/** Every screen, what it is for, and who may see it. */
export const SCREENS = [
  { href: '/', id: 'field', label: 'Field', need: 'search',
    detail: 'Search for material, confirm what you found, bag it, issue it, raise a backorder.' },
  { href: '/admin.html', id: 'office', label: 'Office', need: 'adminBackorder',
    detail: 'Decide backorders, read the FMR register, see progress by drawing.' },
  { href: '/drafts.html', id: 'drafts', label: 'Drafts', need: 'ownerEdit',
    detail: 'Write up an FMR by hand, or review one that came from a drawing.' },
  { href: '/import.html', id: 'import', label: 'Import', need: 'ownerEdit',
    detail: 'Bring in a workbook or a drawing and check it before the crews see it.' },
  { href: '/owner.html', id: 'owner', label: 'Owner', need: 'ownerEdit',
    detail: 'Users, dropdown lists, corrections, and pausing work on a project.' }
];

/** Filled by initShell, read by every screen. */
export const session = {
  user: null,
  projects: [],
  projectId: null,
  get project() {
    return this.projects.find((p) => p.projectId === this.projectId) ?? null;
  },
  get permissions() {
    return this.project?.permissions ?? {};
  },
  can(permission) {
    return Boolean(this.permissions[permission]);
  },
  /** True when this row is the signed-in user — used to guard self-destructive acts. */
  isMe(userId) {
    return Boolean(userId && this.user && userId === this.user.id);
  }
};

/**
 * Resolve the session, draw the topbar, and hand back control.
 *
 * `onProjectChange` fires when the project selector changes, so a screen can
 * reload without re-implementing the bootstrap.
 */
export async function initShell({ current, onProjectChange } = {}) {
  let me;
  try {
    me = await api('/api/me');
  } catch (failure) {
    // Only a dead session sends anyone to sign-in. A blip does not: every
    // screen used to redirect on any failure, so a transient 500 signed you
    // out mid-shift and lost whatever you were looking at.
    if (failure instanceof ApiError && !failure.isAuth) {
      renderFatal(failure.message);
      throw failure;
    }
    location.href = `/signin.html?next=${encodeURIComponent(location.pathname)}`;
    throw failure;
  }

  session.user = me.user;
  session.projects = me.projects ?? [];

  const remembered = localStorage.getItem(PROJECT_KEY);
  const known = session.projects.some((p) => p.projectId === remembered);
  session.projectId = known ? remembered : session.projects[0]?.projectId ?? null;
  setProjectId(session.projectId);

  renderBar(current, onProjectChange);

  return session;
}

function renderBar(current, onProjectChange) {
  const bar = document.querySelector('.topbar');
  if (!bar) return;

  const can = session.permissions;
  const links = SCREENS.filter((screen) => can[screen.need]);

  const projectPicker = session.projects.length
    ? `<label class="project">
         <span class="vh">Project</span>
         <select id="shell-project">${session.projects.map((project) =>
           `<option value="${esc(project.projectId)}"${project.projectId === session.projectId ? ' selected' : ''}
            >${esc(project.name)}</option>`).join('')}</select>
       </label>`
    : '';

  bar.innerHTML = `
    <a class="brand" href="/home.html">FMR</a>
    <nav class="nav" aria-label="Screens">
      ${links.map((screen) =>
        `<a href="${screen.href}" class="nav-link${screen.id === current ? ' on' : ''}"
           ${screen.id === current ? 'aria-current="page"' : ''}>${esc(screen.label)}</a>`).join('')}
    </nav>
    <div class="bar-end">
      ${projectPicker}
      <details class="account">
        <summary aria-label="Account">
          <span class="avatar" aria-hidden="true">${esc(initials(session.user?.name))}</span>
        </summary>
        <div class="menu">
          <div class="menu-who">
            <div class="menu-name">${esc(session.user?.name ?? '')}</div>
            <div class="menu-mail">${esc(session.user?.email ?? '')}</div>
          </div>
          <button type="button" class="menu-item" id="shell-signout">Sign out</button>
        </div>
      </details>
    </div>`;

  const picker = document.getElementById('shell-project');
  if (picker) {
    picker.onchange = async () => {
      const chosen = picker.value;
      const previous = session.projectId;

      // Commit first, so a handler that reloads data reads the new project.
      session.projectId = chosen;
      setProjectId(chosen);

      // A screen with unsaved work may still refuse — the import review, for
      // one, cannot be recovered once it is left. Returning false puts both
      // the selector and the session back, rather than leaving the picker
      // showing a project the page is not actually on.
      if (onProjectChange) {
        const allowed = await onProjectChange(chosen, previous);
        if (allowed === false) {
          session.projectId = previous;
          setProjectId(previous);
          picker.value = previous;
          return;
        }
      }

      localStorage.setItem(PROJECT_KEY, chosen);
      // Permissions differ per project, so the nav is rebuilt too.
      renderBar(current, onProjectChange);
    };
  }

  document.getElementById('shell-signout').onclick = async () => {
    await fetch('/api/auth/signout', { method: 'POST' });
    location.href = '/signin.html';
  };

  // A click anywhere else closes the account menu.
  document.addEventListener('click', (event) => {
    const account = bar.querySelector('.account[open]');
    if (account && !account.contains(event.target)) account.open = false;
  });
}

function renderFatal(message) {
  // No inline handler: the CSP blocks them, so the listener is bound after.
  document.body.innerHTML = `
    <main class="page">
      <div class="empty">
        <h2>FMR is not reachable</h2>
        <p>${esc(message)}</p>
        <button type="button" class="btn btn-primary" id="shell-retry">Try again</button>
      </div>
    </main>`;
  document.getElementById('shell-retry').onclick = () => location.reload();
}

const initials = (name) =>
  String(name ?? '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
