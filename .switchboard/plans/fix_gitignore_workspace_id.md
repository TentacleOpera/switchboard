# Fix Gitignore Rules for workspace-id

## Goal
The `.switchboard/workspace-id` file is currently committed to git via the negation pattern `!.switchboard/workspace-id`. This file contains a machine-specific UUID that should differ per developer/workspace, similar to `kanban.db`. Committing it causes conflicts when multiple developers clone the repo.

Remove the workspace-id exception from the gitignore rules so it's properly ignored by the broader `.switchboard/*` pattern.

## Metadata
**Tags:** infrastructure, bugfix
**Complexity:** 7

## User Review Required
> [!NOTE]
> - Clarification: this plan keeps the existing objective (stop tracking `.switchboard/workspace-id`) but it likely collides with older architecture that described the file as “committed” and “cross-machine stable.” Reviewers should confirm that local-only workspace identity is still the intended product direction before merging.
> - Preserve the original cleanup note, but do not execute state-mutating git commands as part of this plan update. If maintainers later decide they must drop an already-tracked file from the index, handle that separately from this implementation.
> - Historical note preserved from the original draft: if the file was previously committed, a maintainer may need follow-up index cleanup after code changes land.

## Complexity Audit
### Routine
- Remove `!.switchboard/workspace-id` from both existing managed sections in `.gitignore`.
- Remove the same exception from `src/services/WorkspaceExcludeService.ts` so future targeted managed-block rewrites do not re-add it.
- Add or extend regression coverage so checked-in ignore rules and targeted managed rules both stop re-including `.switchboard/workspace-id`.
- Update directly related comments/text that still call the file “committed” if those comments are touched by the implementation.

### Complex / Risky
- Audit current workspace-ID flows in `src/services/TaskViewerProvider.ts` and `src/services/PlanFileImporter.ts`, because both currently describe `.switchboard/workspace-id` as a committed cross-machine file. If the implementation changes git-tracking semantics without clarifying these assumptions, future contributors may silently reintroduce the exception.
- Avoid breaking the broader targeted gitignore strategy that intentionally keeps `.switchboard/plans/`, `.switchboard/sessions/`, and docs visible in git.
- Handle the already-tracked-file case without baking state-mutating git steps into the implementation spec.

## Edge-Case & Dependency Audit
- **Race Conditions:** The local file can still be read/written by multiple windows; ignoring it in git does not change filesystem concurrency. The real risk is semantic drift: code/comments saying “committed” while git rules ignore the file. The implementation should make the ignore behavior and documentation consistent.
- **Security:** `.switchboard/workspace-id` is not a secret, but it is machine-local state. Ignoring it reduces accidental sharing of workspace-specific identifiers.
- **Side Effects:** Removing the exception only from `.gitignore` is insufficient because `WorkspaceExcludeService` regenerates the managed block and would re-add the line on the next targeted apply. If the file is already in git history or currently tracked, it may remain tracked until a maintainer performs explicit index cleanup outside this plan.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. Active Kanban items in **New** (`Investigate Completion and Archival Workflows`) and **Planned** (`Fix Gitignore Rules for workspace-id`, `Comprehensive ClickUp Integration Enhancement`) do not introduce an active sequencing dependency. A scan of `.switchboard/plans/` found historical same-area plans that touch the same ignore strategy surface — `remove_blanket_gitignore_default_for_custom_mode.md` and `brain_a5243677e6100f40a729fd8c8416490e12fe5b5d0e5eb4fd73a7e3a42a58d694_restore_targeted_gitignore_strategy_as_default_for_workspace_exclusion_system.md` — so this plan must preserve the targeted managed-block strategy while removing only the workspace-id re-include. A likely architectural conflict also exists with `.switchboard/archive/plans/bug_workspace_id_idempotency.md` and current source comments in `src/services/TaskViewerProvider.ts` / `src/services/PlanFileImporter.ts`, which still describe `.switchboard/workspace-id` as a committed cross-machine-stable identifier; this plan should document or update those assumptions instead of silently contradicting them.

## Adversarial Synthesis
### Grumpy Critique
> This is not actually a “delete two lines from `.gitignore`” bug unless you enjoy shipping fake fixes. `WorkspaceExcludeService.TARGETED_RULES` still contains `!.switchboard/workspace-id`, so the setup flow will happily reinsert the exception the next time targeted gitignore rules are applied. Worse, the current codebase and archived workspace-ID plan explicitly describe this file as committed, cross-machine state. If you ignore the file without reconciling that language, the repo ends up with code that says one thing, generated ignore rules that say another, and future contributors who “fix” it back because the comments told them to. And the original verification step blindly recommends `git rm --cached`, which is a state-mutating git operation outside this plan’s allowed execution model. If the plan does not separate the code change from any optional maintainer cleanup, it is sloppy.

### Balanced Response
> The critique is correct, so the implementation is tightened without expanding product scope. The goal remains exactly the same: stop tracking `.switchboard/workspace-id` through the managed ignore rules. To make that real, the plan removes the exception from both checked-in `.gitignore` blocks and from `src/services/WorkspaceExcludeService.ts`, then adds regression coverage so targeted-rule regeneration cannot reintroduce it. The plan also calls out directly related comment/documentation cleanup in the workspace-ID resolution code so the repository no longer claims the file is intentionally committed if this behavior changes. Finally, the preserved `git rm --cached` note is demoted to optional maintainer follow-up rather than an implementation step, keeping the plan within the no-state-mutating-git constraint.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Keep the existing objective and original implementation material, but make the spec complete enough that the change persists after the next targeted gitignore rewrite and is validated by existing tooling.

### Low-Complexity / Routine Steps

#### MODIFY `.gitignore`
- **Context:** The original draft correctly identified the two checked-in negation lines that re-include `.switchboard/workspace-id`. Those exact removals still belong in the plan and must remain explicit.
- **Logic:**
  1. Remove `!.switchboard/workspace-id` from the first runtime-state block.
  2. Remove the duplicate line from the managed exclusions mirror block.
  3. Leave all other `.switchboard/*` exceptions intact so plans, sessions, reviews, and Switchboard docs remain visible in git.
- **Implementation (unified diff):**
```diff
--- a/.gitignore
+++ b/.gitignore
@@
 .switchboard/*
 !.switchboard/reviews/
 !.switchboard/plans/
 !.switchboard/sessions/
 !.switchboard/CLIENT_CONFIG.md
 !.switchboard/README.md
 !.switchboard/SWITCHBOARD_PROTOCOL.md
-!.switchboard/workspace-id
 # ClickUp integration config (workspace-specific IDs)
 .switchboard/clickup-config.json
@@
 .switchboard/*
 !.switchboard/reviews/
 !.switchboard/plans/
 !.switchboard/sessions/
 !.switchboard/CLIENT_CONFIG.md
 !.switchboard/README.md
 !.switchboard/SWITCHBOARD_PROTOCOL.md
-!.switchboard/workspace-id
 
 # ClickUp integration config (workspace-specific IDs)
 .switchboard/clickup-config.json
```
- **Edge Cases Handled:** The duplicate managed block stays structurally identical except for the removed exception, so the targeted strategy still preserves every other intended re-include from the existing implementation.

#### MODIFY `src/services/WorkspaceExcludeService.ts`
- **Context:** `.gitignore` alone is not authoritative. The setup flow can rewrite the managed block from `TARGETED_RULES`, so this array must match the checked-in file or the change will be undone.
- **Logic:**
  1. Remove the `!.switchboard/workspace-id` literal from `TARGETED_RULES`.
  2. Keep the rest of the targeted rule order unchanged so the regression is isolated to workspace-id tracking.
  3. Do not change `DEFAULT_RULES`, strategy normalization, or any custom/local behavior; those are unrelated to this plan.
- **Implementation (unified diff):**
```diff
--- a/src/services/WorkspaceExcludeService.ts
+++ b/src/services/WorkspaceExcludeService.ts
@@
     private static readonly TARGETED_RULES: string[] = [
         '# Switchboard runtime state (per-session, not shareable)',
         '.switchboard/*',
         '!.switchboard/reviews/',
         '!.switchboard/plans/',
         '!.switchboard/sessions/',
         '!.switchboard/CLIENT_CONFIG.md',
         '!.switchboard/README.md',
         '!.switchboard/SWITCHBOARD_PROTOCOL.md',
-        '!.switchboard/workspace-id',
         '',
         '# ClickUp integration config (workspace-specific IDs)',
         '.switchboard/clickup-config.json',
```
- **Edge Cases Handled:** Removing the rule from the authoritative source prevents setup-panel reapplication from resurrecting the `.gitignore` exception after a user saves or re-applies targeted gitignore settings.

#### MODIFY `src/test/git-ignore-custom-default-regression.test.js`
- **Context:** This existing regression file already reads both `.gitignore`-related source files and is the lowest-friction place to lock in the new behavior.
- **Logic:**
  1. Read the root `.gitignore` alongside the existing source files.
  2. Assert that neither `.gitignore` nor `WorkspaceExcludeService.TARGETED_RULES` still contains `!.switchboard/workspace-id`.
  3. Keep existing default-strategy assertions intact.
- **Implementation (patch block):**
```diff
--- a/src/test/git-ignore-custom-default-regression.test.js
+++ b/src/test/git-ignore-custom-default-regression.test.js
@@
 function run() {
     const packageJson = JSON.parse(readSource('package.json'));
+    const gitignoreSource = readSource('.gitignore');
     const setupSource = readSource('src', 'webview', 'setup.html');
     const providerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
     const excludeServiceSource = readSource('src', 'services', 'WorkspaceExcludeService.ts');
     const vscodeSettings = JSON.parse(readSource('.vscode', 'settings.json'));
@@
     assert.match(
         excludeServiceSource,
         /config\.get\('ignoreRules', WorkspaceExcludeService\.DEFAULT_RULES\)/,
         'Expected WorkspaceExcludeService.apply() to continue sourcing editable rules from DEFAULT_RULES.'
     );
+    assert.ok(
+        !gitignoreSource.includes('!.switchboard/workspace-id'),
+        'Expected .gitignore not to re-include the machine-local .switchboard/workspace-id file.'
+    );
+    assert.ok(
+        !excludeServiceSource.includes("'!.switchboard/workspace-id'"),
+        'Expected targeted managed gitignore rules not to re-add .switchboard/workspace-id.'
+    );
@@
     console.log('git-ignore custom default regression test passed');
 }
```
- **Edge Cases Handled:** The test protects both the checked-in ignore file and the generated targeted-rule source, which blocks partial fixes that only update one side.

### Complex / Risky Steps

#### MODIFY `src/services/TaskViewerProvider.ts`
- **Context:** The runtime can still use `.switchboard/workspace-id` as a local file, but the current comments explicitly describe it as a committed cross-machine identifier. If the plan changes git tracking without updating that language, the code becomes self-contradictory.
- **Logic:**
  1. Keep the existing resolution chain unless product direction changes beyond this plan.
  2. Update only the directly related comments to stop promising committed cross-machine sync.
  3. **Clarification:** do not expand this plan into a workspace-ID architecture rewrite unless reviewers explicitly reopen that scope.
- **Implementation (comment-only diff):**
```diff
--- a/src/services/TaskViewerProvider.ts
+++ b/src/services/TaskViewerProvider.ts
@@
-        // ── Step 3: Committed file (cross-machine stable ID) ──
+        // ── Step 3: Workspace-local file fallback (.switchboard/workspace-id) ──
@@
-     * Opportunistically write workspace ID to the committed file.
+     * Opportunistically write workspace ID to the workspace-local file.
```
- **Edge Cases Handled:** This keeps behavior unchanged while removing misleading implementation guidance that would otherwise encourage a future revert.

#### MODIFY `src/services/PlanFileImporter.ts`
- **Context:** This file repeats the same “committed workspace-id file” assumption in comments around the importer fallback chain.
- **Logic:**
  1. Keep the read/write behavior intact if the plan only changes git tracking semantics.
  2. Update the nearby comments so they describe a workspace-local file instead of an intentionally committed artifact.
- **Implementation (comment-only diff):**
```diff
--- a/src/services/PlanFileImporter.ts
+++ b/src/services/PlanFileImporter.ts
@@
-    // Read the committed workspace-id file (cross-machine stable ID).
-    // Checked after DB so that the local machine's established ID takes precedence,
-    // but before legacy/hash fallbacks so fresh clones pick up the team's ID.
+    // Read the workspace-local workspace-id file if present.
+    // Checked after DB so that the local machine's established ID takes precedence,
+    // but before legacy/hash fallbacks so existing local workspaces keep using the same ID source.
@@
-    // Opportunistically write committed file for cross-machine sync (wx = exclusive create)
+    // Opportunistically write the workspace-local file (wx = exclusive create)
```
- **Edge Cases Handled:** The behavior remains backwards-compatible for local file users, but the comments no longer encode the old sharing assumption as the intended design.

### Preserved Original Implementation Material
- **Original file target:** `.gitignore`
- **Original instruction preserved verbatim:** Remove the following lines from both occurrences (lines 42 and 78):
  ```text
  !.switchboard/workspace-id
  ```
- **Original rationale preserved:** The file will then be ignored by the existing `.switchboard/*` pattern, which is the desired behavior for machine-local state.
- **Original verification note preserved with clarification:** The draft suggested `git status` and `git rm --cached .switchboard/workspace-id`. Keep the inspection-oriented `git status`/`git check-ignore` validation, but treat any index-cleanup command as optional maintainer follow-up outside this plan’s execution steps because it is state-mutating.

## Verification Plan
### Automated Tests
- Run `npm run lint`.
- Run `npm run compile`.
- Run `node src/test/git-ignore-custom-default-regression.test.js`.
- Run `node src/test/workspace-exclude-strategy-regression.test.js`.

### Manual Checks
- Run `git --no-pager diff -- .gitignore src/services/WorkspaceExcludeService.ts src/services/TaskViewerProvider.ts src/services/PlanFileImporter.ts src/test/git-ignore-custom-default-regression.test.js` to confirm only the intended files changed.
- Run `git check-ignore -v .switchboard/workspace-id` and confirm the matching rule now comes from `.switchboard/*`, not from a negated exception.
- Open the setup flow (or inspect `WorkspaceExcludeService.getTargetedRules()`) and verify targeted gitignore rules no longer include `!.switchboard/workspace-id`.
- If the file was already tracked historically, document that a maintainer may need separate index cleanup after code review; do not perform it as part of this plan.

## Recommended Agent
Send to Lead Coder

## Reviewer Pass
### Stage 1 — Grumpy Principal Engineer
- **MAJOR** The implementation removed `!.switchboard/workspace-id` from only one `.gitignore` block and left the managed mirror block re-including the file. That is not a “small miss”; it is a split-brain ignore policy. `WorkspaceExcludeService.TARGETED_RULES` says the file is local-only, while the checked-in managed block still whispers “actually, commit me.” That is how regressions get reintroduced by the next person who trusts the file over the service.
- **MAJOR** The new regression test correctly asserted default ignore behavior, but the worktree still had `.vscode/settings.json` overrides for `switchboard.workspace.ignoreStrategy` and `switchboard.workspace.ignoreRules`. Shipping a default-behavior regression while a shared settings file force-feeds different behavior is sloppy engineering theater. The test was right; the surrounding workspace state was lying.
- **NIT** The comment cleanup landed, but identifiers such as `committedIdPath` and `_tryWriteCommittedId` still carry the old semantics. That is not a correctness defect today, just semantic debt waiting for a bored future engineer to “fix” things in the wrong direction.

### Stage 2 — Balanced Synthesis
- **Keep:** the `WorkspaceExcludeService.TARGETED_RULES` update, the added assertions in `src/test/git-ignore-custom-default-regression.test.js`, and the comment clarifications in `src/services/TaskViewerProvider.ts` / `src/services/PlanFileImporter.ts`.
- **Fix now:** remove the lingering managed-block negation from `.gitignore` so the checked-in rules match the authoritative source, and clear conflicting workspace ignore overrides when validating the new default-behavior regression.
- **Defer:** renaming `committedIdPath` / `_tryWriteCommittedId` can wait for a broader terminology pass because the comments now describe the intended behavior correctly.

### Fixes Applied
- Removed the remaining `!.switchboard/workspace-id` entry from the managed exclusions mirror block in `.gitignore`.
- Cleared temporary `.vscode/settings.json` overrides for `switchboard.workspace.ignoreStrategy` / `switchboard.workspace.ignoreRules` during validation so the regression could validate repo defaults; the file is back at baseline and is not part of the final diff.

### Files Changed
- `.gitignore`
- `src/services/WorkspaceExcludeService.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/PlanFileImporter.ts`
- `src/test/git-ignore-custom-default-regression.test.js`
- `.switchboard/plans/fix_gitignore_workspace_id.md`

### Validation Results
- `npm run compile` ✅
- `node src/test/git-ignore-custom-default-regression.test.js` ✅
- `node src/test/workspace-exclude-strategy-regression.test.js` ✅
- `npm run lint` ❌ Known repo-wide baseline failure: ESLint 9 cannot find `eslint.config.*`.
- `printf '.switchboard/workspace-id\n' | git check-ignore -v --no-index --stdin` ✅ matched `.gitignore:70:.switchboard/*`

### Remaining Risks
- `git --no-pager ls-files --error-unmatch .switchboard/workspace-id` still succeeds, so the file remains tracked in the index/history. Any `git rm --cached` cleanup is still optional maintainer follow-up outside this plan.
- Identifier names like `committedIdPath` still reflect the older cross-machine vocabulary even though the surrounding comments now document the workspace-local behavior.
