# Fix: Tickets tab sidebar shows "Unassigned" for tickets that are actually assigned

## Goal

In the Tickets tab (Planning panel), every ticket row in the sidebar list shows **"Unassigned"**, even when the ticket has a real assignee. Concrete repro: `/Users/patrickvuleta/Documents/Gitlab/.switchboard/tickets/clickup/tech-team/q3-2026/sprint-1-296-127/clickup_86d325mw7_ios-keyword-field-optimisation.md` is assigned to *patrick*. Clicking **Assign** opens a modal that correctly pre-checks *patrick* — but the sidebar row for the same ticket says "Unassigned".

Make the sidebar row show the ticket's real assignee(s), consistent with what the Assign modal shows.

### Problem analysis & root cause

The sidebar list and the Assign modal read assignees from **two different data sources**:

- **Assign modal (correct):** reads `selectedClickUpIssue.task.assignees` (ClickUp) / `selectedLinearIssue.issue.assignee` (Linear). Those objects are populated by the **live API detail fetch** — `clickupTaskDetailsLoaded` → `_mapClickUpTaskToSidebar` carries `assignees: task.assignees || []` straight from the ClickUp API (`src/services/PlanningPanelProvider.ts:2535`, `:5392`). So the modal has real assignee data.
- **Sidebar list (broken):** the sidebar is **file-backed** — built from the local ticket `.md` files, not the live API. The chain is:
  1. **Import writers never persist the assignee into the ticket file.** `_buildClickUpImportPlanContent` writes frontmatter with `created` / `status` / `statusType` / `listId` / `parentId` only (`src/services/TaskViewerProvider.ts:6115-6122`). `_buildLinearImportPlanContent` writes `created` / `status` / `statusType` / `projectId` / `projectName` / `parentId` only (`src/services/TaskViewerProvider.ts:5845-5853`). Neither writes an assignee field. (The example file's frontmatter confirms this — it has `created`, `status`, `statusType`, `listId` and nothing else.)
  2. **The list emitter can't read what was never written.** `listLocalTicketFiles` parses the frontmatter (`src/services/PlanningPanelProvider.ts:6336-6353`) and emits `{ id, title, status, filePath, lastSyncedAt, syncStatus, url, dateCreated }` (`:6375-6384`) — no assignee field. The fallback file-scan path `_scanLocalTicketFiles` (`:9425-9440`) is the same.
  3. **The webview then hardcodes empty.** `localTicketFilesListed` builds `clickUpProjectIssues` with a literal `assignees: []` (`src/webview/planning.js:5171`) and `linearProjectIssues` with `assignee: null` (`:5181`).
  4. **The render therefore always falls through to "Unassigned".** ClickUp row: `task.assignees && task.assignees.length ? … : 'Unassigned'` (`src/webview/planning.js:9843`). Linear row: `issue.assignee?.name || issue.assignee?.email || 'Unassigned'` (`:9871`).

Note there is a *separate, unrelated* legacy writer (`src/services/ClickUpSyncService.ts:3159,3175`) that emits `> **Assignees:** …` as a **body blockquote** in a non-frontmatter file format. That path does not feed the file-backed sidebar (the sidebar parses `---`-delimited frontmatter) and nothing parses that blockquote back, so it is not the source of truth here and is left untouched.

**Root cause:** a data-source gap, not a field-name or ID-resolution bug. The assignee is available at import time but is never written to the ticket file, never parsed, and is hardcoded to empty in the webview. Fix = thread the assignee end-to-end through the file-backed path: **write it at import → parse it in the list emitters → stop hardcoding it in the webview.**

### Verified during this review (grounds the fix location)

- **The sidebar is unconditionally files-only.** The live-fetch handlers set live tasks then immediately re-load from files: `clickupProjectLoaded` does `clickUpProjectIssues = msg.tasks` (`planning.js:6029`) then calls `loadLocalTicketFiles()` (`:6059`); `linearProjectLoaded` does the same (`:5741`, then `:5774`). The explicit comment at `:6056` — *"Render sidebar from local files in both modes (files only, not raw API)"* — confirms the live snapshot is intentionally superseded. So threading assignees through files reaches the **actual** stable render path; it is not a decoy that a live snapshot would mask.
- **The two import-writer functions the fix targets cover every import path.** The bulk-list writer `_writeTaskDocument` (`TaskViewerProvider.ts:20599`) delegates to `_buildLinearImportPlanContent` (`:20617`) and `_buildClickUpImportPlanContent` (`:20623`); the single-task `importTaskAsDocument` path calls the same builders (`:6029`, `:6053`, `:20323`, `:20623`). Editing the two builders fixes both paths at once.
- **The assignee is genuinely present at import time on the bulk path.** ClickUp bulk tasks are normalised through `_normalizeClickUpTask`, which populates `assignees: [{ id, username, email }]` (`ClickUpSyncService.ts:785-790`); Linear bulk issues come from `queryIssues`, whose GraphQL selects `assignee { id name email }` (`LinearSyncService.ts:945`, `:1017`) and normalises to `{ id, name, email }` (`:376-380`). So `task.assignees` / `issue.assignee` are non-empty for assigned tickets even on the bulk import — the write will capture real data.

## Metadata

- **Tags:** bugfix, frontend, backend, ui
- **Complexity:** 4/10
- **Affected files:** `src/services/TaskViewerProvider.ts`, `src/services/PlanningPanelProvider.ts`, `src/webview/planning.js`
- **Provider scope:** ClickUp (reported) + Linear (identical defect, fixed in the same change for parity)

## User Review Required

- **None.** The provider-agnostic frontmatter key, the comma-joined encoding, and the two-provider parity are all forced by the existing pipeline (regex frontmatter parser, shared render helpers) — there is no open product decision. The one behavioural nuance the user should simply be *aware* of (not decide) is that pre-existing ticket files heal on **Refetch**, not on an ordinary list re-select — see the Edge-Case audit.

## Complexity Audit

### Routine
- A four-touchpoint data-threading fix along one already-understood pipeline: import-write → frontmatter-parse → webview-map → render.
- Reuses the exact pattern already used for `status`, `statusType`, `parentId`, and `created` (each is written to frontmatter at import and regex-parsed back in both list emitters).
- No new services, no schema/DB changes, no new message types, no new settings, no confirm dialogs — nothing touches the CLAUDE.md hot rules.
- The two import-writer edits are made in the shared builders (`_buildClickUpImportPlanContent`/`_buildLinearImportPlanContent`), so single-task and bulk-list imports are fixed by the same change.

### Complex / Risky
- **None** in terms of code risk. The only subtlety is *reasoning* about how already-imported files heal (delta pull vs. full Refetch) — documented in the Edge-Case audit. It changes verification instructions, not implementation, and carries no data-loss risk (assignees are display-only derived data whose source of truth is the remote API).

## Edge-Case & Dependency Audit

**Race Conditions**
- None introduced. The write happens synchronously inside the import writer; the parse happens on list-emit; the webview map happens on message receipt. There is no shared mutable state across these stages, and `assignees` is declared per-iteration (see Proposed Changes), so it cannot leak between ticket rows.
- The known live-then-file overwrite (`clickUpProjectIssues = msg.tasks` at `planning.js:6029`, then `loadLocalTicketFiles()` at `:6059`) can momentarily flash the correct live assignee before the file-backed row loads. After this fix the file-backed row also carries the assignee, so the flash resolves to the *same* value instead of reverting to "Unassigned" — a strict improvement, not a new race.

**Security**
- None. Assignee display names are already surfaced in the Assign modal and the legacy blockquote; writing them into frontmatter exposes nothing new. All webview output goes through the existing `escapeHtml` in the render helpers (`planning.js:9843`, `:9871`).

**Side Effects**
- Ticket `.md` files gain one extra frontmatter line (`assignees: …`) for assigned tickets. Unassigned tickets get no line (writers only emit when there is ≥1 assignee), so their frontmatter stays byte-identical.
- The status filter, sync badges, and subtask hiding all read the *same* frontmatter block; adding a new line below the existing keys does not disturb their single-line regexes.

**Dependencies & Conflicts**
- **Two list paths must both be patched.** The DB-backed emitter (`listLocalTicketFiles`, `PlanningPanelProvider.ts:6251/6325-6386`) and the fallback file-scan (`_scanLocalTicketFiles`, `:9410-9440`) each build sidebar rows. Patch both or the fallback silently regresses to "Unassigned". (The unrelated `syncAllTickets` array at `:6495` is a push-edits helper, not a sidebar builder — leave it.)
- **Frontmatter is regex-parsed, not YAML-parsed.** The parser uses line regexes (`/^status:\s*(.+)$/m`, etc.), so the new value must live on a single line. Use a comma-joined display string (`assignees: patrick, jane`) — mirrors the existing legacy blockquote convention and parses with one regex. A display name containing a comma would split into two names (cosmetic only, no crash).
- **Linear is single-assignee; ClickUp is multi.** Use one shared frontmatter key `assignees:` for both (Linear writes a single name into it). The backend parses into a `string[]`; each provider branch in the webview adapts it to its own render shape (`assignees: [{username}]` for ClickUp, `assignee: {name}` for Linear). This keeps the backend parser provider-agnostic.
- **Assign modal untouched.** The modal reads the live-detail object, not the file, so it stays correct and independent. This fix only aligns the sidebar to match.

- **Migration / already-imported files — the ~4,000-install concern (corrected).**

  > **Superseded:** "re-import is automatic: selecting a list always re-imports it … So the display self-heals on the next list select; no explicit migration."
  > **Reason:** An ordinary list re-select does **not** do a full re-import. The webview fires `refreshTicketsDelta` (`planning.js:6046-6052`, `:5760-5769`), and the backend does a *delta* pull once a per-list cursor exists (`PlanningPanelProvider.ts:6012-6034`): ClickUp fetches only `dateUpdatedGt: deltaSince` tasks (`TaskViewerProvider.ts:20691`) and Linear only `updatedAfter` issues (`:20721`). Unchanged tickets are never re-fetched and their files are **not** rewritten, so a legacy file keeps its assignee-less frontmatter indefinitely — the reported ticket `86d325mw7`, if unchanged, would still show "Unassigned" after this fix on a normal re-select. The cited comment at `PlanningPanelProvider.ts:6370-6373` ("always re-imported on select") describes the *scoping/first-open* behaviour, not the delta-mode steady state.
  > **Replaced with:** Fresh imports (first-ever open of a list — no cursor yet → full import + prune, `PlanningPanelProvider.ts:6013-6014`) get the new `assignees:` frontmatter automatically. Already-imported files heal via any of: **(a)** the **Refetch** button, which sends `forceFull: true` and bypasses the delta cursor to rewrite every file (`planning.js:8915-8942` → `PlanningPanelProvider.ts:6027` `forceFull`); **(b)** switching the status filter to a closed status (also forces a full pull, `:6019-6027`); or **(c)** the ticket being updated on the remote (delta then picks it up). There is still **no data loss** and no `*.migrated.bak` need — assignees are display-only derived data whose source of truth is the remote API; a legacy file merely shows "Unassigned" until one of those heal paths runs. Verification steps 1 and 5 below use **Refetch** (or a never-before-imported list) so the fix is exercised deterministically rather than relying on delta chance.

## Dependencies

- None. This is a self-contained fix with no dependency on any other in-flight plan/session.

## Adversarial Synthesis

Key risks: (1) missing one of the two list-emit paths, silently regressing the fallback to "Unassigned"; (2) over-promising instant self-heal for the ~4,000-install base when a delta re-select does not rewrite unchanged files. Mitigations: patch both `listLocalTicketFiles` and `_scanLocalTicketFiles`, and document the **Refetch** (`forceFull`) heal path in verification rather than assuming re-select suffices. Residual risk is cosmetic only (a display name containing a comma splits into two) — no data loss, since assignees are display-only derived data sourced from the remote API.

## Proposed Changes

> The two builders below are the shared writers for **all** import paths — the bulk-list writer `_writeTaskDocument` (`TaskViewerProvider.ts:20599`) delegates to them (`:20617`, `:20623`), and the single-task `importTaskAsDocument` path calls them directly. Editing them once fixes both.

### 1. `src/services/TaskViewerProvider.ts` — write the assignee into ticket frontmatter at import

**ClickUp — `_buildClickUpImportPlanContent`** (around `:6115-6122`). After the existing `parentId` push, add an `assignees` line built from the task's assignees (defensive against shape/missing fields):

```js
if (task?.parentId) { fmLines.push(`parentId: ${String(task.parentId).trim()}`); }
// Persist assignee display names so the file-backed sidebar can show them
// without re-hitting the API (the Assign modal uses the live detail fetch).
const cuAssignees = Array.isArray(task?.assignees)
    ? task.assignees.map((a) => String(a?.username || a?.email || '').trim()).filter(Boolean)
    : [];
if (cuAssignees.length) { fmLines.push(`assignees: ${cuAssignees.join(', ')}`); }
fmLines.push('---', '');
```

**Linear — `_buildLinearImportPlanContent`** (after the existing `parentId` push at `:5852`). Add the same `assignees:` key (single name):

```js
if ((issue as any)?.parentId) { fmLines.push(`parentId: ${String((issue as any).parentId).trim()}`); }
const lnAssignee = String(issue?.assignee?.name || issue?.assignee?.email || '').trim();
if (lnAssignee) { fmLines.push(`assignees: ${lnAssignee}`); }
fmLines.push('---', '');
```

> Assignee property shapes are confirmed: ClickUp normalised tasks expose `assignees: [{ id, username, email }]` (`ClickUpSyncService.ts:785-790`); Linear issues expose `assignee: { id, name, email } | null` (`LinearSyncService.ts:59`, populated by the GraphQL select at `:945`/`:1017`). The `||`-fallback + `filter(Boolean)` above tolerates missing fields.

### 2. `src/services/PlanningPanelProvider.ts` — parse & emit assignees in both list paths

**DB-backed emitter — `listLocalTicketFiles`.** In the frontmatter-parse block (alongside the `created:` parse at `:6351`), add:

```js
const cm = fm[1].match(/^created:\s*(.+)$/m);
if (cm) { dateCreated = cm[1].trim(); }
const am = fm[1].match(/^assignees:\s*(.+)$/m);
if (am) { assignees = am[1].split(',').map(s => s.trim()).filter(Boolean); }
```

Declare `let assignees: string[] = [];` next to the other per-iteration `let` locals (near `:6327-6332`, inside the `for (const dbT of dbTickets)` body so it resets each row), and include it in the pushed row (`:6375-6384`):

```js
tickets.push({
    id: dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, ''),
    title: dbT.docName,
    status: clickStatus || kanbanColumn || '',
    filePath: dbT.filePath,
    lastSyncedAt: dbT.lastSyncedAt,
    syncStatus,
    url: dbT.url || '',
    dateCreated,
    assignees
});
```

(The `tickets` array is `const tickets: any[]` at `:6251`, so the extra field is type-safe.)

**Fallback file-scan — `_scanLocalTicketFiles`** (around `:9425-9440`). Mirror the parse and add `assignees` to its pushed row:

```js
const cm = fm[1].match(/^created:\s*(.+)$/m); if (cm) { dateCreated = cm[1].trim(); }
const am = fm[1].match(/^assignees:\s*(.+)$/m); if (am) { assignees = am[1].split(',').map(s => s.trim()).filter(Boolean); }
```
```js
out.push({ id, title, status: kanbanColumn || '', filePath: fullPath, url: '', dateCreated, assignees });
```

(Declare `let assignees: string[] = [];` with the other locals in the per-file block, near `:9423-9424`.)

### 3. `src/webview/planning.js` — stop hardcoding empty; use the parsed value

In the `localTicketFilesListed` handler (`:5169-5188`), replace the two hardcoded literals (`assignees: []` at `:5171`, `assignee: null` at `:5181`):

```js
if (localProvider === 'clickup') {
    clickUpProjectIssues = tickets.map(t => ({
        id: t.id, title: t.title, identifier: t.id,
        status: t.status || '',
        assignees: (t.assignees || []).map(n => ({ username: n })),
        filePath: t.filePath,
        syncStatus: t.syncStatus, url: t.url,
        dateCreated: t.dateCreated
    }));
    ...
} else {
    linearProjectIssues = tickets.map(t => ({
        id: t.id, title: t.title, identifier: t.id,
        state: { name: t.status || '' },
        assignee: (t.assignees && t.assignees.length) ? { name: t.assignees[0] } : null,
        description: '', filePath: t.filePath,
        syncStatus: t.syncStatus, url: t.url,
        dateCreated: t.dateCreated
    }));
    ...
}
```

The ClickUp render (`:9843`, reads `a.username || a.email`) and the Linear render (`:9871`, reads `assignee?.name || assignee?.email`) then work unchanged.

## Verification Plan

### Automated Tests
- None added. Per session directive (SKIP TESTS), and there is no existing webview-render/import-frontmatter test harness in this repo to extend without net-new scaffolding. Verification is manual, driven through the running extension (the installed VSIX — dev does not serve from `dist/`).

### Manual Verification
1. **Fresh import shows assignee.** With the extension running, open the Tickets tab and select the ClickUp list containing `86d325mw7`. **If that list was imported before, click Refetch** (or pick a list never imported on this machine) so a full pull runs — a plain re-select is a delta pull and won't rewrite unchanged files. Open the ticket file and confirm the frontmatter now contains `assignees: patrick` (or the real username). Confirm the sidebar row shows *patrick*, not "Unassigned". Confirm the Assign modal still shows *patrick* (unchanged).
2. **Multi-assignee.** Import a ClickUp task with 2+ assignees; confirm the row shows both, comma-joined.
3. **No-assignee.** Import an unassigned ticket; confirm no `assignees:` line is written and the row shows "Unassigned".
4. **Linear parity.** Repeat step 1 for a Linear issue with an assignee (use Refetch if the project was imported before); confirm the row shows the assignee name.
5. **Heal of legacy files (corrected).** Take a ticket file imported before this change (no `assignees:` frontmatter): confirm it shows "Unassigned" initially. Then click **Refetch** (full pull) and confirm the file is rewritten with `assignees:` and the row updates. (Note: an ordinary list *re-select* is a delta pull and will **not** rewrite an unchanged legacy file — this is expected, not a bug; Refetch is the deterministic heal path.)
6. **Fallback path.** Exercise the file-scan fallback (empty DB / cache-miss branch at `PlanningPanelProvider.ts:6394`) and confirm assignees still render — the fix must live in both list paths.
7. **No regressions:** status filter dropdown, sync badges, and subtask hiding (all driven by the same frontmatter) still behave. (Compilation is out of scope per session directive SKIP COMPILATION; testing is done via the installed VSIX, not the repo's `dist/`.)

---

**Recommendation: Send to Coder** (complexity 4/10). Routine multi-touch data-threading along an existing pipeline, with one documented migration nuance (Refetch heals legacy files) and no design decisions left open.
