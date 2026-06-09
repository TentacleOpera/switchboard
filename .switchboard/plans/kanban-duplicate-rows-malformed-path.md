# Bugfix Plan: Kanban Duplicate Rows & Malformed plan_file Paths

## Status
- **Stage**: Investigation Complete → Fix Pending
- **Created**: 2026-05-14
- **Priority**: High (blocks correct Kanban column advancement)

## Goal
Eliminate duplicate Kanban rows caused by malformed `plan_file` paths that contain absolute-path segments (e.g. `Users/patrickvuleta/...`), and prevent their recurrence by hardening path validation at DB write boundaries, registration boundaries, and startup cleanup.

## Metadata
- **Tags:** backend, bugfix, database, reliability, workflow
- **Complexity:** 6

## User Review Required
- Confirm whether deleting malformed rows in `cleanupSpuriousMirrorPlans` is acceptable (they have no valid plan file and cannot be opened by agents).
- Confirm whether auto-canonicalizing stale local entries that point to brain mirror files to `sourceType: 'brain'` is acceptable for any edge-case local plans that happen to be named `brain_*.md`.

## Complexity Audit

### Routine
- Add `path.basename()` normalization in `_registerPlan` before `path.join` (single line change).
- Add `brain_` / `ingested_` guard in `GlobalPlanWatcherService._handlePlanFile` (single conditional).
- Add regex-based malformed-path detection in `_ensureRelativePlanFile` (bounded, local logic).
- Extend `cleanupSpuriousMirrorPlans` SQL with additional `DELETE` passes for malformed `plan_file` and `mirror_path` values.

### Complex / Risky
- **Data-loss risk during startup cleanup:** `cleanupSpuriousMirrorPlans` deletes rows. If the heuristic incorrectly targets a valid row, Kanban history is lost. Mitigation: exact regex patterns, not substring matching.
- **Stale-entry detection change affects all plan migrations:** `_loadPlanRegistry` runs on every startup. Modifying its canonicalization logic could affect legitimate local plans. Mitigation: only canonicalize when `planFile` exactly matches `^\.switchboard/plans/(brain|ingested)_[0-9a-f]{64}\.md$`.
- **Cross-platform path validation:** A heuristic for "absolute-looking segment" must work on macOS (`/Users/`), Linux (`/home/`), Windows (`C:\`), and WSL. Mitigation: detect any segment after `.switchboard/plans` that matches `Users`, `home`, or a Windows drive letter pattern.

## Edge-Case & Dependency Audit

### Race Conditions
- **Mirror write vs. file watcher race:** `_mirrorBrainPlan` writes the mirror file and sets `_recentMirrorWrites`. `GlobalPlanWatcherService` has its own debounce. If the watcher fires before the TTL expires, it may still create a local row. The existing `_recentMirrorWrites` guard should handle this, but the new `brain_` guard in the watcher is a second defense.
- **Startup cleanup vs. concurrent plan creation:** `initializeKanbanDbOnStartup` calls `cleanupSpuriousMirrorPlans` before the UI is ready. If a plan is being created at the exact same moment, it could be deleted. Mitigation: cleanup only targets rows with already-known-bad paths, not rows created during this session.

### Security
- **Path traversal:** `_ensureRelativePlanFile` already rejects paths outside the workspace. The new check must not accidentally allow traversal via `..` or symlink tricks. The existing boundary check at line 3834 handles this.
- **Log injection:** The plan logs malformed paths. Ensure no user-controlled content can inject newlines into log output. Existing code uses template literals with controlled variables.

### Side Effects
- **Kanban UI refresh:** Deleting rows in `cleanupSpuriousMirrorPlans` does not currently trigger a UI refresh. After startup cleanup, the Kanban board may briefly show stale data until the next refresh. The plan should consider calling `_syncFilesAndRefreshRunSheets` after cleanup if rows were removed.
- **Runsheet references:** If a malformed row is deleted, any open runsheet referencing its `sessionId` will 404 on next access. The runsheet is backed by `SessionActionLog`, which is keyed by `sessionId`. Deleting the kanban row does not delete the runsheet, so this is safe.

### Dependencies & Conflicts
- **No ClickUp/Linear sync conflicts:** These services sync by `planFile` or `sessionId`. If a malformed row is deleted, the sync service may attempt to sync a non-existent row. This is harmless (sync is best-effort).
- **No dependency on other pending plans.**

## Dependencies
- None

## Adversarial Synthesis

Key risks: (1) Startup cleanup heuristics may delete valid rows if pattern matching is too broad; (2) Stale-entry canonicalization may misclassify legitimate local plans named `brain_*.md`; (3) Cross-platform home-directory detection (`/Users/`, `/home/`, `C:\`) is inherently fragile. Mitigations: use exact regex `^\.switchboard/plans/(brain|ingested)_[0-9a-f]{64}\.md$` for brain detection; use `path.basename()` recovery instead of substring heuristics in `_registerPlan`; extend existing `cleanupSpuriousMirrorPlans` rather than adding a competing migration.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — Add brain-file guard
- **Context:** `_handlePlanFile` (line 352) processes every `.md` file found in `.switchboard/plans/`, including brain mirror files (`brain_<hash>.md`). It creates a `sourceType: 'local'` row for them, which later becomes the duplicate.
- **Logic:** `TaskViewerProvider._handlePlanCreation` already has a guard at line 11166 that skips `brain_*.md` files. The watcher lacks this guard.
- **Implementation:** At the top of `_handlePlanFile`, after computing `relativePath`, check if the basename matches `isRuntimeMirrorPlanFile`. If yes, log and return early.
- **Edge Cases:** A user might legitimately create a local plan named `brain_notes.md`. `isRuntimeMirrorPlanFile` requires exactly 64 hex chars, so `brain_notes.md` will not match. This is safe.

### `src/services/TaskViewerProvider.ts:9129-9151` — `_registerPlan` basename normalization
- **Context:** `_registerPlan` assumes `entry.mirrorPath` is a simple basename. When stale-entry detection passes a corrupted `mirrorPath`, `path.join` produces `.switchboard/plans/Users/...`.
- **Logic:** `mirrorPath` should always be a basename for brain plans (set by `_mirrorBrainPlan` as `brain_${hash}.md`). If it contains path separators, it is corrupted.
- **Implementation:** Change line 9149 from `entry.mirrorPath` to `path.basename(entry.mirrorPath)`. This safely recovers the correct filename regardless of corruption.
- **Edge Cases:** If `mirrorPath` is an absolute path like `/Users/.../brain_x.md`, `path.basename` correctly returns `brain_x.md`. If it's already a basename, it is unchanged.

### `src/services/TaskViewerProvider.ts:8979-9011` — `_loadPlanRegistry` stale-entry canonicalization
- **Context:** When a stale local entry points to a brain mirror file, the stale detection re-registers it as `sourceType: 'local'` with a new `sess_*` ID, creating a duplicate.
- **Logic:** If a local row's `planFile` exactly matches the brain mirror pattern, it was almost certainly created by the watcher and should be canonicalized to `sourceType: 'brain'`.
- **Implementation:** In the stale-entry loop, before pushing to `staleEntries`, check if `p.sourceType === 'local'` and `p.planFile` matches `^\.switchboard/plans/(brain|ingested)_[0-9a-f]{64}\.md$`. If so, change `sourceType` to `'brain'` and compute the correct `antigravity_*` sessionId. Then push to `staleEntries` with the corrected sourceType.
- **Edge Cases:** A legitimate local plan that happens to match the regex would be misclassified. The probability is negligible (requires exactly 64 hex chars), but the User Review section flags this.

### `src/services/KanbanDatabase.ts:3850-3889` — `_ensureRelativePlanFile` malformed-path rejection
- **Context:** A path like `.switchboard/plans/Users/...` is technically relative but contains an absolute-looking segment. It passes through unchanged.
- **Logic:** After confirming the path is not absolute, check if any segment after `.switchboard/plans` looks like a home directory or drive letter.
- **Implementation:** After line 3863 (`if (!path.isAbsolute(normalized))`), add a check: split the path, and if any segment after index 2 (i.e., after `.switchboard/plans`) matches `/^(Users|home|[A-Za-z]:)$/` or contains `..`, log a warning and return empty string. Returning empty string causes `_registerPlan` to fall back to `localPlanPath`.
- **Edge Cases:** Valid nested paths like `.switchboard/plans/repoScope/foo.md` have `repoScope` at index 2. `repoScope` does not match the regex, so it passes. A path like `.switchboard/plans/../foo.md` is caught by the `..` check.

### `src/services/KanbanDatabase.ts:2449-2528` — `cleanupSpuriousMirrorPlans` extension
- **Context:** This function already deletes spurious duplicate rows for brain/ingested files. It should also delete rows with malformed `plan_file` or `mirror_path`.
- **Logic:** Add two additional SQL cleanup passes:
  1. Delete active rows where `plan_file` contains `Users/` or `home/` (case-insensitive) and does not match the valid brain/ingested pattern.
  2. Delete active rows where `mirror_path` contains `/` or `\\` (i.e., is not a basename).
- **Implementation:** After the existing duplicate-removal loop, add the two new `DELETE` statements. Log the count of removed rows.
- **Edge Cases:** If a legitimate local plan file is in a subfolder and its path contains `home/` (e.g. `.switchboard/plans/home_improvement.md`), the substring `home/` would not appear — the filename is `home_improvement.md`, not a path segment `home/`. The check is for path segments, not substrings in filenames. Use SQL `plan_file LIKE '%/Users/%' OR plan_file LIKE '%/home/%'` to ensure it's a segment.

## Verification Plan

### Automated Tests
1. **`_ensureRelativePlanFile` unit tests:**
   - Input: `.switchboard/plans/brain_abc.md` → returns unchanged.
   - Input: `.switchboard/plans/Users/patrick/.../brain_abc.md` → returns `''` and logs warning.
   - Input: `.switchboard/plans/repoScope/foo.md` → returns unchanged.
   - Input: `/Users/patrick/workspace/.switchboard/plans/brain_abc.md` → returns relative path (existing behavior).

2. **`_registerPlan` integration tests:**
   - Call `_registerPlan` with `mirrorPath = 'Users/patrick/.../brain_abc.md'` → assert stored `plan_file` is `.switchboard/plans/brain_abc.md` (via `path.basename` normalization).
   - Call `_registerPlan` with `mirrorPath = '/Users/patrick/.../brain_abc.md'` → assert stored `plan_file` is `.switchboard/plans/brain_abc.md`.
   - Call `_registerPlan` with `mirrorPath = 'brain_abc.md'` → assert stored `plan_file` is `.switchboard/plans/brain_abc.md`.

3. **`cleanupSpuriousMirrorPlans` integration test:**
   - Insert a row with `plan_file = '.switchboard/plans/Users/patrick/.../brain_abc.md'`, `sessionId = 'sess_123'`, `sourceType = 'local'`.
   - Call `cleanupSpuriousMirrorPlans`.
   - Assert the row is deleted.
   - Assert the canonical brain row (if present) is untouched.

4. **`_loadPlanRegistry` stale-entry test:**
   - Insert a row with `planFile = '.switchboard/plans/brain_abc.md'`, `sourceType = 'local'`, `sessionId = 'sess_123'`.
   - Call `_loadPlanRegistry`.
   - Assert the row is re-registered with `sourceType = 'brain'` and `sessionId = 'antigravity_abc'`.
   - Assert no duplicate local row remains.

5. **`GlobalPlanWatcherService` guard test:**
   - Trigger `_handlePlanFile` with a `brain_*.md` file.
   - Assert no DB row is created.
   - Assert output channel logs "Skipped brain mirror file".

6. **Regression tests:**
   - Run existing `_handlePlanCreation`, `_mirrorBrainPlan`, `_loadPlanRegistry`, and `cleanupSpuriousMirrorPlans` tests to ensure no breakage.

## Risks
- Deleting duplicate rows during migration could lose event history if the wrong row is chosen as canonical.
- Hardening `_ensureRelativePlanFile` too aggressively could accidentally strip valid nested relative paths (e.g. `.switchboard/plans/repoScope/foo.md`).
- Stale-entry detection is also used for legitimate migrations; changing its logic may break other migration scenarios.

## Files to Modify
- `src/services/GlobalPlanWatcherService.ts` — add brain-file guard in `_handlePlanFile`
- `src/services/TaskViewerProvider.ts` — `_registerPlan` basename normalization, `_loadPlanRegistry` stale-entry canonicalization
- `src/services/KanbanDatabase.ts` — `_ensureRelativePlanFile` malformed-path rejection, `cleanupSpuriousMirrorPlans` extension

## Verification Steps
1. Reproduce the issue: manually insert a row with malformed `plan_file`, restart extension, and confirm `_loadPlanRegistry` re-creates it.
2. Apply fix and restart: confirm the malformed row is removed and only the canonical row remains.
3. Run existing tests: ensure `_handlePlanCreation`, `_mirrorBrainPlan`, and `_loadPlanRegistry` tests still pass.
4. Add new tests: assert that `_registerPlan` with `mirrorPath = '/Users/...'` stores `.switchboard/plans/brain_...md`, and with `mirrorPath = 'Users/...'` either normalizes or rejects.

**Recommendation:** Send to Coder (complexity ≤ 6).
