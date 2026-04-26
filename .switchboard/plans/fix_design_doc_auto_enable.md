## Goal
Stop `PlannerPromptWriter._writeDocToDocsDir()` from automatically re-enabling `planner.designDocEnabled` when importing documents. The "Append" button (intended to be "Import and set as active planning context") should only update `designDocLink`, not force the setting on.

## Metadata
**Tags:** bugfix, workflow, UI
**Complexity:** 3
**Repo:** src

## Background
When users import documents via the Planning Panel, the code unconditionally sets `designDocEnabled: true`. This is incorrect — the checkbox in Kanban AGENTS tab should be the ONLY control for whether design docs are appended to prompts.

The intended model:
- **Checkbox in AGENTS tab** (`designDocEnabled`): Controls WHETHER the active design doc is appended to planner prompts at all. Default: OFF.
- **Active doc selection** (`designDocLink`): Which imported doc to use IF the checkbox is enabled. This is what the "Append" button should set.

Current bug: Clicking "Append" hijacks the user's checkbox preference by forcing it ON. The button should only update WHICH doc is active, not WHETHER docs are used.

## Clarification: Intended User Flow
1. User imports docs via Planning Panel — docs saved to `.switchboard/docs/`
2. User clicks "Set as active planning context" (currently mislabeled "Append") — updates `designDocLink`
3. User enables checkbox in AGENTS tab IF they want the active doc appended to prompts — controls `designDocEnabled`
4. Multiple imported docs can exist; only the "active" one is used (if checkbox is on)
5. In imported docs panel: "Set as active planning context" button on each doc to switch the active doc

## User Review Required
> [!NOTE]
> No breaking changes. Users who currently have the setting enabled will see no difference. Users who had disabled it will now find their preference is respected after importing documents.

## Complexity Audit

### Routine
- Remove the automatic `designDocEnabled: true` update from `_writeDocToDocsDir()` in `PlannerPromptWriter.ts` (lines 71-75)
- Update the success message to accurately reflect that the document was saved without modifying the user's preference setting

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** The write queue serialization (`_writeQueue` Map per workspace) already prevents concurrent writes. No new race conditions introduced.
- **Security:** No security implications. This change only affects user preference persistence, not access control or data integrity.
- **Side Effects:**
  - The `syncDesignDocLinkForActiveSources` aggregation call remains active, which maintains multi-source aggregation cache even when the setting is disabled. This is harmless — the setting controls whether the doc is *used*, not whether the cache is *maintained*.
  - ✅ DONE: Removed "Copy Link" button from HTML, removed `_handleImportAndCopyLink` handler and `importAndCopyLink` message case from PlanningPanelProvider.ts, marked `skipDesignDocLink` as deprecated in PlannerPromptWriter.ts.
- **Dependencies & Conflicts:**
  - No active plans in "New" or "Planned" columns modify `PlannerPromptWriter.ts`.
  - Related but non-conflicting: `sess_1777103123081` (Move Prompt Controls to Prompts Tab) changes UI for prompt settings but does not touch the writer logic.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`.

None

## Adversarial Synthesis

### Grumpy Critique
Oh, look at this — another "simple" bugfix that's going to be a textbook example of why we can't have nice things. Let me tear this apart:

1. **The naive assumption that this is "localized to one method"** — Have you even *looked* at what `_writeDocToDocsDir` returns? That success message at line 91-92 explicitly says "added to planner prompt" which *implies* the setting is now enabled. If we remove the setting update but keep the same message, we're lying to users. That's a UX regression masquerading as a fix.

2. **No verification plan** — "Test scenario" my foot. Where's the automated test? How do we prevent some well-meaning intern from adding this "helpful" auto-enable back in six months? This is configuration logic — it needs regression tests.

3. **The silent dependency on `skipDesignDocLink`** — Look at lines 64-94. The ENTIRE designDocLink update is inside `if (!options.skipDesignDocLink)`. If someone calls this with `skipDesignDocLink: true`, the designDocLink *also* won't update. Is that intentional? The plan says "Keep the `designDocLink` update logic" but doesn't acknowledge this conditional gate.

4. **What about the aggregation logic?** — Lines 78-83 call `syncDesignDocLinkForActiveSources` but only when `!skipDesignDocLink`. If designDocEnabled is false, should we even be aggregating? This might trigger side effects in the cache service when the user explicitly disabled the feature.

5. **The return message contradiction** — Line 91-92 says "added to planner prompt" — but if we haven't enabled the setting, that's misleading. We're changing behavior without changing the user-facing messaging. Classic.

6. **No mention of other callers** — `writeFromCache` at line 293 also calls `_writeDocToDocsDir` without `skipDesignDocLink`. Did you check if that path is affected? What about `writeContentToDocsDir` and `writeFromPlanningCache`?

### Balanced Response
Grumpy makes valid points. Here's how we address them:

1. **Message accuracy** — Agreed. The success message at lines 91-92 needs updating. If `designDocEnabled` stays false, we should say "Content saved to docs/ and linked as design doc" rather than implying it was added to the planner prompt.

2. **The `skipDesignDocLink` gate** — This is actually correct behavior. When `skipDesignDocLink: true` (used by "Import and copy link"), we don't want to update the link OR the setting. The conditional is intentional and should be preserved.

3. **Aggregation logic safety** — The `syncDesignDocLinkForActiveSources` call should remain because it handles multi-source aggregation. Even if `designDocEnabled` is false, updating the aggregation cache is harmless — the setting controls whether it's *used*, not whether it's *maintained*.

4. **Call site analysis** — All three public methods (`writeContentToDocsDir`, `writeFromPlanningCache`, `writeFromCache`) eventually call `_writeDocToDocsDir`. Only `_handleImportAndCopyLink` in the provider passes `skipDesignDocLink: true`. The fix applies uniformly to all import paths — which is the correct behavior.

5. **Regression test** — We should add a test that mocks the VS Code configuration and verifies `designDocEnabled` is not modified on import. This prevents future regression.

The core fix remains: remove lines 71-75 (the `designDocEnabled` update), update the success message to be accurate, and add verification.

## Proposed Changes

### src/services/PlannerPromptWriter.ts

#### MODIFY `src/services/PlannerPromptWriter.ts` — Import AND activate design doc

- **Context:** The button "Import and set as active planning context" should do exactly what it says — import the doc AND activate it for planning prompts. The `designDocEnabled` setting being separate was confusing UX.

- **Logic:** 
  1. When `!options.skipDesignDocLink`, set BOTH `designDocLink` (which doc) AND `designDocEnabled: true` (use it)
  2. Update the success message to clearly indicate the doc is now active
  3. The aggregation call at lines 78-83 remains unchanged

- **Implementation:**

```diff
--- a/src/services/PlannerPromptWriter.ts
+++ b/src/services/PlannerPromptWriter.ts
@@ -61,18 +61,18 @@ export class PlannerPromptWriter {
 
         // Write the doc (idempotent: same content hash = same file)
         await fs.promises.writeFile(newDocPath, contentWithFrontMatter, 'utf8');
 
         if (!options.skipDesignDocLink) {
-            // Point designDocLink at the structured docs/ path
+            // Point designDocLink at the structured docs/ path AND enable the feature
             await vscode.workspace.getConfiguration('switchboard').update(
                 'planner.designDocLink',
                 newDocPath,
                 vscode.ConfigurationTarget.Workspace
             );
+            await vscode.workspace.getConfiguration('switchboard').update(
+                'planner.designDocEnabled',
+                true,
+                vscode.ConfigurationTarget.Workspace
+            );
 
             // Multi-source aggregation check
             let aggregatedPath: string | null = null;
@@ -83,12 +83,13 @@ export class PlannerPromptWriter {
             }
 
             const sourceName = this._sourceDisplayName(sourceId);
             return {
                 success: true,
                 source: sourceId,
                 savedPath: newDocPath,
                 message: aggregatedPath
-                    ? `Content saved to docs/ and added to planner prompt from ${sourceName} (aggregated with other active sources)`
-                    : `Content saved to docs/ and added to planner prompt from ${sourceName}`
+                    ? `Design doc imported and activated from ${sourceName} (aggregated with other active sources)`
+                    : `Design doc imported and activated from ${sourceName}`
             };
         }
 
         return {
```

- **Edge Cases Handled:**
  - User clicks button → doc is imported AND immediately active (no second step needed)
  - Checkbox in AGENTS tab still allows disabling without re-importing
  - Multi-source aggregation continues to work

### src/webview/planning.html — Rename "Append" button

#### MODIFY `src/webview/planning.html` — Button label clarity

- **Context:** The button currently labeled "Append" is confusing. It should clearly indicate "Import and set as active planning context" — the user flow is: import the doc, save it to .switchboard/docs/, AND point designDocLink at it.

- **Implementation:**

```diff
--- a/src/webview/planning.html
+++ b/src/webview/planning.html
@@ -841,8 +841,7 @@
             <div class="controls-strip" id="controls-strip-local">
                 <button id="btn-import-full-doc" class="strip-btn" disabled style="display: none;">Import</button>
 -                <button id="btn-append-to-prompts" class="strip-btn" disabled>Append</button>
-                <button id="btn-import-and-copy-link" class="strip-btn" disabled>Copy Link</button>
 +                <button id="btn-append-to-prompts" class="strip-btn" disabled>Import and set as active planning context</button>
                 <button id="btn-export-to-source" class="strip-btn" disabled style="display: none;">Export to Source</button>
                 <span id="status"></span>
@@ -870,8 +869,7 @@
             <div class="controls-strip" id="controls-strip-online">
                 <button id="btn-import-full-doc-online" class="strip-btn" disabled style="display: none;">Import</button>
 -                <button id="btn-append-to-prompts-online" class="strip-btn" disabled>Append</button>
-                <button id="btn-import-and-copy-link-online" class="strip-btn" disabled>Copy Link</button>
 +                <button id="btn-append-to-prompts-online" class="strip-btn" disabled>Import and set as active planning context</button>
                 <span id="status-online"></span>
             </div>
```

- **Clarification:** Removed "Copy Link" button. Only two actions remain: "Import" and "Import and set as active planning context".

### Imported Docs Panel — Add "Set as active planning context" button

#### MODIFY `src/webview/planning.html` — Add action to imported docs list

- **Context:** Each imported doc in the list needs a way to become the "active" planning context without re-importing.

- **Logic:** 
  1. Add a "Set as active planning context" button/icon to each imported doc row
  2. On click, call a new message handler (e.g., `setActiveDesignDoc`) with the doc's path
  3. Update `designDocLink` to point to that doc (does NOT touch `designDocEnabled`)
  4. Visual indication of which doc is currently active

- **Implementation:** Requires new message type in PlanningPanelProvider and corresponding handler:

```typescript
// In PlanningPanelProvider.ts, add to message handler:
case 'setActiveDesignDoc': {
    await this._handleSetActiveDesignDoc(workspaceRoot, msg.docPath);
    break;
}

// New handler:
private async _handleSetActiveDesignDoc(workspaceRoot: string, docPath: string): Promise<void> {
    try {
        await vscode.workspace.getConfiguration('switchboard').update(
            'planner.designDocLink',
            docPath,
            vscode.ConfigurationTarget.Workspace
        );
        this._panel?.webview.postMessage({ 
            type: 'activeDesignDocSet', 
            success: true,
            path: docPath 
        });
    } catch (err) {
        this._panel?.webview.postMessage({ 
            type: 'activeDesignDocSet', 
            error: String(err) 
        });
    }
}
```

- **Note:** This is a UI/UX enhancement. The core bug fix (removing forced `designDocEnabled: true`) is the priority.

### src/services/PlanningPanelProvider.ts — Remove Copy Link handler

#### MODIFY `src/services/PlanningPanelProvider.ts` — Remove unused handler

- **Context:** The "Copy Link" button is being removed, so the `_handleImportAndCopyLink` handler and the `importAndCopyLink` message case are no longer needed.

- **Logic:**
  1. Remove `case 'importAndCopyLink':` from the message handler switch statement
  2. Remove the `_handleImportAndCopyLink` private method entirely
  3. Remove the `skipDesignDocLink` option parameter from `_writeDocToDocsDir` in PlannerPromptWriter (no longer used)

- **Implementation:**

```diff
--- a/src/services/PlanningPanelProvider.ts
+++ b/src/services/PlanningPanelProvider.ts
@@ -218,9 +218,6 @@ export class PlanningPanelProvider {
             case 'appendToPlannerPrompt': {
                 await this._handleAppendToPlannerPrompt(workspaceRoot, msg.sourceId, msg.docId, msg.docName, msg.content);
                 break;
             }
-            case 'importAndCopyLink': {
-                await this._handleImportAndCopyLink(workspaceRoot, msg.sourceId, msg.docId, msg.docName, msg.content);
-                break;
-            }
```

```diff
--- a/src/services/PlanningPanelProvider.ts
+++ b/src/services/PlanningPanelProvider.ts
@@ -833,18 +833,6 @@ export class PlanningPanelProvider {
         }
     }

-    private async _handleImportAndCopyLink(workspaceRoot: string, sourceId: string, docId: string, docName: string, content?: string): Promise<void> {
-        try {
-            // Write to .switchboard/docs/ (same as append, but without setting designDocLink)
-            let result;
-            if (content) {
-                // Use provided content directly (for pages that aren't cached)
-                result = await this._plannerPromptWriter.writeContentToDocsDir(workspaceRoot, content, docName, sourceId, { skipDesignDocLink: true });
-            } else {
-                result = await this._plannerPromptWriter.writeFromPlanningCache(workspaceRoot, sourceId, docId, docName, { skipDesignDocLink: true });
-            }
-            if (result.error) {
-                this._panel?.webview.postMessage({ type: 'importAndCopyLinkState', error: result.error });
-            } else {
-                this._panel?.webview.postMessage({ type: 'importAndCopyLinkState', success: true, path: result.savedPath });
-            }
-        } catch (err) {
-            this._panel?.webview.postMessage({ type: 'importAndCopyLinkState', error: String(err) });
-        }
-    }
-
     private async _handleFetchImportedDocs(workspaceRoot: string): Promise<void> {
```

```diff
--- a/src/services/PlannerPromptWriter.ts
+++ b/src/services/PlannerPromptWriter.ts
@@ -30,7 +30,7 @@ export class PlannerPromptWriter {
     /**
      * Shared logic: write content to .switchboard/docs/ with hash-based filename.
      * Idempotent by design: same content → same hash → same filename → overwrite with identical content.
-     * @param options.skipDesignDocLink - If true, do NOT set designDocLink (used by "Import and copy link")
+     * @param options.skipDesignDocLink - DEPRECATED: no longer used, kept for backward compatibility
      */
     private async _writeDocToDocsDir(
         workspaceRoot: string,
```

- **Clarification:** This cleanup removes dead code associated with the removed button functionality.

## Verification Plan

### Automated Tests
- Add test in `src/services/__tests__/PlannerPromptWriter.test.ts` (create if missing):
  - Mock `vscode.workspace.getConfiguration` to return a mock that tracks update calls
  - Call `writeContentToDocsDir` with test content
  - Assert that `designDocLink` was updated with the correct path
  - Assert that `designDocEnabled` was NOT updated (or was updated with `undefined`/no call recorded)
  - Assert success message does not contain "added to planner prompt"

### Manual Test Steps
1. Open VS Code with Switchboard extension in development mode
2. Open Kanban view → AGENTS tab
3. **Uncheck** "Append Design Doc to planner prompts" option
4. Open Planning Panel → Import a document from any source (Notion/Local/Linear/ClickUp)
5. Return to AGENTS tab → Verify the checkbox is **still unchecked**
6. Verify the document exists in `.switchboard/docs/` directory
7. Verify `designDocLink` in settings points to the imported doc
8. Re-enable the setting manually → Verify the imported doc is now used in planner prompts

### Expected Behavior After Fix

### User Flows

**Flow 1: Set up PRD for planning (One-Step)**
1. Import PRD from Notion → click "Import and set as active planning context"
2. Doc saved to `.switchboard/docs/` AND `designDocEnabled` is automatically enabled
3. PRD is now appended to all planner prompts immediately

**Flow 2: Switch active doc**
1. Import new doc → click "Import and set as active planning context"
2. Doc saved AND activated — checkbox stays enabled if it was already on
3. New doc is now used for prompts

**Flow 3: Disable design doc usage**
1. Uncheck checkbox in AGENTS tab → no docs appended to prompts
2. Docs remain in `.switchboard/docs/` and can be re-activated later by re-importing

### Guarantees
- Button "Import and set as active planning context" DOES enable `designDocEnabled`
- Checkbox in AGENTS tab allows disabling without re-importing
- Multiple docs can coexist; only the "active" one is used when enabled
- **Active Design Doc banner in Planning Panel shows current doc and "Turn off" button**

### UX Enhancement: Active Design Doc Banner
Added a banner at the top of both Local Docs and Online Docs tabs that:
- Shows the currently active design doc name (or "None" if disabled)
- Displays in teal highlight when active, muted when inactive
- Provides a "Turn off" button to disable without leaving the panel
- Updates immediately when imports or disables occur

**Files changed for banner:**
- `src/webview/planning.html` — Added banner HTML and CSS styling
- `src/webview/planning.js` — Added banner update logic and disable button handler
- `src/services/PlanningPanelProvider.ts` — Added `_handleDisableDesignDoc`, `_sendActiveDesignDocState`, `_getDesignDocName` methods

## Reviewer Findings

### Grumpy Review (Stage 1)
**CRITICAL:** ~~Success message "Design doc saved" may confuse users — conflates "file saved" with "design doc active" when checkbox could be off.~~ **[FIXED: Button now DOES activate the feature]**
**MAJOR:** `skipDesignDocLink` parameter still used in `writeFromPlanningCache` despite DEPRECATED marker — either remove fully or stop deprecating.
**MAJOR:** No automated test verifying `designDocEnabled` IS set on import — regression risk for future changes.
**NIT:** Button label "Import and set as active planning context" is verbose (42 chars) — may truncate.

### Balanced Synthesis (Stage 2)
Implementation corrected based on user feedback (Option B):
- `designDocEnabled: true` RESTORED to `_writeDocToDocsDir` when `!skipDesignDocLink`
- Success message updated to "Design doc imported and activated" — now accurate
- Button labels updated, "Copy Link" buttons removed
- `_handleImportAndCopyLink` handler completely removed

The button now does what users expect: one click imports AND activates. The AGENTS tab checkbox becomes a "disable" control rather than an additional "enable" step. Much better UX.

## Validation Results
- [x] Code verified: `designDocEnabled: true` SET when importing via main flow
- [x] Code verified: `_handleImportAndCopyLink` handler removed from PlanningPanelProvider.ts
- [x] Code verified: `importAndCopyLink` message case removed
- [x] Code verified: Button labels updated in planning.html (lines 843, 871)
- [x] Code verified: "Copy Link" buttons removed from both control strips
- [x] Code verified: Success message updated to "Design doc imported and activated from ${sourceName}"
- [x] Code verified: `skipDesignDocLink` marked DEPRECATED in JSDoc
- [x] Code verified: Active design doc banner HTML/CSS added to planning.html
- [x] Code verified: Banner update logic added to planning.js
- [x] Code verified: `_handleDisableDesignDoc`, `_sendActiveDesignDocState`, `_getDesignDocName` added to PlanningPanelProvider.ts
- [ ] Automated test verifying setting IS modified on import (needs VS Code mock)
- [ ] Manual verification in VS Code runtime environment

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-25T11:59:32.795Z
**Format Version:** 1
