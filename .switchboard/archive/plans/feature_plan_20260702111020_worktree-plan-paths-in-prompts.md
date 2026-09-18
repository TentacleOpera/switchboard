# Worktree Plan Paths in Agent Prompts

**Plan ID:** 7e3a1c2d-4b5e-4f9a-8d10-2c7e6b5a4f01

## Goal

### Problem

When a project worktree is created (safety session, epic per-subtask mode, high-low tier mode), the prompts sent to agents do not refer to that worktree. The plan file path in the prompt always points to the **main workspace root**, not the worktree. The agent is told to work inside the worktree (via the `safetySessionBlock`) but the `Plan File:` line and `WORKING DIRECTORY` block both point outside it — forcing the agent to leave the worktree to read the plan, defeating the isolation purpose.

### Background Context

Switchboard creates git worktrees for epic orchestration (per-subtask mode, high-low tier mode) and safety sessions. The `.switchboard/plans/` directory is **git-tracked** (un-ignored via `!.switchboard/plans/` in `.gitignore`, confirmed at lines 42-44 and 74-76), so plan files that are committed to the base branch **do exist inside the worktree** at `<worktreePath>/.switchboard/plans/<filename>`. The worktree is a fully isolated working copy — the agent should never need to reference the main repo directory.

### Root Cause Analysis

The `BatchPromptPlan` interface (`src/services/agentPromptBuilder.ts:28-44`) carries two independent fields:

- `absolutePath` — the plan file path, rendered as `Plan File: ${plan.absolutePath}` in the prompt's plan list
- `worktreePath` — the worktree directory, rendered in the `safetySessionBlock` ("work from inside the worktree directory: ...")

These two fields are **populated independently and never reconciled**:

1. **`absolutePath` is always resolved from `workspaceRoot`**, never from `worktreePath`:
   - `KanbanProvider._resolvePlanFilePath(workspaceRoot, card.planFile)` (line 2676-2680) — `path.resolve(workspaceRoot, normalized)`
   - `TaskViewerProvider._resolveKanbanDispatchPlans` (line 3135) — `path.resolve(workspaceRoot, planFile)`
   - `TaskViewerProvider` single-card dispatch (line 16244) — `path.resolve(resolvedWorkspaceRoot, planFileRelative)`

2. **`workingDir` is resolved from `repoScope`**, never from `worktreePath`:
   - `resolveWorkingDir(workspaceRoot, repoScope)` at all three call sites
   - `buildPromptDispatchContext` (line 267-312) uses `workingDir` for the `WORKING DIRECTORY:` block

3. **The `safetySessionBlock`** (lines 823-828, 941-948, 990-997, 1035-1042) tells the agent "All file operations must be run from inside the worktree directory: `${plan.worktreePath}`" — but the `PLANS TO PROCESS:` section immediately below says `Plan File: /main/repo/.switchboard/plans/foo.md`, a **contradictory instruction** that points outside the worktree.

The result: the agent reads the plan from the main repo (outside the worktree), then tries to implement inside the worktree — or gets confused about which directory to work in. The worktree isolation is partially defeated because the agent's file reads cross the worktree boundary.

## Metadata

- **Tags:** bugfix, backend
- **Complexity:** 4

## User Review Required

Yes — review the `safetySessionBlock` text rewording (Proposed Change #8). The new wording changes the agent-facing instruction from corrective ("read from that location, not the main directory") to reinforcing ("the plan file path above is already inside this worktree"). Confirm the new phrasing matches the intended agent guidance tone. Also confirm the fallback policy (Proposed Change #1): when a plan file is uncommitted and absent from the worktree, the agent is pointed back to the workspace-root path — acceptable trade-off vs. the alternative of auto-committing plan files before worktree creation (explicitly out of scope here).

## Complexity Audit

### Routine
- Re-resolving `absolutePath` against `worktreePath` when present — straightforward `path.resolve` swap at 3 call sites, wrapped in a shared helper with an `fs.existsSync` fallback.
- Setting `workingDir` to `worktreePath` when present — single-line override at 3 call sites via a shared helper.
- Updating the `safetySessionBlock` text to stop contradicting the plan list (the plan list will now point inside the worktree, so the safety block becomes reinforcing rather than corrective).
- Adding imports of the two new helpers to `KanbanProvider.ts` and `TaskViewerProvider.ts`.

### Complex / Risky
- **Epic subtask expansion** (`expandEpicSubtaskPlans`, line 2777-2816): subtasks inherit the epic's worktree or get their own per-subtask worktree. The re-resolution must use each subtask's own `worktreePath`, not the epic's — the existing code already threads `stWorktreePath` per subtask, so this is a matter of applying the re-resolution at the right point.
- **`buildPromptDispatchContext` multi-repo logic** (line 281-311): when plans share the same worktree, the "WORKING DIRECTORY" block should point to the worktree; when plans are in different worktrees, the "MULTI-REPO BATCH" block should list per-plan worktree paths. The current `workingDir`-based logic needs to account for `worktreePath` taking precedence.
- **Fallback when plan file doesn't exist in worktree**: if a plan file was created after the worktree was branched (uncommitted), it won't exist at `<worktreePath>/.switchboard/plans/<filename>`. The re-resolution must fall back to the workspace-root path in that case so the agent can still read the plan.
- **`safetySessionBlock` dedup**: the block is built by looping over `plans` and appending one block per plan with a `worktreePath`. When an epic batch contains the epic card plus N subtasks all sharing the same worktree, the current loop emits N+1 duplicate safety blocks. The text rewording should deduplicate by worktree path so the prompt carries one block per distinct worktree, not one per plan.

## Edge-Case & Dependency Audit

1. **Plan file not yet committed**: `git worktree add` checks out committed files only. A plan file created after the worktree's base branch point won't exist in the worktree. The fix must check `fs.existsSync` on the worktree-resolved path and fall back to the workspace-root path. This is a pragmatic fallback — the ideal long-term fix (auto-committing plan files before worktree creation) is out of scope for this plan.

2. **`absolutePath` already absolute**: `_resolvePlanFilePath` handles absolute `planFile` values by returning them as-is. When re-resolving against the worktree, we need the path *relative to the workspace root* first (`path.relative(workspaceRoot, absolutePath)`), then resolve against the worktree.

3. **No worktree (normal dispatch)**: the vast majority of dispatches have no `worktreePath`. The fix must be a no-op when `worktreePath` is undefined/empty — no behavior change for the common path.

4. **Per-subtask vs epic-level worktree**: `expandEpicSubtaskPlans` sets `hasOwnWorktree` to distinguish a subtask's own worktree from an inherited epic-level worktree. Both cases need the plan path re-resolved — the distinction only affects the orchestration directive, not the path resolution.

5. **`buildPromptDispatchContext` "all plans share dir" logic**: currently checks if all `workingDir` values are identical. When worktree paths are involved, the check should use the effective working directory (worktree path if present, else `workingDir`). Because the call sites will already set `workingDir` to the worktree path via `resolveWorkingDirForWorktree`, the existing `distinctWorkingDirs` check operates on the already-overridden value — so no change is needed inside `buildPromptDispatchContext` itself, only at the call sites.

6. **Reviewer `safetySessionBlock`**: the reviewer block (line 823-828) says "Read the plan file and code changes from that location (not the main directory)." With the fix, the plan file path will already point inside the worktree, so this instruction becomes redundant but not harmful. It can be simplified to just reference the worktree for code changes.

7. **`resolveWorktreePathForPlan` in TaskViewerProvider**: this static method (line 7389) resolves the worktree path from the DB. It's called at the dispatch call sites and the result is passed as `worktreePath`. The fix doesn't change this resolution — it changes how `absolutePath` and `workingDir` are computed *after* `worktreePath` is known.

8. **Mixed worktree / non-worktree batch**: an epic batch may contain the epic card (no worktree resolved) plus subtasks each with their own worktree, or vice versa. `buildPromptDispatchContext` must tolerate a mix where some plans have a worktree-overridden `workingDir` and others have a repoScope `workingDir` — the existing "all share dir" vs "MULTI-REPO BATCH" branch already handles heterogeneous `workingDir` values, so mixing is safe.

9. **`fs.existsSync` on worktree path before override**: `resolveWorkingDirForWorktree` stat-checks the worktree path. If the worktree was deleted between resolution and prompt build (race with manual `git worktree remove`), the helper falls back to the repoScope `workingDir` with a warning rather than emitting a prompt pointing at a non-existent directory.

## Dependencies

- None. This plan is self-contained within `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`, and `src/services/TaskViewerProvider.ts`.

## Adversarial Synthesis

Key risks: (1) the `fs.existsSync` fallback silently re-opens the worktree boundary for uncommitted plan files, masking the real bug (plans not committed before worktree creation) instead of fixing it; (2) the `safetySessionBlock` loop emits one duplicate block per plan sharing a worktree, bloating epic-batch prompts; (3) `path.relative(workspaceRoot, absolutePath)` returns a `..`-prefixed path when the plan lives outside the workspace root, which the helper guards but only by skipping re-resolution — leaving the contradiction in place for that edge case. Mitigations: keep the fallback but log a warning so the uncommitted-plan case is visible; deduplicate the safety block by distinct worktree path; accept the `..` guard as a correct no-op since plans outside the workspace root cannot meaningfully be re-resolved into a worktree anyway.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — add worktree-aware path resolution helper

Add a shared helper function that re-resolves a plan file path against a worktree, with fallback:

```typescript
import * as fs from 'fs';
import * as path from 'path';

/**
 * When a worktree is active, re-resolve the plan file path to point inside the
 * worktree (where the plan exists as a git-tracked file). Falls back to the
 * original workspace-root path if the file doesn't exist in the worktree yet
 * (e.g. plan was created after the worktree was branched and not committed).
 */
export function resolvePlanPathForWorktree(
    absolutePath: string,
    workspaceRoot: string,
    worktreePath?: string
): string {
    if (!worktreePath || !absolutePath) return absolutePath;
    const rel = path.relative(workspaceRoot, absolutePath);
    if (!rel || rel.startsWith('..')) return absolutePath; // plan is outside workspace root — can't re-resolve
    const worktreePath_candidate = path.resolve(worktreePath, rel);
    if (fs.existsSync(worktreePath_candidate)) {
        return worktreePath_candidate;
    }
    // Plan file not in worktree (uncommitted) — fall back to workspace-root path
    console.warn(
        `[resolvePlanPathForWorktree] Plan file not found in worktree: ${worktreePath_candidate}. ` +
        `Falling back to workspace-root path: ${absolutePath}`
    );
    return absolutePath;
}
```

### 2. `src/services/agentPromptBuilder.ts` — add worktree-aware working directory helper

```typescript
/**
 * When a worktree is active, the effective working directory is the worktree
 * path (overriding the repoScope-based workingDir). The worktree is a fully
 * isolated working copy — the agent should operate entirely inside it.
 */
export function resolveWorkingDirForWorktree(
    workingDir: string,
    worktreePath?: string
): string {
    if (!worktreePath) return workingDir;
    if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
        console.warn(
            `[resolveWorkingDirForWorktree] worktreePath does not exist or is not a directory: ${worktreePath}. ` +
            `Falling back to repoScope-based workingDir.`
        );
        return workingDir;
    }
    return worktreePath;
}
```

### 3. `src/services/agentPromptBuilder.ts` — `buildPromptDispatchContext` needs no change

`buildPromptDispatchContext` (line 267-312) consumes `plan.workingDir` and `plan.absolutePath` from the `BatchPromptPlan` objects. Because the call sites (Proposed Changes #4-#7) will pass the worktree-adjusted `workingDir` and `absolutePath` already, the existing `distinctWorkingDirs` / "all plans share dir" logic operates on the overridden values and produces the correct `WORKING DIRECTORY:` block automatically. No edit to this function is required.

### 4. `src/services/KanbanProvider.ts` — apply helpers in `_cardsToPromptPlans`

At line 2743-2752, apply the worktree path resolution:

```typescript
const resolvedAbsolutePath = resolvePlanPathForWorktree(
    this._resolvePlanFilePath(workspaceRoot, card.planFile),
    workspaceRoot,
    worktreePath
);
const resolvedWorkingDir = resolveWorkingDirForWorktree(workingDir, worktreePath);

promptPlans.push({
    topic: card.topic,
    absolutePath: resolvedAbsolutePath,
    complexity: card.complexity,
    workingDir: resolvedWorkingDir,
    sessionId: cardKey,
    worktreePath,
    epicId,
    isEpic: !!card.isEpic
});
```

Add imports at the top of `KanbanProvider.ts`:
```typescript
import { resolvePlanPathForWorktree, resolveWorkingDirForWorktree } from './agentPromptBuilder';
```

### 5. `src/services/KanbanProvider.ts` — apply helpers in `expandEpicSubtaskPlans`

At line 2802-2813, apply the same resolution per subtask:

```typescript
const resolvedAbsolutePath = resolvePlanPathForWorktree(
    this._resolvePlanFilePath(workspaceRoot, st.planFile),
    workspaceRoot,
    stWorktreePath
);
const stWorkingDir = resolveWorkingDirForWorktree(
    st.repoScope ? resolveWorkingDir(workspaceRoot, st.repoScope) : '',
    stWorktreePath
);

out.push({
    topic: `[SUBTASK] ${st.topic}`,
    absolutePath: resolvedAbsolutePath,
    complexity: st.complexity,
    workingDir: stWorkingDir,
    sessionId: st.sessionId || st.planId,
    worktreePath: stWorktreePath,
    hasOwnWorktree: !!ownWorktreePath,
    isSubtask: true,
    epicTopic,
    epicId: epicPlanId
});
```

### 6. `src/services/TaskViewerProvider.ts` — apply helpers in `_resolveKanbanDispatchPlans`

At line 3140-3148, apply the resolution:

```typescript
import { resolvePlanPathForWorktree, resolveWorkingDirForWorktree } from './agentPromptBuilder';

// ... inside _resolveKanbanDispatchPlans, after worktreePath is resolved:
const resolvedAbsolutePath = resolvePlanPathForWorktree(absolutePath, workspaceRoot, worktreePath);
const resolvedWorkingDir = resolveWorkingDirForWorktree(workingDir, worktreePath);

validPlans.push({
    sessionId: sid,
    topic: topic || planFile || 'Untitled',
    absolutePath: resolvedAbsolutePath,
    workingDir: resolvedWorkingDir,
    epicId,
    worktreePath,
    isEpic: !!plan?.isEpic
});
```

Note: the `fs.existsSync(absolutePath)` guard at line 3136 runs against the workspace-root path *before* re-resolution. Keep it as-is — it validates the plan exists somewhere. The worktree re-resolution then either confirms it exists in the worktree or falls back to this validated path.

### 7. `src/services/TaskViewerProvider.ts` — apply helpers in single-card dispatch

At line 16244/16358, apply the resolution:

```typescript
const planFileAbsolute = path.resolve(resolvedWorkspaceRoot, planFileRelative);
// ... after worktreePath is resolved (line 16227):
const resolvedPlanFileAbsolute = resolvePlanPathForWorktree(planFileAbsolute, resolvedWorkspaceRoot, worktreePath);
const effectiveWorkingDir = resolveWorkingDirForWorktree(
    options?.workingDirectory ?? workingDir,
    worktreePath
);

const dispatchPlan: BatchPromptPlan = {
    topic: sessionTopic,
    absolutePath: resolvedPlanFileAbsolute,
    workingDir: effectiveWorkingDir,
    epicId,
    worktreePath,
    isEpic: isEpicPlan
};
```

Note: `resolvePlanPathForWorktree` and `resolveWorkingDirForWorktree` need to be imported from `agentPromptBuilder` (already imported in `TaskViewerProvider` for other types).

### 8. `src/services/agentPromptBuilder.ts` — simplify and deduplicate `safetySessionBlock` text

The `safetySessionBlock` (4 occurrences: reviewer, lead, coder, intern) currently says "Read the plan file and code changes from that location (not the main directory)" / "All file operations must be run from inside the worktree directory." With the fix, the plan file path already points inside the worktree, so the text should reinforce rather than correct. Additionally, the per-plan loop emits one block per plan sharing a worktree — deduplicate by distinct worktree path so an epic batch with N subtasks in one worktree produces a single safety block, not N+1.

**Reviewer (line 823-828):**
```typescript
let safetySessionBlock = '';
const seenWorktrees = new Set<string>();
for (const plan of plans) {
    if (plan.worktreePath && !seenWorktrees.has(plan.worktreePath)) {
        seenWorktrees.add(plan.worktreePath);
        safetySessionBlock += `\nIMPORTANT: You are reviewing work done in a safety session. The worktree directory is: ${plan.worktreePath}\n` +
            `The plan file path above is already inside this worktree — read it from there. Review all code changes from this worktree directory.\n`;
    }
}
```

**Lead/Coder/Intern (lines 941-948, 990-997, 1035-1042):**
```typescript
let safetySessionBlock = '';
const seenWorktrees = new Set<string>();
for (const plan of plans) {
    if (plan.worktreePath && !seenWorktrees.has(plan.worktreePath)) {
        seenWorktrees.add(plan.worktreePath);
        safetySessionBlock += `\nIMPORTANT: You are working in a safety session. All file operations and git commands\n` +
            `must be run from inside the worktree directory: ${plan.worktreePath}\n` +
            `The plan file path above is already inside this worktree. Navigate into this directory before making any changes. Do NOT run git commands\n` +
            `from the parent directory — that is the main branch and will corrupt it.\n`;
    }
}
```

## Verification Plan

### Automated Tests

1. **Unit test — `resolvePlanPathForWorktree`**: create a temp directory structure mimicking a worktree, verify that:
   - When `worktreePath` is set and the plan file exists in the worktree, returns the worktree path
   - When `worktreePath` is set but the plan file doesn't exist in the worktree, falls back to the original path (with warning)
   - When `worktreePath` is undefined, returns the original path unchanged
   - When the plan path is outside the workspace root (relative starts with `..`), returns the original path

2. **Unit test — `resolveWorkingDirForWorktree`**: verify that:
   - When `worktreePath` exists and is a directory, returns `worktreePath`
   - When `worktreePath` doesn't exist, falls back to `workingDir` (with warning)
   - When `worktreePath` is undefined, returns `workingDir` unchanged

3. **Integration test — prompt content**: mock a `BatchPromptPlan` with `worktreePath` set, call `buildKanbanBatchPrompt`, verify:
   - The `Plan File:` line in the plan list points to `<worktreePath>/.switchboard/plans/<filename>`
   - The `WORKING DIRECTORY:` block (if present) points to the worktree path
   - The `safetySessionBlock` references the worktree and doesn't contradict the plan list

4. **Integration test — no worktree (regression)**: mock a `BatchPromptPlan` without `worktreePath`, verify the prompt is unchanged from current behavior (plan file points to workspace root, no safety session block).

5. **Integration test — safety block dedup**: mock an epic batch with one epic card and three subtasks all sharing the same `worktreePath`, verify the `safetySessionBlock` appears exactly once (not four times).

6. **Manual test — epic per-subtask dispatch**: create an epic with per-subtask worktree mode, dispatch to a coder agent, verify the copied prompt's `Plan File:` lines point inside each subtask's worktree.

7. **Manual test — safety session dispatch**: trigger a safety session worktree, dispatch a plan, verify the prompt's plan file path points inside the worktree.

---

**Recommendation:** Complexity 4 → Send to Coder.

## Review Findings

Implementation matches the plan: both helpers (`resolvePlanPathForWorktree`, `resolveWorkingDirForWorktree`) added with correct `fs.existsSync` fallback and `..`-guard; all 4 call sites (`KanbanProvider._cardsToPromptPlans`, `expandEpicSubtaskPlans`, `TaskViewerProvider._resolveKanbanDispatchPlans`, single-card dispatch) thread `worktreePath` and apply resolution; `safetySessionBlock` deduplicated via `seenWorktrees` across all 4 role paths. One MAJOR fix applied: the safety block text said "the plan file path **above**" but the `PLANS TO PROCESS` list renders **below** the block in all role paths — reworded to "in the list below" in all 4 occurrences (`agentPromptBuilder.ts:886,1007,1058,1105`). One NIT fixed: `worktreePath_candidate` snake_case → `worktreeCandidate` (camelCase convention). Verification: grep confirms no orphaned "path above" / snake_case references; compilation and tests skipped per session instructions. Remaining risks: the `fs.existsSync` fallback silently re-opens the worktree boundary for uncommitted plan files (accepted trade-off per plan); the 4 duplicate safety-block loops could be extracted to a shared helper (deferred).
