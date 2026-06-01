---
description: Remove obsolete handoff workflow files and all references
---

# Remove Deprecated Handoff Workflows

## Goal

Remove the obsolete handoff workflow files (`handoff.md`, `handoff-chat.md`, `handoff-lead.md`, `handoff-relay.md`) from the extension source and all user workspaces, along with all code references. These workflows are leftover from the old delegation system that was replaced by the prompts tab checkboxes.

## Metadata

- **Tags:** workflow, reliability, cleanup
- **Complexity:** 4
- **Workspace:** single-repo

## User Review Required

None — internal extension cleanup.

## Complexity Audit

### Routine
- Delete four workflow files from `.agent/workflows/`
- Remove workflow documentation from two template files
- Remove workflow documentation from `extension.ts` help text (3 locations)
- Add workflow files to cleanup/blocklist arrays
- Remove dead `_workflowForColumn` method from `KanbanProvider.ts`
- Remove dead `workflowMap` function from `TaskViewerProvider.ts`
- Update runsheet logging calls to use generic workflow names or `undefined`

### Complex / Risky
- The `handoff` directory (`.switchboard/handoff/`) is still used for coder prompt backups — must NOT be removed
- `_updateSessionRunSheet` calls use workflow names for logging only — must be replaced with generic values or `undefined`
- Template files are copied to user workspaces during setup — must be updated to prevent re-documenting obsolete workflows

## Edge-Case & Dependency Audit

### Race Conditions
- On extension startup, the IDE may ingest workflow files into its prompt cache before `cleanupLegacyAgentFiles()` deletes them. The fix only guarantees cleanliness for subsequent sessions, not the current one. This is the same known limitation documented in the `no_git_for_agents.md` and `switchboard_modes.md` migration plans.

### Security
- No security implications. This is a deletion of obsolete workflow files.

### Side Effects
- The `.switchboard/handoff/` directory is NOT removed — it's still used for coder prompt backups in pair programming mode
- Runsheet logging will show generic workflow names instead of specific handoff workflow names (historical data only, no functional impact)
- Template files will no longer document handoff workflows — users relying on template documentation will see fewer workflow options

### Dependencies & Conflicts
- The `handoff` directory is referenced in `extension.ts` (line 2735) as a directory to create, and in `KanbanProvider.ts` (lines 2851, 5639) for prompt backups. These references must NOT be removed.
- The `handoff_clipboard` tool is documented in help text but is a separate MCP tool, not a workflow file. This documentation should remain.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Two additional locations in `extension.ts` were missed by the original plan — line 2805 generates README content that still documents `/handoff`, and line 3202 lists `handoff` as an example in the `start_workflow` tool description; both reach user workspaces and must be updated. (2) The `.switchboard/handoff/` directory is still used for prompt backups — all references must be audited to distinguish directory usage (keep) from workflow-name usage (remove). (3) The `_advanceSessionsInColumn` third parameter must accept `undefined` — verify the TypeScript signature before changing the call at KanbanProvider line ~4955. (4) Read the current `package.json` version before deciding the new version to avoid double-bumping if another in-flight plan has already incremented it. (5) `workflowMap` line numbers in `TaskViewerProvider.ts` may have drifted — re-verify before deleting. Mitigations: Grep for all `handoff` string literals in `src/` before editing, verify parameter types, read current version from `package.json`, re-verify all line ranges at edit time.

## Context

The handoff workflow files are leftover from the old delegation system where agents would delegate tasks to external terminals via the inbox protocol. The new prompts tab system replaced this with checkbox-based instruction injection, making the handoff workflows obsolete.

**Current state:**
- Four workflow files exist in `.agent/workflows/`: `handoff.md`, `handoff-chat.md`, `handoff-lead.md`, `handoff-relay.md`
- Template files document these workflows: `templates/cursor/cursor-instructions.md.template`, `templates/windsurf/windsurf-instructions.md.template`
- `extension.ts` references these workflows in **5 locations**: workflow tables at lines 3146-3149, 3177-3180, 3222-3225; generated README string at line 2805; `start_workflow` example text at line 3202
- Dead code exists: `_workflowForColumn` in `KanbanProvider.ts` (never called), `workflowMap` in `TaskViewerProvider.ts` (never called)
- Active code uses workflow names for runsheet logging only: `_updateSessionRunSheet` calls in `TaskViewerProvider.ts`

**Problem:**
- The workflow files create confusion about how delegation works
- Dead code adds maintenance burden
- Template and help text document obsolete functionality
- Users will have these files in their workspaces after upgrading

**What is NOT being removed:**
- `.switchboard/handoff/` directory — still used for coder prompt backups
- `handoff_clipboard` MCP tool — separate tool, not a workflow
- Runsheet logging — will use generic workflow names instead

## Solution

Remove the four handoff workflow files, update all documentation, remove dead code, and replace runsheet logging calls with generic values.

## Proposed Changes

### `.agent/workflows/handoff.md`
- **Context:** Extension source file that gets copied to user workspaces during `performSetup()`.
- **Logic:** Delete the entire file.
- **Implementation:** `rm .agent/workflows/handoff.md`

### `.agent/workflows/handoff-chat.md`
- **Context:** Extension source file that gets copied to user workspaces during `performSetup()`.
- **Logic:** Delete the entire file.
- **Implementation:** `rm .agent/workflows/handoff-chat.md`

### `.agent/workflows/handoff-lead.md`
- **Context:** Extension source file that gets copied to user workspaces during `performSetup()`.
- **Logic:** Delete the entire file.
- **Implementation:** `rm .agent/workflows/handoff-lead.md`

### `.agent/workflows/handoff-relay.md`
- **Context:** Extension source file that gets copied to user workspaces during `performSetup()`.
- **Logic:** Delete the entire file.
- **Implementation:** `rm .agent/workflows/handoff-relay.md`

### `templates/cursor/cursor-instructions.md.template`
- **Context:** Template file copied to user workspaces during setup. Documents handoff workflows at lines 20-23.
- **Logic:** Remove the four handoff workflow rows from the workflow triggers table.
- **Implementation:**
```diff
| Trigger | Workflow | Description |
|:--------|:---------|:------------|
-| `/handoff` | handoff | Delegate tasks to external agents |
-| `/handoff-chat` | handoff-chat | Clipboard/chat delegation workflow |
-| `/handoff-relay` | handoff-relay | Execute-now, stage-rest relay workflow |
-| `/handoff-lead` | handoff-lead | One-shot lead execution workflow |
| `/improve-plan` | improve-plan | Deep planning, dependency checks, and adversarial review |
```

### `templates/windsurf/windsurf-instructions.md.template`
- **Context:** Template file copied to user workspaces during setup. Documents handoff workflows at lines 20-23.
- **Logic:** Remove the four handoff workflow rows from the workflow triggers table.
- **Implementation:** Same as cursor template above.

### `src/extension.ts` — Help text (line ~3146)
- **Context:** First location of handoff workflow documentation in the help text.
- **Logic:** Remove the four handoff workflow rows from the workflow triggers table.
- **Implementation:**
```diff
| Trigger | Workflow | Description |
|:--------|:---------|:------------|
-| \`/handoff\` | handoff | Delegate tasks to external agents |
-| \`/handoff-chat\` | handoff-chat | Clipboard/chat delegation workflow |
-| \`/handoff-relay\` | handoff-relay | Execute-now, stage-rest relay workflow |
-| \`/handoff-lead\` | handoff-lead | One-shot lead execution workflow |
| \`/improve-plan\` | improve-plan | Deep planning, dependency checks, and adversarial review |
```

### `src/extension.ts` — Help text (line ~3177)
- **Context:** Second location of handoff workflow documentation in the help text (duplicate for different IDE target).
- **Logic:** Remove the four handoff workflow rows from the workflow triggers table.
- **Implementation:** Same as above.

### `src/extension.ts` — Help text (line ~3222)
- **Context:** Third location of handoff workflow documentation in the help text (duplicate for different IDE target).
- **Logic:** Remove the four handoff workflow rows from the workflow triggers table.
- **Implementation:** Same as above.

**Note:** The `handoff_clipboard` tool documentation (lines 3140, 3171, 3210) should NOT be removed — this is a separate MCP tool, not a workflow file.

### `src/extension.ts` — Generated README content (line ~2805)
- **Context:** `performSetup()` generates a README for new workspaces. The content string (line 2805) currently says `"Use \`/handoff\` to delegate tasks to other agents."` This README is written to every new user workspace.
- **Logic:** Remove or replace the `/handoff` sentence. Replace with the current delegation approach.
- **Implementation:**
```diff
-Use \`/handoff\` to delegate tasks to other agents.
+Use the **Prompts tab** to inject delegation instructions for external agents.
```

### `src/extension.ts` — `start_workflow` example text (line ~3202)
- **Context:** Help text for the `start_workflow` tool lists example workflow names: `"Begin a workflow (e.g., \`handoff\`, \`improve-plan\`, \`challenge\`, \`accuracy\`)"`. This text reaches users via the help command.
- **Logic:** Remove `handoff` from the example list. Keep `improve-plan`, `challenge`, `accuracy`.
- **Implementation:**
```diff
-- **start_workflow** — Begin a workflow (e.g., \`handoff\`, \`improve-plan\`, \`challenge\`, \`accuracy\`).
+- **start_workflow** — Begin a workflow (e.g., \`improve-plan\`, \`challenge\`, \`accuracy\`).
```

### `src/extension.ts` — `cleanupLegacyAgentFiles()` (line ~2560)
- **Context:** This function runs on extension activation for each workspace root. It already removes `no_git_for_agents.md` and `switchboard_modes.md`.
- **Logic:** Add the four handoff workflow files to the `legacyFiles` array so they get deleted from existing user workspaces on activation.
- **Implementation:**
```diff
 async function cleanupLegacyAgentFiles(workspaceRoot: string): Promise<void> {
     const legacyFiles = [
         '.agent/rules/no_git_for_agents.md',
         '.agent/rules/switchboard_modes.md',
+        '.agent/workflows/handoff.md',
+        '.agent/workflows/handoff-chat.md',
+        '.agent/workflows/handoff-lead.md',
+        '.agent/workflows/handoff-relay.md',
     ];
```

### `src/extension.ts` — `performSetup()` blocklist (line ~2673)
- **Context:** The blocklist prevents files from being distributed to user workspaces during setup, even if they exist in the extension source.
- **Logic:** Add the four handoff workflow files to the blocklist as a safety net, preventing re-copying even if the source files are accidentally restored.
- **Implementation:**
```diff
     // 2b. Blocklist: remove files that should never be distributed even if present in source
-    const blocklist = ['.agent/rules/no_git_for_agents.md', '.agent/rules/switchboard_modes.md'];
+    const blocklist = [
+        '.agent/rules/no_git_for_agents.md',
+        '.agent/rules/switchboard_modes.md',
+        '.agent/workflows/handoff.md',
+        '.agent/workflows/handoff-chat.md',
+        '.agent/workflows/handoff-lead.md',
+        '.agent/workflows/handoff-relay.md',
+    ];
```

### `src/extension.ts` — Update JSDoc on `cleanupLegacyAgentFiles()`
- **Context:** The JSDoc currently describes the removal of git-prohibition and mode-trigger files. Should be updated to include handoff workflow removal.
- **Implementation:**
```diff
/**
 * Clean up obsolete agent files from user workspaces.
 * - no_git_for_agents.md: Git prohibition removed in favor of prompts tab
 * - switchboard_modes.md: Mode triggers superseded by prompts tab checkboxes
+ * - handoff*.md: Delegation workflows superseded by prompts tab
 */
```

### `src/services/KanbanProvider.ts` — Remove `_workflowForColumn` method
- **Context:** This method (lines 2950-2960) returns workflow names for column transitions but is never called anywhere in the codebase.
- **Logic:** Delete the entire method.
- **Implementation:** Remove lines 2949-2960.

### `src/services/TaskViewerProvider.ts` — Remove `workflowMap` function
- **Context:** This function (lines 2211-2223) maps roles to workflow names but is never called anywhere in the codebase.
- **Logic:** Delete the entire function.
- **Implementation:** Remove lines 2211-2223.

### `src/services/TaskViewerProvider.ts` — Update runsheet logging calls (line ~12773)
- **Context:** This code uses workflow names for runsheet logging only. The workflow name is not used to invoke actual workflows.
- **Logic:** Replace the handoff workflow names with a generic value or `undefined`.
- **Implementation:**
```diff
             const workflowName = effectiveColumn === 'CREATED'
                 ? 'improve-plan'
-                : effectiveColumn === 'PLAN REVIEWED'
-                    ? (role === 'lead' ? 'handoff-lead' : 'handoff')
+                : effectiveColumn === 'PLAN REVIEWED'
+                    ? undefined
                     : this._isCompletedCodingColumn(effectiveColumn)
                         ? 'reviewer-pass'
                         : isTesterEligible
                             ? 'tester-pass'
                             : undefined;
```

### `src/services/TaskViewerProvider.ts` — Update runsheet logging calls (line ~14683)
- **Context:** This code uses workflow names for runsheet logging only after team dispatch.
- **Logic:** Replace the handoff workflow names with a generic value or `undefined`.
- **Implementation:**
```diff
                 const dispatchedRoles = dispatches.map(dispatch => dispatch.role);
-                const workflowName = dispatchedRoles.includes('lead') ? 'handoff-lead' : 'handoff';
+                const workflowName = undefined;
                 await this._updateSessionRunSheet(sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
```

### `src/services/KanbanProvider.ts` — Update `_advanceSessionsInColumn` call (line ~4955)
- **Context:** This code passes `'handoff'` as the workflow parameter for runsheet logging only. The workflow is not actually invoked.
- **Logic:** Replace with a generic value or `undefined`.
- **Clarification:** Before editing, verify the third parameter of `_advanceSessionsInColumn` accepts `string | undefined` (not just `string`). If strictly typed as `string`, pass `''` (empty string) instead of `undefined`, or update the signature to accept `string | undefined`.
- **Implementation:**
```diff
-                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', 'handoff', workspaceRoot);
+                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', undefined, workspaceRoot);
```

### `package.json`
- **Context:** A version bump triggers `shouldRefreshAgentWorkspaceFiles()` to return true, which causes workflow files to be overwritten during the next `performSetup()` call.
- **Logic:** Read the current version from `package.json` first. Bump the patch version by 1 (e.g. `1.6.0` → `1.6.1`, or `1.6.2` → `1.6.3` if already bumped by another in-flight plan).
- **Clarification:** Do NOT assume the version is still `1.6.0`. Read `package.json` and use the actual current value.
- **Implementation:** Update `"version": "<current>"` to `"version": "<current+patch>"`.

## Verification Plan

### Automated Tests
- (SKIP: Per session directive, automated tests are not run as part of this plan.)

### Manual Verification
1. **Grep dependency check:** Run `grep -r "handoff\.md\|handoff-chat\.md\|handoff-lead\.md\|handoff-relay\.md" --include="*.ts" --include="*.js" --include="*.md" src/ templates/ .agent/` to confirm no file references remain after changes. Expected: zero matches outside plan files and `.switchboard/sessions/` (historical data).
2. **Grep workflow name check:** Run `grep -r "'handoff'\|'handoff-chat'\|'handoff-lead'\|'handoff-relay'" --include="*.ts" --include="*.js" src/` to confirm no workflow name references remain. Expected: only `.switchboard/handoff/` directory references (not workflow names).
3. **Workspace with files present:** Open a workspace that has the four handoff workflow files. After extension activation, verify the files are deleted.
4. **Workspace without files:** Open a workspace that doesn't have the files. Verify no error is thrown.
5. **New workspace setup:** Run setup on a fresh workspace. Verify the four handoff workflow files are NOT copied to the workspace's `.agent/workflows/` directory.
6. **Template files:** Verify `templates/cursor/cursor-instructions.md.template` and `templates/windsurf/windsurf-instructions.md.template` do not document handoff workflows.
7. **Help text:** Run the help command in VS Code and verify handoff workflows are not documented.
8. **Kanban board:** Test batch low-complexity dispatch and pair programming to ensure they still work (runsheet logging will show `undefined` instead of workflow names, but functionality is unchanged).

## Rollback Plan

If issues arise:
- Restore the four workflow files from git
- Remove them from the `cleanupLegacyAgentFiles()` array and blocklist
- Restore the workflow documentation in template files and help text
- Restore the dead code methods in `KanbanProvider.ts` and `TaskViewerProvider.ts`
- Restore the runsheet logging calls to use handoff workflow names
- Users can manually restore the files if needed

## Reviewer Pass Results (2026-06-01)

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| CRITICAL-1 | CRITICAL | `.cursorrules` (the actual Cursor instruction file, not `templates/cursor/cursor-instructions.md.template` which doesn't exist) still documented all four handoff workflows at lines 40-43 | **Fixed** |
| CRITICAL-2 | CRITICAL | `.codeium/windsurf-instructions.md` (the actual Windsurf instruction file, not `templates/windsurf/windsurf-instructions.md.template` which doesn't exist) still documented all four handoff workflows at lines 22-25 | **Fixed** |
| MAJOR-1 | MAJOR | Generated README content in `extension.ts` line 2811 still said "handoff logs" in descriptive text: `"review outputs, handoff logs, and audit reports"`. Plan's diff only addressed the `/handoff` trigger reference, missed this descriptive phrase. | **Fixed** → changed to "session logs" |
| MAJOR-2 | MAJOR | `package.json` version not bumped. Plan requires bump to trigger `shouldRefreshAgentWorkspaceFiles()`. Was `1.7.2`, should be `1.7.3`. | **Fixed** → bumped to 1.7.3 |
| NIT-1 | NIT | `docs/DELEGATION_WORKFLOWS_README.md` still references the old delegation workflow system. The `.switchboard/handoff/` directory reference is valid, but the overall document describes the obsolete pattern. Out of plan scope — deferred. | Deferred |

### Stage 2: Balanced Synthesis

- CRITICAL-1 and CRITICAL-2: The plan referenced template file paths (`templates/cursor/cursor-instructions.md.template`, `templates/windsurf/windsurf-instructions.md.template`) that don't exist in the repo. The actual instruction files are `.cursorrules` and `.codeium/windsurf-instructions.md`. The implementation correctly handled the `extension.ts` help text but missed these two IDE-specific instruction files. Fixed by removing the four handoff rows from both files' Workflow Triggers tables.
- MAJOR-1: The plan's diff for the README content only addressed the `/handoff` trigger line but missed the descriptive "handoff logs" phrase. Fixed by replacing with "session logs".
- MAJOR-2: Version bump was specified in the plan but not applied. Fixed by bumping 1.7.2 → 1.7.3.
- Acceptable deviation: The plan said to delete `workflowMap` as dead code. Instead, it was refactored into `_workflowNameForDispatchRole` with handoff entries removed, and the function is now actively called (line 2334). This is a better outcome than deletion.

### Files Changed by Reviewer

| File | Change |
|------|--------|
| `.cursorrules` | Removed 4 handoff workflow rows from Workflow Triggers table |
| `.codeium/windsurf-instructions.md` | Removed 4 handoff workflow rows from Workflow Triggers table |
| `src/extension.ts` (line 2811) | Changed "handoff logs" → "session logs" in generated README content |
| `package.json` | Bumped version from 1.7.2 → 1.7.3 |

### Verification Results

**Grep check 1 — File path references** (`handoff.md`, `handoff-chat.md`, etc. in `src/`):
- 8 matches in `extension.ts` — all in `cleanupLegacyAgentFiles()` legacyFiles array and blocklist array. These are CORRECT (must stay to clean files from user workspaces and prevent re-distribution).
- 0 matches in `.cursorrules` or `.codeium/windsurf-instructions.md` after fix.

**Grep check 2 — Workflow name references** (`'handoff'`, `'handoff-chat'`, etc. in `src/`):
- `session-action-log.test.ts`: Uses `'handoff'` as test data for session action log tests. Acceptable — testing with historical data patterns.
- `cleanWorkspace.ts`: `'handoff'` in `TRANSIENT_DIRS` — references the `.switchboard/handoff/` DIRECTORY (not workflow). Correct per plan.
- `KanbanMigration.ts`: `workflow === 'handoff'` — migration logic for historical kanban data. Correct — must stay to handle old sessions.
- `kanbanColumnDerivation.test.ts`: `{ workflow: 'handoff' }` test input. Acceptable — testing derivation with historical patterns.

**Grep check 3 — `/handoff` trigger references** in instruction files:
- 0 matches in `.cursorrules` after fix (only `handoff_clipboard` MCP tool remains, which plan says to keep).
- 0 matches in `.codeium/windsurf-instructions.md` after fix (same).

**All verification checks pass.** Remaining `handoff` references are legitimate: cleanup/blocklist entries, directory references, historical data migration, and test fixtures.

### Remaining Risks

1. **Template file path mismatch**: The plan references `templates/cursor/cursor-instructions.md.template` and `templates/windsurf/windsurf-instructions.md.template` — these files don't exist. The actual instruction files are `.cursorrules` and `.codeium/windsurf-instructions.md`. If future tooling expects the template paths, they'll need to be created or the plan's path references corrected.
2. **Historical data**: Old sessions in the kanban database may still have `workflow: 'handoff'` recorded. `KanbanMigration.ts` handles this correctly, but any custom queries against the runsheet data will encounter these values.
3. **`docs/DELEGATION_WORKFLOWS_README.md`**: Still describes the old delegation workflow pattern. The `.switchboard/handoff/` directory reference is valid, but the document as a whole describes an obsolete system. Consider updating or removing in a future cleanup pass.

---

**Send to Coder** (Complexity 4)
