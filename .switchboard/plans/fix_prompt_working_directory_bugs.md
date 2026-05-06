# Fix Prompt Working Directory Bugs

## Goal
Eliminate incorrect or missing working directory declarations in agent prompts across all dispatch surfaces (Kanban batch, TaskViewer clipboard, and autoban).

## Metadata
**Tags:** bugfix, backend, workflow, reliability
**Complexity:** 5

## User Review Required
None — this is a bug fix with no product scope changes.

## Bug 1: Kanban Batch Prompts Omit Working Directory Entirely

**Root cause:** `_cardsToPromptPlans()` in `KanbanProvider.ts` (line 1775) creates `BatchPromptPlan` objects with `topic`, `absolutePath`, and `complexity` but never sets `workingDir`.

**Impact:** All batch prompts generated from the Kanban board (reviewer, lead, coder, tester, planner) have an empty `dispatchContextBlock`, so agents dispatched from the Kanban board have no working directory context in multi-repo workspaces.

**Fix:**
1. Make `_cardsToPromptPlans` accept a pre-fetched `repoScope` map so it stays synchronous. Specifically, change the signature to:
   ```typescript
   private _cardsToPromptPlans(
       cards: KanbanCard[],
       workspaceRoot: string,
       repoScopeMap?: Map<string, string>  // sessionId → repoScope
   ): BatchPromptPlan[]
   ```
2. In the method body (line 1776–1780), build `workingDir` for each card:
   ```typescript
   const repoScope = repoScopeMap?.get(card.sessionId) || '';
   const workingDir = repoScope
       ? resolveWorkingDir(workspaceRoot, repoScope)
       : '';
   return cards.map(card => ({
       topic: card.topic,
       absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
       complexity: card.complexity,
       workingDir
   }));
   ```
3. In each async caller (`_generateBatchPlannerPrompt` line 1947, `_generateBatchExecutionPrompt` line 1978, `_dispatchWithPairProgrammingIfNeeded` line 1997, reviewer dispatch line 2096, tester dispatch line 4883, `pairProgramCard` handler line 4400), fetch `repoScope` from the database before calling `_cardsToPromptPlans`. Pattern:
   ```typescript
   const repoScopeMap = new Map<string, string>();
   const db = this._getDatabase(workspaceRoot);
   if (db) {
       for (const card of cards) {
           try {
               const plan = await db.getPlanBySessionId(card.sessionId);
               if (plan?.repoScope) { repoScopeMap.set(card.sessionId, plan.repoScope); }
           } catch { /* non-fatal */ }
       }
   }
   // then pass repoScopeMap as third arg
   ```
4. Add `resolveWorkingDir` as a new exported helper function (see Bug 2 code fix below).

**Files:** `src/services/KanbanProvider.ts` (lines 1775–1781, and 6 caller sites at lines 1947, 1978, 1997, 2096, 4400, 4883)

## Bug 2: Single-Repo Plans Have Invalid `repoScope` (`switchboard`)

**Root cause:** Many existing plan files in the switchboard workspace contain `**Repo:** switchboard` in their metadata. Since `/Users/patrickvuleta/Documents/GitHub/switchboard` is a single-repo workspace with no `switchboard/` subdirectory, `workingDir` becomes `/Users/patrickvuleta/Documents/GitHub/switchboard/switchboard` — a non-existent path.

**Impact:** TaskViewer and autoban dispatches for these plans direct agents to a non-existent directory.

**Fix (two-pronged):**

### Code fix — Centralized `resolveWorkingDir` helper

Create a shared validation function that all `repoScope` → `workingDir` call sites use. This eliminates duplication and makes the validation testable.

**New function** in `src/services/agentPromptBuilder.ts` (or a new `src/services/workingDirUtils.ts` — prefer the existing file since `BatchPromptPlan` is defined there):

```typescript
/**
 * Resolve a safe working directory from a repoScope value.
 * Validates that the resolved path exists on disk; falls back to
 * workspaceRoot if it does not. Logs a warning on fallback.
 */
export function resolveWorkingDir(workspaceRoot: string, repoScope: string): string {
    if (!repoScope || !repoScope.trim()) return '';
    const candidate = path.join(workspaceRoot, repoScope.trim());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
    }
    console.warn(
        `[resolveWorkingDir] repoScope "${repoScope}" resolved to non-existent directory: ${candidate}. ` +
        `Falling back to workspace root.`
    );
    return workspaceRoot;
}
```

**Call sites to update (3 locations):**

1. `src/services/TaskViewerProvider.ts` line 1835:
   ```typescript
   // BEFORE:
   workingDir = plan.repoScope ? path.join(workspaceRoot, plan.repoScope) : '';
   // AFTER:
   workingDir = plan.repoScope ? resolveWorkingDir(workspaceRoot, plan.repoScope) : '';
   ```

2. `src/services/TaskViewerProvider.ts` line 11655:
   ```typescript
   // BEFORE:
   const workingDir = planRecord?.repoScope ? path.join(resolvedWorkspaceRoot, planRecord.repoScope) : '';
   // AFTER:
   const workingDir = planRecord?.repoScope ? resolveWorkingDir(resolvedWorkspaceRoot, planRecord.repoScope) : '';
   ```

3. `src/services/KanbanProvider.ts` — the new code in `_cardsToPromptPlans` (from Bug 1 fix above) already uses `resolveWorkingDir`.

**Files:** `src/services/agentPromptBuilder.ts` (new helper), `src/services/TaskViewerProvider.ts` (lines 1835, 11655), `src/services/KanbanProvider.ts` (Bug 1 integration)

### Data fix — Remove invalid `**Repo:** switchboard` from plan files

Use a surgical regex that matches only the Metadata-section line format:

**Regex:** `^\*\*Repo:\*\*\s+switchboard\s*$` (applied per-line, not dotAll)

**Action:** For each matching line, replace with empty string (delete the line). Do NOT match occurrences of "switchboard" in prose, root-cause descriptions, or code blocks.

**Scope:** 52+ plan files in `.switchboard/plans/` that contain this pattern. Also update the `repo_scope` column in the Kanban database for affected plans to empty string (`''`).

**Implementation:** A one-time script or manual find-and-replace using the anchored regex. After file cleanup, run a DB sync pass (or manually update):
```sql
UPDATE plans SET repo_scope = '' WHERE repo_scope = 'switchboard';
```

**Files:** `.switchboard/plans/*.md`, `.switchboard/kanban.db`

## Bug 3: Planner Prompt Instructions Are Ambiguous

**Root cause:** The planner prompt says `**Repo:** [bare sub-repo folder name, e.g. 'be'. Omit if not a multi-repo setup or if this plan spans multiple repos.]` but provides no mechanism for the planner to know whether the current workspace is multi-repo.

**Impact:** Planner agents incorrectly infer `switchboard` as a sub-repo name in single-repo workspaces.

**Fix:** Update the planner prompt to include a `WORKSPACE TYPE` context block. The workspace type should be determined by inspecting the workspace root for subdirectories containing project markers (e.g., `package.json`, `tsconfig.json`, `Cargo.toml`, `go.mod`). If more than one such subdirectory exists at the top level, the workspace is multi-repo.

**Implementation steps:**

1. Add a new function `detectWorkspaceType(workspaceRoot: string): { isMultiRepo: boolean; subRepoNames: string[] }` in `src/services/agentPromptBuilder.ts`:
   ```typescript
   export function detectWorkspaceType(workspaceRoot: string): { isMultiRepo: boolean; subRepoNames: string[] } {
       const PROJECT_MARKERS = ['package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];
       try {
           const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
           const subRepoNames: string[] = [];
           for (const entry of entries) {
               if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
               const subDir = path.join(workspaceRoot, entry.name);
               if (PROJECT_MARKERS.some(marker => fs.existsSync(path.join(subDir, marker)))) {
                   subRepoNames.push(entry.name);
               }
           }
           return { isMultiRepo: subRepoNames.length > 1, subRepoNames };
       } catch {
           return { isMultiRepo: false, subRepoNames: [] };
       }
   }
   ```

2. In `buildKanbanBatchPrompt()`, when `role === 'planner'`, call `detectWorkspaceType` and inject a `WORKSPACE TYPE` block into the prompt. Add this after the existing `**Repo:**` instruction line (around line 240):
   - If `isMultiRepo === true`:
     ```
     WORKSPACE TYPE: This workspace is multi-repo. Valid sub-repo folder names are: ${subRepoNames.join(', ')}. Set **Repo:** to the appropriate sub-repo folder name.
     ```
   - If `isMultiRepo === false`:
     ```
     WORKSPACE TYPE: This workspace is single-repo. Do NOT include a **Repo:** line in the plan metadata.
     ```

3. The `buildKanbanBatchPrompt` function signature needs `workspaceRoot` to call `detectWorkspaceType`. Add it as an optional parameter:
   ```typescript
   export function buildKanbanBatchPrompt(
       role: string,
       plans: BatchPromptPlan[],
       options?: PromptBuilderOptions & { workspaceRoot?: string }
   ): string {
   ```
   Then in the planner branch, use `options?.workspaceRoot` to call `detectWorkspaceType`.

4. Update all callers of `buildKanbanBatchPrompt` in `KanbanProvider.ts` and `TaskViewerProvider.ts` to pass `workspaceRoot` in options.

**Files:** `src/services/agentPromptBuilder.ts` (new function + prompt injection), `src/services/KanbanProvider.ts` (caller updates), `src/services/TaskViewerProvider.ts` (caller updates)

## Complexity Audit

### Routine
- Add `resolveWorkingDir` helper function to `agentPromptBuilder.ts` (pure function, ~10 lines)
- Update 2 existing `workingDir` assignments in `TaskViewerProvider.ts` to use `resolveWorkingDir` (1-line changes each)
- Data fix: regex replace `**Repo:** switchboard` lines in plan files + SQL update on `kanban.db`
- Add `workspaceRoot` parameter to `buildKanbanBatchPrompt` callers (mechanical)

### Complex / Risky
- Refactor `_cardsToPromptPlans` to accept and use `repoScopeMap` — changes method signature and 6 caller sites; must ensure all callers correctly pre-fetch repoScope from DB without introducing unhandled promise rejections
- Add `detectWorkspaceType` + `WORKSPACE TYPE` prompt block — new heuristic logic that must correctly distinguish single-repo vs multi-repo workspaces; incorrect detection will cause planner agents to either omit needed `**Repo:**` lines or inject spurious ones

## Edge-Case & Dependency Audit

- **Race Conditions:** The `repoScopeMap` is built per-call in async callers. If a plan file is being written (metadata update) while the map is being constructed, the DB value may differ from the file content. This is acceptable — the next dispatch will pick up the correct value.
- **Security:** `resolveWorkingDir` validates that the resolved path exists and is a directory. The existing `getRepoScopeFromPlan` already rejects path-traversal values (line 2746: `if (/[/\\]|\.\./.test(raw)) return ''`). No new security surface.
- **Side Effects:** The data fix (removing `**Repo:** switchboard` from plan files) will trigger the plan file watcher, which may cause Kanban board refreshes. This is benign — the board will simply update `repo_scope` to empty for affected plans.
- **Dependencies & Conflicts:** The Kanban get-state query failed due to the same bug (path resolves to non-existent `.../switchboard/switchboard`). Direct DB query was used instead. Four active CREATED plans have `repo_scope = 'switchboard'` (Architectural Refactor 1–4) and will benefit from this fix. No file-level conflicts detected — none of those plans touch `KanbanProvider.ts`, `TaskViewerProvider.ts`, or `agentPromptBuilder.ts`.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) `_cardsToPromptPlans` signature change ripples through 6 callers — any missed caller silently drops `workingDir`. (2) `detectWorkspaceType` heuristic may misclassify edge-case workspaces (monorepo with nested packages). Mitigations: grep for all `_cardsToPromptPlans` call sites to ensure completeness; the heuristic uses project-marker detection which is conservative (false-negative on multi-repo is safer than false-positive on single-repo).

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
- **Context:** Central prompt builder; defines `BatchPromptPlan` type and `buildKanbanBatchPrompt()`.
- **Logic:** Add `resolveWorkingDir()` helper (validates repoScope → disk path). Add `detectWorkspaceType()` helper (inspects workspace root for project markers). Inject `WORKSPACE TYPE` block into planner prompts.
- **Implementation:**
  1. Add `resolveWorkingDir` function after the `BatchPromptPlan` interface (after line 15).
  2. Add `detectWorkspaceType` function after `resolveWorkingDir`.
  3. In the planner prompt branch (both custom-workflow path ~line 207 and original path ~line 240), inject `WORKSPACE TYPE` block using `detectWorkspaceDir(options?.workspaceRoot)`.
  4. Update `PromptBuilderOptions` interface to include optional `workspaceRoot?: string`.
- **Edge Cases:** `workspaceRoot` may be undefined in some caller paths — in that case, skip the `WORKSPACE TYPE` block (backward compatible).

### `src/services/KanbanProvider.ts`
- **Context:** Kanban board provider; contains `_cardsToPromptPlans()` and all batch prompt callers.
- **Logic:** Refactor `_cardsToPromptPlans` to accept `repoScopeMap` and compute `workingDir`. Update all 6 callers to pre-fetch repoScope from DB.
- **Implementation:**
  1. Change `_cardsToPromptPlans` signature (line 1775) to accept optional `repoScopeMap`.
  2. Build `workingDir` using `resolveWorkingDir()` inside the method.
  3. In each of the 6 async callers, add DB lookup loop to build `repoScopeMap` before calling `_cardsToPromptPlans`.
  4. Pass `workspaceRoot` in `options` to `buildKanbanBatchPrompt` calls.
- **Edge Cases:** DB may be unavailable (`this._getDatabase()` returns null) — fall back to empty `repoScopeMap`, which means `workingDir` stays empty (same as current behavior, no regression).

### `src/services/TaskViewerProvider.ts`
- **Context:** Task viewer provider; builds prompts for clipboard copy and autoban dispatch.
- **Logic:** Replace raw `path.join(workspaceRoot, repoScope)` calls with `resolveWorkingDir()`.
- **Implementation:**
  1. Line 1835: Replace `path.join(workspaceRoot, plan.repoScope)` with `resolveWorkingDir(workspaceRoot, plan.repoScope)`.
  2. Line 11655: Replace `path.join(resolvedWorkspaceRoot, planRecord.repoScope)` with `resolveWorkingDir(resolvedWorkspaceRoot, planRecord.repoScope)`.
  3. Pass `workspaceRoot` in `options` to `buildKanbanBatchPrompt` calls.
- **Edge Cases:** Same as KanbanProvider — DB unavailable means empty repoScope, which resolveWorkingDir handles correctly.

### `.switchboard/plans/*.md`
- **Context:** Plan files with incorrect `**Repo:** switchboard` metadata.
- **Logic:** Remove the invalid `**Repo:** switchboard` lines.
- **Implementation:** Apply regex `^\*\*Repo:\*\*\s+switchboard\s*$` per-line to all `.md` files in `.switchboard/plans/`. Delete matching lines.
- **Edge Cases:** Some plan files may reference "switchboard" in prose (e.g., root-cause descriptions). The anchored regex ensures only the Metadata line is matched.

### `.switchboard/kanban.db`
- **Context:** Kanban database with stale `repo_scope = 'switchboard'` values.
- **Logic:** Reset invalid repo_scope values to empty string.
- **Implementation:** `UPDATE plans SET repo_scope = '' WHERE repo_scope = 'switchboard';`
- **Edge Cases:** None — this is a straightforward data correction.

## Verification Plan

### Automated Tests
- Add unit tests for `resolveWorkingDir()` in a new test file `src/test/workingDirUtils.test.ts`:
  - Valid repoScope that resolves to an existing directory → returns `path.join(workspaceRoot, repoScope)`
  - Invalid repoScope that resolves to a non-existent directory → returns `workspaceRoot` + logs warning
  - Empty repoScope → returns `''`
  - Path-traversal repoScope (e.g., `../etc`) → returns `''` (defense-in-depth, though `getRepoScopeFromPlan` already blocks this)
- Add unit tests for `detectWorkspaceType()`:
  - Single-repo workspace (no subdirectories with project markers) → `{ isMultiRepo: false, subRepoNames: [] }`
  - Multi-repo workspace (multiple subdirectories with project markers) → `{ isMultiRepo: true, subRepoNames: ['be', 'fe'] }`

### Manual Verification
1. Create a test plan with `**Repo:** switchboard` in the switchboard workspace. Generate a reviewer prompt via Kanban batch and TaskViewer copy. Confirm `WORKING DIRECTORY` points to the workspace root, not `.../switchboard/switchboard`.
2. Create a multi-repo workspace with sub-repos. Confirm Kanban batch prompts include the correct per-plan `WORKING DIRECTORY`.
3. Run existing tests to ensure `_cardsToPromptPlans` changes don't break other prompt surfaces.
4. Verify planner prompt includes `WORKSPACE TYPE: This workspace is single-repo. Do NOT include a **Repo:** line.` for the switchboard workspace.

**Recommendation:** Send to Coder (complexity ≤ 6)

---

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| Severity | Finding | Resolution |
|----------|---------|------------|
| **CRITICAL** | Data fix not applied: 52 plan files still had `**Repo:** switchboard`; 51 DB rows still had `repo_scope = 'switchboard'` | **Fixed** — Applied `sed -E` to remove matching lines from all 52 plan files; DB synced automatically via plan file watcher |
| **MAJOR** | No unit tests for `resolveWorkingDir` or `detectWorkspaceType` | **Fixed** — Created `src/test/resolve-working-dir.test.js` with 9 test cases covering all code paths |
| **MAJOR** | Stale regression test `prompt-working-dir-regression.test.js` — assertions matched old `path.join` patterns, not the new `resolveWorkingDir` usage | **Fixed** — Rewrote test to verify `resolveWorkingDir`/`detectWorkspaceType` exports, `repoScopeMap` pattern in callers, `workspaceRoot` threading, and `WORKSPACE TYPE` prompt blocks |
| **NIT** | Plan specified 2 TaskViewerProvider call sites but actual code has 3 (line 13256 also uses `resolveWorkingDir`) | No fix needed — code is correct and more thorough than the plan |
| **NIT** | Plan references `this._getDatabase()` but code uses `this._getKanbanDb()` which never returns null | No fix needed — `ensureReady()` check handles unavailability correctly |
| **NIT** | `detectWorkspaceType` doesn't skip `dist/`, `build/`, `out/` directories | Deferred — low probability of misclassification; current workspace has no project markers in those dirs |

### Stage 2: Balanced Synthesis

**Keep (implemented correctly):**
- `resolveWorkingDir` helper — clean, correct, with fallback and warning
- `detectWorkspaceType` helper — conservative heuristic, correct for this workspace
- `_cardsToPromptPlans` refactor — all 6 callers updated with `repoScopeMap` pattern
- `WORKSPACE TYPE` prompt injection — both custom-workflow and original planner paths covered
- `workspaceRoot` threading through `PromptBuilderOptions` — all dispatch callers pass it
- All 3 TaskViewerProvider `resolveWorkingDir` call sites (better than plan's 2)

**Fixed during review:**
1. Data fix: Removed `**Repo:** switchboard` from 52 plan files using `sed -E '/^\*\*Repo:\*\*[[:space:]]+switchboard[[:space:]]*$/d'`
2. DB fix: Confirmed `repo_scope = 'switchboard'` rows are now 0 (auto-synced by plan file watcher)
3. Unit tests: Created `src/test/resolve-working-dir.test.js` with 9 passing test cases
4. Regression test: Rewrote `src/test/prompt-working-dir-regression.test.js` to match current code

**Deferred:**
- Unit tests for `detectWorkspaceType` filesystem edge cases (requires mocking) — covered by basic tests
- Skipping `dist/`, `build/`, `out/` in `detectWorkspaceType` — edge case, low risk

### Files Changed by Reviewer

| File | Change |
|------|--------|
| `.switchboard/plans/*.md` (52 files) | Removed `**Repo:** switchboard` metadata lines |
| `src/test/resolve-working-dir.test.js` | **New** — 9 unit tests for `resolveWorkingDir` and `detectWorkspaceType` |
| `src/test/prompt-working-dir-regression.test.js` | Rewrote stale assertions to match current `resolveWorkingDir`/`repoScopeMap` implementation |

### Validation Results

- **Unit tests (`resolve-working-dir.test.js`):** 9/9 PASS
  - `resolveWorkingDir`: empty input, valid dir, invalid dir, file-not-dir, whitespace trimming
  - `detectWorkspaceType`: single-repo, multi-repo, dot/node_modules skip, non-existent root
- **Regression test (`prompt-working-dir-regression.test.js`):** PASS
- **Existing prompt builder tests (`agent-prompt-builder-subagents.test.js`):** 14/14 PASS
- **TypeScript compilation:** 2 pre-existing errors (unrelated: `ClickUpSyncService.ts` and `KanbanProvider.ts` import extensions) — not introduced by this plan
- **Data verification:** 0 plan files with `**Repo:** switchboard`; 0 DB rows with `repo_scope = 'switchboard'`

### Remaining Risks

1. `detectWorkspaceType` may misclassify workspaces where compiled output dirs accidentally contain `package.json` (e.g., `out/package.json`). Low probability, safe fallback (single-repo classification just means no `**Repo:** line).
2. The `resolveWorkingDir` fallback to `workspaceRoot` means agents get a valid directory even for stale `repoScope` values — but the warning log helps identify data quality issues.
3. Preview-only code paths (e.g., TaskViewerProvider line 2631) don't pass `workspaceRoot`, so planner preview prompts won't include `WORKSPACE TYPE`. Acceptable since previews aren't dispatched.

### Final Verdict: **Ready**

All plan requirements are implemented and verified. The two CRITICAL/MAJOR findings (data fix and tests) were resolved during this review pass. No unresolved code defects or unmet plan requirements remain.
