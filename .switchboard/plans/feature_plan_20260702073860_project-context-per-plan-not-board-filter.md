# Project Context injects PRD into ALL plans, not just plans belonging to that project

**Plan ID:** 7a3c1f2e-9b4d-4e8a-a612-2c5e7f9b0d44

## Goal

### Problem
When **PROJECT CONTEXT** is toggled ON for a project, that project's PRD is injected into planner prompts for **ALL** dispatched plans — including plans that have **no project** and plans belonging to a **different** project. Example: with one project "Foo" and project context on, plans with no project still receive Foo's PRD in their prompt. This is a serious correctness bug: the agent is told to respect requirements that have nothing to do with the plan it is working on.

### Background
The per-project PRD feature has a single workspace-level toggle (`project_context_enabled`) and resolves the PRD from the **board's current display filter** (`getDisplayedProjectForRoot`), not from the **plan's own `project` field**. The dispatch path in `generateUnifiedPrompt` calls `_resolveProjectPrd(workspaceRoot, this.getDisplayedProjectForRoot(workspaceRoot))` once for the entire batch, then injects the result into the shared `dispatchPrefixCore` that prefixes every role's prompt.

### Root Cause
`getDisplayedProjectForRoot` (KanbanProvider.ts:4811-4819) returns `this._projectFilter` — the project **currently selected in the board's project dropdown** — not the project assigned to the specific plan(s) being dispatched. So:

1. If the board filter is set to project "Foo", every dispatched plan (regardless of its own project) gets Foo's PRD.
2. If the board filter is "All Projects" (unfiltered), `getDisplayedProjectForRoot` returns `null` and **no** PRD is injected — even for plans that DO belong to a project with a PRD.

Both directions are wrong. The PRD must be resolved from the **plan's own `project` field**, not the board UI state.

The `BatchPromptPlan` interface (agentPromptBuilder.ts:28-44) does not currently carry a `project` field, so the prompt builder has no way to know which project each plan belongs to. The `KanbanCard` interface (KanbanProvider.ts:99-113) DOES carry `project?: string`, but `_cardsToPromptPlans` (KanbanProvider.ts:2744-2752) drops it when building `BatchPromptPlan` entries.

### Architectural Note (shared prefix constraint)
`dispatchPrefixCore` (agentPromptBuilder.ts:653-655) is built **once** per `generateUnifiedPrompt` call from a single `options` object — there is no per-plan options bag. Therefore "per-plan PRD resolution" is implemented as **per-batch distinct-project resolution**: the distinct projects across all plans in the batch are collected, each project's PRD resolved, and the combined block folded into the shared prefix. Consequence: in a **mixed batch** (e.g. one Foo plan + one no-project plan), the shared prefix carries Foo's PRD and the no-project plan sees it too. This is acceptable (the prefix is shared batch context) but is NOT a hard per-plan exclusion. A no-project plan is fully excluded from PRD injection **only when it is dispatched alone** (single-plan batch). This is documented honestly in the Edge-Case audit below.

### Companion Plan (injection shape)
Plan `feature_plan_20260702073858_prd-link-only-not-full-content.md` decides the **HOW** of PRD injection: **link-only**, not full content embedding. A 3000-word PRD inlined into every dispatched prompt bloats tokens and blows context windows; the agent can read the file path itself. This plan decides the **WHICH** (which plans get the PRD) and depends on the companion plan's link-only decision. The `prdReferences` shape carries `prdLink` only — no `prdContent`.

## Metadata
- **Tags**: `bugfix`, `backend`, `api`
- **Complexity**: 5/10

## User Review Required
- None. The link-only injection shape is decided by the companion plan (`feature_plan_20260702073858`). The feature is assumed shipped per CLAUDE.md ("when unsure whether something shipped, assume it did and migrate") — the behavioral change (board filter no longer drives PRD injection; "All Projects" now correctly injects PRD links for project-tagged plans) is a user-visible behavior change and MUST be called out in the release notes / changelog for the next VSIX release. No data migration is needed (no persisted state shape changes — only dispatch-time prompt construction changes).

## Complexity Audit

### Routine
- Adding an optional `project?: string` field to the `BatchPromptPlan` interface (backward-compatible, no migration).
- Threading `card.project` into the `_cardsToPromptPlans` push (one line).
- Threading `planRecord?.project` into the two `TaskViewerProvider` CLI-dispatch `BatchPromptPlan` literals.
- Collecting distinct projects from `plans.map(p => p.project)` and filtering `UNASSIGNED_PROJECT_FILTER`.

### Complex / Risky
- Rewriting `buildPrdReferenceBlock` from single-PRD to multi-project `prdReferences` (link-only) while preserving the existing single-project output shape (no regression for the common case).
- Updating the **custom-agent** PRD block (agentPromptBuilder.ts:1345-1351) which reads `addons.prdContent`/`addons.prdLink` directly — must be rewired to `addons.prdReferences` or custom agents silently lose the PRD.
- Updating the **tester acceptance-baseline** block (agentPromptBuilder.ts:896-900) which reads `options.prdContent`/`options.prdLink` directly — must be rewired to `options.prdReferences`.
- Subtask project inheritance: subtask `KanbanPlanRecord` already carries `project?` (KanbanDatabase.ts:45); must prefer the subtask's own project and fall back to the epic's, not blindly inherit the epic's.
- Honest documentation of the mixed-batch shared-prefix leak (no hard per-plan exclusion in mixed batches).
- Coordination with the companion plan (`...73858`): both plans touch `buildPrdReferenceBlock`, the tester block, and the custom-agent block. If both are implemented, the companion plan's link-only conversion and this plan's multi-project `prdReferences` rewrite must be merged carefully — they are not independent edits to the same lines.

## Edge-Case & Dependency Audit
- **Plans with no project (single-plan dispatch)**: Must receive NO PRD block. After the fix, `project === undefined/null` plans are excluded from distinct-project collection, so a lone no-project plan produces an empty `prdReferences` and no PRD block. (Today this incorrectly receives the board-filter project's PRD.)
- **Plans with no project (mixed batch)**: The shared prefix carries the distinct projects' PRD links from OTHER plans in the batch, so the no-project plan will see those links in the shared prefix. This is inherent to the shared-prefix architecture and is acceptable — the prefix is batch-wide context. Not a hard per-plan exclusion.
- **Multi-project batch**: If a batch contains plans from projects "Foo" and "Bar", both PRD links are injected (each labelled with its project name). Most batches are single-project, so the common case produces one PRD block — identical in shape to today.
- **Board filter "All Projects"**: Today this suppresses PRD injection entirely (returns null). After the fix, the board filter is irrelevant to PRD injection — the plan's own project drives it. This is the correct behavior and is a deliberate user-visible change.
- **Board filter set to a specific project**: Today this injects that project's PRD for all plans. After the fix, only plans actually belonging to that project get the PRD. If the user dispatches a batch filtered to "Foo", all plans in the batch belong to Foo, so the result is the same — no regression for the filtered-dispatch workflow.
- **`UNASSIGNED_PROJECT_FILTER` ("__none__")**: Must be treated as "no project" — no PRD. `_resolveProjectPrd` already guards against this (KanbanProvider.ts:3163); the distinct-project collector must also filter it.
- **CLI dispatch path** (`TaskViewerProvider.ts:14313, 16358`): Constructs `BatchPromptPlan` from plan records. Must populate `project` from `planRecord?.project`. Confirmed `KanbanPlanRecord.project?: string` exists (KanbanDatabase.ts:45).
- **Custom-agent branch** (KanbanProvider.ts:3225-3231): Uses `getDisplayedProjectForRoot`. Must be updated to per-plan distinct-project resolution and set `mergedAddons.prdReferences`.
- **Tester acceptance-baseline block** (agentPromptBuilder.ts:896-900): Reads `options.prdContent`/`options.prdLink` directly. Must be updated to `options.prdReferences`.
- **Epic subtask expansion** (`expandEpicSubtaskPlans`, KanbanProvider.ts:2777-2816): Subtask `KanbanPlanRecord` carries its own `project?` field. Thread `project: st.project || epicProject` into subtask `BatchPromptPlan` entries (prefer subtask's own project, fall back to epic's).
- **`getDisplayedProjectForRoot`**: After this fix, this method is no longer used by the PRD resolver. It may still be used elsewhere — check before removing. If unused, leave it (dead code is safer than a broken reference) or remove in a follow-up.
- **`prdEnabled` guard**: The current `buildPrdReferenceBlock` early-returns on `!options?.prdEnabled` (line 334). The rewrite removes this guard and keys off `prdReferences` presence instead. Ensure no other call site depends on `prdEnabled` being set.
- **Companion plan overlap**: `feature_plan_20260702073858` also rewrites `buildPrdReferenceBlock`, the tester block, and the custom-agent block for link-only. The two plans must be implemented together or the later one must account for the earlier one's changes — they edit the same lines.

## Dependencies
- `feature_plan_20260702073858_prd-link-only-not-full-content.md` — PRD link-only injection (the HOW). This plan (the WHICH) depends on its link-only decision. If both are in the same batch, implement the companion plan first, then this plan adapts the link-only `prdReferences` shape to multi-project resolution.

## Adversarial Synthesis
Key risks: (1) the shared-prefix architecture means "per-plan PRD" is really "per-batch distinct-project PRD," so no-project plans in mixed batches still see other projects' PRD links — mitigated by documenting this honestly rather than claiming a hard exclusion; (2) custom-agent and tester code paths read `prdContent`/`prdLink` directly and would silently lose the PRD if not rewired — mitigated by concrete code blocks for both; (3) the companion plan (`...73858`) edits the same lines in `buildPrdReferenceBlock`, the tester block, and the custom-agent block — the two plans must be coordinated so the merge doesn't conflict. Subtask project inheritance must prefer the subtask's own project over the epic's.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — add `project` to `BatchPromptPlan`
```ts
// BEFORE (line 28-44)
export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    workingDir?: string;
    sessionId?: string;
    worktreePath?: string;
    epicId?: string;
    isSubtask?: boolean;
    epicTopic?: string;
    isEpic?: boolean;
    hasOwnWorktree?: boolean;
}

// AFTER — add optional project field
export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    workingDir?: string;
    sessionId?: string;
    worktreePath?: string;
    epicId?: string;
    isSubtask?: boolean;
    epicTopic?: string;
    isEpic?: boolean;
    hasOwnWorktree?: boolean;
    /** The plan's assigned project name (from KanbanCard.project / KanbanPlanRecord.project). Drives per-plan PRD resolution. */
    project?: string;
}
```

### 2. `src/services/agentPromptBuilder.ts` — add `prdReferences` to `PromptBuilderOptions`
The current `prdLink`/`prdContent`/`prdEnabled` fields (lines 200-204) assume a single PRD. Add a list of per-project PRD **links** so the block builder can emit one section per project. **Link-only, per the companion plan** — no `prdContent` in the ref shape.

```ts
// Add to PromptBuilderOptions (near line 204)
/**
 * Per-project PRD links resolved from the plans' own project fields (not the board filter).
 * Link-only — the agent reads the PRD file itself (per feature_plan_20260702073858).
 * When empty/absent, no PRD block is emitted.
 */
prdReferences?: Array<{ projectName: string; prdLink: string }>;
```

Leave the existing `prdEnabled`/`prdLink`/`prdContent` fields for backward compat but stop populating them in the dispatch path. The rewritten `buildPrdReferenceBlock` keys off `prdReferences` instead of `prdEnabled`.

### 3. `src/services/agentPromptBuilder.ts` — rewrite `buildPrdReferenceBlock` for per-project resolution (link-only)
```ts
// AFTER (replaces line 329-342)
export function buildPrdReferenceBlock(options: PromptBuilderOptions | undefined, role: string): string {
    if (role === 'tester') return '';
    const refs = options?.prdReferences;
    if (!refs || refs.length === 0) return '';

    // Single project (common case) — keep the existing one-block shape.
    if (refs.length === 1) {
        const r = refs[0];
        return `PROJECT REQUIREMENTS (PRD):\nThe following product requirements document applies to the active project and must be respected throughout this work:\n${r.prdLink}`;
    }
    // Multi-project batch — one labelled section per project.
    const sections = refs.map(r =>
        `PROJECT REQUIREMENTS (PRD) — project "${r.projectName}":\nRead ${r.prdLink} and respect it for plans belonging to this project.`
    );
    return `PROJECT REQUIREMENTS (PRD) — multiple projects in this batch:\n${sections.join('\n\n')}`;
}
```

### 4. `src/services/agentPromptBuilder.ts` — update tester acceptance-baseline block (line 896-900)
The tester block reads `prdContent`/`prdLink` directly. Rewire to `prdReferences` (link-only). The tester typically processes a small batch; list each project's PRD link as a labelled baseline entry.
```ts
// AFTER (replaces line 896-900)
const blocks: string[] = [];
if (options?.prdReferences && options.prdReferences.length > 0) {
    for (const r of options.prdReferences) {
        blocks.push(`PRODUCT REQUIREMENTS (PRD) — project "${r.projectName}" — primary acceptance baseline:\n${r.prdLink.trim()}`);
    }
}
```
(The constitution block at 902-906 stays unchanged.)

### 5. `src/services/agentPromptBuilder.ts` — update `buildCustomAgentPrompt` PRD block (line 1345-1351)
Custom agents read `addons.prdContent`/`addons.prdLink` directly. Rewire to `addons.prdReferences` (link-only), mirroring `buildPrdReferenceBlock`'s rendering.
```ts
// AFTER (replaces line 1345-1351)
// Per-project PRD (project-context toggle) — custom agents are a separate prompt
// path and must carry the PRD too, otherwise they silently miss it.
if (addons?.prdReferences && addons.prdReferences.length > 0) {
    if (addons.prdReferences.length === 1) {
        const r = addons.prdReferences[0];
        prompt += `\n\nPROJECT REQUIREMENTS (PRD):\nThe following product requirements document applies to the active project and must be respected throughout this work:\n${r.prdLink}`;
    } else {
        const sections = addons.prdReferences.map(r =>
            `PROJECT REQUIREMENTS (PRD) — project "${r.projectName}":\nRead ${r.prdLink} and respect it for plans belonging to this project.`
        );
        prompt += `\n\nPROJECT REQUIREMENTS (PRD) — multiple projects in this batch:\n${sections.join('\n\n')}`;
    }
}
```

### 6. `src/services/KanbanProvider.ts` — populate `project` in `_cardsToPromptPlans` (line 2744-2752)
```ts
// BEFORE (line 2744-2752)
promptPlans.push({
    topic: card.topic,
    absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
    complexity: card.complexity,
    workingDir,
    sessionId: cardKey,
    worktreePath,
    epicId,
    isEpic: !!card.isEpic
});

// AFTER — thread card.project
promptPlans.push({
    topic: card.topic,
    absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
    complexity: card.complexity,
    workingDir,
    sessionId: cardKey,
    worktreePath,
    epicId,
    isEpic: !!card.isEpic,
    project: card.project || undefined
});
```

### 7. `src/services/KanbanProvider.ts` — thread `project` through `expandEpicSubtaskPlans` (line 2802-2813)
Subtask `KanbanPlanRecord` carries its own `project?`. Prefer the subtask's own project, fall back to the epic card's project.
```ts
// AFTER (replaces the out.push(...) at 2802-2813)
out.push({
    topic: `[SUBTASK] ${st.topic}`,
    absolutePath: this._resolvePlanFilePath(workspaceRoot, st.planFile),
    complexity: st.complexity,
    workingDir: st.repoScope ? resolveWorkingDir(workspaceRoot, st.repoScope) : '',
    sessionId: st.sessionId || st.planId,
    worktreePath: stWorktreePath,
    hasOwnWorktree: !!ownWorktreePath,
    isSubtask: true,
    epicTopic,
    epicId: epicPlanId,
    project: st.project || epicProject || undefined
});
```
This requires `expandEpicSubtaskPlans` to accept the epic's project. Add an `epicProject?: string` parameter (after `subtaskWorktreePathMap`) and update the two call sites:
- `_cardsToPromptPlans` (KanbanProvider.ts:2755-2757): pass `card.project`.
- `_resolveKanbanDispatchPlans` in TaskViewerProvider (the CLI-dispatch expansion): pass the epic plan record's `project`.

### 8. `src/services/KanbanProvider.ts` — resolve PRDs per-plan in `generateUnifiedPrompt` built-in branch (line 3286-3293)
```ts
// BEFORE (line 3286-3293)
if (await this._resolveProjectContextEnabled(workspaceRoot)) {
    const { prdLink, prdContent } = await this._resolveProjectPrd(workspaceRoot, this.getDisplayedProjectForRoot(workspaceRoot));
    if (prdLink || prdContent) {
        resolvedOptions.prdEnabled = true;
        resolvedOptions.prdLink = prdLink;
        resolvedOptions.prdContent = prdContent;
    }
}

// AFTER — resolve from the plans' own projects (link-only)
if (await this._resolveProjectContextEnabled(workspaceRoot)) {
    const distinctProjects = [...new Set(
        plans.map(p => p.project).filter((p): p is string => !!p && p !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)
    )];
    const prdReferences: Array<{ projectName: string; prdLink: string }> = [];
    for (const projectName of distinctProjects) {
        const { prdLink } = await this._resolveProjectPrd(workspaceRoot, projectName);
        if (prdLink) prdReferences.push({ projectName, prdLink });
    }
    if (prdReferences.length > 0) {
        resolvedOptions.prdReferences = prdReferences;
    }
}
```
Note: `_resolveProjectPrd` currently returns both `prdLink` and `prdContent`. The companion plan (`...73858`) may strip `prdContent` from its return shape. Either way, this plan only destructures `prdLink` — safe regardless of whether the companion plan is applied first.

### 9. `src/services/KanbanProvider.ts` — update custom-agent PRD injection (line 3225-3231)
```ts
// BEFORE (line 3225-3231)
if (await this._resolveProjectContextEnabled(workspaceRoot)) {
    const { prdLink, prdContent } = await this._resolveProjectPrd(workspaceRoot, this.getDisplayedProjectForRoot(workspaceRoot));
    if (prdLink || prdContent) {
        mergedAddons.prdLink = prdLink;
        mergedAddons.prdContent = prdContent;
    }
}

// AFTER
if (await this._resolveProjectContextEnabled(workspaceRoot)) {
    const distinctProjects = [...new Set(
        plans.map(p => p.project).filter((p): p is string => !!p && p !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)
    )];
    const prdReferences: Array<{ projectName: string; prdLink: string }> = [];
    for (const projectName of distinctProjects) {
        const { prdLink } = await this._resolveProjectPrd(workspaceRoot, projectName);
        if (prdLink) prdReferences.push({ projectName, prdLink });
    }
    if (prdReferences.length > 0) {
        mergedAddons.prdReferences = prdReferences;
    }
}
```

### 10. `src/services/TaskViewerProvider.ts` — populate `project` in CLI-dispatch `BatchPromptPlan` entries (lines 14313, 16358)
```ts
// BEFORE (line 14313)
const plan: BatchPromptPlan = { topic, absolutePath: planFileAbsolute, workingDir, isEpic: !!planRecord?.isEpic };

// AFTER
const plan: BatchPromptPlan = { topic, absolutePath: planFileAbsolute, workingDir, isEpic: !!planRecord?.isEpic, project: planRecord?.project || undefined };
```
```ts
// BEFORE (line 16358)
const dispatchPlan: BatchPromptPlan = { topic: sessionTopic, absolutePath: planFileAbsolute, workingDir: effectiveWorkingDir, epicId, worktreePath, isEpic: isEpicPlan };

// AFTER
const dispatchPlan: BatchPromptPlan = { topic: sessionTopic, absolutePath: planFileAbsolute, workingDir: effectiveWorkingDir, epicId, worktreePath, isEpic: isEpicPlan, project: planRecord?.project || undefined };
```
For line 16358, confirm `planRecord` is in scope at that point (the dispatch path at 16358 is the configured-dispatch path; verify the plan record lookup precedes it — see TaskViewerProvider.ts:15046 for the `getPlanBySessionId` pattern). If `planRecord` is not in scope, resolve it via `db.getPlanBySessionId(sessionId)` or `db.getPlanByPlanFile(planId, workspaceId)` before constructing `dispatchPlan`.

## Verification Plan
1. **Manual — no-project plan excluded (single-plan dispatch)**: Create a plan with no project. Enable PROJECT CONTEXT for project "Foo" (which has a PRD). Dispatch a prompt for the no-project plan **alone**. Confirm the prompt contains **no** PRD block. (Today this incorrectly includes Foo's PRD.)
2. **Manual — single-project plan included**: Dispatch a prompt for a plan belonging to "Foo" with PROJECT CONTEXT on. Confirm the prompt includes Foo's PRD **link** (not content — per the companion plan).
3. **Manual — different-project plan excluded**: Create a plan belonging to project "Bar". With PROJECT CONTEXT on (toggle is workspace-level), dispatch a prompt for the Bar plan. Confirm the prompt includes **Bar's** PRD link (if it exists), NOT Foo's. If Bar has no PRD, confirm no PRD block appears.
4. **Manual — multi-project batch**: Dispatch a batch containing one Foo plan and one Bar plan (both with PRDs). Confirm the prompt includes both PRD links, each labelled with its project name.
5. **Manual — mixed batch (no-project + project)**: Dispatch a batch containing one Foo plan and one no-project plan. Confirm the shared prefix carries Foo's PRD link (the no-project plan sees it — this is the documented shared-prefix behavior, NOT a bug).
6. **Manual — board filter "All Projects"**: Set the board filter to "All Projects". Dispatch a plan belonging to "Foo". Confirm Foo's PRD link is injected (today this suppresses it — the fix corrects this).
7. **Manual — PROJECT CONTEXT off**: Disable the toggle. Confirm no PRD block appears for any plan regardless of project.
8. **Manual — custom agent**: Repeat test 1 with a custom agent role. Confirm the custom-agent prompt also excludes the PRD for a lone no-project plan.
9. **Manual — tester role**: Dispatch a tester prompt for a Foo plan with PROJECT CONTEXT on. Confirm the acceptance-baseline block includes Foo's PRD link (labelled), and that the shared-prefix PRD block is suppressed (no double-injection).
10. **Manual — epic subtask**: Dispatch an epic whose subtasks have their own `project` field set to a different project than the epic. Confirm each subtask's PRD resolves from its own project, not the epic's.
11. **Manual — link-only (no content embedding)**: With a project whose PRD file is large (e.g. 3000 words), confirm the prompt contains only the file path/link, NOT the full content. This is the companion plan's guarantee — this plan must not regress it.
12. **Unit**: Run `npm test`. Update `pair-programming-comprehensive.test.ts` fixtures if the new `project` field causes type errors (it's optional, so likely unaffected). Add a test case asserting `buildPrdReferenceBlock` returns `''` when `prdReferences` is empty or undefined, and returns a labelled multi-section block (links only) when given two refs.

### Automated Tests
- `npm test` — confirm no regressions in `pair-programming-comprehensive.test.ts` (the new `project` field is optional; existing fixtures should compile unchanged).
- New unit test: `buildPrdReferenceBlock` — empty/undefined `prdReferences` → `''`; single ref → link-only block; two refs → labelled multi-section block (links only, no content).
- New unit test: `generateUnifiedPrompt` — a batch with one project-tagged plan and one no-project plan produces a `prdReferences` with exactly one entry (the no-project plan does not contribute a ref).

## Recommendation
Complexity 5/10 → **Send to Coder**.
