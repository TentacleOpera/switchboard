# Trim AGENTS.md to Skills Table with Automatic Migration

## Goal
Reduce AGENTS.md from 116 lines to ~45 lines by removing protocol documentation now handled by the kanban.html prompts tab (retaining Workspace Detection, which is operational guidance not replaced by the prompts tab), and fix the `ensureAgentsProtocol()` markerless-skip bug so existing workspaces automatically receive the trimmed version on extension update.

## Metadata
- **Tags:** [workflow, documentation]
- **Complexity:** 5

## User Review Required
- Confirm that `.cursorrules` (which duplicates the workflow registry and skills table) should be updated in a follow-up plan rather than this one.

## Complexity Audit

### Routine
- Trimming the bundled AGENTS.md to keep only the skills table (pure content removal)
- Adding a version-gated activation hook calling existing `ensureAgentsProtocol()`
- Bumping `package.json` version to trigger `shouldRefreshAgentWorkspaceFiles()`

### Complex / Risky
- Fixing the `ensureAgentsProtocol()` markerless-skip bug (line 2441-2443): changing the `hasProtocolHeaderLine` branch from "skip" to "replace with managed block" affects all existing workspaces that were scaffolded before boundary markers were introduced
- Preserving user content in markerless AGENTS.md files: the entire file is Switchboard-managed content, but users may have added custom content above/below the protocol block — the replacement must not destroy it

## Edge-Case & Dependency Audit

- **Race Conditions:** None — migration runs once on activation, sequentially before any user interaction with AGENTS.md
- **Security:** No security implications — AGENTS.md is a guidance file, not executable
- **Side Effects:** Existing workspaces with markerless AGENTS.md will have their file rewritten (content replaced with trimmed version + markers). Users who manually edited AGENTS.md outside markers will lose edits unless they have git history.
- **Dependencies & Conflicts:** The `.cursorrules` file at repo root contains a duplicate workflow registry and skills table. Trimming AGENTS.md without updating `.cursorrules` creates an inconsistency where agents reading `.cursorrules` see the old full protocol. This should be addressed in a follow-up plan.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The `ensureAgentsProtocol()` markerless-skip bug silently prevents migration for pre-marker workspaces — this is the root cause, not a missing migration function. (2) User content in markerless files cannot be reliably distinguished from Switchboard content. Mitigations: Fix the markerless branch to replace with managed block (treating the entire old file as Switchboard-managed); users can restore custom content from git. (3) `.cursorrules` inconsistency is deferred to a follow-up.

## Proposed Changes

### AGENTS.md (repo root, 116 lines → ~45 lines)
- **Context:** The prompts tab in kanban.html now provides dynamic workflow configuration, role-based prompt customization, protocol enforcement, and kanban operations — making most of AGENTS.md redundant. The Workspace Detection section is retained because it provides operational guidance (where to write plan files) that the prompts tab does not replace.
- **Logic:** Remove protocol enforcement sections only; retain skills table and Workspace Detection.
- **Implementation:**
  - **Remove lines 3-65:** STRICT PROTOCOL ENFORCEMENT, Workflow Registry, MANDATORY PRE-FLIGHT CHECK, Execution Rules, Code-Level Enforcement, Switchboard Global Architecture
  - **Keep lines 1-2:** Header `# AGENTS.md - Switchboard Protocol`
  - **Keep lines 67-98:** Available Skills section (lines 67-98)
  - **Keep lines 100-116:** Workspace Detection for Plan Creation (operational guidance, not protocol enforcement)
  - **Result:** ~45 line file containing header + skills table + workspace detection
- **Edge Cases:** The bundled AGENTS.md does NOT include boundary markers — they are added by `ensureAgentsProtocol()` when writing to workspace. So the trimmed file should also NOT include markers.

### src/extension.ts — Fix markerless-skip bug in `ensureAgentsProtocol()` (line 2441-2443)
- **Context:** When `ensureAgentsProtocol()` encounters a target AGENTS.md that has the protocol header line (`# AGENTS.md - Switchboard Protocol`) but NO boundary markers, it returns `{ status: 'skipped' }`. This means workspaces scaffolded before markers were introduced will never receive updates.
- **Logic:** Change the `hasProtocolHeaderLine` branch to replace the entire file content with the new managed block, treating the old content as fully Switchboard-managed.
- **Implementation:**
  - At line 2441, change the `hasProtocolHeaderLine` branch from:
    ```typescript
    if (hasProtocolHeaderLine(targetContent)) {
        return { status: 'skipped', reason: 'Switchboard protocol block already present' };
    }
    ```
    to:
    ```typescript
    if (hasProtocolHeaderLine(targetContent)) {
        // Legacy markerless AGENTS.md — replace entire content with managed block.
        // The old file was fully scaffolded by the extension, so this is safe.
        try {
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(managedBlock + '\n', 'utf8'));
            return { status: 'updated', reason: 'Legacy markerless AGENTS.md replaced with managed block' };
        } catch (e) {
            return { status: 'failed', reason: `Failed to replace legacy AGENTS.md: ${getErrorMessage(e)}` };
        }
    }
    ```
- **Edge Cases:** If a user added custom content above/below the protocol block in a markerless file, that content will be lost. This is acceptable because: (a) the file was scaffolded by the extension, (b) users can restore from git, (c) the new managed block supports future incremental updates with content preservation via markers.

### src/extension.ts — Add activation hook for AGENTS.md migration (after line 378)
- **Context:** `ensureAgentsProtocol()` is only called inside `performSetup()`, which runs during the setup wizard — NOT on activation. Existing users who never re-run setup will never get the trimmed AGENTS.md.
- **Logic:** Add a version-gated call to `ensureAgentsProtocol()` in the `activate()` function, using the existing `shouldRefreshAgentWorkspaceFiles()` gate.
- **Implementation:**
  - In `activate()`, after the `migrateWorkspaceDatabaseMappings()` try/catch block (line 374-378), add:
    ```typescript
    // Version-gated AGENTS.md migration: when the extension version changes,
    // ensure the workspace AGENTS.md is updated to the latest bundled version.
    // This handles the transition from full-protocol to skills-only AGENTS.md.
    if (workspaceRoot) {
        try {
            if (shouldRefreshAgentWorkspaceFiles(context.extensionUri.fsPath, workspaceRoot)) {
                const agentsResult = await ensureAgentsProtocol(
                    vscode.Uri.file(workspaceRoot),
                    context.extensionUri
                );
                outputChannel?.appendLine(
                    `[Migration] AGENTS.md: ${agentsResult.status} — ${agentsResult.reason}`
                );
            }
        } catch (err) {
            console.error('[Switchboard] AGENTS.md migration failed, continuing activation:', err);
        }
    }
    ```
  - Note: `workspaceRoot` is available from `kanbanProvider!.getCurrentWorkspaceRoot()` at line 381, which is set before this insertion point. The `outputChannel` is also already created at line 368.
- **Edge Cases:** Multi-root workspaces: only the primary workspace root is migrated on activation. Other roots are handled when the user runs setup for them. This matches existing behavior.

### package.json — Bump version (line 12)
- **Context:** The current version is `1.6.0`. Bumping the version triggers `shouldRefreshAgentWorkspaceFiles()` to return `true`, which gates the activation migration.
- **Implementation:** Change `"version": "1.6.0"` to `"version": "1.7.0"` (or appropriate next version).
- **Edge Cases:** None — standard semver bump.

## Verification Plan

### Automated Tests
- N/A — No existing unit test infrastructure for `ensureAgentsProtocol()`. Manual verification required.

### Manual Verification Checklist
- [ ] Bundled AGENTS.md trimmed to ~45 lines (header + skills table + workspace detection)
- [ ] New workspace (no AGENTS.md): `ensureAgentsProtocol()` creates trimmed version with markers
- [ ] Workspace with marker-based AGENTS.md (current format): `ensureAgentsProtocol()` updates managed block to trimmed version, preserves content outside markers
- [ ] Workspace with markerless AGENTS.md (legacy format): `ensureAgentsProtocol()` replaces entire file with trimmed version + markers
- [ ] Workspace with custom AGENTS.md (no Switchboard header): `ensureAgentsProtocol()` appends managed block
- [ ] Activation hook runs on version change and skips when version matches
- [ ] Migration failure does not block extension activation
- [ ] Migration status logged to output channel
- [ ] `package.json` version bumped

### Skip Directives
- SKIP compilation (per session directive)
- SKIP automated tests (per session directive)

## Review Results (Post-Implementation)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Activation hook never calls `setLastCopiedAgentVersion()` — migration runs on every activation forever because the version file is never updated after migration succeeds. `shouldRefreshAgentWorkspaceFiles()` always returns `true` on subsequent activations. | CRITICAL | **Fixed** |
| 2 | `ensureAgentsProtocol()` docstring claims "Non-destructive: preserves all existing user content" but the markerless branch replaces entire file content — docstring is misleading for future maintainers. | MAJOR | **Fixed** |
| 3 | Double blank line between `> [!IMPORTANT]` block and skills table in AGENTS.md (lines 11-12). Formatting inconsistency. | NIT | **Fixed** |
| 4 | AGENTS.md is 51 lines, not the estimated ~45 lines. | NIT | Deferred — cosmetic, no functional impact |

### Stage 2: Balanced Synthesis

- **CRITICAL fix applied**: Added `setLastCopiedAgentVersion()` call after successful migration in the activation hook (lines 396-400 of extension.ts). This mirrors the pattern used in `performSetup()` at line 2696 and ensures the migration gate works correctly — migration runs once on version change, then skips on subsequent activations.
- **MAJOR fix applied**: Updated `ensureAgentsProtocol()` docstring (lines 2381-2387) to accurately describe the markerless branch behavior: "Preserves user content outside boundary markers when markers are present. For legacy markerless files (header only, no markers), replaces the entire file content."
- **NIT fix applied**: Removed double blank line in AGENTS.md between the `> [!IMPORTANT]` block and the skills table.

### Files Changed by Review

| File | Change |
|------|--------|
| `src/extension.ts` (lines 396-400) | Added `setLastCopiedAgentVersion()` call after successful AGENTS.md migration in activation hook |
| `src/extension.ts` (lines 2381-2387) | Updated `ensureAgentsProtocol()` docstring to accurately describe markerless branch behavior |
| `AGENTS.md` (line 11) | Removed double blank line between `> [!IMPORTANT]` block and skills table |

### Validation Results

- **TypeScript check**: `npx tsc --noEmit` shows 2 pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated import extension issues). No new errors introduced by review fixes.
- **AGENTS.md line count**: 51 lines (trimmed from 116, containing header + skills table + workspace detection). Within acceptable range of the ~45 line estimate.
- **package.json version**: `1.7.0` — correctly bumped from `1.6.0`.
- **Markerless-skip bug**: Fixed — `hasProtocolHeaderLine` branch now replaces entire content with managed block instead of returning `{ status: 'skipped' }`.
- **Activation hook version recording**: Fixed — `setLastCopiedAgentVersion()` now called after successful migration, preventing re-run on every activation.

### Remaining Risks

1. **`.cursorrules` inconsistency**: The `.cursorrules` file at repo root still contains the old full protocol (workflow registry, execution rules, etc.). Agents reading `.cursorrules` will see stale protocol info. This was explicitly deferred to a follow-up plan per the "User Review Required" section.
2. **Markerless file user content loss**: If a user added custom content above/below the protocol block in a markerless AGENTS.md, that content will be lost during migration. This is an accepted trade-off documented in the plan. Mitigated by: (a) the file was scaffolded by the extension, (b) users can restore from git, (c) future updates preserve content via markers.
3. **Multi-root workspace limitation**: The activation hook only migrates the primary workspace root. Other roots require manual setup. This matches existing behavior and is documented in the plan.

## Original Plan Content (Preserved)

### Background
The prompts tab in kanban.html now provides:
- Dynamic workflow configuration (not static registry)
- Role-based prompt customization (Lead/Coder/Reviewer)
- Protocol enforcement via UI addons (accuracy mode, inline challenge)
- Workspace detection via checkbox
- Kanban operations via UI

This makes most of AGENTS.md redundant. Only the skills table provides unique value.

### Rollback Plan
If issues arise:
1. Revert AGENTS.md to full protocol version
2. Revert the `ensureAgentsProtocol()` markerless branch change (restore 'skipped' behavior)
3. Remove the activation hook from `activate()`
4. Users can manually restore old AGENTS.md from git history
5. Extension will continue to work with old format

### Success Criteria
- AGENTS.md reduced from 116 lines to ~45 lines
- Automatic migration runs on extension update (version change)
- User custom content preserved when markers are present
- No extension activation failures
- Migration logged and trackable

### Recommendation
Complexity 5 → **Send to Coder**
