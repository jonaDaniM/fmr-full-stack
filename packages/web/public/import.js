/**
 * Import.
 *
 * Three kinds of file arrive here. A workbook of FMRs, which is what the office
 * has always produced. The CSV that extract_materials.py writes after reading
 * drawings. And the drawing PDFs themselves, which the server reads directly.
 * Same destination, different readers, and the page picks between them by
 * looking at what was actually dropped.
 *
 * Either way nothing is created until a person has read it. That is the whole
 * point of this screen.
 */

import {
  api, upload as uploadWithProgress, idempotencyKey, getProjectId
} from './lib/api.js';
import { $, esc, editableNumber } from './lib/dom.js';
import { confirmAction } from './lib/modal.js';
import { toast, toastError } from './lib/toast.js';
import { initShell, session, refuseUnless } from './lib/shell.js';

const state = {
  batch: null, extraction: null, polling: null, removedEverything: false,
  // Which workbook layout to read with, and the ones this project can pick.
  profileName: 'default', profiles: [{ name: 'default', builtIn: true }],
  tuning: null
};

// --- tuning a workbook layout ---------------------------------------------

/**
 * What a column can hold.
 *
 * These are the parser's own field names, with the wording a person would use.
 * Description and quantity are marked because an import cannot produce a line
 * without them — everything else is optional detail.
 */
const FIELDS = [
  ['description', 'Description — required'],
  ['quantity', 'Quantity — required'],
  ['commodityCode', 'Commodity code'],
  ['size', 'Size'],
  ['uom', 'Unit of measure'],
  ['lineNumber', 'Item / line number'],
  ['storageLocation', 'Storage location'],
  // Header fields, offered here because an exported table carries them as a
  // column on every row rather than as a label above the table. Without these
  // there was no way to tell the reader which column held the drawing number,
  // and the import failed on a file that plainly contained it.
  ['isoNumber', 'Drawing / ISO number'],
  ['isoSheet', 'Drawing sheet'],
  ['fmrNumber', 'FMR number'],
  ['iwpNumber', 'IWP number']
];

/** The fields above that belong to the FMR, not to each material line. */
const HEADER_FIELDS = new Set(['isoNumber', 'isoSheet', 'fmrNumber', 'iwpNumber']);

const FIELD_LABEL = Object.fromEntries(FIELDS);

/**
 * Which layout this project last imported with.
 *
 * Remembered per project: a project that has tuned a layout uses it every
 * time, rather than quietly falling back to the baseline and staging an empty
 * batch. Kept in the browser, because it is a convenience rather than a
 * setting anyone else needs to see.
 */
const rememberedKey = () => `fmr.importProfile.${session.projectId ?? 'none'}`;

function rememberProfile(name) {
  try {
    localStorage.setItem(rememberedKey(), name);
  } catch {
    // Private windows and blocked site data: the picker still works, it just
    // will not be remembered next time.
  }
}

function rememberedProfile() {
  try {
    return localStorage.getItem(rememberedKey());
  } catch {
    return null;
  }
}

/** Whatever this project can import with, plus the built-in baselines. */
async function loadProfiles() {
  try {
    const { profiles } = await api('/api/import/profiles');
    state.profiles = profiles;

    // What this browser last chose wins. Failing that, a layout the project
    // has tuned — because a project that went to the trouble of tuning one
    // wants it, and silently reading with the baseline stages an empty batch
    // and gives no reason for it. Only then the baseline.
    const remembered = rememberedProfile();
    state.profileName = (remembered && profiles.some((p) => p.name === remembered))
      ? remembered
      : (profiles.find((p) => !p.builtIn)?.name ?? 'default');
  } catch {
    // Not fatal: the baseline still works, and the picker falls back to it.
    state.profiles = [{ name: 'default', builtIn: true }];
    state.profileName = 'default';
  }
}

/**
 * The tuning screen.
 *
 * The parser matches column headings exactly, so a project whose sheets say
 * REQ'D QTY instead of Qty imports nothing and says nothing about why. This is
 * where somebody fixes that without a developer: upload one of their own
 * sheets, see which headings were not recognised, say what each one holds, and
 * save it as a layout for the project.
 */
function renderTuner(message = null) {
  const tuning = state.tuning;

  $('view').innerHTML = `
    <div class="page-head">
      <h2>Tune a workbook layout</h2>
      <p class="lede">The reader matches column headings exactly. Show it one of
         this project's own workbooks and tell it what the unfamiliar headings
         hold — it will recognise them from then on.</p>
    </div>

    ${message ? `<div class="issue issue-error">${esc(message)}</div>` : ''}

    <div class="drop" id="tryDrop">
      <h3>Try a workbook</h3>
      <p>Nothing is imported and nothing is published — this only reports what
         the reader can and cannot see.</p>
      <input id="tryFile" type="file" accept=".xlsx,.xls,.csv">
      <label for="tryFile" class="btn btn-primary">Choose a workbook</label>
    </div>

    ${tuning ? renderFit(tuning) : ''}

    <div class="tunerbar">
      <button type="button" class="btn btn-quiet" id="tuneBack">Back to import</button>
    </div>`;

  $('tryFile').onchange = (event) => tryWorkbook(event.target.files[0]);
  $('tuneBack').onclick = () => renderDrop();

  if (tuning) bindTuner();
}

/** What the reader made of the file, sheet by sheet. */
function renderFit(tuning) {
  return `
    <div class="fit">
      <p class="source-line"><strong>${esc(tuning.filename)}</strong> &middot;
         read with the "${esc(tuning.profileName)}" layout</p>

      ${tuning.sheets.map(renderFitSheet).join('')}

      <div class="save-profile">
        <label for="profileName">Save this layout as</label>
        <input id="profileName" type="text" value="${esc(tuning.saveAs)}"
               placeholder="Midwest Expansion" autocomplete="off">
        <button type="button" class="btn btn-primary" id="saveProfile">Save layout</button>
        <p class="hint">Saving under an existing name replaces it. The next
           import can then pick this layout.</p>
      </div>
    </div>`;
}

function renderFitSheet(sheet) {
  const unplaced = sheet.unmatched.filter((u) => !u.hidden);

  return `
    <div class="fit-sheet">
      <h3>${esc(sheet.sheet)}</h3>

      ${sheet.headerRow === null
        ? `<p class="issue issue-error">No heading row was found in this sheet.
             It may be a cover page, or the headings may be further down than
             the reader looks.</p>`
        : `<p class="dim">Headings found on row ${esc(String(sheet.headerRow + 1))}.</p>`}

      ${sheet.matched.length ? `
        <p class="fit-ok"><strong>Recognised:</strong>
          ${sheet.matched.map((m) =>
            `${esc(m.heading)} <span class="dim">→ ${esc(FIELD_LABEL[m.field] ?? m.field)}</span>`
          ).join(' &middot; ')}</p>` : ''}

      ${sheet.missing.length ? `
        <p class="issue issue-error">Nothing is mapped to
          ${sheet.missing.map((f) => esc(FIELD_LABEL[f] ?? f)).join(' or ')}.
          An import would produce no lines until that is fixed.</p>` : ''}

      ${unplaced.length ? `
        <table class="fit-table">
          <thead><tr><th>Heading in the file</th><th>What it holds</th></tr></thead>
          <tbody>
            ${unplaced.map((u) => `
              <tr>
                <td><code>${esc(u.heading)}</code></td>
                <td>
                  <select data-map="${esc(u.heading)}">
                    <option value="">— leave it out —</option>
                    ${FIELDS.map(([field, label]) => `
                      <option value="${esc(field)}"
                              ${field === u.suggestion ? 'selected' : ''}>
                        ${esc(label)}</option>`).join('')}
                  </select>
                  ${u.suggestion
                    ? '<span class="dim">suggested</span>'
                    : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`
        : `<p class="fit-ok">Every heading in this sheet was recognised.</p>`}
    </div>`;
}

function bindTuner() {
  $('saveProfile').onclick = saveTunedProfile;
}

/** Send one workbook and report what the current layout made of it. */
async function tryWorkbook(file) {
  if (!file) return;

  try {
    const buffer = await file.arrayBuffer();
    const result = await api(
      `/api/import/profiles/try?filename=${encodeURIComponent(file.name)}`
      + `&profile=${encodeURIComponent(state.profileName)}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' },
        body: buffer }
    );

    state.tuning = {
      filename: file.name,
      profileName: result.profileName,
      sheets: result.sheets,
      saveAs: state.profiles.find((p) => p.name === state.profileName && !p.builtIn)
        ? state.profileName
        : ''
    };
    renderTuner();
  } catch (failure) {
    renderTuner(failure.message);
  }
}

/**
 * Save what was mapped as a layout for this project.
 *
 * The exact heading is recorded, so the next import matches it outright rather
 * than relying on the same guess being made again.
 */
async function saveTunedProfile() {
  const name = $('profileName').value.trim();
  if (!name) return toastError('Give the layout a name.');

  const chosen = [...document.querySelectorAll('select[data-map]')]
    .map((select) => ({ heading: select.dataset.map, field: select.value }))
    .filter((entry) => entry.field);

  try {
    const { definition } = await api(
      `/api/import/profiles/built-in/${encodeURIComponent(
        state.profiles.find((p) => p.name === state.profileName)?.basedOn ?? 'default')}`
    );

    // Start from what the current layout already knows, then add what was just
    // mapped — so tuning one sheet never loses headings learned earlier.
    const base = await currentDefinition(definition);
    const columns = { ...(base.columns ?? {}) };
    const header = { ...(base.header ?? {}) };

    const bare = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

    for (const { heading, field } of chosen) {
      // A header field keeps its aliases under `header`, where the reader looks
      // for it — both above the table and, failing that, as a column heading.
      if (HEADER_FIELDS.has(field)) {
        const spec = header[field] ?? { aliases: [] };
        const aliases = spec.aliases ?? [];
        if (!aliases.some((alias) => bare(alias) === bare(heading))) {
          header[field] = { ...spec, aliases: [...aliases, heading] };
        }
        continue;
      }

      const existing = columns[field] ?? [];
      if (!existing.some((alias) => bare(alias) === bare(heading))) {
        columns[field] = [...existing, heading];
      }
    }

    await api('/api/import/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: state.profiles.find((p) => p.name === name && !p.builtIn)?.id,
        name,
        definition: { ...base, columns, header },
        basedOn: state.profileName
      })
    });

    await loadProfiles();
    state.profileName = name;
    rememberProfile(name);
    state.tuning = null;
    toast(`Saved. Imports can now be read with the "${name}" layout.`);
    renderDrop();
  } catch (failure) {
    toastError(failure.message);
  }
}

/** The definition the current layout is actually using. */
async function currentDefinition(fallback) {
  const chosen = state.profiles.find((p) => p.name === state.profileName);
  if (!chosen || chosen.builtIn) return fallback;

  const saved = await api(`/api/import/profiles/${encodeURIComponent(chosen.id)}`);
  return saved.definition ?? fallback;
}

// --- upload ----------------------------------------------------------------

function renderDrop(message = null) {
  $('view').innerHTML = `
    ${message ? `<div class="issue issue-error" style="margin-bottom:var(--s-4)">${esc(message)}</div>` : ''}
    <div class="drop" id="drop">
      <h2>Drop files here</h2>
      <p>Drawing PDFs, an FMR workbook, or the CSV that the drawing extractor
         writes. Nothing is created until you have reviewed it.</p>
      <input id="file" type="file" accept=".pdf,.xlsx,.xls,.csv" multiple>
      <label for="file" class="btn btn-primary">Choose files</label>
    </div>
    <p class="hint">Drop a whole IWP package of drawings at once — the material
       on each one becomes an FMR to check. Workbooks are read one sheet per
       FMR, and an extraction CSV one drawing per FMR.</p>

    <div class="profile-bar">
      <label for="profilePick">Workbook layout</label>
      <select id="profilePick">
        ${state.profiles.map((profile) => `
          <option value="${esc(profile.name)}"
                  ${profile.name === state.profileName ? 'selected' : ''}>
            ${esc(profile.name)}${profile.builtIn ? '' : ' (this project)'}
          </option>`).join('')}
      </select>
      <button type="button" class="btn btn-quiet" id="tuneProfile">Tune it</button>
      <p class="hint">Which column headings this project's workbooks use. Drawings
         and extraction CSVs ignore this.</p>
    </div>

    <div class="takeoff-offer">
      <h3>Or take material off for ordering</h3>
      <p>A Material Takeoff is what the material team quotes and buys from,
         before any FMR exists. Same drawings, read for what to order rather
         than what to fetch — pipe by the foot, bolts and gaskets listed apart
         so they can be quoted separately.</p>
      <div class="takeoff-fields">
        <label for="mtoCwa">CWA <span class="dim">(optional)</span></label>
        <input id="mtoCwa" type="text" placeholder="10D" autocomplete="off">
        <label for="mtoIwp">IWP <span class="dim">(if the cover page has none)</span></label>
        <input id="mtoIwp" type="text" placeholder="IP-SMM30R107MMPP-K447" autocomplete="off">
      </div>
      <input id="mtoFile" type="file" accept=".pdf" multiple>
      <label for="mtoFile" class="btn">Choose drawings for a takeoff</label>
    </div>`;

  const drop = $('drop');
  const file = $('file');

  file.onchange = () => send([...file.files]);

  for (const event of ['dragenter', 'dragover']) {
    drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const event of ['dragleave', 'drop']) {
    drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }

  drop.addEventListener('drop', (e) => send([...(e.dataTransfer?.files ?? [])]));

  $('profilePick').onchange = (event) => {
    state.profileName = event.target.value;
    rememberProfile(state.profileName);
  };
  $('tuneProfile').onclick = () => renderTuner();

  $('mtoFile').onchange = (event) => sendTakeoff([...event.target.files]);
}

/**
 * Which reader this file needs.
 *
 * The extractor's CSV always names the PDF each row came from and scores its
 * own confidence. No FMR workbook has those columns, so the header settles it
 * without asking the user to classify their own file.
 */
function looksExtracted(text) {
  const header = text.slice(0, 400).split(/\r?\n/)[0]?.toLowerCase() ?? '';
  return header.includes('source_pdf') && header.includes('confidence');
}

/**
 * Lay several files end to end for one upload.
 *
 * A package is many drawings and the server has no multipart parser, so each
 * file is preceded by a header naming the length of its name and its data.
 */
function frameFiles(files) {
  const parts = [];
  let total = 0;

  for (const { name, buffer } of files) {
    const encoded = new TextEncoder().encode(name);
    const header = new DataView(new ArrayBuffer(8));
    header.setUint32(0, encoded.byteLength);
    header.setUint32(4, buffer.byteLength);
    parts.push(new Uint8Array(header.buffer), encoded, new Uint8Array(buffer));
    total += 8 + encoded.byteLength + buffer.byteLength;
  }

  const body = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { body.set(part, at); at += part.byteLength; }
  return body.buffer;
}

async function send(chosen) {
  if (!chosen.length) return;

  const pdfs = chosen.filter((f) => /\.pdf$/i.test(f.name));

  // Drawings are read by the server and take a while, so they go their own
  // way. Anything else is a single file read inside the request.
  if (pdfs.length) return sendDrawings(pdfs);
  return sendOneFile(chosen[0]);
}

/**
 * The largest body the deployment will carry.
 *
 * Cloud Run's front end refuses anything over 32MB, and refuses it before the
 * server sees it — no log line, and an HTML error page the API layer can only
 * report as "Something went wrong". Packages near that go the long way round
 * instead, with the margin covering the framing headers.
 */
const DIRECT_UPLOAD_LIMIT = 30_000_000;

const progress = (fraction, done) => {
  const bar = $('progress');
  if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
  if (fraction === 1 && done) $('uploadWhat').textContent = done;
};

/**
 * Send a package the way this server can actually receive it.
 *
 * Small packages go straight to the app, which is one request and needs
 * nothing configured. A package too big for the front end is uploaded to Cloud
 * Storage a file at a time, and only the object names are posted here.
 *
 * The deployment decides which is available, not this page: asking for signed
 * URLs answers 404 where there is no bucket, and a local run — where there is
 * no front end and no limit — always uploads directly.
 */
async function sendDrawings(files) {
  renderUploading(
    `${files.length} drawing${files.length === 1 ? '' : 's'}`,
    'Sending the drawings…'
  );

  const total = files.reduce((sum, file) => sum + file.size, 0);

  try {
    const started = total > DIRECT_UPLOAD_LIMIT
      ? await sendViaStorage(files)
      : await sendDirectly(files);

    watchJob(started.jobId, files.length);
  } catch (failure) {
    renderDrop(failure.message);
  }
}

/** One request carrying every file, for a package that fits in one. */
async function sendDirectly(files) {
  const loaded = await Promise.all(
    files.map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() }))
  );

  return uploadWithProgress('/api/import/drawings', frameFiles(loaded), {
    onProgress: (fraction) => progress(fraction, 'Reading the drawings…')
  });
}

/**
 * Upload to Cloud Storage first, then hand over the names.
 *
 * One file at a time rather than all at once: a package this size is being
 * sent over site wifi, and several large uploads competing for it finish no
 * sooner while making the progress bar meaningless.
 */
async function sendViaStorage(files) {
  const objects = await uploadToStorage(files);

  $('uploadWhat').textContent = 'Reading the drawings…';

  return api('/api/import/drawings', {
    method: 'POST',
    body: JSON.stringify({ objects })
  });
}

/**
 * Put every file in the bucket and return what to call them.
 *
 * Shared by the FMR import and the takeoff, which differ only in what they ask
 * the server to do with the names afterwards.
 *
 * One file at a time rather than all at once: a package this size is being
 * sent over site wifi, and several large uploads competing for it finish no
 * sooner while making the progress bar meaningless.
 */
async function uploadToStorage(files) {
  let uploads;
  try {
    ({ uploads } = await api('/api/import/uploads', {
      method: 'POST',
      body: JSON.stringify({ files: files.map((f) => ({ name: f.name })) })
    }));
  } catch (failure) {
    // 404 is the deployment saying it has no bucket. Anything else is a real
    // failure and keeps its own message.
    if (failure.status !== 404) throw failure;
    const megabytes = Math.round(files.reduce((s, f) => s + f.size, 0) / 1_000_000);
    throw new Error(
      `That package is too large for this server to accept in one piece (${megabytes}MB). `
      + 'Send the drawings as separate files, or ask for large uploads to be '
      + 'switched on.'
    );
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  const sent = [];
  let done = 0;

  for (const [index, upload] of uploads.entries()) {
    const file = files[index];

    await putToStorage(upload.url, file, upload.contentType, (fraction) => {
      // One bar for the whole package: a bar that restarts at every file
      // reads as a stall on the twentieth drawing.
      progress((done + fraction * file.size) / total);
      $('uploadWhat').textContent =
        `Sending drawing ${index + 1} of ${uploads.length}…`;
    });

    done += file.size;
    sent.push(upload.objectName);
  }

  return sent;
}

/**
 * PUT one file to a signed URL.
 *
 * Not `api()`: the request goes to Google, not to this server, so it must
 * carry none of the session or project headers — and the content type has to
 * be exactly what was signed or the signature will not match.
 */
function putToStorage(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('content-type', contentType);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return resolve();
      console.error('storage upload failed:', request.status, request.responseText);
      reject(new Error(`${file.name} could not be uploaded. Try again.`));
    };

    request.onerror = () =>
      reject(new Error(`${file.name} did not reach the server.`));

    request.send(file);
  });
}

/**
 * Read a package for ordering rather than for requisitioning.
 *
 * Nothing is staged and nothing is published — the answer is the takeoff
 * file, which goes to whoever quotes the material. So this does not poll a
 * job: it asks, waits, and hands back a download.
 */
async function sendTakeoff(files) {
  const pdfs = files.filter((file) => /\.pdf$/i.test(file.name));
  if (!pdfs.length) {
    return renderDrop('A takeoff is read from drawing PDFs. Choose the ISO sheets.');
  }

  const cwa = $('mtoCwa')?.value.trim() ?? '';
  const iwp = $('mtoIwp')?.value.trim() ?? '';

  renderUploading(
    `${pdfs.length} drawing${pdfs.length === 1 ? '' : 's'}`,
    'Reading the drawings for a takeoff…'
  );

  const query = new URLSearchParams();
  if (cwa) query.set('cwa', cwa);
  if (iwp) query.set('iwp', iwp);

  try {
    // A package over the front end's limit goes to Cloud Storage first and is
    // named rather than sent, exactly as the FMR import does.
    const total = pdfs.reduce((sum, file) => sum + file.size, 0);
    const request = total > DIRECT_UPLOAD_LIMIT
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ objects: await uploadToStorage(pdfs) })
        }
      : {
          body: frameFiles(await Promise.all(
            pdfs.map(async (file) => ({ name: file.name, buffer: await file.arrayBuffer() }))
          ))
        };

    $('uploadWhat').textContent = 'Reading the drawings for a takeoff…';

    const response = await fetch(`/api/import/takeoff?${query}`, {
      method: 'POST',
      headers: { 'x-project-id': getProjectId(), ...(request.headers ?? {}) },
      body: request.body
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Those drawings could not be read.');
    }

    const rows = response.headers.get('x-takeoff-rows');
    const drawings = response.headers.get('x-takeoff-drawings');
    const name = /filename="([^"]+)"/.exec(
      response.headers.get('content-disposition') ?? ''
    )?.[1] ?? 'takeoff.csv';

    saveFile(await response.blob(), name);

    renderDrop();
    toast(`Took off ${rows} lines from ${drawings} drawings — ${name}`);
  } catch (failure) {
    renderDrop(failure.message);
  }
}

/**
 * Hand a generated file to whoever asked for it.
 *
 * The one place this app produces a download rather than a screen, so the
 * object URL is revoked here instead of leaking for the life of the tab.
 */
function saveFile(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

/** A workbook or a CSV: read inside the request, as it always was. */
async function sendOneFile(file) {
  const buffer = await file.arrayBuffer();

  // A CSV could be either kind, so read the header before choosing a route.
  const extracted = /\.csv$/i.test(file.name)
    && looksExtracted(new TextDecoder().decode(buffer.slice(0, 400)));

  renderUploading(file.name, extracted ? 'Sending the extraction…' : 'Sending the workbook…');

  const path = extracted
    ? `/api/import/extracted?filename=${encodeURIComponent(file.name)}`
    : `/api/import/stage?filename=${encodeURIComponent(file.name)}`
      + `&profile=${encodeURIComponent(state.profileName)}`;

  try {
    const result = await uploadWithProgress(path, buffer, {
      onProgress: (fraction) => {
        const bar = $('progress');
        if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
        // Once the bytes are up, the server is still parsing. Say so, rather
        // than leaving a full bar sitting under a stale label.
        if (fraction === 1) $('uploadWhat').textContent = 'Reading it…';
      }
    });

    state.extraction = result.description ?? null;
    await loadBatch(result.batchId);
  } catch (failure) {
    // The message used to be wiped by a timer three seconds later, which is
    // not long enough to read "that file is too large" and act on it.
    renderDrop(failure.message);
  }
}

/**
 * Wait for the server to finish reading a package.
 *
 * The upload ended when the bytes landed; the reading carries on behind it, so
 * the page asks how it is going until there is a batch to review.
 */
function watchJob(jobId, fileCount) {
  const startedAt = Date.now();
  renderReading(fileCount, 0);

  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    let job;
    try {
      job = await api(`/api/import/jobs/${jobId}`);
    } catch (failure) {
      clearInterval(state.polling);
      return renderDrop(failure.message);
    }

    if (job.status === 'Running') {
      return renderReading(fileCount, Math.round((Date.now() - startedAt) / 1000));
    }

    clearInterval(state.polling);

    if (job.status === 'Failed') return renderDrop(job.message);

    state.extraction = job.message ?? null;
    loadBatch(job.batchId).catch((failure) => renderDrop(failure.message));
  }, 1000);
}

function renderUploading(what, saying) {
  $('view').innerHTML = `
    <div class="drop">
      <h2>${esc(what)}</h2>
      <p id="uploadWhat">${esc(saying)}</p>
      <div class="progress"><i id="progress" style="width:0%"></i></div>
    </div>`;
}

/** The wait while the server reads a package, with something honest on screen. */
function renderReading(fileCount, seconds) {
  $('view').innerHTML = `
    <div class="drop">
      <h2>Reading ${esc(fileCount)} drawing${fileCount === 1 ? '' : 's'}</h2>
      <p>Finding the material on each one. This does not need you to wait here —
         the drafts will be in the queue either way.</p>
      <p class="hint">${esc(seconds)} second${seconds === 1 ? '' : 's'} so far</p>
    </div>`;
}

// --- review ----------------------------------------------------------------

async function loadBatch(batchId) {
  state.removedEverything = false;
  state.batch = await api(`/api/import/${batchId}`);
  renderBatch();
}

function renderBatch() {
  const batch = state.batch;
  const selectable = batch.items.filter((i) => i.status !== 'Blocked');
  const selected = batch.items.filter((i) => i.selected).length;

  // Blocked is its own count. A batch where nothing can be published while the
  // Errors tile reads 0 looks fine and is not — the reason is a duplicate
  // number or a missing detail, neither of which is an "error" in the row.
  const blocked = batch.items.length - selectable.length;
  const staged = batch.items.filter((i) =>
    i.issues?.some((issue) => issue.code === 'ALREADY_STAGED')).length;

  $('view').innerHTML = `
    ${state.removedEverything ? '' : `<div class="stats">
      <div class="stat"><span class="n">${batch.summary.sheets}</span><span class="l">Sheets</span></div>
      <div class="stat"><span class="n">${batch.summary.lines}</span><span class="l">Lines</span></div>
      <div class="stat ${batch.summary.errors ? 'stat-danger' : ''}">
        <span class="n">${batch.summary.errors}</span><span class="l">Errors</span></div>
      <div class="stat ${blocked ? 'stat-danger' : ''}">
        <span class="n">${esc(String(blocked))}</span><span class="l">Blocked</span></div>
      <div class="stat ${batch.summary.warnings ? 'stat-warn' : ''}">
        <span class="n">${batch.summary.warnings}</span><span class="l">Warnings</span></div>
    </div>`}

    ${staged && !state.removedEverything ? `
      <div class="issue issue-error">
        <strong>This package is already in the queue.</strong>
        ${esc(String(staged))} of its ${esc(String(batch.items.length))} FMRs
        carry a number that is already waiting, so their numbers were dropped
        rather than their material. Either work from the batch already staged
        and start this one over, or give these FMRs numbers of their own.
      </div>` : ''}

    ${state.extraction ? `<div class="extract-note">${esc(state.extraction)}</div>` : ''}

    <p class="source-line">
      <strong>${esc(batch.sourceName)}</strong> &middot; read with the
      "${esc(batch.profileName)}" profile
      ${!state.removedEverything && batch.summary.errors
        ? '&middot; errors must be fixed before publishing'
        : ''}
      ${!state.removedEverything && !batch.summary.errors && blocked
        ? `&middot; ${esc(String(blocked))} of ${esc(String(batch.items.length))} cannot be published yet`
        : ''}
    </p>

    ${batch.items.length
      ? batch.items.map(renderItem).join('')
      : `<div class="empty">
           <h2>Nothing to review</h2>
           ${state.removedEverything
             ? `<p>Every FMR in this batch was removed. Nothing was published, and
                   the drawings are unchanged — read them again to start over.</p>`
             : `<p>No FMRs were found in that file. Check it is the right one, or that
                   the sheet names match what the profile expects.</p>`}
           <button type="button" class="btn btn-primary" id="again">Try another file</button>
         </div>`}

    ${batch.items.length ? `
      <div class="publishbar">
        <span>${selected} of ${selectable.length} selected</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-quiet" id="again">Start over</button>
        <button type="button" class="btn btn-primary" id="publish"
                ${batch.summary.errors || !selected ? 'disabled' : ''}>
          Publish ${selected} FMR${selected === 1 ? '' : 's'}
        </button>
      </div>` : ''}`;

  $('publish')?.addEventListener('click', publish);
  $('again')?.addEventListener('click', () => {
    state.batch = null;
    state.extraction = null;
    renderDrop();
  });
}

function renderItem(item) {
  const cls = item.status === 'Blocked' ? 'blocked' : item.isDuplicate ? 'dup' : '';

  return `<section class="item ${cls}" data-item="${esc(item.id)}">
    <div class="item-head">
      <input type="checkbox" data-select="${esc(item.id)}"
             ${item.selected ? 'checked' : ''}
             ${item.status === 'Blocked' ? 'disabled' : ''}
             aria-label="Include ${esc(item.fmrNumber ?? item.sheetName)}">
      <span class="name">${esc(item.fmrNumber ?? '(no FMR number)')}</span>
      <span class="dim">${esc(item.isoNumber ?? '')} sht ${esc(item.isoSheet ?? '')}
        &middot; ${item.lines.length} lines &middot; sheet "${esc(item.sheetName)}"</span>
      ${item.isDuplicate ? '<span class="pill pill-warn">Already exists</span>' : ''}
      ${item.status === 'Blocked' ? '<span class="pill pill-danger">Blocked</span>' : ''}
      <button type="button" class="btn btn-quiet btn-sm drop-item"
              data-drop-item="${esc(item.id)}">Remove</button>
    </div>

    ${item.issues.length ? `<div class="issues">
      ${item.issues.map((issue) => `
        <div class="issue issue-${esc(issue.severity)}">
          ${issue.sourceRow ? `<span class="where">Row ${esc(issue.sourceRow)}</span>` : ''}
          <span>${esc(issue.message)}</span>
        </div>`).join('')}
    </div>` : ''}

    <div class="tw"><table>
      <thead><tr>
        <th class="w-tiny">#</th><th class="w-sm">Source row</th>
        <th class="w-md">Code</th><th class="w-sm">Size</th>
        <th class="w-grow">Description</th><th class="num w-sm">Qty</th><th class="w-sm">UOM</th>
        <th class="w-tiny"><span class="sr-only">Remove</span></th>
      </tr></thead>
      <tbody>${item.lines.map((l) => `
        <tr data-line="${esc(l.id)}" ${rowIsFlagged(item, l) ? 'class="row-bad"' : ''}>
          <td class="num">${esc(l.lineNumber)}</td>
          <td class="dim num">${esc(l.sourceRow ?? '')}</td>
          <td class="mono" contenteditable data-field="commodityCode">${esc(l.commodityCode ?? '')}</td>
          <td class="mono" contenteditable data-field="size">${esc(l.size ?? '')}</td>
          <td contenteditable data-field="description">${esc(l.description ?? '')}</td>
          <td class="num" contenteditable data-field="quantity">${esc(editableNumber(l.quantity))}</td>
          <td class="mono" contenteditable data-field="uom">${esc(l.uom ?? '')}</td>
          <td><button type="button" class="linkish drop-line"
                      data-drop-line="${esc(l.id)}"
                      aria-label="Remove line ${esc(l.lineNumber)}">&times;</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </section>`;
}

/** An issue names a source row; mark that row so it can be found by eye. */
const rowIsFlagged = (item, line) =>
  line.sourceRow != null
  && item.issues.some((i) => i.severity === 'error' && i.sourceRow === line.sourceRow);

// --- edits -----------------------------------------------------------------

// Scoped to the view, not the document: the old listeners fired on any change
// or blur anywhere on the page, including the project selector.
$('view').addEventListener('change', (event) => {
  const box = event.target.closest('input[data-select]');
  if (!box || !state.batch) return;

  const item = state.batch.items.find((i) => i.id === box.dataset.select);
  if (!item) return;

  item.selected = box.checked;

  // Update only the publish bar. Re-rendering everything used to destroy
  // scroll position and any half-typed cell.
  updatePublishBar();
});

function updatePublishBar() {
  const batch = state.batch;
  const selectable = batch.items.filter((i) => i.status !== 'Blocked');
  const selected = batch.items.filter((i) => i.selected).length;

  const bar = document.querySelector('.publishbar');
  if (!bar) return;

  bar.firstElementChild.textContent = `${selected} of ${selectable.length} selected`;

  const button = $('publish');
  button.disabled = Boolean(batch.summary.errors) || !selected;
  button.textContent = `Publish ${selected} FMR${selected === 1 ? '' : 's'}`;
}

/**
 * Remove a line, or a whole proposed FMR, before anything is published.
 *
 * A package holds every drawing a planner compiled, and the office is often
 * only working part of it: pipe and field welds now, valves and gaskets when
 * the crew comes back. Deselecting an FMR hides it from the publish button
 * but leaves it in the queue; this takes it out.
 */
$('view').addEventListener('click', async (event) => {
  const lineButton = event.target.closest('button[data-drop-line]');
  const itemButton = event.target.closest('button[data-drop-item]');
  if ((!lineButton && !itemButton) || !state.batch) return;

  if (lineButton) {
    const { dropLine } = lineButton.dataset;
    const row = lineButton.closest('tr');
    const description = row.querySelector('[data-field="description"]')?.textContent.trim();

    const sure = await confirmAction({
      title: 'Remove this line?',
      lede: description || `Line ${row.firstElementChild.textContent.trim()}`,
      body: 'It will not be published. The drawing is unchanged.',
      confirmLabel: 'Remove line'
    });
    if (!sure) return;

    try {
      await api('/api/import/line', {
        method: 'DELETE',
        body: JSON.stringify({ lineId: dropLine })
      });

      for (const item of state.batch.items) {
        const at = item.lines.findIndex((l) => l.id === dropLine);
        if (at === -1) continue;
        item.lines.splice(at, 1);
        item.lines.forEach((line, index) => { line.lineNumber = index + 1; });
      }
      renderBatch();
    } catch (failure) {
      toastError(failure.message);
    }
    return;
  }

  const { dropItem } = itemButton.dataset;
  const item = state.batch.items.find((i) => i.id === dropItem);
  if (!item) return;

  const sure = await confirmAction({
    title: 'Remove this FMR?',
    lede: item.fmrNumber ?? item.sheetName,
    body: `All ${item.lines.length} lines go with it, and it will not be published. `
      + 'The drawing is unchanged, so it can be read again later.',
    confirmLabel: 'Remove FMR',
    danger: true
  });
  if (!sure) return;

  try {
    await api('/api/import/item', {
      method: 'DELETE',
      body: JSON.stringify({ itemId: dropItem })
    });
    state.batch.items = state.batch.items.filter((i) => i.id !== dropItem);
    // An empty batch means one of two different things, and the message that
    // blames the file is wrong when the office just emptied it by hand.
    state.removedEverything = state.batch.items.length === 0;
    renderBatch();
  } catch (failure) {
    toastError(failure.message);
  }
});

/** Save a corrected cell when focus leaves it. */
$('view').addEventListener('focusout', async (event) => {
  const cell = event.target.closest('td[contenteditable]');
  if (!cell || !state.batch) return;

  const lineId = cell.closest('tr').dataset.line;
  const field = cell.dataset.field;
  const raw = cell.textContent.trim();
  const value = field === 'quantity' ? Number(raw.replace(/,/g, '')) : raw;

  // An emptied cell reads as 0, which is a finite number and used to save
  // silently — leaving a line that tells a crew to go and find nothing. Say
  // what is wrong rather than only colouring the cell red.
  if (field === 'quantity' && (!raw || !Number.isFinite(value) || value <= 0)) {
    cell.classList.add('bad');
    toastError(
      raw
        ? `"${raw}" is not a quantity anyone can go and find.`
        : 'A line needs a quantity. Remove the line if it is not wanted.'
    );
    return;
  }
  cell.classList.remove('bad');
  cell.classList.add('saving');

  try {
    await api('/api/import/line', {
      method: 'POST',
      body: JSON.stringify({ lineId, patch: { [field]: value } })
    });

    for (const item of state.batch.items) {
      const line = item.lines.find((l) => l.id === lineId);
      if (line) line[field] = value;
    }

    cell.classList.remove('saving');
    cell.classList.add('saved');
    setTimeout(() => cell.classList.remove('saved'), 900);
  } catch (failure) {
    cell.classList.remove('saving');
    cell.classList.add('bad');
    toastError(failure.message);
  }
});

async function publish() {
  const items = state.batch.items.filter((i) => i.selected);

  const sure = await confirmAction({
    title: `Publish ${items.length} FMR${items.length === 1 ? '' : 's'}?`,
    lede: state.batch.sourceName,
    body: `<p class="dim">The crews will see ${items.length === 1 ? 'it' : 'them'}
           immediately and can start pulling material. Publishing cannot be undone —
           a mistake afterwards has to be corrected on the ledger.</p>`,
    confirmLabel: 'Publish'
  });
  if (!sure) return;

  const button = $('publish');
  button.disabled = true;
  button.textContent = 'Publishing…';

  try {
    const result = await api('/api/import/publish', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey() },
      body: JSON.stringify({
        batchId: state.batch.id,
        itemIds: items.map((i) => i.id)
      })
    });

    toast(`Published ${result.count} FMR${result.count === 1 ? '' : 's'}.`);
    renderPublished(result.count);
  } catch (failure) {
    toastError(failure.message);
    button.disabled = false;
    updatePublishBar();
  }
}

/** Say what happened, and offer somewhere to go, rather than a bare drop zone. */
function renderPublished(count) {
  state.batch = null;
  state.extraction = null;

  $('view').innerHTML = `
    <div class="empty">
      <h2>${count} FMR${count === 1 ? '' : 's'} published</h2>
      <p>They are live. The crews can search for this material now.</p>
      <div style="display:flex;gap:var(--s-3);justify-content:center;margin-top:var(--s-4)">
        <a class="btn btn-primary" href="/admin.html">See the register</a>
        <button type="button" class="btn btn-quiet" id="again">Import another</button>
      </div>
    </div>`;

  $('again').onclick = () => renderDrop();
}

await initShell({
  current: 'import',
  onProjectChange: async () => {
    // A staged batch belongs to the project it was uploaded against, so
    // switching projects abandons the review. Ask before it disappears, and
    // refuse the switch if the answer is no.
    if (state.batch) {
      const sure = await confirmAction({
        title: 'Leave this review?',
        lede: state.batch.sourceName,
        body: '<p class="dim">The file stays staged on the other project, but this ' +
              'page has no way back to it. You would need to upload it again.</p>',
        confirmLabel: 'Leave it',
        danger: true
      });
      if (!sure) return false;
    }
    // A package still being read belongs to the project it was sent to. Stop
    // asking after it, or the next poll reports "not found" against the new
    // project and reads as an error the user caused.
    clearInterval(state.polling);
    state.polling = null;
    state.batch = null;
    state.extraction = null;
    await loadProfiles();
    renderDrop();
  }
});

if (!refuseUnless('ownerEdit', { what: 'Importing' })) {
  await loadProfiles();
  renderDrop();
}
