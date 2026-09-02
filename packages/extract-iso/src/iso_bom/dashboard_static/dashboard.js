const state = { timer: null, data: null };
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const workflowLabels = { pipe_footage: "Pipe Footage", fmr: "FMR", mto: "MTO", bolt_gasket: "Bolt & Gasket" };
const scopeLabels = { combined: "Combined", "bolts-gaskets": "Bolts & Gaskets" };

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
function formatNumber(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function formatFeet(value) { return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 3 }).format(Number(value || 0))} LF`; }
function formatDuration(value, available = true, unavailableLabel = "Not measured") {
  if (!available || value === null || value === undefined || value === "") return unavailableLabel;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return unavailableLabel;
  if (seconds < 10) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(seconds)}s`;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}
function statusLabel(value) { return String(value || "unknown").replaceAll("_", " "); }
function statusChip(value) { return `<span class="status-chip status-${escapeHtml(value)}">${escapeHtml(statusLabel(value))}</span>`; }
function toast(message) { const node = byId("toast"); node.textContent = message; node.hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { node.hidden = true; }, 3500); }

function filterQuery() {
  const params = new URLSearchParams();
  const mapping = { q: "search", workflow: "workflow", status: "status", cwa: "cwa", mto_scope: "mto-scope", date_from: "date-from", date_to: "date-to" };
  Object.entries(mapping).forEach(([key, id]) => { const value = byId(id).value.trim(); if (value) params.set(key, value); });
  return params.toString();
}

async function loadDashboard() {
  const response = await fetch(`/api/dashboard?${filterQuery()}`);
  if (!response.ok) throw new Error("Dashboard data could not be loaded.");
  const data = await response.json();
  state.data = data;
  renderDashboard(data);
}

function renderDashboard(data) {
  const overview = data.overview;
  byId("kpi-packages").textContent = formatNumber(overview.packages);
  byId("kpi-runs").textContent = formatNumber(overview.runs);
  byId("kpi-isos").textContent = formatNumber(overview.isos);
  byId("kpi-time-saved").textContent = formatDuration(overview.estimated_time_saved_seconds, overview.time_estimate_available);
  byId("kpi-processing").textContent = formatDuration(overview.processing_seconds, overview.processing_available, "Not recorded");
  byId("kpi-pipe").textContent = formatFeet(overview.pipe_footage);
  byId("kpi-fmr").textContent = formatNumber(overview.fmr_sheets);
  byId("kpi-materials").textContent = formatNumber(overview.accepted_records);
  byId("kpi-cwas").textContent = formatNumber(overview.cwas);
  byId("kpi-mto-rows").textContent = formatNumber(overview.mto_rows);
  byId("kpi-partial-rows").textContent = formatNumber(overview.partial_rows);
  byId("kpi-reviews").textContent = formatNumber(overview.outstanding_reviews);
  fillOptions("workflow", data.filters.workflows, "All workflows");
  fillOptions("status", data.filters.statuses.map((value) => ({ value, label: statusLabel(value) })), "All statuses");
  fillOptions("cwa", data.filters.cwas.map((value) => ({ value, label: value })), "All CWAs");
  fillOptions("mto-scope", data.filters.mto_scopes.map((value) => ({ value, label: scopeLabels[value] || value })), "All MTO scopes");
  renderPipeChart(data.charts.pipe_by_package);
  renderTimeChart(data.charts.time_saved_by_package);
  renderTrend(data.charts.trend, data.charts.status);
  renderPackages(data.packages);
  renderMtoRegister(data.mto_register);
}

function renderTimeChart(rows) {
  const node = byId("time-chart");
  if (!rows.length) { node.innerHTML = '<div class="loading">Time savings are not measured for this view.</div>'; return; }
  const shown = rows.slice(0, 7); const max = Math.max(...shown.map((row) => Number(row.value)), 1);
  node.innerHTML = shown.map((row) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><span class="bar-track"><span class="bar-fill time-fill" style="width:${Math.max(1, Number(row.value) / max * 100)}%"></span></span><span class="bar-value">${escapeHtml(formatDuration(row.value))}</span></div>`).join("");
}

function fillOptions(id, options, placeholder) {
  const select = byId(id); const selected = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  options.forEach((item) => select.add(new Option(item.label, item.value)));
  select.value = selected;
}

function renderPipeChart(rows) {
  const node = byId("pipe-chart");
  if (!rows.length) { node.innerHTML = '<div class="loading">No pipe-footage totals in this view.</div>'; return; }
  const shown = rows.slice(0, 7); const max = Math.max(...shown.map((row) => Number(row.value)), 1);
  node.innerHTML = shown.map((row) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(1, Number(row.value) / max * 100)}%"></span></span><span class="bar-value">${escapeHtml(formatFeet(row.value))}</span></div>`).join("");
}

function renderTrend(rows, statuses) {
  const chart = byId("trend-chart");
  if (!rows.length) { chart.innerHTML = '<div class="loading">No run history in this view.</div>'; }
  else {
    const max = Math.max(...rows.map((row) => Number(row.value)), 1);
    chart.innerHTML = rows.slice(-14).map((row) => `<div class="trend-column" title="${escapeHtml(row.label)}: ${escapeHtml(row.value)} runs"><span class="trend-bar" style="height:${Math.max(4, Number(row.value) / max * 100)}%"></span><span class="trend-label">${escapeHtml(row.label.slice(5))}</span></div>`).join("");
  }
  byId("status-legend").innerHTML = statuses.map((item) => `<span class="legend-item"><span class="legend-dot status-${escapeHtml(item.label)}"></span>${escapeHtml(statusLabel(item.label))}: <strong>${escapeHtml(item.value)}</strong></span>`).join("");
}

function renderPackages(rows) {
  byId("result-count").textContent = `${rows.length} ${rows.length === 1 ? "package" : "packages"}`;
  byId("empty-state").hidden = rows.length > 0;
  byId("package-rows").innerHTML = rows.map((row) => {
    const key = row.package_number || "__standalone__";
    const workflows = row.workflows.map((value) => `<span class="workflow-chip">${escapeHtml(workflowLabels[value] || value)}</span>`).join("");
    const scopes = row.mto_scopes.map((value) => `<span class="scope-chip">${escapeHtml(scopeLabels[value] || value)}</span>`).join("") || "—";
    return `<tr><td><button class="package-link" type="button" data-package="${escapeHtml(key)}">${escapeHtml(row.display_package)}</button><div class="run-meta">${escapeHtml(row.run_count)} runs</div></td><td>${escapeHtml(row.cwas.join(", ") || "—")}</td><td>${statusChip(row.latest_status)}</td><td><div class="workflow-stack">${workflows}</div></td><td><div class="workflow-stack">${scopes}</div></td><td class="numeric">${escapeHtml(row.iso_count)}</td><td class="numeric time-value">${escapeHtml(formatDuration(row.estimated_time_saved_seconds, row.time_estimate_available))}</td><td class="numeric">${escapeHtml(formatFeet(row.pipe_footage))}</td><td class="numeric">${escapeHtml(row.fmr_count)}</td><td class="numeric ${row.issue_count ? "issue-number" : ""}">${escapeHtml(row.issue_count)}</td><td>${escapeHtml(formatDate(row.last_run))}</td></tr>`;
  }).join("");
  document.querySelectorAll(".package-link").forEach((button) => button.addEventListener("click", () => openPackage(button.dataset.package)));
}

function renderMtoRegister(rows) {
  byId("mto-result-count").textContent = `${rows.length} ${rows.length === 1 ? "MTO" : "MTOs"}`;
  byId("mto-empty-state").hidden = rows.length > 0;
  byId("mto-rows").innerHTML = rows.map((row) => {
    const workbook = row.workbook && row.workbook.exists_flag
      ? `<a class="artifact-link" href="/artifact/${escapeHtml(row.workbook.id)}">${escapeHtml(row.workbook.name)}</a>`
      : '<span class="run-meta">Unavailable</span>';
    const packageButton = row.package_number
      ? `<button class="package-link mto-package-link" type="button" data-package="${escapeHtml(row.package_number)}">${escapeHtml(row.package_number)}</button>`
      : "—";
    return `<tr><td>${escapeHtml(row.cwa || "—")}</td><td>${packageButton}</td><td><span class="scope-chip">${escapeHtml(scopeLabels[row.mto_scope] || row.mto_scope)}</span></td><td class="numeric">${escapeHtml(row.selected_iso_count)}</td><td class="numeric">${escapeHtml(row.mto_rows)}</td><td class="numeric ${row.partial_rows ? "issue-number" : ""}">${escapeHtml(row.partial_rows)}</td><td>${escapeHtml(formatDate(row.generated_at))}</td><td>${statusChip(row.status)}</td><td>${workbook}</td></tr>`;
  }).join("");
  document.querySelectorAll(".mto-package-link").forEach((button) => button.addEventListener("click", () => openPackage(button.dataset.package)));
}

async function openPackage(packageNumber) {
  const panel = byId("detail-panel"); const backdrop = byId("detail-backdrop");
  backdrop.hidden = false; panel.classList.add("open"); panel.setAttribute("aria-hidden", "false");
  byId("detail-content").innerHTML = '<div class="loading">Loading package history…</div>';
  try {
    const response = await fetch(`/api/package?number=${encodeURIComponent(packageNumber)}`);
    if (!response.ok) throw new Error("Package detail could not be loaded.");
    renderPackageDetail(await response.json());
    byId("detail-close").focus();
  } catch (error) { byId("detail-content").textContent = error.message; }
}

function renderPackageDetail(data) {
  byId("detail-title").textContent = data.display_package;
  const allIsos = new Set(data.runs.flatMap((run) => run.isos.map((iso) => iso.drawing_number)));
  const artifacts = data.runs.reduce((sum, run) => sum + run.artifacts.length, 0);
  const issues = data.runs.reduce((sum, run) => sum + run.issues.length, 0);
  const currentRuns = data.runs.filter((run) => run.is_current && run.time_estimate_available);
  const currentSaved = currentRuns.reduce((sum, run) => sum + Number(run.estimated_time_saved_seconds || 0), 0);
  let html = `<div class="detail-summary"><div class="detail-stat"><span>Runs</span><strong>${data.runs.length}</strong></div><div class="detail-stat"><span>ISO drawings</span><strong>${allIsos.size}</strong></div><div class="detail-stat"><span>Current time saved</span><strong>${escapeHtml(formatDuration(currentSaved, currentRuns.length > 0))}</strong></div><div class="detail-stat"><span>Artifacts</span><strong>${artifacts}</strong></div><div class="detail-stat"><span>Review items</span><strong>${issues}</strong></div></div>`;
  html += data.runs.map((run) => renderRun(run)).join("");
  byId("detail-content").innerHTML = html || '<div class="loading">No run history is available.</div>';
}

function renderRun(run) {
  const current = run.is_current ? '<span class="current-label">Current result</span>' : "";
  const isoRows = run.isos.length ? `<div class="table-scroll"><table class="mini-table"><thead><tr><th>ISO drawing</th><th>Rev</th><th>Rows</th><th>Partial</th><th>Scope</th><th>Linear feet</th><th>Status</th></tr></thead><tbody>${run.isos.map((iso) => `<tr><td>${escapeHtml(iso.drawing_number)}</td><td>${escapeHtml(iso.revision || "—")}</td><td class="numeric">${escapeHtml(iso.material_rows)}</td><td class="numeric">${escapeHtml(iso.partial_rows)}</td><td>${escapeHtml(run.workflow === "mto" ? (scopeLabels[run.mto_scope] || run.mto_scope) : "—")}</td><td>${escapeHtml(iso.linear_feet ? formatFeet(iso.linear_feet) : "—")}</td><td>${escapeHtml(statusLabel(iso.status))}</td></tr>`).join("")}</tbody></table></div>` : '<div class="run-meta">No ISO identities recorded for this run.</div>';
  const artifactLinks = run.artifacts.length ? run.artifacts.map((artifact) => artifact.exists_flag ? `<a class="artifact-link" href="/artifact/${artifact.id}">${escapeHtml(artifact.name)}</a>` : `<span class="artifact-link artifact-missing" title="File is no longer present">${escapeHtml(artifact.name)}</span>`).join("") : '<span class="run-meta">No artifacts recorded.</span>';
  const issueList = run.issues.length ? `<ul class="issue-list">${run.issues.map((issue) => `<li>${escapeHtml(issue.drawing_number || issue.source_path || "Package")} ${issue.page ? `(page ${escapeHtml(issue.page)})` : ""}: ${escapeHtml(issue.reason_detail || issue.reason_code)}</li>`).join("")}</ul>` : '<span class="run-meta">No review items.</span>';
  const identity = [run.cwa ? `CWA ${run.cwa}` : "", run.workflow === "mto" ? (scopeLabels[run.mto_scope] || run.mto_scope) : ""].filter(Boolean).join(" · ");
  return `<article class="run-card"><div class="run-header"><div><div class="run-title">${escapeHtml(run.workflow_label)} ${statusChip(run.status)}</div><div class="run-meta">${escapeHtml(formatDate(run.generated_at))}${identity ? ` · ${escapeHtml(identity)}` : ""}</div></div>${current}</div>${renderRunTiming(run)}<div class="run-section"><h3>ISO drawings</h3>${isoRows}</div><div class="run-section"><h3>Created artifacts</h3><div class="artifact-list">${artifactLinks}</div></div><div class="run-section"><h3>Review items</h3>${issueList}</div></article>`;
}

function renderRunTiming(run) {
  const breakdown = run.time_saved_breakdown || {};
  const saved = formatDuration(run.estimated_time_saved_seconds, run.time_estimate_available);
  const processing = formatDuration(run.processing_seconds, run.processing_seconds !== null && run.processing_seconds !== "", "Not recorded");
  let details = "";
  if (run.workflow === "fmr" && run.time_estimate_available) {
    details = `${formatNumber(breakdown.selected_iso_count)} ISOs · ${formatNumber(breakdown.normal_material_rows)} normal rows · ${formatNumber(breakdown.overflow_material_rows)} overflow rows`;
  } else if (run.workflow === "pipe_footage" && run.time_estimate_available) {
    details = `${formatNumber(breakdown.selected_iso_count)} selected ISOs · 8 seconds per ISO`;
  } else {
    details = ["bolt_gasket", "mto"].includes(run.workflow) ? "Manual benchmark not measured" : "Estimate withheld for this run status or missing evidence";
  }
  return `<div class="run-section timing-section"><h3>Efficiency estimate</h3><div class="timing-grid"><div><span>Estimated time saved</span><strong>${escapeHtml(saved)}</strong></div><div><span>Processing time</span><strong>${escapeHtml(processing)}</strong></div></div><p class="timing-detail">${escapeHtml(details)}</p><p class="run-meta">Model: ${escapeHtml(run.time_model_version || "Not measured")}. Download, command preparation, and final review excluded.</p></div>`;
}

function closeDetail() {
  byId("detail-panel").classList.remove("open"); byId("detail-panel").setAttribute("aria-hidden", "true"); byId("detail-backdrop").hidden = true;
}

async function refreshOutputs() {
  const button = byId("refresh-button"); button.disabled = true; button.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" }); const result = await response.json();
    if (!response.ok) throw new Error("Refresh failed.");
    await loadDashboard(); toast(`Refresh complete: ${result.indexed} runs indexed${result.errors.length ? `, ${result.errors.length} warnings` : ""}.`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "Refresh outputs"; }
}

function scheduleLoad() { clearTimeout(state.timer); state.timer = setTimeout(() => loadDashboard().catch((error) => toast(error.message)), 220); }

document.addEventListener("DOMContentLoaded", () => {
  ["workflow", "status", "cwa", "mto-scope", "date-from", "date-to"].forEach((id) => byId(id).addEventListener("change", scheduleLoad));
  byId("search").addEventListener("input", scheduleLoad);
  byId("clear-filters").addEventListener("click", () => { ["search", "workflow", "status", "cwa", "mto-scope", "date-from", "date-to"].forEach((id) => { byId(id).value = ""; }); scheduleLoad(); });
  byId("refresh-button").addEventListener("click", refreshOutputs);
  byId("detail-close").addEventListener("click", closeDetail); byId("detail-backdrop").addEventListener("click", closeDetail);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDetail(); });
  loadDashboard().catch((error) => toast(error.message));
});
