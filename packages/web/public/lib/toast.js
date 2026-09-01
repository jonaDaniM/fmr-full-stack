/**
 * Brief messages.
 *
 * Two changes from the copies this replaces. Failures look like failures —
 * "Published 4 FMRs" and "Permission denied" used to render identically. And
 * messages stack instead of replacing each other: tabbing through cells in the
 * line editor fires a save per cell, and when several fail you need to see all
 * of them, not just the last.
 */

const STACK_ID = 'toast-stack';
const LIFETIME = { ok: 3200, error: 6000 };

function stack() {
  let node = document.getElementById(STACK_ID);
  if (!node) {
    node = document.createElement('div');
    node.id = STACK_ID;
    node.className = 'toast-stack';
    document.body.append(node);
  }
  return node;
}

function push(message, kind) {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  // Failures interrupt; confirmations wait their turn.
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.textContent = message;

  stack().append(node);

  const life = LIFETIME[kind];
  const timer = setTimeout(() => node.remove(), life);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });

  return node;
}

/** Something worked. */
export const toast = (message) => push(message, 'ok');

/** Something did not. Stays longer, because it needs reading. */
export const toastError = (message) => push(message, 'error');
