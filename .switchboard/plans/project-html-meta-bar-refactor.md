# Fix Project.html Kanban & Epics Preview Meta Bars + Add Missing Create Epic

## Goal

Restructure the `project.html` Kanban and Epics preview meta bars to the fixed "second function row" pattern from `planning.html` (meta bar pinned outside the scrolling content), give Epics a real edit mode, and wire a working **"Create Epic"** button — including the **backend handler the original plan incorrectly assumed already existed** for this panel.

## Metadata
**Tags:** frontend, UI, UX, bugfix
**Complexity:** 7

> Tag note: the prior `refactor` / `feature` tags are not in the allowed tag list and were dropped.
> Complexity raised from 6 → 7 (Clarification, not new scope): code verification proved this work requires **extension-host (TypeScript) changes** with DB + filesystem writes, not webview-only edits as the prior draft assumed. See Complexity Audit.

## User Review Required

These decisions need a human ruling before/while coding because they change scope or contradict the original draft:

1. **Zero-subtask epics.** The existing `createEpic` handler (`KanbanProvider.ts:6684`) **hard-rejects epics with an empty `subtaskPlanIds` array** (`if (!name || subtaskPlanIds.length === 0)`). The original plan's design ("create with no subtasks, add later") is therefore **impossible against the cited handler**. The ported handler must be adapted to permit name-only epics. Confirm this is acceptable (it diverges from the kanban-board behavior, where epics are only born from ≥1 selected subtask).
2. **Backend change is mandatory.** The original plan stated "No backend changes needed." That is **false** for `project.html`. Confirm the implementer may modify `PlanningPanelProvider.ts` (port `createEpic`, adjust `saveFileContent` panel routing). If backend edits are out of scope for this ticket, the Create-Epic feature cannot ship and should be split out.
3. **Epic file location.** Real handler writes `.switchboard/plans/epic-{planId}.md` (flat), **not** `.switchboard/plans/epics/epic-{id}.md` as the draft claimed. Confirm we keep the existing flat convention (recommended — display is driven by the DB `is_epic` flag, not the path).

## Complexity Audit

### Routine
- HTML restructure of the Kanban and Epics preview panes to pin the meta bar outside the scroll region (mirrors `planning.html` `#preview-pane-tickets`, line 3260).
- CSS: tighten `#kanban-preview-meta-bar, #epic-preview-meta-bar` to the `planning.html` function-row spec (`padding: 6px 10px; gap: 12px; flex-wrap: wrap; align-items: center;`).
- Add `<textarea id="epics-editor" class="markdown-editor">` and an `epicsEditor` element handle.
- Extend `state.editMode/editOriginalContent/dirtyFlags/externalChangePending` with an `epics` key.
- Remove the now-dead static Edit/Save/Cancel buttons from `.kanban-controls-strip`.
- Add the "+ New Epic" button + modal markup to the epics `.controls-strip`.

### Complex / Risky
- **Backend port of `createEpic`** into `PlanningPanelProvider.ts` (DB write via `db.upsertPlan` + `db.updateEpicStatus`, filesystem write of the epic markdown, then `kanbanPlansReady` refresh). Data-consistency risk: DB row and on-disk file must stay in sync; mirror the existing `addSubtaskToEpic`/`deleteEpic` patterns (lines 2348–2421) and reuse `GlobalPlanWatcherService.registerPendingCreation` before writing so the file watcher does not double-import.
- **`saveFileContent` response routing** (`PlanningPanelProvider.ts:2562`): `saveDestPanel` only routes `kanban`/`constitution` to the project panel. A `tab: 'epics'` save would post its result to the wrong webview. Must add `|| tab === 'epics'`.
- **Dynamic button lifecycle**: moving Edit/Save/Cancel from static HTML into the dynamically re-rendered meta bar invalidates the captured `btnEditKanban`/`btnSaveKanban`/`btnCancelKanban` consts (`project.js:116–118`) and their one-time listeners (`project.js:960–977`). Listeners must be (re)attached inside `renderKanbanMetaBar`/`renderEpicMetaBar` on every render.

## Edge-Case & Dependency Audit

**Race Conditions**
- **File-watcher double-create**: writing the epic `.md` triggers `GlobalPlanWatcherService`. The kanban handler guards this with `registerPendingCreation(epicPath)` *before* `writeFile` (KanbanProvider.ts:6748). The port MUST replicate this ordering, or the watcher re-imports the file as a second plan.
- **External-change during epic edit**: `kanbanPlanPreviewReady` for the epics branch (`project.js:177`) currently overwrites `innerHTML` unconditionally. Once epics have edit mode, an in-flight preview response could clobber unsaved edits. Add the same guard the kanban branch uses (`if (state.editMode.epics) { state.externalChangePending.epics = true } else { ... }`).

**Security**
- `saveFileContent` already enforces workspace-root path allow-listing (`PlanningPanelProvider.ts:2575–2595`); epic saves reuse it, so no new path-traversal surface.
- Epic name/description are written into YAML frontmatter. The existing handler escapes single quotes (`name.replace(/'/g, "''")`, KanbanProvider.ts:6742–6744). The port must keep this; do not drop the YAML quoting or a name containing `:`/`---` breaks the frontmatter.
- Webview rendering already routes user strings through `escapeHtml` — reuse it for the modal and any echoed epic name.

**Side Effects**
- **CSS cascade onto Constitution**: `.kanban-preview-pane, .epics-preview-pane, .constitution-preview-pane` are a **single grouped rule** (`project.html:164`, `flex:1; overflow-y:auto; padding:16px;`). Changing kanban+epics to `display:flex; flex-direction:column;` + removing `overflow-y` MUST split this selector so the Constitution tab keeps its current behavior. (Original plan Risk #3 flagged this; this audit makes it a hard requirement.)
- `.edit-mode` rule (`project.html:186–190`) hides `#epics-preview-content` and shows `.markdown-editor` only when `.edit-mode` is on `#epics-preview-pane` — `enterEditMode('epics')` already adds the class to `${tab}-preview-pane`, so this works once `#epics-editor` exists as a child of `#epics-preview-pane`.
- Removing static strip buttons leaves `btn-import-kanban-plans`, filters, and search untouched.

**Dependencies & Conflicts**
- `enterEditMode`/`exitEditMode` (`project.js:924–958`) are already generic over `tab` and look buttons up by `btn-edit-${tab}` etc. via `getElementById`. Keep those exact IDs in the dynamic meta-bar markup (`btn-edit-kanban`, `btn-edit-epics`, …) so the existing functions keep working without rewrite.
- Save path uses message type **`saveFileContent`** with `tab` echoed back as **`saveFileContentResult`** / **`fileSaved`** (`project.js:284–297`, `PlanningPanelProvider.ts:2637`). The draft's references to `saveKanbanPlan` and `fileChanged` are **wrong** — no such handlers exist on this path.
- `createEpic` currently lives ONLY in `KanbanProvider.ts` (kanban.html's provider). `project.html` is served by `PlanningPanelProvider.ts`, which has **no** `createEpic` case. Confirmed via grep.

## Dependencies

- None — no upstream planning sessions block this work. All required handlers/patterns already exist in-repo (`PlanningPanelProvider` epic handlers at 2331–2421; `KanbanProvider.createEpic` at 6679 as the reference implementation to port).

## Adversarial Synthesis

Key risks: (1) the original "no backend changes" assumption is false — Create-Epic needs a ported `PlanningPanelProvider` handler and the `saveFileContent` epic-routing fix, or the feature silently no-ops; (2) the cited `createEpic` rejects zero-subtask epics, contradicting the draft's UX, so the port must be adapted, not copied; (3) moving Edit/Save/Cancel into a re-rendered meta bar and editing the shared 3-pane CSS rule can break Kanban edit wiring and the Constitution tab. Mitigations: port + adapt the handler mirroring sibling epic handlers (with `registerPendingCreation` before write), add `|| tab === 'epics'` to save routing, split the grouped pane selector, re-attach button listeners inside the render functions, and guard the epics preview branch against clobbering live edits.

## Proposed Changes

> The original draft's section-by-section instructions are preserved below and **corrected/annotated** where code verification contradicted them.

### `src/webview/project.html`

**Context.** Meta bars currently sit *inside* the scrolling pane (`#kanban-preview-meta-bar` at line 1016, `#epic-preview-meta-bar` at line 1049), so they scroll with content. Kanban Edit/Save/Cancel are misplaced in `.kanban-controls-strip` (lines 1002–1004). Epics pane has no editor textarea.

**Logic.** Pin the meta bar as a fixed first child of a flex-column pane; only the inner `#*-preview-content` scrolls — exactly `planning.html`'s `#preview-pane-tickets` (line 3260) + `#tickets-preview-meta-bar` (line 3261) + meta-bar CSS at lines 2813–2824.

**Implementation.**
- Kanban pane — move the meta bar to be a sibling above the scrolling content (keep it inside `.preview-panel-wrapper`):
```html
<div class="preview-panel-wrapper">
    <div class="cyber-scanlines"></div>
    <!-- Meta bar moves OUT of the scrolling pane -->
    <div id="kanban-preview-meta-bar" style="display:none;"></div>
    <div id="kanban-preview-pane" class="kanban-preview-pane">
        <div id="kanban-preview-content"></div>
        <textarea id="kanban-editor" class="markdown-editor"></textarea>
    </div>
</div>
```
- Apply the same restructuring to the **Epics** pane and **add** `<textarea id="epics-editor" class="markdown-editor"></textarea>` inside `#epics-preview-pane`.
- Remove `btn-edit-kanban`, `btn-save-kanban`, `btn-cancel-kanban` from `.kanban-controls-strip`.
- Add `<button id="btn-new-epic" class="strip-btn">+ New Epic</button>` to the epics `.controls-strip` (line 1033), and a hidden modal (reuse the `.kanban-log-overlay`/`.kanban-log-modal` pattern at lines 451–470) with: Epic Name (required `<input>`), Description (`<textarea>`), Cancel / Create buttons.

**CSS (same file).**
- Split the grouped pane rule at line 164. Give `.kanban-preview-pane, .epics-preview-pane` `display:flex; flex-direction:column;` and **remove** `overflow-y:auto` from them; keep `.constitution-preview-pane` on its own rule with the original `overflow-y:auto; padding:16px;`.
- Move scrolling to the inner content: `#kanban-preview-content, #epics-preview-content { overflow-y:auto; flex:1; }`.
- Update `#kanban-preview-meta-bar, #epic-preview-meta-bar` (line 387) to: `padding:6px 10px; gap:12px; flex-wrap:wrap; align-items:center;` keeping `background: var(--panel-bg2)` so it reads as a function row.
- Ensure pane padding does not inset the pinned meta bar full-width.

**Edge Cases.** Constitution tab must be visually unchanged (verify after the selector split). Scanlines overlay (`inset:0`) still covers the wrapper including the now-external meta bar — acceptable.

### `src/webview/project.js`

**Context.** `state` only tracks `kanban` + `constitution` (lines 42–45). Kanban Edit/Save/Cancel are wired once at load to now-removed static buttons (lines 116–118, 960–977). Epic meta bar shows a redundant title + "Open File" (lines 772–788) with no edit mode. Epics preview branch overwrites `innerHTML` unconditionally (lines 177–179).

**Logic.** Add `epics` everywhere the edit machinery is keyed by tab; render Edit/Save/Cancel into the meta bars and (re)wire on each render; store raw epic content for editing; reuse `saveFileContent` with `tab:'epics'`.

**Implementation.**
- Extend `state.editMode/editOriginalContent/dirtyFlags/externalChangePending` with `epics: false/null`.
- `renderKanbanMetaBar` (line 543): remove the Constitution group (lines 571–574) and the `getConstitutionStatus` post (586–590); render `btn-edit-kanban`/`btn-save-kanban`/`btn-cancel-kanban` (IDs unchanged so `enterEditMode('kanban')` keeps working) plus existing Column/Complexity/Upload/Log/Delete; attach their listeners here (Save posts `saveFileContent` with `filePath=_kanbanSelectedPlan.planFile`, `tab:'kanban'`, `originalContent=state.editOriginalContent.kanban`). Add an `input` listener on `#kanban-editor` setting `state.dirtyFlags.kanban` (parity with epics).
- `renderEpicMetaBar` (line 772): drop the "Epic: [topic]" group and "Open File"; render `btn-edit-epics`/`btn-save-epics`/`btn-cancel-epics`; wire `btn-edit-epics → enterEditMode('epics')`, `btn-cancel-epics → exitEditMode('epics')`, `btn-save-epics → postMessage({type:'saveFileContent', filePath:_epicSelectedPlan.planFile, content: epicsEditor.value, originalContent: state.editOriginalContent.epics, tab:'epics'})`. Add `input` listener on `#epics-editor` setting `state.dirtyFlags.epics`.
- `kanbanPlanPreviewReady` epics branch (line 177): mirror the kanban branch — guard `state.editMode.epics` (set `externalChangePending.epics`), else set `innerHTML`, `state.editOriginalContent.epics = msg.rawContent || ''`, and enable `btn-edit-epics`.
- `fileSaved`/`saveFileContentResult` handler (lines 284–297): add an `else if (msg.tab === 'epics') { exitEditMode('epics'); if (_epicSelectedPlan) selectEpic(_epicSelectedPlan); }` branch.
- Remove the dead static-button consts/listeners (116–118, 960–977) or guard-null them; the live wiring now lives in the render functions.
- "+ New Epic": wire `btn-new-epic` to open the modal; on Create, `postMessage({type:'createEpic', name, description, workspaceRoot: epicsFilters.workspaceRoot, subtaskPlanIds: []})`. On `kanbanPlansReady` the list refreshes automatically; `epicError` already triggers an `alert` (lines 210–212).

**Edge Cases.** Selecting a different epic while dirty should call `exitEditMode('epics')` first (mirror the kanban list-item handler at line 446). Modal Create must require a non-empty name client-side before posting.

### `src/services/PlanningPanelProvider.ts` (BACKEND — newly required)

**Context.** This provider serves `project.html`. It already has `getEpicDetails`, `addSubtaskToEpic`, `removeSubtaskFromEpic`, `deleteEpic` (lines 2331–2421) using `KanbanDatabase.forWorkspace(wsRoot)` + `this._getKanbanPlans(wsRoot)` → `kanbanPlansReady`. It has **no** `createEpic` case. `saveFileContent` (line 2556) routes its result panel by `tab === 'kanban' || tab === 'constitution'` only (line 2562).

**Logic.** (1) Allow epic saves to reach the project panel. (2) Port + adapt `createEpic` from `KanbanProvider.ts:6679`, dropping the ≥1-subtask requirement.

**Implementation.**
- Line 2562: `const saveDestPanel = (tab === 'kanban' || tab === 'constitution' || tab === 'epics') ? this._projectPanel : this._panel;`
- Add `case 'createEpic':` mirroring the sibling handlers' shape:
  - `const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot)`; bail if falsy.
  - `const name = String(msg.name||'').trim()`; if empty → `this._projectPanel?.webview.postMessage({type:'epicError', message:'Epic name is required.'})` and break.
  - `const db = KanbanDatabase.forWorkspace(wsRoot)`.
  - `planId/sessionId = crypto.randomUUID()`, `workspaceId = await db.getWorkspaceId()` (bail with `epicError` if missing).
  - **Adapted column default**: with no subtasks, `resolvedColumn = 'CREATED'` (the kanban version's subtask-min logic at 6703–6706 is N/A here).
  - `epicPlanFile = path.join('.switchboard','plans',`epic-${planId}.md`)` — **flat path**, matching KanbanProvider.ts:6714.
  - `db.upsertPlan({...isEpic:1, complexity:'Unknown', kanbanColumn: resolvedColumn, status:'active', ...})` then `db.updateEpicStatus(planId, 1, '')` (copy field set from KanbanProvider.ts:6716–6739).
  - YAML-safe frontmatter exactly as KanbanProvider.ts:6742–6744 (escape `'`).
  - `GlobalPlanWatcherService.registerPendingCreation(epicPath)` **before** `fs.promises.writeFile` (ordering matters — see Race Conditions).
  - Refresh: `const allPlans = await this._getKanbanPlans(wsRoot); this._projectPanel?.webview.postMessage({type:'kanbanPlansReady', plans: allPlans, requestId: Date.now()});`
  - Wrap in try/catch posting `epicError` on failure.

**Edge Cases.** No subtasks means the `subtaskPlanIds` loop and the "no valid subtasks" guard from the original are intentionally omitted. Do not call `KanbanProvider._refreshBoard` here — that refreshes kanban.html, not this panel; use `_getKanbanPlans` + `kanbanPlansReady` like the sibling cases.

---

### (Preserved) Original Root Cause analysis

1. **Structural**: `#kanban-preview-pane` and `#epics-preview-pane` have `overflow-y: auto`, causing the meta bar to scroll away with content. In `planning.html`, `#preview-pane-tickets` uses `display: flex; flex-direction: column;` with the meta bar as a fixed first child and only the content area scrolling.
2. **Layout**: The meta bars use a metadata-display layout (label/value pairs with wide gaps) rather than a compact action-button row.
3. **Missing capability**: `project.js` state tracking only covers `kanban` and `constitution` edit modes; `epics` was never wired up.

### Files Changed
- `src/webview/project.html`
- `src/webview/project.js`
- `src/services/PlanningPanelProvider.ts` **(added — backend port + save routing; was missing from the original plan)**

## Verification Plan

> Per session directive: do NOT run project compilation (`tsc`/build) or execute the automated suite as part of this plan — the user runs those separately. Tests below describe intended coverage; author them but defer execution.

### Automated Tests
- **Host unit (PlanningPanelProvider)**: `createEpic` with a name and `subtaskPlanIds: []` → DB gets one row with `is_epic=1`, a `.switchboard/plans/epic-<uuid>.md` file is written with valid quoted YAML frontmatter, and a `kanbanPlansReady` message is posted to the project panel. Empty name → `epicError` posted, no DB/file write.
- **Host unit**: `saveFileContent` with `tab:'epics'` routes its `saveFileContentResult` to `this._projectPanel` (not `this._panel`).
- **Host unit**: epic file write is preceded by `registerPendingCreation` (assert call order) so the watcher does not re-import.

### Manual Validation (preserved from original, corrected)
1. Open `project.html` in the Switchboard webview.
2. **Kanban Plans** tab → select a plan. Confirm: meta bar is pinned at the top (does not scroll); Edit/Save/Cancel are in the meta bar, not the tab strip; no "Constitution" label; edit toggles and saves without error.
3. **Epics** tab → select an epic. Confirm: meta bar pinned; no redundant "Epic:" title; Edit present and functional; Save/Cancel appear during edit and persist changes.
4. **Epics** tab → **"+ New Epic"** → fill name (+ optional description) → Create. Confirm: a new `.switchboard/plans/epic-<uuid>.md` is written (flat path), the epic appears in the epics list immediately, and it is NOT duplicated by the file watcher.
5. Confirm the **Constitution** tab layout/scroll is unchanged after the CSS selector split.

### Risks (preserved from original)
- **Regression in kanban edit flow**: moving Edit/Save/Cancel from static HTML to a dynamically rendered meta bar requires careful event-listener management; old static references must be removed and listeners re-attached on each render.
- **Epic save path**: epics reuse `saveFileContent`; verify the host echoes `tab:'epics'` and routes the result to the project panel (fix at line 2562).
- **CSS cascade**: splitting `.kanban-preview-pane`/`.epics-preview-pane` from `.constitution-preview-pane` must be scoped tightly to avoid Constitution-tab side effects.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.** The webview restructure is routine, but the required backend port (DB + filesystem writes, watcher-ordering, panel routing) and the zero-subtask design divergence carry data-consistency and contract risk that warrant senior review.

---

## Reviewer Pass (2026-06-19) — Direct Reviewer-Executor

Reviewed the implemented code in the working tree (frontend committed in `6f64897`, backend `createEpic` in `d364bc0`) against the requirements above. Compilation and tests deferred per session directive (SKIP COMPILATION / SKIP TESTS).

### Stage 1 — Grumpy Principal Engineer

> *Pulls glasses down nose.* So we built a beautiful pinned meta bar, a shiny new editor, a whole backend port with watcher choreography worthy of a ballet… and then we **forgot to tell the webview the save succeeded.** Let me be specific, because vague rage helps no one.
>
> **CRITICAL — the Epics Save button is a liar.** `project.js:312` — the `fileSaved` / `saveFileContentResult` switch arm branches on `'kanban'` and `'constitution'` and then *stops*. There is no `'epics'` arm. The plan TOLD you to add one (Implementation line 112, verbatim, with the exact code). What happens at runtime? The user edits an epic, hits Save, the host dutifully writes the file and posts `saveFileContentResult{tab:'epics', success:true}` — and the webview shrugs, leaves the textarea wide open in edit mode, never refreshes the preview, never flips the buttons back. The change is on disk. The UI says nothing happened. That is the single worst kind of bug: silent success that *looks* like failure. Manual validation step 3 — "Save/Cancel appear during edit and persist changes" — **fails on its face.** Fix it.
>
> **MAJOR — you ignored two of your own acceptance criteria.** `renderKanbanMetaBar` (`project.js:599–602`) still proudly renders the "Constitution:" group and still fires `getConstitutionStatus`. The plan said *remove the Constitution group*. Validation step 2 demands "no 'Constitution' label." And `renderEpicMetaBar` (`project.js:855–863`) keeps the "Epic: [topic]" title AND the "Open File" button — the plan said *drop both*, validation step 3 says "no redundant 'Epic:' title." Now — I will grudgingly admit the "Open File" button is *useful* and the constitution status is *informative*, so this may be a defensible product call rather than sloppiness. But you don't get to silently overrule the spec. Flag it, get a ruling.
>
> **MAJOR — none of this is live.** It's all in `src/webview/*`. The extension serves from `dist/`. Until somebody runs `npm run compile`, every word above describes a file nobody is executing. Yes, the directive says skip compilation — fine — but the plan must scream this so the user doesn't "test" a stale bundle and file a phantom bug.
>
> **NIT —** `PlanningPanelProvider.ts:2540` computes `yamlSafeDesc` and then never uses it. Before you grab a pitchfork: the reference `KanbanProvider.ts:6767` has the *exact same* dead variable. It's a faithful port of a pre-existing wart. The body is markdown, not YAML, so no escaping is needed there. Leave it or kill it, I don't care, but know it's there.
>
> Everything else? *Reluctantly nods.* The CSS pane split correctly quarantines Constitution. Listeners re-attach on every render — the dynamic-button lifecycle trap was actually handled. The epics preview branch guards `editMode` so an in-flight preview can't clobber live edits. The backend honored `registerPendingCreation` *before* `writeFile`, used `_getKanbanPlans`+`kanbanPlansReady` instead of the wrong `_refreshBoard`, kept the YAML quoting, allowed zero-subtask epics with `resolvedColumn='CREATED'`, and added `|| tab === 'epics'` to the save routing. Imports are all present. Credit where due.

### Stage 2 — Balanced Synthesis

**Fix now (done in this pass):**
- **C1** Missing `epics` arm in the save-result handler → epic edits silently fail to close out. Applied.

**Keep (verified correct, no action):**
- CSS pane-rule split isolating `.constitution-preview-pane` (project.html:164–180); meta-bar function-row CSS (project.html:398–407); pinned meta bar outside the scroll region (project.html:1025–1068).
- Dynamic Edit/Save/Cancel listeners re-attached inside `renderKanbanMetaBar` (project.js:624–645) and `renderEpicMetaBar` (project.js:870–891).
- Epics preview branch guards `state.editMode.epics` against clobber (project.js:197–206).
- Backend `createEpic` (PlanningPanelProvider.ts:2491–2552): imports present, zero-subtask allowed, YAML escaping retained, `registerPendingCreation` before `writeFile`, refresh via `_getKanbanPlans`+`kanbanPlansReady`. Save routing fix at line 2692.
- Client-side non-empty-name guard + modal wiring (project.js:1080–1097); `_resolveWorkspaceRoot('')` falls back to a default allowed root, so "All Workspaces" does not crash.
- The three "User Review Required" items are all resolved by the implementation as recommended (zero-subtask epics permitted; backend modified; flat `epic-{planId}.md` path).

**Fixed in follow-up (user confirmed: remove per plan):**
- **D1** Removed the Kanban "Constitution:" status group, its `getConstitutionStatus` request, and the now-dead `constitutionStatus` message handler from project.js. (Backend `getConstitutionStatus` case at PlanningPanelProvider.ts:2582 is now orphaned but harmless — left in place to avoid an out-of-scope TS edit.)
- **D2** Removed the Epic "Epic: [topic]" title group, the "Open File" button, and its listener from `renderEpicMetaBar`. Edit/Save/Cancel are now the only meta-bar controls, matching the plan.

**Defer:**
- **Rebuild required:** `npm run compile` before any manual validation — webview edits are not in `dist/` yet.

### Fixes Applied
- `src/webview/project.js:318–321` — added `else if (msg.tab === 'epics') { exitEditMode('epics'); if (_epicSelectedPlan) selectEpic(_epicSelectedPlan); }` to the `fileSaved`/`saveFileContentResult` handler so a successful epic save exits edit mode and refreshes the preview.

### Validation Results
- Static review only. Per session directive, did **not** run `npm run compile` or the test suite.
- `selectEpic` (project.js:833) and `exitEditMode` (project.js:1048) confirmed to exist and to be generic over the `epics` tab; the fix uses no undefined symbols.

### Remaining Risks
- **Stale bundle**: until `npm run compile` runs, the webview behaves as the old `dist/` build. Validate only after rebuild.
- **Spec divergence (D1/D2)**: meta bars retain elements the plan asked to remove; awaiting product confirmation.
- **Unrelated working-tree change**: `PlanningPanelProvider.ts` has an uncommitted diff at lines ~2089/2115 (clickup/linear field cleanup) **outside this plan's scope** — left untouched; flagged so it isn't bundled into this plan's commit unintentionally.

### Findings Summary
| Sev | ID | Location | Status |
|-----|----|----------|--------|
| CRITICAL | C1 | project.js:312–325 (now 318–321) | **Fixed** |
| MAJOR | D1 | project.js (Constitution group + status post/handler) | **Fixed** — removed per plan |
| MAJOR | D2 | project.js (Epic: title + Open File) | **Fixed** — removed per plan |
| MAJOR | B1 | webview not in dist/ | Action: run `npm run compile` |
| NIT | N1 | PlanningPanelProvider.ts:2540 | Accepted (mirrors reference) |
