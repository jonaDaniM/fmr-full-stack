# FMRv3 → FMR parity audit

Every user-facing operation in the Apps Script system, and where it lives now.

The earlier audit read the function surface and reasoned about it. That method
already failed once in this project: the drawing extractor was declared working
on the strength of the 20 sample PDFs shipped inside it, and one command
against real drawings in `materialScrapper/` disproved it. So this document
records **what was looked at** for each row, and Pass 2 records **what
happened** when the rule was exercised against the running app.

Cutover is the moment a missed feature stops being a bug and becomes a crew
standing at a rack unable to work. That is what this is for.

## Sources read

| Source | What it gave |
|---|---|
| `FMRCoreV3/PublicApi.gs` | 41 RPC entry points |
| `FMRCoreV3/AdminFieldNotesService.gs:549`, `OwnerCorrectionService.gs:2137-2149`, `SizeReconciliationService.gs:1199-1204` | 7 public functions declared **outside** PublicApi.gs |
| `Bound/Adapter.gs` | 74 functions; 34 reachable from the browser |
| `Bound/OwnerMaintenanceAdapter.gs` | 13 owner-maintenance functions |
| `Bound/Client.html` (12,396 lines), `Index.html`, `OwnerMaintenance.html` | every button, tab and filter, via the `callServerV3_` RPC wrapper |

**How the browser reaches the server.** `callServerV3_` (`Client.html:266`) is
the only path. Extracting its call sites gives the operations a user can
actually trigger — 34 from `Client.html`, 14 from `OwnerMaintenance.html`. Two
findings fell straight out of that and are recorded in their rows below:
`getAdminActiveBagsV3` and `getStagingListV3` are never called by any screen,
and `getOwnerCorrectionHistoryV3` is exposed but unreferenced.

## Pass 1 — the map

Scope is what a user does. Diagnostics, contract self-tests and acceptance
fixtures are excluded by agreement and listed under **Excluded** with reasons.

### Sign-in, search and the field workflow

| FMRv3 operation | Where it lives now |
|---|---|
| `getPortalBootstrapV3` → `getFmrV3Bootstrap` (`PublicApi.gs:5`) | `GET /api/bootstrap` → `services/bootstrap.js:27` |
| `searchPortalV3` → `searchFmrV3` (`PublicApi.gs:215`) | `GET /api/search` → `services/search.js:19` |
| ISO suffix fallback `isoSuffixSearchCandidatesFmrV3_` (`PublicApi.gs:46`) | `domain/isoKey.js:29` `isoCandidates`, used at `services/search.js:35` |
| Admin register ISO normalisation (`PublicApi.gs:177`) | same `isoCandidates`, applied in `services/reporting.js:16` `getRegister` |
| `performFieldActionV3` → `performFmrV3FieldAction` (`PublicApi.gs:258`) | `POST /api/field/action` → `services/field.js:340` |
| Six field actions and their ceilings (`Client.html:2350-2436`) | `domain/ledger.js`, mirrored client-side in `lib/ceilings.js` |
| Bag tag numbering (`FieldService.gs:731`) | `services/controls.js:146` `nextBagTagNumber` |
| Field backorder notices (`FieldBackorderNoticeService.gs`) | `domain/notices.js` + `services/notices.js` |

### The office screens

| FMRv3 operation | Where it lives now |
|---|---|
| `getAdminDashboardV3` KPIs (`DashboardService.gs:9`, from `Dashboard!A4:G9`) | `GET /api/dashboard` → `services/reporting.js:156`. Computed, not read from spreadsheet formulas. |
| `getAdminFmrRegisterV3` (`PublicApi.gs:290`) | `GET /api/register` → `services/reporting.js:16`. **Gap — the register lost its search, exception filter, sorting and paging.** See finding 4. |
| `getAdminFmrDetailV3` → `getFmrV3AdminFmrDetail` (`AdminFieldNotesService.gs:549`) | `GET /api/fmr/:id` → `services/search.js:105`. **Gap — field notes missing.** See Pass 3. |
| ISO summary (`AdminIsoSummaryService.gs`) | `GET /api/iso-summary` → `services/reporting.js:96` |
| Backorder queue, part of the operational rail (`BackorderService.gs`) | `GET /api/backorders` → `services/backorderReview.js:16` |
| `reviewBackorderV3` (`PublicApi.gs:371`) | `POST /api/backorders/decide` → `services/backorderReview.js:41` |
| Active Bags tab of the operational rail (`AdminActiveBagService.gs:7`) | **Gap — no list.** `getDashboard` returns a count only. See Pass 3. |
| Line history behind the register | `GET /api/lines/:id/history` → `services/reporting.js:131` |

**On the Active Bags row.** `getAdminActiveBagsV3` (`Adapter.gs:727`) exists but
no screen calls it — the queue reaches the browser inside
`getAdminDashboardV3`'s `operationalRail.activeBags`
(`DashboardService.gs:86`), with a summary, pagination and a readiness filter,
rendered at `Client.html:5037`. So the feature is real and used even though its
dedicated RPC is dead. The new system has the count
(`reporting.js:156`) but not the list.

### Import and drafts

| FMRv3 operation | Where it lives now |
|---|---|
| `startBulkImportUploadV3` (`PublicApi.gs:768`) | `POST /api/import/stage` → `import/src/staging.js:14` |
| `startBulkImportGoogleSheetV3` (`PublicApi.gs:783`) | Excluded — no Google Sheets source. Replaced by CSV/XLSX upload and by drawing PDF extraction (`POST /api/import/drawings`), which FMRv3 had no equivalent of. |
| `getBulkImportBatchV3` / `getBulkImportItemV3` | `GET /api/import/:id` → `import/src/staging.js:167` |
| `updateBulkImportItemV3` (`PublicApi.gs:828`) | `POST /api/import/line` → `import/src/staging.js:242` |
| `applyBulkImportIsoSheetOverrideV3` (`PublicApi.gs:845`) | `POST /api/import/line` with an ISO/sheet patch — same service, no separate route |
| `stageBulkImportItemsV3` (`PublicApi.gs:866`) | `POST /api/import/publish` → `import/src/staging.js:280` |
| `getRecentBulkImportBatchesV3` (`PublicApi.gs:883`) | `GET /api/drafts` → `import/src/drafts.js:435` |
| Quantity normalisation (`BulkImportQuantityNormalization.gs`) | `import/src/normalize.js:166` |
| Size normalisation (`BulkImportSizeNormalizationAlpha30_4.gs`) | `import/src/normalize.js:60` |
| `saveStagingV3` / `getStagingWorkspaceV3` / `getStagedFmrV3` | `POST /api/drafts`, `/api/drafts/header`, `/api/drafts/line` → `import/src/drafts.js` |
| `publishStagedFmrV3` (`PublicApi.gs:528`) | `POST /api/import/publish`, gated by `GET /api/drafts/:id/check` (`drafts.js:490`) |
| `archiveStagedFmrV3` / `restoreStagedFmrV3` (`StagingArchiveService.gs`) | `POST /api/drafts/archive` → `drafts.js:329` / `drafts.js:378` |
| `getStagingListV3` (`Adapter.gs:757`) | Superseded by `GET /api/drafts`. Note the old one was **never called by a screen** either. |

### Owner and administration

| FMRv3 operation | Where it lives now |
|---|---|
| `saveSystemUserV3` (`PublicApi.gs:608`) | `POST /api/admin/members` → `services/admin.js:105` |
| `setSystemUserActiveV3` (`PublicApi.gs:623`) | `POST /api/admin/members/active` → `services/admin.js:191` |
| Last active owner cannot be removed (`MultipleOwnerSupport.gs:47`) | enforced in `services/admin.js:191` |
| `saveSystemConfigurationV3` (`PublicApi.gs:644`) — lists | `POST /api/admin/lists` → `services/admin.js:278`, `:331` |
| `getSystemControlV3` (`PublicApi.gs:593`) | `GET /api/controls` → `services/controls.js:17` |
| `TRANSACTION_MODE` read-only lock (`SystemControlService.gs`) | `services/controls.js:46,62` — `assertFieldOpen`, `assertImportOpen`, reason shown to the crew |
| `renumberFmrV3` / `renumberFmrV3ByNumber` (`PublicApi.gs:547,570`) | `POST /api/fmr/renumber` → `services/admin.js:364` |
| `searchOwnerLedgerV3` (`OwnerCorrectionService.gs:2137`) | `GET /api/lines/:id/corrections` → `services/corrections.js:23` |
| `previewOwnerCorrectionV3` (`:2141`) | `POST /api/corrections/preview` → `services/corrections.js:96` |
| `applyOwnerCorrectionV3` (`:2145`) | `POST /api/corrections/apply` → `services/corrections.js:138` |
| `getOwnerCorrectionHistoryV3` (`:2149`) | `GET /api/corrections` → `services/corrections.js:245`. The old one was exposed but **no screen called it** — the new system surfaces it on the Owner screen. |
| `runOperationalHealthV3` (`PublicApi.gs:674`) | `GET /api/project-health` → `services/controls.js:186`, plus `GET /api/integrity` → `services/integrity.js:164` |
| `getOperationsCenterV3` (`PublicApi.gs:659`) | Partly. Health and settings are the two routes above; the backup-history half is excluded (below). |
| `previewHistoricalSizeReconciliationV3` / `applyHistoricalSizeReconciliationV3` (`SizeReconciliationService.gs:1199,1204`) | Excluded, and checked rather than assumed. It repairs one historical defect: Excel turned size `3/4` into a March-4 date and Alpha 30.3 rebuilt it backwards as `4/3`. It does patch **published** lines, so it is user-facing — but the new system fixes the same mangling at import (`normalize.js:23` `fractionFromDateText`, tested at `import.test.js:46-63`), so it cannot write the corruption the tool exists to undo. Anything already wrong in Jonathan's sheet is `packages/migrate`'s problem. |

### Excluded, and why

Recorded so it is not re-litigated.

| Excluded | Why |
|---|---|
| `createFmrV3DatabaseBackup`, `previewFmrV3Recovery`, `applyFmrV3Recovery` (`PublicApi.gs:690,723,738`), `OwnerDriveAuthorization.gs`, `probeOwnerMigrationFolderV3` | Drive backup and restore. Cloud SQL does this. |
| `runFmrV3ScheduledOperations` (`:753`), `installBoundDailyOperationsV3` / `removeBoundDailyOperationsV3` (`Adapter.gs:1073,1155`) | The daily trigger's two jobs were backup and health check. Backup is Cloud SQL's; health is `GET /api/project-health`. |
| `getFmrV3AdminIsoSummaryContract`, `getFmrV3AdminDecisionContract`, `getFmrV3StagingArchiveContract`, `getFmrV3BulkImportContract` (`PublicApi.gs:335,346,501,898`) | Thin wrappers over `inspect*` self-tests — dev tooling, not user operations. |
| ~40 `verify*` / `inspect*` / `run*Diagnostic` functions across `Adapter.gs:488-3159`, `Diagnostics.gs`, `AdminAcceptanceFixtureService.gs`, `FieldAcceptanceFixtureService.gs`, `Alpha23MaintenanceDiagnostic.gs`, `ProductionPerformanceDiagnostic.gs`, `SystemuserOwnerDiagnostic.gs` | They wrote test data into the production database. `npm test` replaces them. |
| `HistoricalMigrationService.gs`, `HistoricalMigrationHardeningService.gs`, and the 6 `*HistoricalMigration*V3` adapter functions | `packages/migrate` covers the one-time load, with a dry run. |
| `configureBoundEnvironmentV3`, `activateBoundEnvironmentV3`, `inspectBoundEnvironmentV3` (`Adapter.gs:107,147,178`) | Apps Script bound-environment plumbing. No equivalent concept. |
| `Dashboard!A4:G9` spreadsheet formulas (`DashboardService.gs:14-18`) | KPIs are computed in SQL by `getDashboard`. |
| `PerformanceBatchLookupService.gs`, `IndexServiceFmr.gs`, `Repository.gs`, `StagingArchiveService.gs` index maintenance | Spreadsheet-row-index machinery. Postgres indexes replace it. |

Every row above is either mapped or excluded with a reason. No row is blank.

## Pass 2 — what happened when the rules were exercised

Every row below was run against the app on `localhost:3000`, signed in over
HTTP as a seeded user, with the ledger read back afterwards. These are
observed results, not readings of the code. The harness signs in through
`/api/auth/dev`, acts through the same routes the browser uses, and re-reads
through `/api/search`, `/api/backorders` and `/api/fmr/:id`.

| Behaviour | Where the old rule is stated | Observed |
|---|---|---|
| Six field actions and their ceilings | `Client.html:2350-2436`, `IntegrityService.gs:52` | **Agrees.** Locating 121 of 120 requested → refused, "Only 120 can be newly confirmed…". Exactly 120 → accepted, `located 120, available 120`. A further 1 → refused. Issuing 121 of 120 available → refused. `ISSUE_FROM_AVAILABLE 40` → `issued 40, available 80`. `BAG 30` → `bagged 30, available 50`, tag `BT-2026-00001`. `DIRECT_ISSUE 6` on an untouched line → `located 6, issued 6, available 0`. |
| Located = available + bagged + issued | `001_init.sql` CHECK | **Holds** through the whole sequence: `120 = 50 + 30 + 40`. |
| Pending backorders lock material | guide §4, `IntegrityService.gs:1` | **Agrees.** On a line with 80 requested and 30 pending, locating all 80 → refused, "Only 50 can be newly confirmed while pending backorders remain locked." Locating the free 50 → accepted. |
| Backorders settle when material is located | `IntegrityService.gs:588` | **Agrees.** `CONFIRM` moved 30 from pending to confirmed; locating the material then took `confirmed backorder 30 → 0` with `located 80`. |
| A partial return **splits** the request | `BackorderService.gs:542` | **Agrees.** Returning 60 of a 120 request left two rows on the line — `Returned for Review:60` and `Pending:60` — and the returned row carries `split_from_id` back to the original. A return with no note → refused. |
| Re-raising answers a returned request | `IntegrityService.gs:939` | **Agrees, with one inherited limitation** — see the finding below. On a line with spare capacity, re-raising the returned 40 revived that request (`1 request: Pending:40`, not two) and cleared the crew's notice. |
| Rejected notice settles by locating, not dismissing | `FieldBackorderNoticeService.gs:1268` | **Agrees.** Rejecting raised "40 FT rejected — source it on site" and released the lock (`pendingBackorder 0`). There is no dismiss route at all (`POST /api/notices/dismiss` → 404). Locating the 40 cleared the notice. |
| Corrections append, never edit | guide §4 | **Agrees.** History went 1 → 2 rows; the original `ISSUE_FROM_AVAILABLE 5` is still present with its original note; the ledger shows `issued 0`. |
| Last active owner cannot be removed | `MultipleOwnerSupport.gs:47` | **Agrees, via two guards.** Deactivating yourself → refused. With two owners, removing the other → allowed. A non-owner attempting it → 403. The explicit `LAST_OWNER` branch (`admin.js:222`) is defence behind those two and is not reachable through the UI. |
| Bag tag numbering | `FieldService.gs:731` | **Agrees.** Consecutive baggings took `BT-2026-00001`, `BT-2026-00002`, `BT-2026-00003`; a crew-supplied number (`MANUAL-77`) is honoured. |
| ISO+sheet search finds what FMR-number search finds | guide §6 | **Agrees.** `FMR-2026-0417` → 8 lines; `D-4410\|01` → the same 3 lines that FMR carries on that sheet; `D-4410-01` → identical; bare `D-4410` → 5 lines across both sheets. |
| Read-only / `TRANSACTION_MODE` | `SystemControlService.gs` | **Was broken. Now agrees** — see finding 1. Pausing then refuses field work with "Material movement is paused: Month-end count in progress."; lifting it lets work resume. |

### The two ceiling formulas are equivalent

FMRv3 and the new system compute the backorder ceiling differently:

```
FMRv3   max(0, min(notYetLocated, remaining) − pendingBackorder − confirmedBackorder)
new     max(0, remaining − available − bagged − pendingBackorder − confirmedBackorder)
```

Rather than reason about it, both were run over every reachable ledger state
(every combination satisfying `located = available + bagged + issued` and
`issued ≤ requested`, up to 8 units): **10,363 states, 0 disagreements.** The
port is exact.

### Findings

**1. Pausing work was impossible — every write to `/api/controls` returned 500.**
`controls.js:113` used `$1` as both a uuid (`project_id`) and `$1::text`
(`entity_id`) in one audit insert. Postgres cannot deduce a type for that and
refused the statement — `42P08`. Read-only mode is the control an owner uses to
stop the floor during a count, and it could not be turned on or off. Fixed by
casting both uses. This is the item the earlier audit listed as "already
handled", which is exactly the failure mode this audit exists to catch: the
function existed and the mapping was right, but it had never been run.

**2. Deactivating any member returned 500.** `admin.js:229` put `$3` (a uuid)
inside `CASE WHEN $2 THEN NULL ELSE $3 END`; with only the NULL to infer from,
Postgres typed it as text and the uuid column rejected it. Fixed by casting.
The sibling `$4` had the same shape — harmless only because its column happens
to be text — and was cast too.

Both were invisible to `npm test`, because the domain tests deliberately run
without a database and a statement that never parses looks like one that
works. So `scripts/check-sql.js` now reads the SQL for this class of fault and
runs as part of `npm test`; reintroducing either bug fails the suite.

**3. Inherited: a crew cannot answer a return that covers the whole line.**
When the entire requirement sits under a returned request, the crew is shown
"120 FT returned — more detail needed" and the action it asks for is refused:
"Only 0 can be submitted as a new backorder without duplicating an existing
commitment." The domain rule `planReturnedResubmission` handles this correctly,
but `applyBackorderRequest` checks the ceiling before the service reaches it.

**FMRv3 does the same thing** — `FieldService.gs:1712` throws on
`fieldNewBackorderQuantityFmrV3_` before calling
`planReturnedBackorderResubmissionFmrV3_`, with the same message. So this is
not a regression and not a parity gap; it is a pre-existing defect faithfully
carried across. **Recorded, not fixed** — the plan is explicit that a
disagreement is raised rather than silently changed, and this one is worth
Jonathan's decision because the workaround (the office re-opens the request
instead) may already be what the office does.

### Every mapped route, called

Pass 1 was written by reading code — the method this audit exists to distrust.
So every route the map names was called against the running app.

**20 read routes: all 200.** `/api/bootstrap`, `/api/search`, `/api/register`,
`/api/iso-summary`, `/api/dashboard`, `/api/backorders`, `/api/active-bags`,
`/api/notices`, `/api/corrections`, `/api/controls`, `/api/project-health`,
`/api/integrity`, `/api/drafts`, `/api/admin/members`, `/api/admin/lists`,
`/api/me`, `/api/health`, `/api/fmr/:id`, `/api/lines/:id/history`,
`/api/lines/:id/corrections`.

**Every write route: all answered.** This mattered more than the reads — both
500s the audit found were writes whose read side worked perfectly, so a route
that has only ever been read is a route that has not been checked. The nine
Pass 2 had not touched were exercised too:

| Write | ← FMRv3 | Observed |
|---|---|---|
| `POST /api/admin/lists` | `saveFmrV3SystemConfiguration` | value added and readable back |
| `POST /api/drafts` | `saveStagingV3` | draft created, validated |
| `POST /api/drafts/header` | staging header edit | 200 |
| `POST /api/drafts/line` | staging line edit | line added |
| `DELETE /api/drafts/line` | staging line removal | line removed |
| `GET /api/drafts/:id/check` | the publish gate | reports issues and `canPublish` |
| `POST /api/import/publish` | `publishStagedFmrV3` | draft published to the register |
| `POST /api/drafts/archive` | `archiveStagedFmrV3` | archived with a reason |
| `POST /api/fmr/renumber` | `renumberFmrV3` | `FMR-2026-9001` → `FMR-2026-9002`, register follows |
| `POST /api/integrity/repair` | `IntegrityService` | `{repaired: 0}` on a clean ledger |
| `POST /api/auth/signout` | session | 200 |

No further defects found. The publish gate correctly refuses a draft with
unresolved errors (`HAS_ERRORS`), which is what `checkDraftForPublish` is for.

### The SQL checker covers the migration too

`scripts/check-sql.js` originally read only `packages/core`, `packages/import`
and `packages/api`. `packages/migrate` and `db/seed` also hold SQL, and the
migration is the code that runs once, against Jonathan's real spreadsheet, at
cutover — the worst place to discover a statement that will not parse. Both are
now in scope. Neither had a fault.

**4. The FMR register lost most of its controls.** This is the one thing a
user could do in FMRv3 and cannot do here.

FMRv3's register (`Index.html:140-245`) carried six controls. The new one
(`admin.js` `renderRegister`) calls `/api/register` with no parameters at all
and renders every FMR in a fixed order:

| FMRv3 control | Now |
|---|---|
| Text search, typed as `AUTO` / `FMR` / `ISO` / **`IWP`** | **absent** — `?q=` is ignored |
| Status filter | present (`?status=`) |
| Priority filter | present (`?priority=`) |
| Exception filter — `HAS_REMAINING`, `NOT_FULLY_LOCATED`, `HAS_AVAILABLE`, `HAS_BAGGED`, `PENDING_BACKORDER`, `CONFIRMED_BACKORDER` | **absent** |
| Sort — `LAST_ACTIVITY`, `DATE_REQUIRED`, `FMR_NUMBER`, `REMAINING`, `FULFILLMENT`, `REQUESTED`, either direction | **absent** — order is fixed |
| Paging, 25 a page | **absent** — the whole register is sent |

Observed: `?q=`, `?exception=`, `?sort=` and `?page=` all change nothing.

**IWP is the sharpest loss.** `GET /api/register` returns `iwpNumber`, and
`/api/search` does not match on it — searching a real IWP number returns 0
results. An IWP is how a planner refers to a package of work, so "show me
everything for IWP-88-014" is a question the old system answered and this one
cannot, from any screen.

Scale is what makes this matter rather than a nicety: `outputs.zip` holds 660
generated workbooks. A register that renders every FMR unsorted, unsearchable
and unpaged is usable against the 1-FMR seed and not against a real job.

Not fixed here: the audit's remit was to find what is missing, and this is a
screen's worth of work — a query with search, exception and sort parameters,
plus the controls to drive it — not a defect to patch in passing. It is the
first thing to build before cutover.

## Pass 3 — the two gaps, closed

Both additive: no schema change, no domain rule touched.

### Field notes on the FMR drill-down

`getFmrDetail` (`services/search.js`) now carries a `fieldNotes` block per
line, and `admin.js` renders it under the material description in the existing
dialog.

Two sources are merged, as `AdminFieldNotesService.gs:340` did: what the crew
typed on a movement transaction, and the note they wrote raising a backorder.
Newest first, capped at 20 per line with a `truncated` flag so one heavily
annotated line cannot bury the rest of the FMR.

One detail worth keeping: the transaction query filters to the five *movement*
actions and excludes `BACKORDER_REQUESTED`. Raising a backorder writes the same
note to both the transaction and the request, so without that filter the office
sees the same sentence twice — the first implementation did, and the duplicate
was visible in testing. FMRv3 drew the same line
(`FIELD_TRANSACTION_TYPES`, `AdminFieldNotesService.gs:6`).

Observed, in the browser, opening FMR-2026-0417 from Office → Register:

```
Backorder Request 60 FT   Rack 12 empty, checked 14 as well. Nothing on site.
                          Rita Alvarez · Sep 2
Bag & Tag 8 EA            Bagged with the flanges for spool 12 — hydro Monday.
                          Rita Alvarez · Sep 2
Issue Available 4 EA      Handed to Dale at the north gate.
                          Rita Alvarez · Sep 2
Backorder Request 30 FT   Checked Yard A and Conex 4, none on site.
                          Dale Hughes · Sep 2
```

A line nobody annotated returns `{count: 0, truncated: false, notes: []}` and
renders nothing.

### Active-bag queue

A tab beside Backorders on the Office screen, backed by
`getActiveBagQueue` (`services/reporting.js`) and `GET /api/active-bags`,
behind the same `adminBackorder` permission as the backorder queue — a
warehouse hand gets 403.

Oldest first, because age is the whole signal. Each row carries the tag, its
FMR and line, the drawing, what the material is, where it was put, how much is
left in it, who packed it and when. `readiness` separates a bag nobody has
touched from one drawn against and left part-full; bags older than 14 days are
marked. Search covers tag, FMR, drawing, commodity, description and location,
so the office can find a bag **without knowing its number** — which was the
point.

Observed, running the plan's own acceptance steps:

| Step | Result |
|---|---|
| Bag 7 EA of elbows into Rack 21 on the Field screen | `BT-2026-00001`, in the queue |
| Find it from Office without knowing the number — search "ELBOW" | found: `7 EA in Rack 21, bagged by Rita Alvarez` |
| Search by where it was put — "Rack 21" | found |
| Draw 3 of the 7 | stays in the queue, `Partially Issued, 4 of 7 left`, and the ready-for-field filter now excludes it |
| Issue the rest | leaves the queue |
| Dashboard count vs the list | agree |

Confirmed in Chrome as well as over HTTP: the tab renders, the filter chips and
the search work, focus stays in the search box across re-renders, and a
31-day-old bag shows "sitting a while" with the stat turning amber.

## What was deliberately not done

- The ~40 diagnostics were not re-verified or replaced.
- Drive backups, recovery and the daily trigger were not ported.
- The historical migration engine was not touched.
- No domain rule was changed. Finding 3 is recorded and raised, not fixed.
