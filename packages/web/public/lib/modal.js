/**
 * One dialog, used everywhere.
 *
 * This generalises the correction-preview dialog, which was the only one of the
 * five hand-rolled modals that got the important parts right: the error appears
 * inside the dialog rather than as a toast that vanishes, and the submit button
 * disables, relabels, and comes back if the server refuses.
 *
 * What it adds, which none of the five had:
 *
 *   - focus is trapped inside, and returns to whatever opened the dialog
 *   - Escape always closes, and its listener is always removed (the old one
 *     removed itself only on the Escape path, so every dialog closed another
 *     way left a listener behind holding its whole closure)
 *   - the page behind is inert, so it cannot be tabbed into or clicked
 *   - the page behind does not scroll when the dialog does
 *
 * It also replaces the browser's own confirm() and prompt(). prompt() was the
 * worse of the two: it collected reasons that go into the audit log through an
 * unstyled OS box that cannot validate, and threw the typed text away when the
 * server refused — so a rejected deactivation meant typing the reason again.
 */

import { esc } from './dom.js';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

let open = null;

// The last thing the user pressed, so a dialog opened from it can hand focus
// back to it afterwards.
let lastPointerTarget = null;
document.addEventListener('pointerdown', (event) => {
  lastPointerTarget = event.target.closest('button, [role="button"], a[href]');
}, true);

/**
 * Show a dialog.
 *
 * `body` is HTML — escape anything interpolated into it. `fields` describes the
 * inputs; `onSubmit` receives their values and may throw, in which case the
 * message appears inside the dialog and the dialog stays open with the input
 * intact.
 *
 * Returns a promise resolving to the submitted values, or null if dismissed.
 */
export function dialog({
  title,
  lede = '',
  body = '',
  fields = [],
  confirmLabel = 'Confirm',
  workingLabel = 'Working…',
  cancelLabel = 'Cancel',
  danger = false,
  wide = false,
  onSubmit
}) {
  // Only one at a time; a second would fight the first for focus.
  open?.dismiss();

  // Where focus should land when this closes. activeElement alone is not
  // enough: a tapped button is not focused on iOS, and a click handler may
  // have moved focus already — so prefer the element that was actually
  // clicked, and fall back to whatever had focus.
  const opener = (lastPointerTarget?.isConnected && lastPointerTarget)
    || document.activeElement;

  // Screens re-render after a successful action, so hold a way to find the
  // trigger again rather than a reference to a node that may be gone.
  const openerSelector = describe(opener);

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-bg';
  backdrop.innerHTML = `
    <div class="sheet${wide ? ' sheet-wide' : ''}" role="dialog" aria-modal="true"
         aria-labelledby="dlg-title" aria-describedby="dlg-err">
      <h2 id="dlg-title">${esc(title)}</h2>
      ${lede ? `<p class="for">${esc(lede)}</p>` : ''}
      <div class="dlg-err" id="dlg-err" role="alert" hidden></div>
      ${body}
      ${fields.map(fieldMarkup).join('')}
      <div class="sheet-acts">
        <button type="button" class="btn btn-quiet" data-dlg="cancel">${esc(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}"
                data-dlg="ok">${esc(confirmLabel)}</button>
      </div>
    </div>`;

  document.body.append(backdrop);
  document.body.classList.add('has-dialog');

  // Everything else on the page stops being reachable, by mouse or keyboard.
  const siblings = [...document.body.children].filter((c) => c !== backdrop);
  for (const node of siblings) node.inert = true;

  const sheet = backdrop.querySelector('.sheet');
  const errorBox = backdrop.querySelector('.dlg-err');
  const okButton = backdrop.querySelector('[data-dlg="ok"]');
  const cancelButton = backdrop.querySelector('[data-dlg="cancel"]');

  let settle;
  const result = new Promise((resolve) => { settle = resolve; });

  function teardown() {
    document.removeEventListener('keydown', onKey, true);
    for (const node of siblings) node.inert = false;
    document.body.classList.remove('has-dialog');
    backdrop.remove();
    open = null;
    // Put the caret back where the user left it — after the current task, so
    // a screen that re-renders on success has already done so and the trigger
    // can be found again by its data attribute.
    queueMicrotask(() => {
      if (opener?.isConnected) return opener.focus();
      if (openerSelector) document.querySelector(openerSelector)?.focus();
    });
  }

  function dismiss(value = null) {
    if (!backdrop.isConnected) return;
    teardown();
    settle(value);
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }

    if (event.key !== 'Tab') return;

    // Keep Tab inside the dialog.
    const stops = [...sheet.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (!stops.length) return;

    const first = stops[0];
    const last = stops[stops.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function values() {
    return Object.fromEntries(fields.map((field) => {
      const input = backdrop.querySelector(`[name="${field.name}"]`);
      return [field.name, input ? input.value.trim() : ''];
    }));
  }

  async function submit() {
    const entered = values();

    // Validate before the round trip, so nothing typed is ever lost to a
    // refusal the page could have predicted.
    for (const field of fields) {
      const value = entered[field.name];
      if (field.required && !value) return showError(`${field.label} is required.`);
      if (field.minLength && value.length < field.minLength) {
        return showError(`${field.label} needs at least ${field.minLength} characters.`);
      }
      if (field.type === 'number' && value !== '' && !Number.isFinite(Number(value))) {
        return showError(`${field.label} must be a number.`);
      }
    }

    errorBox.hidden = true;
    okButton.disabled = true;
    cancelButton.disabled = true;
    okButton.textContent = workingLabel;

    try {
      const outcome = onSubmit ? await onSubmit(entered) : entered;
      dismiss(outcome ?? entered);
    } catch (failure) {
      // Stay open, keep what they typed, say what went wrong.
      showError(failure.message);
      okButton.disabled = false;
      cancelButton.disabled = false;
      okButton.textContent = confirmLabel;
    }
  }

  okButton.onclick = submit;
  cancelButton.onclick = () => dismiss();
  backdrop.onclick = (event) => { if (event.target === backdrop) dismiss(); };

  // A control inside `body` may close the dialog and hand back its own answer —
  // used where the dialog is a list to choose from rather than a form to fill.
  sheet.addEventListener('click', (event) => {
    const picker = event.target.closest('[data-pick]');
    if (picker && sheet.contains(picker)) dismiss({ pick: picker.dataset.pick });
  });

  // Enter submits from any single-line input.
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input:not([type="checkbox"])')) {
      event.preventDefault();
      submit();
    }
  });

  document.addEventListener('keydown', onKey, true);

  open = { dismiss };

  // Focus the first thing worth typing into, or the safe button.
  const firstInput = sheet.querySelector('input, select, textarea');
  (firstInput ?? cancelButton).focus();

  return result;
}

/** A selector that finds this element again after its container re-renders. */
function describe(node) {
  if (!node?.dataset) return null;
  for (const key of ['action', 'decide', 'edit', 'publish', 'archive', 'restore', 'history', 'role', 'deactivate']) {
    const value = node.dataset[key];
    if (value) return `[data-${key}="${CSS.escape(value)}"]`;
  }
  return node.id ? `#${CSS.escape(node.id)}` : null;
}

function fieldMarkup(field) {
  const id = `dlg-${field.name}`;
  const label = `<label for="${id}">${esc(field.label)}</label>`;
  const hint = field.hint ? `<div class="max">${esc(field.hint)}</div>` : '';
  const common = `id="${id}" name="${esc(field.name)}"${field.required ? ' required' : ''}`;

  if (field.type === 'select') {
    const options = (field.options ?? []).map((option) => {
      const value = typeof option === 'string' ? option : option.value;
      const text = typeof option === 'string' ? option : option.label;
      return `<option value="${esc(value)}"${value === field.value ? ' selected' : ''}>${esc(text)}</option>`;
    }).join('');
    return `<div class="field">${label}<select ${common}>${options}</select>${hint}</div>`;
  }

  if (field.type === 'textarea') {
    return `<div class="field">${label}<textarea ${common} rows="${Number(field.rows) || 3}"
      ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ''}
      >${esc(field.value ?? '')}</textarea>${hint}</div>`;
  }

  const attrs = [
    `type="${esc(field.type ?? 'text')}"`,
    field.value != null ? `value="${esc(field.value)}"` : '',
    field.min != null ? `min="${esc(field.min)}"` : '',
    field.max != null ? `max="${esc(field.max)}"` : '',
    field.step ? `step="${esc(field.step)}"` : '',
    field.inputmode ? `inputmode="${esc(field.inputmode)}"` : '',
    field.list ? `list="${esc(field.list)}"` : '',
    field.placeholder ? `placeholder="${esc(field.placeholder)}"` : '',
    field.autocomplete ? `autocomplete="${esc(field.autocomplete)}"` : ''
  ].filter(Boolean).join(' ');

  const datalist = field.suggestions?.length
    ? `<datalist id="${esc(field.list)}">${
        field.suggestions.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>`
    : '';

  return `<div class="field">${label}<input ${common} ${attrs}>${hint}${datalist}</div>`;
}

/**
 * Ask before doing something that cannot be taken back.
 *
 * Resolves true if confirmed. Pass `danger` when the outcome is destructive so
 * the affirmative button is not styled as the safe choice.
 */
export async function confirmAction({ title, lede, body, confirmLabel = 'Confirm', danger = false }) {
  const answer = await dialog({
    title, lede, body, confirmLabel, danger,
    workingLabel: confirmLabel,
    onSubmit: () => true
  });
  return answer === true;
}

/**
 * Collect a reason for the audit log.
 *
 * Replaces prompt(). The length rule is checked here, before the request, and
 * what was typed survives a refusal.
 */
export async function askReason({
  title,
  lede,
  label = 'Reason',
  minLength = 3,
  confirmLabel = 'Save',
  danger = false,
  onSubmit
}) {
  const answer = await dialog({
    title,
    lede,
    confirmLabel,
    danger,
    fields: [{
      name: 'reason',
      label,
      type: 'textarea',
      rows: 3,
      required: true,
      minLength,
      hint: `At least ${minLength} characters. This is recorded against your name.`
    }],
    onSubmit: onSubmit ? (values) => onSubmit(values.reason) : undefined
  });

  return answer?.reason ?? answer ?? null;
}
