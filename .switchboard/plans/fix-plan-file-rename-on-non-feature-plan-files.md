# Fix Unwanted Plan File Rename on Non-feature_plan Files

## Goal
Plan files that were created manually (e.g. `move-agent-prompt-config-to-kanban.md`) are being silently renamed by `_renameSessionPlanFile` when their topic slug doesn't already appear in the filename. This is destructive: VS Code editors lose their open file reference, the user's manually-curated filename is lost, and the plan dropdown shows a confusing new filename. The fix must make rename opt-in only for `feature_plan_` prefixed files.

## Metadata
**Tags:** bug, core, filesystem
**Complexity:** 3

## Root Cause (Confirmed)

In `TaskViewerProvider.ts` line 10544–10602, `_renameSessionPlanFile` is called whenever `savePlanText` is invoked (line 10750). The rename logic:

```ts
const prefixMatch = currentBase.match(/^(feature_plan_\d{8}_\d{6})_/i);
const prefix = prefixMatch ? prefixMatch[1] : currentBase;  // ← BUG
const slug = this._toPlanSlug(nextTopic);
const baseTargetName = `${prefix}_${slug}${currentExt}`;
```

When `prefixMatch` is null (any non-`feature_plan_` file), `prefix` becomes the **entire current basename**. The new target name is `<originalBasename>_<topicSlug>.md`. Since this differs from the current filename, `fs.promises.rename` is called.

**Example:** `move-agent-prompt-config-to-kanban.md` + topic "Move Agent and Prompt Configuration to Kanban View" → `move-agent-prompt-config-to-kanban_move_agent_and_prompt_configuration_to_kanban_view.md`

This also explains clipboard import failures: `importPlanFromClipboard` (line 13018) calls `_createInitiatedPlan` for single-plan imports (no `### PLAN N START` markers) which writes the file and registers it. When the user then opens that plan in the review panel and it syncs via `savePlanText`, the rename fires.

## Complexity Audit

### Routine
- The fix is a 1-line guard in `_renameSessionPlanFile`: if the file does not have a `feature_plan_` prefix, skip the rename entirely.
- Zero downstream callers need changes — they already handle the case where `planFileAbsolute === candidateAbsolute` (no-op return).
- Existing test coverage for `_renameSessionPlanFile` must be updated to assert the new guard behavior.

### Complex / Risky
- None. The guard is inserted before the `fs.promises.rename` call and returns the unchanged path tuple. Worst case: a `feature_plan_` file that previously got renamed correctly now also passes through. But that path is unchanged by this fix.

## Edge-Case Audit
- **Files already double-renamed** (like `move-agent-prompt-config-to-kanban_move_agent_and_prompt_configuration_to_kanban_view.md`): the guard will stop future re-renames of these files too, since they also lack the `feature_plan_` prefix.
- **`feature_plan_` files**: behavior completely unchanged — they still get their topic slug suffix updated on save.
- **Files in subdirectory repo scopes** (e.g. `.switchboard/plans/myrepo/my-plan.md`): same guard applies. Repo-scoped manually-named files are also protected.
- **Import from clipboard (single plan, no markers)**: `_createInitiatedPlan` writes a `feature_plan_YYYYMMDD_HHMMSS_<slug>.md` file. The rename guard does NOT affect this path because the file already has the correct `feature_plan_` prefix.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line.

None.

## Adversarial Synthesis

### Grumpy Critique
*"This fix is too narrow. If someone imports a plan from clipboard and the content has a different H1 than the filename, renaming it to match the H1 is CORRECT behavior for feature_plan files. The real issue is that manually-named plans were ever tracked by the DB at all — once tracked, any save triggers the rename. The fix should also prevent manually-named plans from being imported into the DB in the first place, or add a 'user-owned filename' flag to the DB record so the rename logic can respect it regardless of filename prefix."*

### Balanced Response
The grumpy critique raises a valid architectural point but is out of scope for a complexity-3 bug fix. The `feature_plan_` prefix guard is the minimal safe fix that restores expected behavior immediately without touching the DB schema or import pipeline. A future improvement can add a `userOwnedFilename` boolean to `KanbanPlanRecord` and use that as the canonical check — but that is a separate, larger change.

## Proposed Changes

### Component: `src/services/TaskViewerProvider.ts`

#### [MODIFY] `_renameSessionPlanFile` (line ~10544)

Add an early-exit guard. If the current file does **not** start with the `feature_plan_YYYYMMDD_HHMMSS_` prefix, return without renaming:

```ts
private async _renameSessionPlanFile(
    workspaceRoot: string,
    sessionId: string,
    sheet: any,
    nextTopic: string
): Promise<{ planFileAbsolute: string; planFileRelative: string }> {
    const currentPlanFileAbsolute = this._getPlanPathFromSheet(workspaceRoot, sheet);
    const currentRelative = (typeof sheet.planFile === 'string' && sheet.planFile.trim())
        ? sheet.planFile.trim().replace(/\\/g, '/')
        : path.relative(workspaceRoot, currentPlanFileAbsolute).replace(/\\/g, '/');
    const currentExt = path.extname(currentPlanFileAbsolute) || '.md';
    const currentBase = path.basename(currentPlanFileAbsolute, currentExt);

    // ── GUARD: only rename files that follow the feature_plan_ naming convention ──
    // Manually-named plan files (e.g. my-feature.md) must never be silently renamed.
    const prefixMatch = currentBase.match(/^(feature_plan_\d{8}_\d{6})_/i);
    if (!prefixMatch) {
        return { planFileAbsolute: currentPlanFileAbsolute, planFileRelative: currentRelative };
    }
    // ── END GUARD ──

    const currentDir = path.dirname(currentPlanFileAbsolute);
    const prefix = prefixMatch[1];
    const slug = this._toPlanSlug(nextTopic);
    const baseTargetName = `${prefix}_${slug}${currentExt}`;
    let candidateAbsolute = path.join(currentDir, baseTargetName);
    let suffix = 2;
    while (candidateAbsolute !== currentPlanFileAbsolute && fs.existsSync(candidateAbsolute)) {
        candidateAbsolute = path.join(currentDir, `${prefix}_${slug}_${suffix}${currentExt}`);
        suffix += 1;
    }

    if (candidateAbsolute === currentPlanFileAbsolute) {
        return { planFileAbsolute: currentPlanFileAbsolute, planFileRelative: currentRelative };
    }

    await fs.promises.rename(currentPlanFileAbsolute, candidateAbsolute);
    const nextRelative = path.relative(workspaceRoot, candidateAbsolute).replace(/\\/g, '/');

    await this._getSessionLog(workspaceRoot).updateRunSheet(sessionId, (current: any) => {
        current.planFile = nextRelative;
        return current;
    });

    const planId = this._getPlanIdForRunSheet(sheet);
    if (planId) {
        const entry = this._planRegistry.entries[planId];
        if (entry) {
            entry.localPlanPath = nextRelative;
            entry.updatedAt = new Date().toISOString();
            await this._savePlanRegistry(workspaceRoot);
        }
    }

    const db = await this._getKanbanDb(workspaceRoot);
    if (db) {
        await db.updatePlanFile(sessionId, nextRelative);
    }

    sheet.planFile = nextRelative;
    return { planFileAbsolute: candidateAbsolute, planFileRelative: nextRelative };
}
```

**Exact diff (minimal):** Move the `prefixMatch` extraction before the `currentDir` line and add the early-return guard immediately after:

```diff
     const currentExt = path.extname(currentPlanFileAbsolute) || '.md';
     const currentBase = path.basename(currentPlanFileAbsolute, currentExt);
-    const prefixMatch = currentBase.match(/^(feature_plan_\d{8}_\d{6})_/i);
-    const prefix = prefixMatch ? prefixMatch[1] : currentBase;
+    const prefixMatch = currentBase.match(/^(feature_plan_\d{8}_\d{6})_/i);
+    if (!prefixMatch) {
+        return { planFileAbsolute: currentPlanFileAbsolute, planFileRelative: currentRelative };
+    }
+    const prefix = prefixMatch[1];
     const slug = this._toPlanSlug(nextTopic);
```

## Verification Plan

### Automated Tests
- In the existing `_renameSessionPlanFile` tests, add a case where `currentBase = 'my-custom-plan'` and assert the returned paths are identical to the inputs (no rename, no FS call).
- Existing `feature_plan_` rename tests must still pass unchanged.

### Manual Verification
1. Create a plan manually: `touch .switchboard/plans/test-manual-plan.md` with a `# Test Manual Plan` H1
2. Import it via Reset Database / file watcher
3. Open it in the Plan Review panel
4. Edit the plan text and click Save
5. Verify: filename remains `test-manual-plan.md` (not `test-manual-plan_test_manual_plan.md`)
6. Verify: `feature_plan_` prefixed plans still rename correctly when topic is changed via the ticket title field

## Reviewer Pass Results

**Reviewer:** Inline pass — 2026-04-25
**Verdict:** APPROVED — No code changes required.

### Findings
- **CRITICAL:** None
- **MAJOR:** None
- **NIT:** `const currentDir = path.dirname(currentPlanFileAbsolute)` (line 10568) is computed before the `prefixMatch` guard (line 10571–10573). For non-`feature_plan_` files, the function returns immediately after the guard, so `currentDir` is computed but never used. One wasted `path.dirname` call per no-op — completely harmless.
- **NIT:** No automated unit test for `_renameSessionPlanFile` with a non-`feature_plan_` filename. Manual verification only. Low risk given the simplicity of the guard, but a future improvement opportunity.

### Code Verification
Lines 10571–10574 in `TaskViewerProvider.ts`:
```typescript
const prefixMatch = currentBase.match(/^(feature_plan_\d{8}_\d{6})_/i);
if (!prefixMatch) {
    return { planFileAbsolute: currentPlanFileAbsolute, planFileRelative: currentRelative };
}
```
Guard is correctly placed. Returns the unchanged `currentRelative` (correctly computed from `sheet.planFile` before the guard). ✅

### Typecheck
`npx tsc --noEmit` → 2 pre-existing TS2835 errors in unrelated files. **Zero errors in changed files.**

### Remaining Risks
- No automated test covering the non-`feature_plan_` guard. Manual testing only.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-24T23:02:01.147Z
**Format Version:** 1
