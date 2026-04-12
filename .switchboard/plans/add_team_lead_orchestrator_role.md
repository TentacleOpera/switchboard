# Add Team Lead Orchestrator Role

## Goal

Add a new `team-lead` built-in role and `TEAM LEAD CODED` Kanban column to Switchboard. This role is designed for terminals running a self-contained AI team orchestration framework — such as OpenCode with its orchestrator-planner agent, GitHub Squads, or Claude Code Agent Teams. Unlike every other Switchboard role (where Switchboard controls the full workflow — planning, routing, reviewing), the team-lead terminal's orchestration framework manages all internal coordination itself. Switchboard's job is just to bootstrap the terminal with the task; the framework handles decomposition, specialist routing, internal review cycles, and retries autonomously.

---

## Metadata

**Tags:** backend, UI
**Complexity:** 5

---

## Cross-Plan Conflict Analysis

| Plan | Shared File | Risk |
|------|------------|------|
| Customize Default Prompts | `agentConfig.ts` | Adds `parseDefaultPromptOverrides` + `DefaultPromptOverride` — **already implemented, no conflict**. This plan adds `'team-lead'` to VALID_ROLES inside that function. |
| Customize Default Prompts | `agentPromptBuilder.ts` | Adds `applyPromptOverride` helper + `defaultPromptOverrides` option — **already implemented, no conflict**. This plan's team-lead branch uses the existing `applyPromptOverride` pattern. |
| Customize Default Prompts | `TaskViewerProvider.ts` | Adds message handlers + `_cachedDefaultPromptOverrides` — **different code regions, no conflict** |
| Linear / Notion / ClickUp plans | `TaskViewerProvider.ts`, `KanbanProvider.ts` | Add integration message handlers — **different switch cases/methods, no conflict** |
| Fix Autoban Routing Map Discrepancy | `KanbanProvider.ts` | May touch `_autobanColumnToRole` equivalent — **verify at implementation time** |

**Dependency:** This plan depends on `customize_default_prompts` being implemented (for `applyPromptOverride` and `promptOverride` variables in agentPromptBuilder.ts). **Verified: already implemented** (`applyPromptOverride` at line 38, `promptOverride` extracted at line 99).

**Verdict:** No blocking conflicts. All changes are additive (new switch cases, new array entries, new prompt branch).

---

## Complexity Audit

### Routine
- Adding `'team-lead'` to the `BuiltInAgentRole` union type in `agentConfig.ts` (line 1)
- Adding `'team-lead': 'Team Lead'` to `BUILT_IN_AGENT_LABELS` in `agentConfig.ts` (line 25)
- Adding `TEAM LEAD CODED` column definition to `DEFAULT_KANBAN_COLUMNS` in `agentConfig.ts` (line 36)
- Adding `'team-lead'` to `VALID_ROLES` in `parseDefaultPromptOverrides` in `agentConfig.ts` (line 164)
- Adding `case 'TEAM LEAD CODED': return 'team-lead';` to `_columnToRole` in `KanbanProvider.ts` (line 3101)
- Adding `'TEAM LEAD CODED': 'team-lead'` to `roleFromColumn` map in `KanbanProvider.ts` (line 526)
- Adding `'team-lead': 'TEAM LEAD CODED'` to `roleToCol` map in `KanbanProvider.ts` (line 1782)
- Adding `case 'TEAM LEAD CODED': return 'review';` to `_workflowForColumn` in `KanbanProvider.ts` (line 1096)
- Adding `case 'team-lead': return 'TEAM LEAD CODED';` to `_codedColumnForRole` in `TaskViewerProvider.ts` (line 737)
- Adding `TEAM LEAD CODED` to `_isCompletedCodingColumn` in `TaskViewerProvider.ts` (line 758)
- Adding `case 'team-lead':` to `_targetColumnForRole` in `TaskViewerProvider.ts` (line 763)
- Adding `case 'TEAM LEAD CODED': return 'team-lead';` to `_roleForKanbanColumn` in `TaskViewerProvider.ts` (line 780)
- Adding `case 'TEAM LEAD CODED':` to `_getNextKanbanColumnForSession` in `TaskViewerProvider.ts` (line 812)
- Adding `case 'TEAM LEAD CODED':` to `_autobanColumnToRole` in `TaskViewerProvider.ts` (line 2594)
- Adding `'TEAM LEAD CODED': 'Team Lead'` to `columnRoleMap` in `TaskViewerProvider.ts` (line 6583)
- Adding `case 'TEAM LEAD CODED':` to `columnToPromptRole` in `agentPromptBuilder.ts` (line 275)

### Complex / Risky
- **New prompt branch in `buildKanbanBatchPrompt`** (agentPromptBuilder.ts) — this function is the canonical prompt source for ALL dispatch paths. The team-lead branch intentionally excludes `executionDirective` (AUTHORIZATION TO EXECUTE), `batchExecutionRules`, `challengeBlock`, pair-programming directives, and accuracy-mode options. This is a deliberate design decision (orchestration frameworks manage their own planning/execution), but any future change to the prompt builder that assumes all code-execution roles include `executionDirective` could silently break team-lead behaviour.
- **Autoban routing gap** — `_autobanColumnToRole` (TVP line 2594) maps `PLAN REVIEWED → 'lead'` for autoban dispatch. With team-lead added, autoban still routes PLAN REVIEWED cards to lead only; team-lead is manual-only. This is intentional but creates an asymmetry: a user with ONLY a team-lead terminal and no lead terminal would see autoban fail silently on PLAN REVIEWED cards.

---

## Background & Research

### Why a dedicated role?

Current Switchboard roles (lead, coder, intern, reviewer) model a single agent doing single-threaded work on a plan. The team-lead role models a different operating mode: a terminal that acts as the entry point into an orchestration framework where multiple agents work in parallel. The framework itself handles what Switchboard normally provides (planning, routing, quality gates).

This matters for prompt design. Sending a team-lead terminal the same "AUTHORIZATION TO EXECUTE: do not enter planning mode" directive is counterproductive — orchestration frameworks need to plan, decompose, and delegate before any code is written.

### Framework Architecture (researched)

The three primary orchestration frameworks have a consistent internal architecture:

**OpenCode (orchestrator-planner agent)**
- Agents are configured via `opencode.json` with description, temperature, steps, and custom prompt files
- The orchestrator-planner agent handles aggressive parallel execution and task delegation to subagents
- Temperature 0.0–0.2 for planning/analysis; 0.3–0.5 for implementation work
- Max steps (`steps`) controls iteration budget per agent; on hitting limit the agent summarizes remaining work

**GitHub Squads**
- A thin coordinator agent figures out routing, loads repository context, and spawns specialists (frontend, backend, tester, lead)
- "Drop-box" pattern: architectural decisions are appended to a shared `decisions.md` file rather than synchronized in real-time — more resilient than live state sync
- Context replication, not context splitting: each specialist gets its own full context window rather than sharing one fragmented window
- Reviewer protocol prevents the original author from revising their own rejected work — a separate agent with a fresh context window must fix it
- Squad's coordinator is intentionally a thin router; it does not do implementation work

**Claude Code Agent Teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
- Three-layer architecture: Team Lead (decomposes, creates task list, synthesizes) → Shared Task List (statuses: pending / in_progress / completed / blocked, dependency tracking, file locking) → Teammates (each an independent Claude Code instance with its own context window)
- Teammates self-claim tasks from the shared list
- Peer-to-peer messaging: teammates communicate directly with each other — backend tells frontend the API contract without routing through the lead, preventing the lead from becoming a bottleneck
- Idle notifications: a teammate automatically notifies the lead when it finishes
- Plan approval for risky tasks: the lead reviews a teammate's plan before implementation begins

### Prompt Design Principles (from research)

Key findings that shape what Switchboard should send to the team-lead terminal:

1. **Be a thin handoff, not a micromanager.** The frameworks expect a task description, not step-by-step orchestration instructions. The coordinator agent decides how to decompose the work.

2. **Loop guardrails live inside the framework.** Patterns like "force a reflection step before each retry" (`What failed? What specific change would fix it? Am I repeating the same approach?`) are built into the framework's own agent prompts, not the entry prompt. Switchboard should not try to replicate these.

3. **3–5 teammates is the sweet spot** (Addy Osmani, O'Reilly AI CodeCon, March 2026). Token costs scale linearly; three focused teammates outperform five scattered ones.

4. **Quality gates are internal.** A dedicated reviewer teammate auto-triggering on every task completion is a framework-level configuration, not something Switchboard needs to instruct.

5. **The orchestrator must not implement directly.** The coordinator's context should stay clean — it decomposes and delegates; specialists do the work.

6. **Hierarchical subagents scale better.** Rather than the orchestrator spawning 6+ subagents (fragmenting its context), it spawns 2–3 feature leads, each of which spawns their own specialists. Switchboard's prompt should not constrain this internal structure.

### What Switchboard should NOT include in the team-lead prompt

- `AUTHORIZATION TO EXECUTE: do not enter PLANNING mode` — frameworks need to plan internally first
- Pair-programming directives (handled by the framework's internal routing)
- Specific iteration counts or retry logic (framework-managed)
- Internal quality gate instructions (framework-managed)
- Step-by-step delegation instructions (the coordinator decides this)

---

## Proposed Changes

### [MODIFY] `src/services/agentConfig.ts`

**1. Add `'team-lead'` to the `BuiltInAgentRole` union type (line 1):**

```typescript
// Before
export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'planner' | 'analyst';

// After
export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'planner' | 'analyst' | 'team-lead';
```

**2. Add label to `BUILT_IN_AGENT_LABELS` (line 25):**

```typescript
export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    planner: 'Planner',
    analyst: 'Analyst',
    'team-lead': 'Team Lead',   // ← add
};
```

**3. Add column definition to `DEFAULT_KANBAN_COLUMNS` (after line 36, before LEAD CODED at order 180):**

```typescript
{ id: 'TEAM LEAD CODED', label: 'Team Lead', role: 'team-lead', order: 170, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
```

Order 170 places it just before LEAD CODED (180), making the Kanban column sequence: Planned → **Team Lead** → Lead Coder → Coder → Intern → Reviewed → Completed. `hideWhenNoAgent: true` keeps it hidden until a terminal is registered, matching intern column behaviour.

**4. Add `'team-lead'` to the `VALID_ROLES` array in `parseDefaultPromptOverrides` (line 164):**

```typescript
const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'intern', 'analyst', 'team-lead'];
```

---

### [MODIFY] `src/services/agentPromptBuilder.ts`

**1. Add `if (role === 'team-lead')` branch in `buildKanbanBatchPrompt` (insert before the fallback `return` at line 260):**

```typescript
if (role === 'team-lead') {
    return applyPromptOverride(`You are a Team Lead orchestrator. Spin up a team of specialist agents and drive the following plan(s) to completion.

You own all internal coordination: decomposing work, assigning tasks, routing between specialists, running your own review cycles, and handling retries. Do NOT escalate to the user for task routing decisions or intermediate failures — those are yours to resolve internally. Only escalate if the plan genuinely requires external credentials, access, or human approval that is outside the codebase.

${focusDirective}${GIT_PROHIBITION_DIRECTIVE}

PLANS TO PROCESS:
${planList}`, planList, promptOverride);
}
```

**2. Add `'TEAM LEAD CODED'` to `columnToPromptRole` (line 274–286):**

```typescript
case 'TEAM LEAD CODED':
case 'LEAD CODED':
case 'CODER CODED':
case 'INTERN CODED':
    return 'reviewer';
```

---

### [MODIFY] `src/services/KanbanProvider.ts`

Four locations require updates:

**1. `_columnToRole` (line 3101):** Add team-lead mapping:

```typescript
case 'TEAM LEAD CODED': return 'team-lead';
```

Insert before the `case 'LEAD CODED'` line.

**2. `roleFromColumn` map (line 526):** Add team-lead to the dispatch identity tracking map inside the card-move recording function:

```typescript
const roleFromColumn: Record<string, string> = {
    'TEAM LEAD CODED': 'team-lead',   // ← add
    'LEAD CODED': 'lead',
    'CODER CODED': 'coder',
    'INTERN CODED': 'intern',
    'PLANNED': 'planner',
    'CODE REVIEWED': 'reviewer',
};
```

> **Clarification:** Without this, dragging a card to `TEAM LEAD CODED` does not record the dispatch identity, causing the session's run-sheet to miss the dispatch event.

**3. `_workflowForColumn` (line 1096):** Add team-lead-coded to the review workflow set:

```typescript
case 'TEAM LEAD CODED': return 'review';   // ← add
case 'LEAD CODED': return 'review';
case 'CODER CODED': return 'review';
```

> **Clarification:** Without this, advancing from `TEAM LEAD CODED` falls through to the `default: return 'handoff'` branch, triggering the wrong workflow.

**4. `roleToCol` map (line 1782):** Add team-lead to the MCP dispatch path's role→column mapping:

```typescript
const roleToCol: Record<string, string> = {
    'lead': 'LEAD CODED', 'coder': 'CODER CODED', 'intern': 'INTERN CODED',
    'team-lead': 'TEAM LEAD CODED',   // ← add
    'planner': 'PLANNED', 'reviewer': 'CODE REVIEWED',
};
```

> **Clarification:** Without this, MCP-path dispatches to team-lead fail to record the target column.

**Note:** `_targetColumnForDispatchRole` (line 1694) handles automatic complexity routing to intern/coder/lead columns and intentionally excludes team-lead. The team-lead column is a manual assignment path, not an auto-complexity route. Do not modify this function.

---

### [MODIFY] `src/services/TaskViewerProvider.ts`

Seven locations require updates:

**1. `_codedColumnForRole` (line 737):** Add team-lead case:

```typescript
case 'team-lead':
    return 'TEAM LEAD CODED';
```

**2. `_isCompletedCodingColumn` (line 758):** Add TEAM LEAD CODED to the column check so it flows to the reviewer column:

```typescript
return normalizedColumn === 'TEAM LEAD CODED' || normalizedColumn === 'LEAD CODED' || normalizedColumn === 'CODER CODED' || normalizedColumn === 'INTERN CODED';
```

**3. `_roleForKanbanColumn` (line 780):** Add mapping:

```typescript
case 'TEAM LEAD CODED':
    return 'team-lead';
```

**4. `_targetColumnForRole` (line 763):** Add team-lead to the set of coded roles (alongside lead/coder/intern/jules/team):

```typescript
case 'team-lead':
    return this._codedColumnForRole(role);
```

**5. `_getNextKanbanColumnForSession` (line 812):** Add `TEAM LEAD CODED` to the coded-column group so cards advance to `CODE REVIEWED` after team-lead completes:

> ⚠️ **CRITICAL — this was missing from the original plan.** Without this, a completed team-lead card falls through to the `default` branch which uses positional column indexing. Depending on column order, the card could advance to LEAD CODED instead of CODE REVIEWED, or return `null`.

```typescript
case 'LEAD CODED':
case 'CODER CODED':
case 'INTERN CODED':
case 'TEAM LEAD CODED':   // ← add
    return 'CODE REVIEWED';
```

**6. `_autobanColumnToRole` (line 2594):** Add `TEAM LEAD CODED` to the reviewer-generating set so autoban advances team-lead-completed cards to the reviewer:

> **Clarification:** The original plan called this "Column-to-prompt-role switch" — the actual method name is `_autobanColumnToRole`.

```typescript
case 'TEAM LEAD CODED':   // ← add
case 'INTERN CODED':
case 'LEAD CODED':
case 'CODER CODED':
case 'CODED':
    return 'reviewer';
```

**7. `columnRoleMap` display label (line 6583):** Add entry for sidebar review-log display:

```typescript
'TEAM LEAD CODED': 'Team Lead',
```

---

## The Prompt (canonical text)

```
You are a Team Lead orchestrator. Spin up a team of specialist agents and drive the following plan(s) to completion.

You own all internal coordination: decomposing work, assigning tasks, routing between specialists, running your own review cycles, and handling retries. Do NOT escalate to the user for task routing decisions or intermediate failures — those are yours to resolve internally. Only escalate if the plan genuinely requires external credentials, access, or human approval that is outside the codebase.

FOCUS DIRECTIVE: Each plan file path below is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.

[GIT_PROHIBITION_DIRECTIVE - standard no-git block]

PLANS TO PROCESS:
[plan list]
```

**Design rationale:**
- No `AUTHORIZATION TO EXECUTE` or anti-planning directives — orchestration frameworks legitimately need a planning phase before they execute
- No pair-programming, accuracy-mode, or challenge-block options — the framework handles all of this internally
- `focusDirective` and `GIT_PROHIBITION_DIRECTIVE` are retained — they are workspace conventions that apply regardless of execution model
- Escalation boundary is explicit: only for genuine external blockers, not for task complexity or internal routing decisions

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/agentConfig.ts` | Add type union member, label, column definition, VALID_ROLES entry (4 changes) |
| `src/services/agentPromptBuilder.ts` | Add `team-lead` prompt branch; add `TEAM LEAD CODED` to `columnToPromptRole` (2 changes) |
| `src/services/KanbanProvider.ts` | Add to `_columnToRole`, `roleFromColumn`, `_workflowForColumn`, `roleToCol` (4 changes) |
| `src/services/TaskViewerProvider.ts` | Add to `_codedColumnForRole`, `_isCompletedCodingColumn`, `_targetColumnForRole`, `_roleForKanbanColumn`, `_getNextKanbanColumnForSession`, `_autobanColumnToRole`, `columnRoleMap` (7 changes) |

**Total: 17 changes across 4 files.**

---

## Edge-Case & Dependency Audit

- **Race Conditions:** None introduced. All changes are additive switch cases and map entries. No shared mutable state affected.
- **Security:** No new authentication, credential storage, or network calls. The team-lead prompt includes `GIT_PROHIBITION_DIRECTIVE` consistent with all other roles.
- **Backward Compatibility:** `hideWhenNoAgent: true` ensures the TEAM LEAD CODED column is invisible until a terminal registers as team-lead. Existing users see zero UI changes. The `BuiltInAgentRole` type expansion is backward-compatible (union grows, no existing member removed).
- **Side Effects — Autoban gap:** If a user has ONLY a team-lead terminal (no lead/coder/intern), autoban on PLAN REVIEWED still routes to `'lead'`, which has no terminal → dispatch fails silently. This is acceptable for v1 (manual-only assignment) but should be documented in user-facing notes.
- **Side Effects — `_codedColumnForDispatchRoles`:** This function (TVP line 752) is used for pair-programming multi-agent dispatch recording. It does NOT need team-lead because team-lead is a single-dispatch role, not part of the pair-programming split. Intentionally excluded.
- **Dependencies:** Depends on `customize_default_prompts` plan (for `applyPromptOverride` and `promptOverride` in agentPromptBuilder.ts). **Already implemented** — verified in codebase.

## Verification Plan

- [ ] `TEAM LEAD CODED` column appears in the Kanban UI only when a `team-lead` terminal is registered
- [ ] Dragging a card to `TEAM LEAD CODED` dispatches the plan to the team-lead terminal via CLI trigger
- [ ] The dispatched prompt contains "Team Lead orchestrator" and `PLANS TO PROCESS:` — and does NOT contain `AUTHORIZATION TO EXECUTE`
- [ ] After the team-lead terminal completes, advancing the card moves it to `CODE REVIEWED` (same as other coded columns)
- [ ] "Copy Prompt" on a team-lead card produces the team-lead prompt body
- [ ] Default prompt overrides for `team-lead` persist and load correctly via the custom prompts modal
- [ ] No regressions on existing intern, coder, lead, or reviewer dispatch paths

---

## Open Questions

- Should `team-lead` be included in the complexity-routing path (`_partitionByComplexityRoute` / `_targetColumnForDispatchRole`) as a high-complexity option (e.g. complexity ≥ 9)? Current plan: **no** — keep it as a manual assignment only. Revisit when usage patterns are clearer.
- Should `_codedColumnForDispatchRoles` (used for multi-agent pair-programming dispatch recording) include `team-lead`? Current plan: **no** — team-lead is a single-column, single-dispatch assignment, not part of the pair-programming split.

---

## Adversarial Synthesis

### 🔥 Grumpy Principal Engineer Critique

> Well, well. A plan that says "Four locations require updates" and then lists SIX. I suppose counting is an optional skill these days.
>
> **1. `_getNextKanbanColumnForSession` — the missing function that breaks everything.** This function (line 812) is the canonical auto-advance handler. It has `LEAD CODED | CODER CODED | INTERN CODED → CODE REVIEWED`. Without `TEAM LEAD CODED` here, when a team-lead session completes and the card tries to advance, it hits the `default` branch — which does *positional column indexing*. With order 170, the next column is LEAD CODED (order 180). So instead of going to the reviewer, the card quietly slides into Lead Coder. The user drags a card to team-lead, the orchestration framework does its thing, the card "completes"… and gets re-dispatched to Lead Coder. Wonderful experience.
>
> **2. Three missing KanbanProvider locations.** The plan touched ONE switch in KP (`_columnToRole`). But there are THREE more: `roleFromColumn` (line 526 — dispatch identity tracking), `_workflowForColumn` (line 1096 — determines review vs handoff workflow), and `roleToCol` (line 1782 — MCP dispatch path). Without `roleFromColumn`, dragging a card to TEAM LEAD CODED doesn't record the dispatch event. Without `_workflowForColumn`, advancing from that column triggers `handoff` instead of `review`. Without `roleToCol`, MCP-path dispatches to team-lead silently drop the target column.
>
> **3. "Column-to-prompt-role switch (line 2595)" — a function name that doesn't exist.** The actual method is `_autobanColumnToRole` at line 2594. If I were a coder, I'd grep for "Column-to-prompt-role", find nothing, and add the case to the *wrong* switch statement.
>
> **4. Metadata tag `feature` — invented from thin air.** The allowed tags are: frontend, backend, authentication, database, UI, devops, infrastructure, bugfix. `feature` is not on the list. Were we in such a rush we couldn't check the enumeration in the instructions?
>
> **5. Complexity 4 for 17 changes across 4 files?** That's not "routine single-file changes." That's multi-file changes with moderate logic — a 5 by the scoring guide. The plan underrates itself, which means the assigned coder underestimates the scope, which means they rush, which means they miss the four locations I just found.

### ⚖️ Balanced Response

All five issues have been addressed:

1. **`_getNextKanbanColumnForSession` added** as TVP change #5 (line 812), with a ⚠️ CRITICAL callout explaining the positional-indexing fallthrough bug. `case 'TEAM LEAD CODED':` now routes to `'CODE REVIEWED'`.
2. **All 4 KanbanProvider locations enumerated**: `_columnToRole` (line 3101), `roleFromColumn` (line 526), `_workflowForColumn` (line 1096), `roleToCol` (line 1782). Each includes a "Clarification" note explaining what breaks without it.
3. **Method name corrected**: "Column-to-prompt-role switch" → `_autobanColumnToRole` (line 2594), with explicit clarification note in the plan.
4. **Invalid `feature` tag removed** from Metadata. Tags now: `backend, UI`.
5. **Complexity updated from 4 to 5** (Medium — multi-file changes, moderate logic, 17 total changes across 4 files).

The plan's overall architecture is sound: the research is thorough, the prompt design is well-reasoned (thin handoff, no micromanagement, explicit escalation boundary), and the intentional exclusion of team-lead from complexity routing and pair-programming dispatch is the right v1 decision. The changes are numerous but repetitive — each is a one-line switch case or map entry following an established pattern.

---

## Recommended Agent

**Send to Coder** (Complexity 5 — 17 changes but all follow established patterns; no new state management or architectural decisions)

---

## Implementation Review (2026-04-10)

**Reviewer:** Copilot (Claude Opus 4.6)
**Mode:** Light (findings in chat, fixes applied directly)

### Stage 1 — Grumpy Principal Engineer

| # | Severity | Finding |
|---|----------|---------|
| 1 | MAJOR | `planStateUtils.ts` VALID_COLUMNS missing `TEAM LEAD CODED` — `extractKanbanState()` returns null for plans in this column, breaking plan file state persistence on reimport. The plan's Files to Modify omitted this file. |
| 2 | NIT | `KanbanDatabase.ts` VALID_KANBAN_COLUMNS also missing `TEAM LEAD CODED` (and `INTERN CODED`), but `SAFE_COLUMN_NAME_RE` regex fallback handles it — no functional impact |
| 3 | NIT | `_workflowForColumn` (KP line 1093) missing `INTERN CODED` — pre-existing, not introduced by this plan |
| 4 | NIT | `columnRoleMap` (TVP line 6590) missing `INTERN CODED` — pre-existing |
| 5 | NIT | Prompt template directive variables adjacent with no explicit newline separator — output correct (both vars include leading `\n`) |

### Stage 2 — Balanced Synthesis

**Implemented Well:**
- All 17 plan-specified changes present and correct across all 4 files
- Prompt text matches canonical text — no `executionDirective`, no `batchExecutionRules`, no challenge/pair/accuracy options
- `applyPromptOverride` correctly applied for custom prompt override compatibility
- Column order 170 with `hideWhenNoAgent: true` — invisible until team-lead terminal registers
- `_codedColumnForDispatchRoles` intentionally excludes team-lead (single-dispatch, not pair-programming)
- `_autobanColumnToRole` correctly maps `TEAM LEAD CODED` → `'reviewer'`
- `_getNextKanbanColumnForSession` includes `TEAM LEAD CODED` → `'CODE REVIEWED'` (critical positional-indexing bug prevention)

**Fixes Applied:**
- `src/services/planStateUtils.ts` line 9-12: Added `'TEAM LEAD CODED'` to `VALID_COLUMNS` Set

### Validation Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ Pass (pre-existing ArchiveManager error only) |
| `npm run compile` | ✅ webpack compiled successfully |
| `agentConfig.ts` — type + label + column + VALID_ROLES | ✅ Lines 1, 32, 38, 166 |
| `agentPromptBuilder.ts` — prompt branch + columnToPromptRole | ✅ Lines 260-269, 290-294 |
| `KanbanProvider.ts` — all 4 locations | ✅ Lines 526, 1097, 1785, 3107 |
| `TaskViewerProvider.ts` — all 7 locations | ✅ Lines 742, 762, 774, 793, 832, 2604, 6594 |
| `planStateUtils.ts` — VALID_COLUMNS | ✅ Fixed: TEAM LEAD CODED added |

### Remaining Risks
- Autoban gap: user with ONLY team-lead terminal (no lead/coder/intern) sees autoban fail silently on PLAN REVIEWED cards — documented in plan, acceptable for v1
- `KanbanDatabase.ts` VALID_KANBAN_COLUMNS doesn't explicitly list TEAM LEAD CODED — regex handles it, cosmetic inconsistency

### Verdict: ✅ READY
