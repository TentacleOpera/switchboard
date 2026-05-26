---
description: Remove obsolete switchboard_modes.md file from all user workspaces
---

# Remove switchboard_modes.md Migration

## Goal

Remove the obsolete `.agent/rules/switchboard_modes.md` file from the extension source and all user workspaces, since the prompts builder system now handles mode activation via checkboxes instead of command-based triggers.

## Metadata

- **Tags:** [workflow, reliability]
- **Complexity:** 3
- **Workspace:** single-repo

## User Review Required

- Confirm that removing the "Lead Engineer" persona guidance from `accuracy.md` is acceptable (the persona's tone rules — no apologies, no filler — are not injected by the prompts tab checkbox; only the verification gates are redundant with the workflow's own instructions).

## Complexity Audit

### Routine
- Adding a file path to the `cleanupLegacyAgentRules()` array (1-line change)
- Adding a file path to the `performSetup()` blocklist array (1-line change)
- Removing a single line from `accuracy.md` workflow
- Deleting the source file `.agent/rules/switchboard_modes.md`
- Version bump in `package.json`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** On extension startup, the IDE may ingest `.agent/rules/switchboard_modes.md` into its prompt cache before `cleanupLegacyAgentRules()` deletes it. The fix only guarantees cleanliness for subsequent sessions, not the current one. This is the same known limitation documented in the `no_git_for_agents.md` migration plan. No workaround exists without an IDE restart.
- **Security:** No security implications. This is a deletion of an obsolete rules file.
- **Side Effects:** The `/accuracy` workflow will no longer reference the "Lead Engineer" persona. The workflow's own verification gates (plan → implement → verify → complete) already encode the essential behavior. The persona only added tone guidance (no apologies, no filler, verify delegated work) which is not critical to the accuracy process.
- **Dependencies & Conflicts:** Grep search confirms that `switchboard_modes.md` is only referenced by `accuracy.md` line 22. No other workflows, TypeScript code, or configuration files reference it. The other plan file `fix_git_policy_file_circumvents_checkbox.md` mentions it in a context line but that is informational only.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The source file at `.agent/rules/switchboard_modes.md` must be deleted from the extension repo — without this, `performSetup()` will re-copy it to new workspaces even with the blocklist. (2) Both cleanup paths are needed — `cleanupLegacyAgentRules()` for existing installations and the blocklist for the setup copy path. (3) The IDE prompt-cache race condition means the current session may still see the file after activation. Mitigations: Delete the source file, use both cleanup paths, and accept the race condition as a known limitation (identical to the `no_git_for_agents.md` migration pattern).

## Context

The `.agent/rules/switchboard_modes.md` file is outdated by the new prompts builder system. It describes command-based mode triggers (`/accuracy`, `/chat`, `/handoff`) that are no longer the primary mechanism for activating these behaviors. The prompts tab now uses checkboxes to inject instructions directly.

**Current state:**
- `switchboard_modes.md` exists in the extension source at `.agent/rules/switchboard_modes.md` (77 lines, `trigger: always_on`)
- `accuracy.md` workflow references it for persona guidance (line 22)
- No other code or workflows use it (verified via grep)
- The prompts builder doesn't enforce these mode rules

**Problem:**
- The file creates confusion about how modes are activated
- The "NON-NEGOTIABLE LAWS" language conflicts with the optional prompts tab checkboxes
- Users will have this file in their workspaces after upgrading
- The source file will continue to be copied to new workspaces by `performSetup()` if not removed

## Solution

Remove `switchboard_modes.md` from the extension source and all user workspaces via three coordinated changes: (1) delete the source file, (2) add to both cleanup paths, (3) remove the accuracy.md reference.

## Proposed Changes

### `.agent/rules/switchboard_modes.md`
- **Context:** This is the extension source file that gets copied to user workspaces during `performSetup()`.
- **Logic:** Delete the entire file. This prevents it from being copied to new workspaces.
- **Implementation:** `rm .agent/rules/switchboard_modes.md`
- **Edge Cases:** The blocklist in `performSetup()` serves as a safety net even after source deletion, but the primary prevention is removing the source.

### `.agent/workflows/accuracy.md`
- **Context:** Line 22 references `switchboard_modes.md` for the "Lead Engineer" persona.
- **Logic:** Remove the reference line. The workflow is comprehensive without the persona — the persona only adds tone guidance (no apologies, no filler) which is not critical to the accuracy verification process. The workflow's own steps already encode the essential behavior (plan → implement → verify gate → self-review → final verification).
- **Implementation:**
```diff
-   - Read `.agent/rules/switchboard_modes.md` for the "Lead Engineer" persona.
```
- **Edge Cases:** None. The persona guidance is redundant with the workflow's inline instructions.

### `src/extension.ts` — `cleanupLegacyAgentRules()` (line ~2560)
- **Context:** This function runs on extension activation for each workspace root (called at line 540). It already removes `no_git_for_agents.md` using the same pattern.
- **Logic:** Add `.agent/rules/switchboard_modes.md` to the `legacyFiles` array so it gets deleted from existing user workspaces on activation.
- **Implementation:**
```diff
 async function cleanupLegacyAgentRules(workspaceRoot: string): Promise<void> {
     const legacyFiles = [
         '.agent/rules/no_git_for_agents.md',
+        '.agent/rules/switchboard_modes.md',
     ];
```
- **Edge Cases:** If the file doesn't exist, the `catch` block handles it gracefully (non-fatal). The IDE may have already cached the file for the current session — only subsequent sessions are guaranteed clean.

### `src/extension.ts` — `performSetup()` blocklist (line ~2673)
- **Context:** The blocklist prevents files from being distributed to user workspaces during setup, even if they exist in the extension source. Currently only contains `no_git_for_agents.md`.
- **Logic:** Add `.agent/rules/switchboard_modes.md` to the blocklist as a safety net, preventing re-copying even if the source file is accidentally restored.
- **Implementation:**
```diff
     // 2b. Blocklist: remove files that should never be distributed even if present in source
-    const blocklist = ['.agent/rules/no_git_for_agents.md'];
+    const blocklist = ['.agent/rules/no_git_for_agents.md', '.agent/rules/switchboard_modes.md'];
```
- **Edge Cases:** The blocklist deletion uses `useTrash: false` and is wrapped in try/catch — non-fatal if the file doesn't exist.

### `package.json`
- **Context:** Current version is `1.5.9`. The version bump triggers `shouldRefreshAgentWorkflowFiles()` to return true, which causes workflow files to be overwritten during the next `performSetup()` call. This ensures the updated `accuracy.md` (without the persona reference) reaches user workspaces.
- **Logic:** Bump version from `1.5.9` to `1.6.0` (or next appropriate version per semver).
- **Implementation:** Update `"version": "1.5.9"` to `"version": "1.6.0"`.
- **Edge Cases:** The version comparison mechanism (`shouldRefreshAgentWorkflowFiles`) compares against the last-copied version stored in workspace state. Workspaces that haven't been opened since the version change will get the cleanup on their next activation.

## Verification Plan

### Automated Tests
- (SKIP: Per session directive, automated tests are not run as part of this plan.)

### Manual Verification
1. **Grep dependency check:** Run `grep -r "switchboard_modes" --include="*.ts" --include="*.js" --include="*.json"` to confirm no code references remain after changes. Expected: zero matches outside plan files.
2. **Workspace with file present:** Open a workspace that has `.agent/rules/switchboard_modes.md`. After extension activation, verify the file is deleted.
3. **Workspace without file:** Open a workspace that doesn't have the file. Verify no error is thrown.
4. **New workspace setup:** Run setup on a fresh workspace. Verify `switchboard_modes.md` is NOT copied to the workspace's `.agent/rules/` directory.
5. **accuracy.md workflow:** Execute the `/accuracy` workflow and confirm it runs successfully without the persona reference.
6. **Prompts tab:** Verify the accuracy checkbox in the prompts tab continues to function as before.

## Rollback Plan

If issues arise:
- Revert `accuracy.md` to restore the persona reference
- Remove `switchboard_modes.md` from the `cleanupLegacyAgentRules()` array and blocklist
- Restore the source file `.agent/rules/switchboard_modes.md` if needed
- Users can manually restore the file if needed (but this is unlikely to be necessary)

## Recommendation

**Send to Intern** — Complexity 3: single-file deletions and 1-line array additions following established patterns already in the codebase.
