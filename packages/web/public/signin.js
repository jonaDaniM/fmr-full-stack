/**
 * Sign in.
 *
 * Two ways in. Google is what a deployment uses; the seeded-user list only
 * appears when FMR_DEV_LOGIN is set, which no deployment should do.
 *
 * The page used to dead-end when neither was available — it said "Sign in with
 * your Google account" and rendered no button at all. It now either shows a
 * working Google button or explains plainly why it cannot.
 */

import { $, esc } from './lib/dom.js';
import { safeNext } from './lib/safeNext.js';

const params = new URLSearchParams(location.search);

// Where to land after signing in, so a deep link survives an expired session.
const next = safeNext(params.get('next'), location.origin);

function note(message, bad = false) {
  const node = $('note');
  node.textContent = message;
  node.classList.toggle('bad', bad);
}

async function start() {
  // Already signed in?
  try {
    const response = await fetch('/api/me');
    if (response.ok) return (location.href = next);
  } catch { /* not signed in, or offline — either way, offer sign-in */ }

  const config = await fetch('/api/auth/dev')
    .then((r) => r.json())
    .catch(() => ({ enabled: false, googleClientId: null }));

  if (config.googleClientId) return renderGoogle(config);
  if (config.enabled) return renderDevUsers(config);

  $('who').innerHTML = `
    <div class="empty">
      <h2>No sign-in configured</h2>
      <p>This server has no Google client set up and developer sign-in is off.
         Ask whoever deployed it to set GOOGLE_CLIENT_ID.</p>
    </div>`;
}

/** The real thing: Google Identity Services renders and owns its own button. */
function renderGoogle({ googleClientId, enabled, users }) {
  $('who').innerHTML = '<div id="gbutton"></div>';
  note('Use the Google account your administrator set up.');

  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;

  script.onload = () => {
    google.accounts.id.initialize({
      client_id: googleClientId,
      callback: async ({ credential }) => {
        try {
          const response = await fetch('/api/auth/google', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ idToken: credential })
          });
          if (!response.ok) throw new Error((await response.json()).error);
          location.href = next;
        } catch (failure) {
          note(failure.message, true);
        }
      }
    });

    google.accounts.id.renderButton($('gbutton'), {
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
      size: 'large',
      width: 360,
      text: 'signin_with'
    });
  };

  script.onerror = () => {
    // Offer the local list rather than stranding whoever is at the keyboard.
    if (enabled) return renderDevUsers({ users });
    $('who').innerHTML = `
      <div class="empty">
        <h2>Google sign-in did not load</h2>
        <p>Check the connection and reload.</p>
      </div>`;
  };

  document.head.append(script);
}

/** Local only: pick a seeded user and go. */
function renderDevUsers({ users }) {
  $('who').innerHTML = users.map((user) => `
    <button type="button" class="who" data-email="${esc(user.email)}">
      <span>
        <span class="name">${esc(user.name)}</span>
        <span class="mail">${esc(user.email)}</span>
      </span>
      <span class="role">${esc(user.role)}</span>
    </button>`).join('');

  note('Running locally, so sign in as any seeded user. Deployments use Google.');

  $('who').onclick = async (event) => {
    const button = event.target.closest('button[data-email]');
    if (!button) return;

    button.disabled = true;
    try {
      const response = await fetch('/api/auth/dev', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: button.dataset.email })
      });
      if (!response.ok) throw new Error((await response.json()).error);
      location.href = next;
    } catch (failure) {
      note(failure.message, true);
      button.disabled = false;
    }
  };
}

start();
