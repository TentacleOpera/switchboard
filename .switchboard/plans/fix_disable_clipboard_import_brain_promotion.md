# Fix: Disable Auto-Promotion of Clipboard Imports to Antigravity Brain

## Goal
Prevent clipboard imports from being auto-promoted to the Antigravity brain, eliminating duplicate kanban cards caused by the brain watcher's mirroring behavior.

## Metadata
**Tags:** backend, UI, bugfix
**Complexity:** 4

## User Review Required
> [!NOTE]
> - No user-facing configuration change is required.
> - Verify local clipboard imports still create normal plans/cards, but no longer create `~/.gemini/antigravity/brain/feature_plan_*.md` copies or mirrored `antigravity_...` duplicates.
> - **Clarification:** Keep ordinary draft-plan creation on the current promotion path; only confirmed clipboard-import entry points should opt out.
> - **Clarification:** The repo scan proved three current `_createInitiatedPlan()` callers in `src/services/TaskViewerProvider.ts` (draft creation at line 10477, single clipboard import at line 10511, multi-plan import at line 10599). No active `isAirlock=true` caller was proven in this workspace.

## Complexity Audit
### Routine
- Add an optional `skipBrainPromotion` parameter to `_createInitiatedPlan()` in `src/services/TaskViewerProvider.ts:10625-10692`, defaulting to `false`.
- Update the exact clipboard-import call sites in `src/services/TaskViewerProvider.ts:10511` and `src/services/TaskViewerProvider.ts:10599` to pass `true`.
- Leave the draft-plan flow at `src/services/TaskViewerProvider.ts:10472-10478` unchanged so ordinary plans still auto-promote.
- Add a focused regression test in `src/test/clipboard-import-brain-promotion-regression.test.js`.
- Original low-complexity assessment preserved: this remains a small change centered on one parameter addition and two clipboard-import call-site updates.

### Complex / Risky
- The only real risk is accidentally changing the default behavior of the shared creation funnel. If `skipBrainPromotion` does not default to `false`, or if the guard wraps more than the `_promotePlanToBrain()` block, ordinary draft-plan creation will silently stop syncing to the Antigravity brain.

## Edge-Case & Dependency Audit
- **Race Conditions:** `_createInitiatedPlan()` schedules `_promotePlanToBrain()` as a fire-and-forget task after the plan file is written, registered, and surfaced in the UI (`src/services/TaskViewerProvider.ts:10684-10690`). Clipboard imports must bypass that async branch entirely; otherwise a delayed copy into `~/.gemini/antigravity/brain/` can still trigger the brain watcher at `src/services/TaskViewerProvider.ts:5108-5152` and create a second mirrored card after the first local card already exists.
- **Security:** No auth or secret-handling behavior changes. Clipboard content continues to be written only to the local plan file; this plan should not add new logging, token handling, or new filesystem destinations beyond the existing optional brain copy.
- **Side Effects:** Clipboard-imported plans will stop participating in cross-workspace Antigravity sync by design. Ordinary draft plans must keep promoting to the brain. This plan should not change `_isLikelyPlanFile()` (`src/services/TaskViewerProvider.ts:7003-7020`), `_promotePlanToBrain()` itself (`src/services/TaskViewerProvider.ts:10703-10717`), or duplicate cleanup in `src/services/KanbanDatabase.ts:1118-1126`.
- **Dependencies & Conflicts:** `fix_terminal_disconnect_on_minimize.md` targets `src/extension.ts` and has no overlap. There is file-level merge pressure with `brain_f0df2dc1687320b9685b43413e91ac53e7b8ceaedca3083dd769c0e19de4f4b7_antigravity_brain_plans_still_not_being_detected.md`, `restore_completed_column_visibility_and_preserve_completed_status.md`, and the user-listed `simplify_clickup_automation.md`, because all three plans touch `src/services/TaskViewerProvider.ts`; the Antigravity detection plan also shares the same brain-ingestion subsystem. No runtime dependency is required, but these plans should be rebased carefully if they land together. **Clarification:** `switchboard-get_kanban_state` currently reports `Simplify ClickUp Automation` in **Lead Coder**, not **Planned**; it was still scanned as active because the user explicitly listed it in the active context.

## Adversarial Synthesis
### Grumpy Critique
> Oh good, another "tiny" fix in the one shared method every plan-creation path runs through. That is exactly how you ship a stealth regression: bolt a clipboard special-case onto `_createInitiatedPlan()`, forget the default, and suddenly ordinary draft plans stop syncing to the Antigravity brain while everyone swears "we only changed import." And if clipboard imports still hit `_promotePlanToBrain()` even once, the watcher does what it was built to do and manufactures a second `antigravity_...` card. Congratulations, the bug is no longer deterministic; it is just harder to reproduce.
>
> The other trap is scope creep dressed up as cleanup. The duplicate-card symptom tempts people to "also fix" `_mirrorBrainPlan()`, `_isLikelyPlanFile()`, or `cleanupSpuriousMirrorPlans()`. That is how a two-call-site opt-out turns into a weekend of watcher regressions. This plan only works if it stays ruthlessly boring: opt clipboard imports out before the fire-and-forget brain copy, prove ordinary draft creation still opts in, and leave the rest of the Antigravity machinery alone.

### Balanced Response
> The safe implementation is deliberately narrow. `_createInitiatedPlan()` remains the single creation funnel, but it gains an explicit `skipBrainPromotion = false` parameter so existing callers preserve today's behavior unless they opt out. Only the confirmed clipboard-import call sites at `src/services/TaskViewerProvider.ts:10511` and `src/services/TaskViewerProvider.ts:10599` pass `true`, which prevents the duplicate-card path by never scheduling `_promotePlanToBrain()` for imported content.
>
> To keep the change honest, the plan adds a regression test that locks three facts at once: single clipboard imports opt out, multi-plan clipboard imports opt out, and ordinary draft creation still uses the default promotion path. Just as important, the plan explicitly leaves watcher heuristics, mirror ingestion, and Kanban dedupe code untouched, avoiding scope creep and avoiding unnecessary overlap with the separate Antigravity detection plan.

## Preserved Original Draft
### Context
When a user imports a plan from the clipboard, `_createInitiatedPlan` creates the plan file and then calls `_promotePlanToBrain` which copies the file to `~/.gemini/antigravity/brain/`. The brain watcher then detects this new file and creates a mirrored version with an `antigravity_` prefix session ID, resulting in two kanban cards for the same plan content.

Clipboard imports are typically one-off tasks that do not need cross-workspace sync via the brain.

### Original Proposed Changes
#### File: `src/services/TaskViewerProvider.ts`

Modify `_createInitiatedPlan` to accept an optional `skipBrainPromotion` parameter and skip the `_promotePlanToBrain` call when true.

```typescript
private async _createInitiatedPlan(
    title: string, 
    idea: string, 
    isAirlock: boolean,
    skipBrainPromotion: boolean = false  // <-- ADD
): Promise<{ sessionId: string; planFileAbsolute: string; }> {
    // ... existing code ...
    
    await this._syncFilesAndRefreshRunSheets();
    this._view?.webview.postMessage({ type: 'selectSession', sessionId });

    // Non-blocking auto-promotion: copy plan to Antigravity brain
    // SKIP for clipboard imports to prevent duplicate kanban cards
    if (!skipBrainPromotion) {  // <-- ADD
        void this._promotePlanToBrain(planFileAbsolute, fileName).catch((e) => {
            console.error('[TaskViewerProvider] Auto-promotion to brain failed (non-fatal):', e);
        });
    }

    return { sessionId, planFileAbsolute };
}
```

Update all callers of `_createInitiatedPlan`:
1. **Clipboard import** (`importPlanFromClipboard` and `_importMultiplePlansFromClipboard`): Pass `skipBrainPromotion: true`
2. **All other callers** (airlock, create plan button, etc.): Leave as default `false` to preserve existing behavior

### Specific call sites to update

Line ~10511 (single plan import):
```typescript
await this._createInitiatedPlan(title, text, false, true);  // Add true
```

Line ~10599 (multi-plan import loop):
```typescript
await this._createInitiatedPlan(plan.title, plan.content, false, true);  // Add true
```

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Keep this fix limited to the clipboard-import creation path. Do not broaden scope into brain detection heuristics, mirror cleanup, Kanban status logic, or ClickUp automation.

### Clarification - Preserved context and scope guard
- When a user imports a plan from the clipboard, `_createInitiatedPlan()` writes the local plan file and currently always calls `_promotePlanToBrain()`, which copies the same file into `~/.gemini/antigravity/brain/` (`src/services/TaskViewerProvider.ts:10625-10717`).
- The brain watcher then sees that new brain file, runs it back through `_mirrorBrainPlan()` / `_isLikelyPlanFile()` (`src/services/TaskViewerProvider.ts:5108-5152` and `7003-7020`), and can create a mirrored `antigravity_...` session/card for the same content before cleanup logic catches up.
- Clipboard imports are typically one-off tasks that do not need cross-workspace sync via the brain.
- **Clarification:** Do not modify watcher heuristics, duplicate cleanup, or any other Antigravity ingestion code in this plan. The only behavior change here is whether clipboard-imported plans enter the existing promotion path.

### Clipboard import creation funnel
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** This file contains every proven touchpoint for the bug: `createDraftPlanTicket()` at `10472-10478`, `importPlanFromClipboard()` at `10485-10523`, `_importMultiplePlansFromClipboard()` at `10525-10623`, `_createInitiatedPlan()` at `10625-10692`, and `_promotePlanToBrain()` at `10703-10717`.
- **Logic:**
  1. Extend `_createInitiatedPlan(title, idea, isAirlock)` to accept `skipBrainPromotion: boolean = false`.
  2. Leave file creation, runsheet creation, plan registration, logging, sync, and webview selection untouched.
  3. Wrap only the fire-and-forget `_promotePlanToBrain(planFileAbsolute, fileName)` block in `if (!skipBrainPromotion)`.
  4. Update the exact clipboard-import call sites to pass `true`:
     - Single plan import: `src/services/TaskViewerProvider.ts:10511`
     - Multi-plan import loop: `src/services/TaskViewerProvider.ts:10599`
  5. Keep the draft-plan caller at `src/services/TaskViewerProvider.ts:10477` unchanged so default promotion behavior survives.
  6. **Clarification:** The repo scan did not prove any current `isAirlock=true` caller, so do not invent additional call-site changes.
- **Implementation:**
```diff
--- a/src/services/TaskViewerProvider.ts
+++ b/src/services/TaskViewerProvider.ts
@@ -10508,7 +10508,7 @@
             }
 
             try {
-                await this._createInitiatedPlan(title, text, false);
+                await this._createInitiatedPlan(title, text, false, true);
                 await this._syncFilesAndRefreshRunSheets();
                 vscode.window.showInformationMessage(`Imported plan: ${title}`);
             } catch (err: any) {
@@ -10596,7 +10596,7 @@
 
         for (const plan of plans) {
             try {
-                await this._createInitiatedPlan(plan.title, plan.content, false);
+                await this._createInitiatedPlan(plan.title, plan.content, false, true);
                 importedTitles.push(plan.title);
             } catch (err: any) {
                 const msg = err?.message || String(err);
@@ -10622,7 +10622,12 @@
         }
     }
 
-    private async _createInitiatedPlan(title: string, idea: string, isAirlock: boolean): Promise<{ sessionId: string; planFileAbsolute: string; }> {
+    private async _createInitiatedPlan(
+        title: string,
+        idea: string,
+        isAirlock: boolean,
+        skipBrainPromotion: boolean = false
+    ): Promise<{ sessionId: string; planFileAbsolute: string; }> {
         const workspaceRoot = this._resolveWorkspaceRoot();
         if (!workspaceRoot) {
             throw new Error('No workspace folder found.');
@@ -10684,9 +10689,12 @@
             await this._syncFilesAndRefreshRunSheets();
             this._view?.webview.postMessage({ type: 'selectSession', sessionId });
 
-            // Non-blocking auto-promotion: copy plan to Antigravity brain
-            void this._promotePlanToBrain(planFileAbsolute, fileName).catch((e) => {
-                console.error('[TaskViewerProvider] Auto-promotion to brain failed (non-fatal):', e);
-            });
+            // Non-blocking auto-promotion: copy plan to Antigravity brain.
+            // Clipboard imports opt out to avoid duplicate mirrored kanban cards.
+            if (!skipBrainPromotion) {
+                void this._promotePlanToBrain(planFileAbsolute, fileName).catch((e) => {
+                    console.error('[TaskViewerProvider] Auto-promotion to brain failed (non-fatal):', e);
+                });
+            }
 
             return { sessionId, planFileAbsolute };
         } finally {
```
- **Edge Cases Handled:** Single-plan and multi-plan clipboard imports both bypass the brain-copy path; ordinary draft creation keeps the existing default; no watcher timing, registry, or duplicate-cleanup behavior changes are required.

### Regression guard for clipboard-only opt-out
#### [CREATE] `src/test/clipboard-import-brain-promotion-regression.test.js`
- **Context:** The repo already uses source-based regression locks for fragile `TaskViewerProvider` behavior in files such as `src/test/brain-new-plan-visibility-regression.test.js` and `src/test/brain-duplicate-dedupe-regression.test.js`. There is currently no explicit guard ensuring clipboard imports opt out without breaking ordinary draft plan promotion.
- **Logic:**
  1. Read `src/services/TaskViewerProvider.ts` as source text.
  2. Assert the single-plan clipboard import path passes `skipBrainPromotion=true`.
  3. Assert the multi-plan clipboard import loop passes `skipBrainPromotion=true`.
  4. Assert `createDraftPlanTicket()` still calls `_createInitiatedPlan(title, idea, false)` with the default behavior.
  5. Assert `_createInitiatedPlan()` declares `skipBrainPromotion: boolean = false` and wraps `_promotePlanToBrain()` inside `if (!skipBrainPromotion)`.
- **Implementation:**
```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('clipboard import brain-promotion regressions', () => {
    it('opts both clipboard import entry points out of brain promotion', () => {
        assert.match(
            source,
            /public async importPlanFromClipboard\(\): Promise<void> \{[\s\S]*await this\._createInitiatedPlan\(title, text, false, true\);/,
            'Expected single-plan clipboard import to pass skipBrainPromotion=true.'
        );

        assert.match(
            source,
            /private async _importMultiplePlansFromClipboard\(text: string\): Promise<void> \{[\s\S]*await this\._createInitiatedPlan\(plan\.title, plan\.content, false, true\);/,
            'Expected multi-plan clipboard imports to pass skipBrainPromotion=true for each imported plan.'
        );
    });

    it('keeps ordinary draft-plan creation on the default promotion path', () => {
        assert.match(
            source,
            /public async createDraftPlanTicket\(\): Promise<void> \{[\s\S]*await this\._createInitiatedPlan\(title, idea, false\);/,
            'Expected normal draft plan creation to keep the default brain-promotion behavior.'
        );
    });

    it('guards fire-and-forget brain promotion behind skipBrainPromotion', () => {
        assert.match(
            source,
            /private async _createInitiatedPlan\(\s*title: string,\s*idea: string,\s*isAirlock: boolean,\s*skipBrainPromotion: boolean = false\s*\): Promise<\{ sessionId: string; planFileAbsolute: string; \}> \{[\s\S]*if \(!skipBrainPromotion\) \{[\s\S]*void this\._promotePlanToBrain\(planFileAbsolute, fileName\)\.catch\(\(e\) => \{/,
            'Expected _createInitiatedPlan to skip auto-promotion when skipBrainPromotion=true.'
        );
    });
});
```
- **Edge Cases Handled:** The test locks the intended asymmetry: clipboard imports opt out, normal draft plans still opt in. Because it asserts the default parameter as well as both call sites, it catches the subtle regression where a future refactor changes all creation flows instead of only clipboard imports.

## Verification Plan
### Automated Tests
- Add `src/test/clipboard-import-brain-promotion-regression.test.js`.
- Run `npm run compile` to verify the `TaskViewerProvider.ts` signature change still type-checks through the extension bundle.
- Record that `npm run lint` currently fails at baseline because ESLint 9 cannot find an `eslint.config.*` file; do not expand this bugfix to repair repo-wide lint tooling.
- Run `npm test` so the new regression file executes under the existing test harness alongside the current Antigravity regression coverage.

### Manual Checks
1. **Test clipboard import:**
   - Copy a Markdown plan to clipboard.
   - Click "Import from Clipboard" in Kanban.
   - Verify only **one** card appears in the CREATED column.
   - Verify no file is created in `~/.gemini/antigravity/brain/`.
2. **Test regular plan creation still promotes:**
   - Create a new plan via "Create Plan".
   - Verify a file **is** created in `~/.gemini/antigravity/brain/`.
   - Verify no duplicate Kanban cards appear.
3. **Regression test multi-plan import:**
   - Import multiple plans at once using `### PLAN N START` markers.
   - Verify the card count matches the number of imported plans.
   - Verify no mirrored `antigravity_...` duplicates appear.

## Agent Recommendation
- Send to Coder

## Open Questions
- None

## Review Findings
### Stage 1 — Grumpy Principal Engineer
- **CRITICAL:** `src/test/clipboard-import-brain-promotion-regression.test.js` was written as a Mocha-style `describe()/it()` file, but this repo already exercises source-regression tests directly with `node`. Running it that way exploded immediately with `ReferenceError: describe is not defined`, so the promised regression guard was dead on arrival.
- **MAJOR:** The same test also anchored its path off `__dirname`, which is brittle for the repo's direct-node test pattern and makes the guard dependent on how the file is launched instead of the workspace root.
- **NIT:** The implementation change in `src/services/TaskViewerProvider.ts` is otherwise pleasantly boring, which is exactly what this fix needed. The problem was the test harness, not the clipboard opt-out logic.

### Stage 2 — Balanced Synthesis
- **Keep:** The `skipBrainPromotion` parameter on `_createInitiatedPlan()` and the two clipboard-import call-site updates are the right narrow fix.
- **Fix now:** The regression test must run under the repo's existing node-based test style, so it should read source from `process.cwd()` and execute via a plain `run()`/`try` wrapper.
- **Defer:** No additional Antigravity watcher, Kanban dedupe, or promotion-path changes are needed for this plan.

## Fixes Applied
- Converted `src/test/clipboard-import-brain-promotion-regression.test.js` to the repo's direct-node regression-test pattern.
- Switched the source read to `process.cwd()` so the test is stable when launched from the workspace root.

## Files Changed During Review
- `src/test/clipboard-import-brain-promotion-regression.test.js`
- `.switchboard/plans/fix_disable_clipboard_import_brain_promotion.md`
- `src/services/TaskViewerProvider.ts` (reviewed implementation surface; unchanged during this review)

## Validation Results
- `npm run compile` ✅
- `node src/test/clipboard-import-brain-promotion-regression.test.js` ✅
- `npm run lint` not run; repo baseline is known to fail because ESLint 9 cannot find an `eslint.config.*` file.

## Remaining Risks
- The regression test is source-text based, so harmless formatting churn in `TaskViewerProvider.ts` can require test updates.
- No runtime clipboard-import integration test was added; the guard is still structural, not end-to-end.
