# Upload Plan as Ticket Attachment

## Goal
Add an "Upload Plan" action to the kanban plan preview pane in `planning.html` that uploads the current kanban plan `.md` file as an attachment to its linked ClickUp task or Linear issue.

### Core Problems
1. **No way to sync plan back to ticket**: Once a kanban plan is imported from a ClickUp/Linear ticket, the plan evolves locally but there is no one-click way to push the updated plan file back to the original ticket as an attachment.
2. **Repetitive manual work**: Users must manually export or copy the plan content and paste it into the ticket, losing formatting and file context.
3. **Feature gap**: The extension can import tickets as plans and push edits to ticket descriptions, but attaching the actual plan file is not supported.

### Background Context
- Kanban plans imported from tickets store the remote ticket ID in the `plans` table (`clickup_task_id` or `linear_issue_id`).
- Plan files are physical `.md` files at `{workspaceRoot}/.switchboard/plans/feature_plan_*.md`.
- `ClickUpSyncService.attachFile(taskId, fileName, buffer, comment?)` already handles multipart upload to ClickUp.
- `LinearSyncService.uploadAttachment(issueId, buffer, fileName)` already handles Linear's signed-URL 3-step upload flow.
- The planning webview (`planning.js`) communicates with `PlanningPanelProvider.ts` via `vscode.postMessage` / `panel.webview.postMessage`.

## Metadata

**Tags:** ui, api, feature

**Complexity:** 5

## User Review Required
- Confirm the upload button should live in the kanban plan preview controls strip (next to Edit/Copy Prompt buttons).
- Confirm whether uploading should also post a comment on ClickUp (the existing `attachFile` API supports an optional comment; Linear does not).
- Confirm file naming: should the uploaded file keep its generated plan filename (e.g. `feature_plan_2026-06-18_fix-login-bug.md`) or be renamed to something cleaner like `plan.md` or `{ticket-id}-plan.md`.

## Complexity Audit

### Routine
- Add upload button inside `renderKanbanMetaBar` in `project.js`.
- Add click listener and message posting in `project.js` (inside `renderKanbanMetaBar`).
- Add `uploadPlanAttachment` message handler in `PlanningPanelProvider.ts`.
- Add `uploadPlanToTicket` logic directly in `PlanningPanelProvider.ts` that reads the file and calls the sync service.
- Add `uploadPlanAttachmentResult` message handler in `project.js` to show success/error status.

### Complex / Risky
- The upload is an outbound network call that may take several seconds. The UI must show a loading state and handle failures gracefully.
- `KanbanDatabase` lookups (`getPlanByPlanFile`) are needed to resolve the linked ticket ID; if the plan was created locally (not imported), there is no linked ticket — the button must be hidden or disabled.
- Linear's `uploadAttachment` requires a 3-step GraphQL + HTTPS flow; any step can fail independently.
- ClickUp's `attachFile` uses raw `https.request` multipart upload; failure modes include token expiry, rate limits, and file size limits.

## Edge-Case & Dependency Audit

### Race Conditions
- Rapid successive clicks on the upload button must be debounced / disable the button while a upload is in flight.
- Uploading while the plan file is being written by another process (e.g., auto-save or brain mirroring) could upload a partially-written file. Mitigation: read the file synchronously at handler entry, or use `fs.promises.readFile` which returns the state at call time.

### Security
- The uploaded file path must be validated to stay within the workspace root (existing `isAllowedSwitchboardLocation` guard applies).
- No new attack surface: the sync services already handle authentication tokens; no tokens are exposed to the webview.

### Side Effects
- Uploading creates a new attachment on the remote ticket every time it is clicked. There is no deduplication. This is acceptable (users can delete old attachments in ClickUp/Linear), but should be noted.
- ClickUp's `attachFile` may post an optional comment; if enabled, each upload spawns a comment.

### Dependencies & Conflicts
- No conflicting plans identified.

## Dependencies
- Existing `ClickUpSyncService.attachFile()` and `LinearSyncService.uploadAttachment()` implementations.
- `KanbanDatabase.getPlanByPlanFile()` to resolve linked ticket IDs.

## Adversarial Synthesis
Key risks: (1) The plan file may not have a linked ticket ID (local plans). The upload button must be conditional on `clickupTaskId || linearIssueId` being present in the `KanbanPlanSummary` sent to the webview. (2) Network failures during upload must be surfaced to the user with a meaningful error, not swallowed. (3) The button is dynamically rendered inside `renderKanbanMetaBar`, so its listener must be re-attached on every plan selection. Mitigations: gate button visibility on the selected plan having a non-empty linked ticket ID; return detailed error messages from `PlanningPanelProvider._handleMessage`; attach the listener inside `renderKanbanMetaBar` immediately after setting `innerHTML`.

## Proposed Changes

> **File path corrections discovered during audit:** The kanban plan preview pane lives in `project.html` and `project.js` (the Project panel), not `planning.html`/`planning.js`. `planning.html` does not contain `#kanban-preview-meta-bar`. `PlanningPanelProvider` has no `_taskViewerProvider` reference; upload logic belongs directly in `PlanningPanelProvider.ts`. `KanbanDatabase.getPlanByPlanFile` already exists and does not need to be added.

### `src/webview/project.html`
**Context:** The kanban plan preview pane (`#kanban-preview-pane`) already contains `#kanban-preview-meta-bar` (initially `display:none`). No new HTML element is required; the upload button is injected dynamically by `renderKanbanMetaBar` in `project.js`.

**Logic:**
1. No static HTML changes required. The meta bar container already exists at line ~1016 of `project.html`:
   ```html
   <div id="kanban-preview-meta-bar" style="display:none;"></div>
   ```

**Edge Cases:**
- The button is rendered conditionally by JS, so no stale DOM elements remain when switching plans.

---

### `src/webview/project.js`
**Context:** Kanban plan preview state (`_kanbanSelectedPlan`), `renderKanbanMetaBar`, and message handling.

**Logic:**
1. **Add state variable near `_kanbanSelectedPlan` (~line 97):**
   ```js
   let uploadingPlanAttachment = false;
   ```

2. **Update `renderKanbanMetaBar(plan)` (~line 540) to inject the upload button conditionally:**
   Inside the `metaBar.innerHTML = `...`` template, add a conditional upload button inside the right-most `kanban-meta-group` (after Log and Delete):
   ```js
   metaBar.innerHTML = `
       <div class="kanban-meta-group"> ... </div>
       <div class="kanban-meta-group"> ... </div>
       <div class="kanban-meta-group">
           <span class="kanban-meta-label">Constitution:</span>
           <span class="kanban-meta-value" id="kanban-meta-constitution">Loading...</span>
       </div>
       <div class="kanban-meta-group" style="margin-left: auto;">
           ${plan.clickupTaskId || plan.linearIssueId ? `
               <button class="strip-btn" id="kanban-meta-upload-btn" ${uploadingPlanAttachment ? 'disabled' : ''}>
                   ${uploadingPlanAttachment ? 'Uploading...' : 'Upload'}
               </button>
           ` : ''}
           <button class="strip-btn" id="kanban-meta-log-btn">Log</button>
           <button class="strip-btn" id="kanban-meta-delete-btn">Delete</button>
       </div>
   `;
   ```
   Then attach the click listener immediately after setting `innerHTML`, alongside the existing Log/Delete listeners (~line 610):
   ```js
   const uploadBtn = document.getElementById('kanban-meta-upload-btn');
   if (uploadBtn) {
       uploadBtn.addEventListener('click', () => {
           if (!_kanbanSelectedPlan) return;
           if (uploadingPlanAttachment) return;
           uploadingPlanAttachment = true;
           uploadBtn.disabled = true;
           uploadBtn.textContent = 'Uploading...';
           vscode.postMessage({
               type: 'uploadPlanAttachment',
               workspaceRoot: _kanbanSelectedPlan.workspaceRoot,
               planFile: _kanbanSelectedPlan.planFile,
               topic: _kanbanSelectedPlan.topic || '(untitled)'
           });
       });
   }
   ```

3. **Add message handler for `uploadPlanAttachmentResult` inside the `window.addEventListener('message', ...)` switch (~line 150):**
   ```js
   case 'uploadPlanAttachmentResult': {
       uploadingPlanAttachment = false;
       // Re-render meta bar so button returns to normal state
       if (_kanbanSelectedPlan && _kanbanSelectedPlan.planFile === msg.planFile) {
           renderKanbanMetaBar(_kanbanSelectedPlan);
       }
       if (msg.success) {
           alert(`Plan uploaded to ${msg.provider} ticket.\n${msg.url || ''}`);
       } else {
           alert(`Upload failed: ${msg.error}`);
       }
       break;
   }
   ```

**Edge Cases:**
- `renderKanbanMetaBar` rebuilds `innerHTML` on every plan selection, so the upload button listener must be attached *inside* `renderKanbanMetaBar` or it will be lost.
- Re-rendering `renderKanbanMetaBar` on result naturally resets button state.
- If the user switches plans mid-upload, `msg.planFile` is compared to `_kanbanSelectedPlan?.planFile` before re-rendering or showing alerts.
- The button is only rendered when `plan.clickupTaskId || plan.linearIssueId` is truthy.

---

### `src/services/PlanningPanelProvider.ts`
**Context:** The `_handleMessage` switch statement routes webview messages. There is no `_taskViewerProvider` reference in this class; sync services are accessed via `this._adapterFactories`.

**Logic:**
1. **Add `clickupTaskId` and `linearIssueId` to `KanbanPlanSummary` interface (~line 37):**
   ```typescript
   interface KanbanPlanSummary {
       planId: string;
       sessionId: string;
       topic: string;
       column: string;
       workspaceRoot: string;
       workspaceLabel: string;
       project: string;
       repoScope: string;
       mtime: number;
       planFile: string;
       complexity: string;
       isEpic?: number;
       epicId?: string;
       clickupTaskId?: string;
       linearIssueId?: string;
   }
   ```

2. **Augment `_getKanbanPlans` mapper (~line 6112) to include the ticket IDs:**
   ```typescript
   return allRecords.map((r: any) => ({
       planId: r.planId,
       sessionId: r.sessionId || '',
       topic: r.topic || path.basename(r.planFile || '') || 'Untitled',
       column: r.kanbanColumn,
       workspaceRoot: effectiveRoot,
       workspaceLabel: wsLabel,
       project: r.project || '',
       repoScope: r.repoScope || '',
       mtime: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
       planFile: r.planFile || '',
       complexity: r.complexity || 'Unknown',
       isEpic: r.isEpic,
       epicId: r.epicId || '',
       clickupTaskId: r.clickupTaskId || r.clickup_task_id || '',
       linearIssueId: r.linearIssueId || r.linear_issue_id || ''
   }));
   ```

3. **Add `case 'uploadPlanAttachment'` after existing kanban message handlers in `_handleMessage` (~line 1937 area):**
   ```typescript
   case 'uploadPlanAttachment': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       const { planFile, topic } = msg;
       if (!workspaceRoot || !planFile) {
           this._panel?.webview.postMessage({
               type: 'uploadPlanAttachmentResult',
               success: false,
               error: 'Missing workspace root or plan file.',
               planFile
           });
           break;
       }
       try {
           const db = KanbanDatabase.forWorkspace(workspaceRoot);
           const workspaceId = await this._getWorkspaceId(workspaceRoot);
           const plan = await db.getPlanByPlanFile(planFile, workspaceId);
           if (!plan) {
               this._panel?.webview.postMessage({
                   type: 'uploadPlanAttachmentResult',
                   success: false,
                   error: 'Plan not found in kanban database.',
                   planFile
               });
               break;
           }
           if (!plan.clickupTaskId && !plan.linearIssueId) {
               this._panel?.webview.postMessage({
                   type: 'uploadPlanAttachmentResult',
                   success: false,
                   error: 'Plan is not linked to a ClickUp task or Linear issue.',
                   planFile
               });
               break;
           }
           const planFileAbsolute = path.isAbsolute(planFile)
               ? planFile
               : path.join(workspaceRoot, planFile);
           const resolvedFile = path.resolve(planFileAbsolute);
           const resolvedRoot = path.resolve(workspaceRoot);
           if (!resolvedFile.startsWith(resolvedRoot + path.sep) && resolvedFile !== resolvedRoot) {
               this._panel?.webview.postMessage({
                   type: 'uploadPlanAttachmentResult',
                   success: false,
                   error: 'Plan file path is outside the workspace root.',
                   planFile
               });
               break;
           }
           const buffer = await fs.promises.readFile(planFileAbsolute);
           const fileName = path.basename(planFileAbsolute);
           if (plan.clickupTaskId) {
               const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
               const result = await clickup.attachFile(plan.clickupTaskId, fileName, buffer);
               this._panel?.webview.postMessage({
                   type: 'uploadPlanAttachmentResult',
                   success: true,
                   url: result.url,
                   provider: 'clickup',
                   planFile
               });
           } else if (plan.linearIssueId) {
               const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
               const result = await linear.uploadAttachment(plan.linearIssueId, buffer, fileName);
               this._panel?.webview.postMessage({
                   type: 'uploadPlanAttachmentResult',
                   success: true,
                   url: result.url,
                   provider: 'linear',
                   planFile
               });
           }
       } catch (error) {
           const errMsg = error instanceof Error ? error.message : String(error);
           this._panel?.webview.postMessage({
               type: 'uploadPlanAttachmentResult',
               success: false,
               error: errMsg,
               planFile
           });
       }
       break;
   }
   ```

**Edge Cases:**
- Catch all errors and post them back to the webview so the UI is never stuck in a loading state.
- Validate resolved plan file is within workspace root before reading.
- Guard against missing workspace root or plan file at handler entry.
- The handler works for both the main planning panel and the project panel because `_handleMessage` routes messages from both webviews.

---

### `src/services/TaskViewerProvider.ts` — NOT REQUIRED
**Correction:** `PlanningPanelProvider` does not hold a reference to `TaskViewerProvider`. The upload logic is implemented directly inside `PlanningPanelProvider._handleMessage` (see corrected section above). No changes to `TaskViewerProvider.ts` are needed for this feature.

---

### `src/services/KanbanDatabase.ts` — NOT REQUIRED
**Correction:** `getPlanByPlanFile(planFile, workspaceId)` already exists in `KanbanDatabase.ts` (line ~2438). No additions are needed.

## Edge Cases

1. **No linked ticket**: The upload button is hidden; if invoked via message anyway, return a clear error.
2. **Plan file deleted locally**: Read failure is caught and surfaced to the user.
3. **Token expired / API error**: Provider-specific error message is returned; user can retry.
4. **Large plan files**: Both services upload the raw buffer; ClickUp has an implicit size limit (~100MB for most workspaces). No client-side size check is added; let the API fail naturally.
5. **Upload while plan is unsaved**: The upload reads the file on disk, so any unsaved editor changes are not reflected. This is acceptable (users can save first).
6. **Multiple workspaces**: The handler resolves the workspace root and uses the correct DB instance per workspace.
7. **Offline**: Network failure is caught and surfaced with the provider's error message.

## Risks

1. **Duplicate attachments**: Each click creates a new attachment on the remote ticket. Users may accidentally spam attachments.
2. **Token scope**: ClickUp/Linear tokens must have attachment upload scope. If not, the error may be opaque (e.g., `401 Unauthorized`).
3. **Filename collisions on remote**: ClickUp allows duplicate filenames; Linear uses asset URLs. No deduplication is attempted.
4. **Performance**: Reading the entire file into memory may be slow for very large plans (hundreds of MB). Plans are typically small markdown files (< 50KB), so this is acceptable.
5. **UI state desync**: If the kanban plan record is updated (e.g., ticket unlinked) while the preview is open, the button visibility may be stale until re-render. Standard re-select refreshes the state.

## Verification Plan

### Automated Tests
- Skipped per session directive.

### Manual Verification
1. Import a ClickUp task as a kanban plan. Open the plan preview. Verify the "Upload" button appears.
2. Click "Upload". Verify the button label changes to "Uploading..." and is disabled.
3. On success, verify a status message appears with the ClickUp attachment URL.
4. Open the ClickUp task in the browser. Verify the plan `.md` file appears as an attachment.
5. Repeat steps 1-4 with a Linear issue. Verify the attachment appears in Linear.
6. Create a local plan (not imported from a ticket). Verify the "Upload" button does **not** appear.
7. Delete the local plan file, then click Upload (if somehow still visible). Verify a clear "Failed to read plan file" error.
8. Disconnect the ClickUp/Linear integration, then click Upload. Verify a clear auth/API error.
9. Click Upload rapidly twice. Verify only one upload occurs (button disabled during flight).
10. Switch to a different plan while an upload is in progress. Verify the result is handled gracefully (status shown only if the returned plan matches the current selection).

## Risks

- **Recommendation:** Send to Coder

---

## Code Review (2026-06-19)

Reviewer-executor pass against the corrected plan. Verification was static only (compilation and tests skipped per session directive); every referenced symbol, import, and message route was traced in source.

### Verified against plan
- **`src/webview/project.js`** — `uploadingPlanAttachment` flag (line 99); conditional Upload button gated on `plan.clickupTaskId || plan.linearIssueId` inside `renderKanbanMetaBar` (lines 602–606); click listener attached *after* `innerHTML` with in-flight debounce (lines 678–693); `uploadPlanAttachmentResult` handler resets state and re-renders only when `msg.planFile === _kanbanSelectedPlan.planFile` (lines 296–307). Matches plan exactly.
- **`src/services/PlanningPanelProvider.ts`** — `KanbanPlanSummary` extended with `clickupTaskId?`/`linearIssueId?` (lines 52–53); `_getKanbanPlans` mapper populates both with snake_case fallback (lines 6540–6541); `case 'uploadPlanAttachment'` (lines 2067–2152) with full guard chain (missing root/file → plan-not-found → not-linked → path-traversal), `fs.promises.readFile`, provider dispatch, and catch-all that always posts a result. Matches plan.
- **Symbol resolution confirmed:** `fs` is imported at line 5 (`stateFs as fs`, exposes `.promises.readFile`); `_resolveWorkspaceRoot` (1130), `_getWorkspaceId` (5502), `KanbanDatabase.forWorkspace` (720), `getPlanByPlanFile` (2498) all exist; `_readRows` maps `clickup_task_id`/`linear_issue_id` → camelCase (5496–5497); `_adapterFactories.getClickUpSyncService`/`getLinearSyncService` defined (34–35), wired in extension.ts (789–790); `attachFile` returns `{url, fileName}` (ClickUpSyncService:1600), `uploadAttachment` returns `{url}` (LinearSyncService:1071) — `result?.url` is valid for both.
- **Message routing confirmed:** `PlanningPanelProvider` serves `project.html`/`project.js` itself (329–354), so the Project-panel webview's `uploadPlanAttachment` message reaches this `_handleMessage`. Handler is correctly placed; not stranded in the wrong provider.
- **dist build current:** `dist/webview/project.js` and `dist/extension.js` already contain the feature — no rebuild needed for it to run.

### Stage 1 — Grumpy Principal Engineer
> *"Show me where it breaks."* I went hunting for the usual graveyard sins and came up mostly empty, which is itself suspicious, but the corpse is clean.
> - **The auto-commit is a LIE.** The commit literally titled `Upload Plan as Ticket Attachment` (693928c) contains *zero* of this feature — it's a stray `TaskViewerProvider.ts` ClickUp-refresh hunk from the *previous* plan. The actual implementation lives in the working tree / an earlier commit. The snapshot label is theatre; don't trust it to tell you what shipped. **(MAJOR — process, not code)**
> - **Dead passenger `topic`.** `const { planFile, topic } = msg;` (2069) — `topic` is destructured, ferried across the postMessage boundary from the webview, and then... ignored forever. It does nothing. It will never do anything. Why is it here? **(NIT)**
> - **`alert()` again?!** Six existing `alert()` calls in this file and you added two more (302, 304). In a sandboxed webview without `allow-modals` these can be silent no-ops. But — credit where due — the button state still resets via re-render regardless, and this is the file's entrenched convention, so I'll holster the pitchfork. **(NIT, pre-existing)**
> - **Hand-rolled path guard.** The audit promised `isAllowedSwitchboardLocation`; the code ships a bespoke `startsWith(resolvedRoot + path.sep)` check (2107). It's *correct* for traversal on a read-only op, but it's a one-off where a shared guard existed. **(NIT)**
> - **No dedup, infinite attachment spam.** Click ten times, get ten attachments. But it's documented as accepted in Risks, so fine. **(by design)**

### Stage 2 — Balanced synthesis
- **Keep:** Everything. The implementation is a faithful, complete realization of the corrected plan. Guard chain is exhaustive (every early-return and the catch both post a result → the webview can never wedge in "Uploading..."), the in-flight debounce is real, path traversal is blocked, both provider return shapes are handled with optional chaining, and message routing is genuinely correct.
- **Fix now:** Nothing. No CRITICAL or MAJOR *code* defects found.
- **Defer / accept:** unused `topic` (harmless — `noUnusedLocals` is off, so not even a compile warning); `alert()` usage (matches file convention; functionally safe due to re-render); inline path check (adequate for a read); no dedup (documented).
- **Process note (not code):** the auto-commit titled for this plan does not contain this plan's diff. Whoever commits next should stage the real changes (`src/webview/project.js`, `src/services/PlanningPanelProvider.ts`) explicitly rather than trusting the snapshot label.

### Fixes applied
None. No valid CRITICAL/MAJOR code findings warranted a change.

### Verification results
- Compilation: **skipped** per session directive. Static trace: all symbols/imports/return-types resolve; no type mismatch found. `fs` import present, `_adapterFactories` accessors present and wired, DB field mapping confirmed.
- Tests: **skipped** per session directive.
- Build artifact: `dist/` already contains the feature (grep-confirmed).

### Findings by severity
- **CRITICAL:** none.
- **MAJOR:** none in code. (Process: `693928c` auto-commit mislabeled — its diff is the prior plan's `TaskViewerProvider.ts:17931` hunk, not this feature.)
- **NIT:** unused `topic` — `PlanningPanelProvider.ts:2069`; `alert()` for result toast — `project.js:302,304` (pre-existing convention); bespoke path guard vs shared `isAllowedSwitchboardLocation` — `PlanningPanelProvider.ts:2107`.

### Remaining risks
- Webview `alert()` may not surface in sandboxed configs, but button state self-heals via `renderKanbanMetaBar` re-render — no functional stall.
- Duplicate attachments on repeated clicks (accepted, documented).
- ClickUp/Linear token scope must include attachment upload; failures surface as the provider's raw error string (acceptable).
- The named auto-commit does not contain this diff — ensure the real working-tree changes are committed deliberately.
