# Fix Planning Panel Workspace Root Detection

## Goal
Fix the Planning Panel documents view so it uses the active workspace folder instead of always defaulting to the first workspace folder in multi-root workspaces. This resolves the issue where documents appear empty when working in non-primary workspace folders.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 2

## User Review Required
None. This is a transparent bugfix with no breaking changes or manual steps required.

## Complexity Audit

### Routine
- Single-line function modification in `extension.ts`
- Uses existing VS Code API (`vscode.window.activeTextEditor`, `vscode.workspace.getWorkspaceFolder`)
- Simple fallback chain: active file → workspace folder → first workspace folder

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** 
- None. The workspace root detection runs synchronously when the Planning Panel opens.

**Security:** 
- No external inputs. Only uses VS Code's internal APIs and file system paths already accessible to the user.

**Side Effects:** 
- None. The function is pure with no persistent state mutations.

**Dependencies & Conflicts:**
- Kanban board is currently empty (no active plans in CREATED or PLANNED columns).
- No cross-plan conflicts detected.
- Must coordinate with Plan 1 (file watcher changes) if both affect workspace root resolution patterns.

## Dependencies
None

## Problem
In multi-root VS Code workspaces (e.g., autism360.code-workspace), the Planning Panel always uses the first workspace folder to determine the workspace root, regardless of which folder the user is actively working in. This causes the documents view to look for `.switchboard/docs` in the wrong location.

When working in the switchboard project (mounted as a secondary folder in the Gitlab workspace), the Planning Panel uses the Gitlab root instead of the switchboard root, resulting in an empty documents view because it's searching in the wrong `.switchboard/docs` directory.

## Root Cause
In `src/extension.ts` line 1339, the `PlanningPanelProvider` is initialized with:

```typescript
() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
```

This function always returns the first workspace folder, ignoring which workspace folder contains the currently active file or which folder the user is actually working in.

## Proposed Changes

### 1. Update workspace root detection to use active workspace
#### [MODIFY] `src/extension.ts`
- **Context:** Line 1339 in the PlanningPanelProvider constructor initialization
- **Logic:**
  1. Check if there's an active text editor
  2. Get the workspace folder for the currently open file
  3. Fall back to the first workspace folder if no file is open
- **Implementation:**

```diff
--- a/src/extension.ts
+++ b/src/extension.ts
@@
     const planningPanelProvider = new PlanningPanelProvider(
         context.extensionUri,
         researchImportService,
         plannerPromptWriter,
-        () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
+        () => {
+            const activeTextEditor = vscode.window.activeTextEditor;
+            if (activeTextEditor) {
+                const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeTextEditor.document.uri);
+                if (activeWorkspaceFolder) {
+                    return activeWorkspaceFolder.uri.fsPath;
+                }
+            }
+            return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
+        },
         {
             getNotionService: (root) => (kanbanProvider as any)._getNotionService(root),
             getNotionBrowseService: (root) => (kanbanProvider as any)._getNotionBrowseService(root),
```

## Verification Plan

### Automated Tests
- `npm run compile`

### Manual Verification Steps
1. Open the autism360.code-workspace in VS Code
2. Open a file from the switchboard project (e.g., `/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts`)
3. Open the Planning Panel
4. Verify that the documents view now shows imported docs from the switchboard project's `.switchboard/docs` directory
5. Switch to a file in the Gitlab root (e.g., `/Users/patrickvuleta/Documents/Gitlab/ai/app.ts`)
6. Refresh or reopen the Planning Panel
7. Verify that the documents view now shows imported docs from the Gitlab root's `.switchboard/docs` directory
8. Close all files and reopen the Planning Panel
9. Verify it falls back to the first workspace folder (Gitlab root)

## Edge Cases Handled
- **No active file:** Falls back to the first workspace folder (existing behavior)
- **Single-root workspace:** Behavior unchanged (active folder = first folder)
- **File outside workspace:** Falls back to first workspace folder
- **Multiple workspace folders:** Uses the folder containing the active file

---
**Recommendation:** Send to Coder (Complexity 2)

## Adversarial Synthesis
Key risks: Panel state stale if user switches files without reopening panel; `triggerPlanningPanelSync` command at line 1359 still uses first folder. Mitigations: Document need to reopen panel when switching contexts; consider updating sync command in future work.

## Dependencies & Conflicts
- No other active plans modify the PlanningPanelProvider initialization
- This change is isolated to the workspace root detection logic only
- No changes to the PlanningPanelProvider class itself
- **Clarification:** The `triggerPlanningPanelSync` command at line 1359 also uses `workspaceFolders?.[0]`; this is out of scope for this plan but noted for future improvement

---

# Reviewer Pass Results

**Review Date:** 2026-04-29
**Reviewer:** Direct Reviewer Pass (in-place)
**Files Reviewed:** `src/extension.ts` (lines 1339-1373)

## Stage 1: Grumpy Adversarial Critique

*Incisive, specific, theatrical — the Principal Engineer is NOT amused...*

### NIT: The Ghost of Code Past
**Severity:** NIT

Look at line 1368, mere inches below our }iggered fix. The `triggerPlanningPanelSync` command still uses the OLD pattern `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`. Did we just... forget? Or is this intentional? The plan acknowledges this at line 124 with "this is out of scope" — but proximity breeds suspicion. The sync command will still grab the FIRST folder while the panel itself is now context-aware. Enjoy your inconsistent state, users! (*Plan acknowledges this; no fix required per scope*)

### NIT: The Stale State Tango
**Severity:** NIT

The Planning Panel captures the workspace root at OPEN time. User switches to a different folder WITHOUT reopening the panel? Panel still shows docs from the OLD folder. No automatic refresh. No reactive sync. The plan's "Edge Cases Handled" section smugly notes this is "expected behavior" — but expected does not mean *good*. (*Documented limitation; acceptable for Complexity 2*)

### NIT: Type Safety? Never Heard of Her
**Severity:** NIT

The return type of that arrow function is inferred. No explicit `: string | undefined` annotation. VS Code's language server will figure it out... probably. For a mission-critical path like workspace resolution, I'd prefer explicit intent. (*TSC compiles successfully; acceptable*)

## Stage 2: Balanced Synthesis

### What to Keep
- ✅ **Logic is correct**: Active editor → workspace folder → first folder fallback is the RIGHT chain
- ✅ **Minimal change**: Single function body replacement, no external API churn
- ✅ **Fallback preserved**: Existing behavior maintained when no editor is active
- ✅ **Compilation clean**: Zero errors, zero warnings from `npm run compile`

### What to Fix Now
- **NONE** — All identified issues are either (a) documented out-of-scope per plan, or (b) NIT-severity style preferences

### What Can Defer
- `triggerPlanningPanelSync` alignment: Out of scope per plan; address in future sprint if sync consistency becomes user-visible
- Panel refresh on folder switch: Requires reactive architecture work beyond Complexity 2

## Files Changed
| File | Lines | Change Type | Description |
|------|-------|-------------|-------------|
| `src/extension.ts` | 1339-1348 | MODIFY | Replaced single-line arrow function with multi-line active-editor-aware logic |

## Validation Results

### Automated Tests
```
npm run compile
webpack 5.105.4 compiled successfully in 23748 ms
Exit code: 0
```
**Result:** PASSED — No TypeScript errors, no build failures

### Manual Verification
- [ ] Open autism360.code-workspace and verify multi-root behavior (requires IDE interaction)
- [ ] Verify fallback when no active editor (requires IDE interaction)

**Note:** Automated verification limited to compilation. Full manual verification requires active VS Code session with multi-root workspace.

## Remaining Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| Panel state stale on folder switch without reopen | LOW | Documented; user must reopen panel |
| `triggerPlanningPanelSync` uses first folder always | LOW | Out of scope; noted for future work |
| Active file outside all workspace folders falls back to first | LOW | Documented fallback behavior |

## Final Verdict
**APPROVED with observations.** Implementation matches plan specification. Zero code fixes required. Minor architectural inconsistencies noted but explicitly out-of-scope.
