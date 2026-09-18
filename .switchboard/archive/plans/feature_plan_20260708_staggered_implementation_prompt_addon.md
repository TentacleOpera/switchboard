# Staggered Implementation Prompt Add-on — Feature-File Context Relay

## Metadata

**Complexity:** 4
**Tags:** feature, ui, backend

## Goal

Add a new "Staggered Implementation" prompt add-on (coder / lead / intern roles) that instructs the agent to append a brief implementation note to the feature overview file after completing each subtask. The accumulated notes act as a **context relay** — when a large feature exceeds a single agent's context window (or a fresh dispatch picks up mid-feature), the next subtask's agent reads the feature file and sees what prior subtasks did, what files changed, and what issues arose, without needing to re-read all the code.

### Problem / background / root cause

In feature-mode coder dispatch today, the agent is told to "execute each subtask plan in full before moving to the next" — all in one session (`agentPromptBuilder.ts:1177`). For large features (10+ subtasks), the agent exhausts its context window partway through. Whatever it learned doing earlier subtasks — files touched, conventions established, interfaces introduced, gotchas hit — is lost. A fresh dispatch starts blind, with only the original planning content in the feature file and no record of what actually happened during implementation.

The existing `CODING_COMPLETION_REPORT_DIRECTIVE` (`agentPromptBuilder.ts:569`) writes a 3-5 sentence summary to the **plan file** (per-subtask, signals the kanban watcher). But that note is scattered across individual plan files — the next subtask's agent would have to read every prior plan file to reconstruct context. There is no **feature-level** accumulation of implementation progress.

The feature overview file is the natural relay point: every feature-mode dispatch already reads it (the `FEATURE FILE:` block at `agentPromptBuilder.ts:1174-1176` points the agent at it). Adding an append-only `## Implementation Notes` section at the end of the file — outside the auto-generated Subtasks/Worktrees blocks — gives the next agent instant context with zero extra read steps.

### Why this is safe

The feature file update logic (`KanbanProvider.ts:10244-10250`) uses a **marker-based splice**: it only replaces content between `<!-- BEGIN SUBTASKS -->` / `<!-- END SUBTASKS -->` (and `<!-- BEGIN WORKTREES -->` / `<!-- END WORKTREES -->` at `KanbanProvider.ts:10284-10288`). Everything outside those markers is preserved. A `## Implementation Notes` section at the end of the file is outside both blocks and survives all system-driven feature-file rewrites (subtask status changes, worktree additions, complexity marker updates). No changes to the rewrite logic are needed.

### Concurrency scope

Sequential subtask dispatch (one subtask at a time, merged before the next starts) is the **primary** mode: notes written after each subtask flow through to the next agent cleanly.

**Parallel/worktree-per-subtask mode is handled, not ignored.** When `useWorktreesPerPlan` is also enabled, `FEATURE_ORCHESTRATION_DIRECTIVE` (`agentPromptBuilder.ts:577-585`) invites the agent to run subtasks in parallel via native subagents in separate worktrees. Per-subtask appends to the same `## Implementation Notes` tail from parallel branches would conflict on merge-back. The directive therefore carries an explicit **parallel-mode clause**: when running subtasks in parallel, parallel subtasks do NOT append individually — instead, after all subtasks complete and their worktrees merge back, a single consolidated note is appended for the batch. This keeps the add-on safe to co-enable with `useWorktreesPerPlan` without a hard gate (the worktree mode is the one that most needs context relay for large features).

## User Review Required

- **Parallel-mode handling choice:** the plan defaults to a *consolidated-append-after-merge* clause (keeps the add-on usable alongside `useWorktreesPerPlan`). If the user prefers a hard auto-suppress when `useWorktreesPerPlan` is on, the injection gate changes from `options?.featureMode && staggeredImplementationEnabled` to also require `!useWorktreesPerPlanEnabled`. Confirm the softer clause is acceptable before coding.
- **Default off:** the add-on ships opt-in (`default: false`). Confirm this matches intent (only large features that need context relay enable it).

## Complexity Audit

### Routine
- Mirrors an existing checkbox add-on (`suppressWalkthrough`) across four files — mechanical pattern-copy, no new architectural pattern.
- UI checkbox is auto-rendered by the existing generic `renderRoleAddons` (`kanban.html:3435`); no webview JS changes. `saveRoleConfig` persists state to `roleConfigs[role].addons.staggeredImplementation` automatically.
- Config wiring in `KanbanProvider.ts` mirrors the existing `suppressWalkthroughByRole` / `suppressWalkthroughEnabled` blocks line-for-line.
- Directive injection in the three feature-mode prompt paths (coder/lead/intern) mirrors the adjacent `suppressWalkthroughBlock` construction and placement.
- Feature-file splice preservation is already guaranteed by the existing marker-based rewrite — no splice logic changes.

### Complex / Risky
- **Interaction with `useWorktreesPerPlan` (parallel subagent) mode:** concurrent per-subtask appends to `## Implementation Notes` would conflict on merge-back. Mitigated by a directive clause (consolidated append in parallel mode), **not** by mechanical code enforcement — relies on agent compliance, same risk profile as the existing `CODING_COMPLETION_REPORT_DIRECTIVE`.
- **Lead/intern prompt paths lack an explicit `FEATURE FILE:` path block** (only the coder feature-mode path emits it at `agentPromptBuilder.ts:1174`). The directive must be **self-locating** via the `[FEATURE: ...] Plan File:` entry in PLANS TO PROCESS (`agentPromptBuilder.ts:357`, verified present for all roles) so lead/intern agents can find the file without extra plumbing.

## Edge-Case & Dependency Audit

### Race Conditions
- **Parallel worktree appends:** the top race. Multiple subagents appending to the same file tail from separate worktree branches conflict on merge-back. Mitigation: directive's parallel-mode clause mandates a single consolidated append after all merges. Not mechanically enforced (agent discipline) — same soft-enforcement class as `CODING_COMPLETION_REPORT_DIRECTIVE`.
- **Feature-file rewrite vs. agent append:** the system's marker splice (`KanbanProvider.ts:10244-10288`) only touches the SUBTASKS/WORKTREES regions; an agent appending at the very end does not race with a system splice in those regions. A subtask-column move triggering a rewrite while the agent is mid-append is a normal file-edit interleaving on disjoint regions — the marker boundaries keep them from clobbering each other; the agent appends outside both markers.

### Security
- None. The add-on only adds prompt text and a UI checkbox. No new code paths, no privilege changes, no secret handling.

### Side Effects
- **Extra feature-file reparse per note append:** each append triggers the plan watcher to re-parse the feature file. For a 20-subtask feature that is ~20 reparses — negligible (the parser ignores content outside markers/metadata).
- **Dual completion notes:** the agent now writes a 3-5 sentence summary to the **plan file** (`CODING_COMPLETION_REPORT_DIRECTIVE`) AND a 3-5 sentence summary to the **feature file** (this add-on). Different audiences (kanban watcher vs. next-subtask context). The directive explicitly tells the agent the two coexist and neither may be skipped, to prevent effort-optimization dropping one.

### Dependencies & Conflicts
- **`useWorktreesPerPlan` co-enable:** both checkboxes can be on simultaneously. Handled via the directive's parallel clause (see Race Conditions) — not a hard conflict, but the interaction must be verified.
- **`writeFeatureDescriptionIfEmpty`:** that add-on writes planning sections *before* the SUBTASKS block; this add-on writes implementation notes *after* the WORKTREES block. No overlap.
- **Feature file rewrite preservation:** the marker-based splice preserves all content outside `<!-- BEGIN/END SUBTASKS -->` and `<!-- BEGIN/END WORKTREES -->`. The `## Implementation Notes` section at the end of the file is safe.
- **Feature file doesn't exist:** the plan's original "can't happen" assertion is too strong (remote sessions, worktree CWDs with a different root, a race between feature creation and a fast dispatch, a user deleting the file mid-run). The directive includes a defensive *"if the feature file is not present, skip this step"* clause.

## Dependencies

- None. This plan is self-contained; it does not depend on any other plan or session.

## Adversarial Synthesis

Key risks: (1) concurrent per-subtask appends to `## Implementation Notes` conflicting on merge-back when `useWorktreesPerPlan` is co-enabled; (2) lead/intern agents never receiving an explicit feature-file path and skipping or mis-targeting the note; (3) the missing `agentConfig.ts:202` persistence line silently dropping the setting on reload. Mitigations: a parallel-mode clause in the directive (consolidated append after merge), a self-locating directive that references the `[FEATURE:]` planList entry, and one added persistence line mirroring `suppressWalkthrough`. All risks are handled in prose + one-line config, not new machinery.

## Implementation

### Step 1 — Add-on UI metadata (`src/webview/sharedDefaults.js`)

Add `staggeredImplementation` to the `ROLE_ADDONS` entries for **coder**, **lead**, and **intern**. Follow the exact pattern of existing checkbox add-ons (e.g. `suppressWalkthrough`). `ROLE_ADDONS` is defined at line 97; the role arrays are `lead` (110-128, `suppressWalkthrough` at 122), `coder` (129-146, `suppressWalkthrough` at 140), and `intern` (168-185, `suppressWalkthrough` at 179).

```javascript
{ id: 'staggeredImplementation', label: 'Staggered Implementation', tooltip: 'After completing each subtask, append a brief summary to the feature file\'s ## Implementation Notes section so the next subtask has context from prior work', default: false }
```

Place it after `suppressWalkthrough` in each of the three role arrays. Default: **off** (opt-in for large features that need context relay).

The existing `renderRoleAddons` function in `kanban.html` (line 3435) handles checkbox add-ons generically — no JS changes needed in the webview. The `saveRoleConfig` mechanism (line 3695) persists the state to `roleConfigs[role].addons.staggeredImplementation` automatically.

### Step 2 — Add-on type and persistence (`src/services/agentConfig.ts`)

**2a.** Add `staggeredImplementation?: boolean;` to the `CustomAgentAddons` interface (after `suppressWalkthrough?: boolean;` at line 26).

**2b.** Add the persistence line in the custom-agent load block (after `if (s.suppressWalkthrough === true) a.suppressWalkthrough = true;` at line 202):

```typescript
if (s.staggeredImplementation === true) a.staggeredImplementation = true;
```

Without this, a custom agent definition that enables the add-on silently loses the setting on reload. This mirrors the plan's stated "follow the exact pattern of `suppressWalkthrough`" principle — `suppressWalkthrough` has this line at 202, so `staggeredImplementation` must too.

### Step 3 — Config wiring (`src/services/KanbanProvider.ts`)

**3a.** In `_getPromptsConfig` (the `suppressWalkthroughByRole` block at lines 4731-4735), add immediately after it:

```typescript
staggeredImplementationByRole: {
    lead: leadConfig?.addons?.staggeredImplementation ?? false,
    coder: coderConfig?.addons?.staggeredImplementation ?? false,
    intern: internConfig?.addons?.staggeredImplementation ?? false,
},
```

**3b.** In the `resolvedOptions` object (lines 4341-4369), add after `suppressWalkthroughEnabled` (line 4346):

```typescript
staggeredImplementationEnabled: promptsConfig.staggeredImplementationByRole?.[role] ?? false,
```

### Step 4 — Directive constant and injection (`src/services/agentPromptBuilder.ts`)

**4a.** Add to the `PromptBuilderOptions` interface (after `suppressWalkthroughEnabled?: boolean;` at line 221):

```typescript
/** When true, instructs the agent to append implementation notes to the feature file after each subtask (feature mode only). */
staggeredImplementationEnabled?: boolean;
```

**4b.** Define the directive constant (near `SUPPRESS_WALKTHROUGH_DIRECTIVE` at line 568). The directive is **self-locating** (references the `[FEATURE:]` planList entry so lead/intern — which do not receive a `FEATURE FILE:` block — can find the file), **parallel-safe** (consolidated append after merge when subtasks run in parallel via worktrees/subagents), **defensive** (skip if the file is absent), and **dual-report-aware** (distinct from the per-plan completion report).

```typescript
export const STAGGERED_IMPLEMENTATION_DIRECTIVE = `STAGGERED IMPLEMENTATION: After completing each subtask, append a brief summary (3-5 sentences) to a ## Implementation Notes section at the END of the feature overview file — the feature file is the entry tagged [FEATURE: ...] Plan File: in PLANS TO PROCESS above. Place the ## Implementation Notes section AFTER the auto-generated Subtasks and Worktrees blocks; if it does not exist, create it. For each subtask note include: what you implemented, files changed, and any issues or decisions the next subtask's agent needs to know. These notes are a context relay — they let the next subtask pick up where you left off without re-reading your code changes. If you are handling subtasks in parallel via subagents/worktrees, do NOT have parallel subtasks append individually — instead, after all subtasks complete and their worktrees merge back, append a single consolidated note for the batch. If the feature file is not present, skip this step. This is in addition to the per-plan completion report (which still goes to each subtask's own plan file); do not skip either. Do NOT skip this step.`;
```

> **Refinement note (preserved from original):** the original directive text was *`STAGGERED IMPLEMENTATION: After completing each subtask, append a brief summary (3-5 sentences) to a ## Implementation Notes section at the END of the feature overview file (after the auto-generated Subtasks and Worktrees blocks). Include: what you implemented, files changed, and any issues or decisions the next subtask's agent needs to know. If the ## Implementation Notes section does not exist, create it. These notes are a context relay — they let the next subtask pick up where you left off without re-reading your code changes. Do NOT skip this step.`* The refined version above adds four clauses: self-locating (`[FEATURE:]` planList reference), parallel-mode consolidated-append, missing-file skip, and dual-report distinction. The original intent and core instruction are preserved.

**4c.** Read the option near the other option reads (after `suppressWalkthroughEnabled` at line 774):

```typescript
const staggeredImplementationEnabled = options?.staggeredImplementationEnabled ?? false;
```

**4d.** Inject the directive in three places, gated by `featureMode`. In each path, build the block and add it to `promptParts` **immediately before `suppressWalkthroughBlock`** (consistent placement — `suppressWalkthroughBlock` is the last element in all three arrays):

```typescript
const staggeredImplementationBlock = (options?.featureMode && staggeredImplementationEnabled) ? STAGGERED_IMPLEMENTATION_DIRECTIVE : '';
```

1. **Coder feature-mode path** (promptParts at lines 1200-1208): add `staggeredImplementationBlock` to the array immediately before `suppressWalkthroughBlock` (line 1207). The coder path also has `featureFileBlock` (line 1205), so the agent gets both the explicit path and the self-locating reference.
2. **Lead path** (promptParts at lines 1150-1160): add `staggeredImplementationBlock` immediately before `suppressWalkthroughBlock` (line 1159). Note: the lead path has **no** `featureFileBlock` — it uses `featureDirectiveBlock` (line 1156), which does not carry the feature file path. The self-locating `[FEATURE:]` reference in the directive is what makes this work for lead.
3. **Intern path** (promptParts at lines 1283-1292): add `staggeredImplementationBlock` immediately before `suppressWalkthroughBlock` (line 1291). Same note as lead — no `featureFileBlock`; relies on the self-locating directive.

The coder **non-feature** path (promptParts at lines 1242 onward) does NOT get the directive — there is no feature file in non-feature mode, and the `options?.featureMode` gate already prevents it.

## Proposed Changes

### `src/webview/sharedDefaults.js`
- **Context:** `ROLE_ADDONS` (line 97) holds per-role checkbox UI metadata; `renderRoleAddons` in `kanban.html` renders any entry generically.
- **Logic:** append a `staggeredImplementation` checkbox object after `suppressWalkthrough` in the `lead` (after line 122), `coder` (after line 140), and `intern` (after line 179) arrays.
- **Implementation:** one-line object per role (see Step 1 code block). `default: false`.
- **Edge Cases:** the checkbox must NOT be added to `planner`, `reviewer`, `tester`, or `analyst` — those roles do not execute feature subtasks.

### `src/services/agentConfig.ts`
- **Context:** `CustomAgentAddons` interface (line 26 area) declares addon fields; the load block at line 202 persists each boolean addon from a saved custom-agent definition.
- **Logic:** add the interface field (2a) and the persistence line (2b).
- **Implementation:** see Step 2a/2b.
- **Edge Cases:** omitting 2b silently drops the setting on reload for custom agent definitions — the exact bug this step prevents.

### `src/services/KanbanProvider.ts`
- **Context:** `_getPromptsConfig` (line 4505) aggregates per-role addon flags; `resolvedOptions` (line 4341) feeds them to the prompt builder.
- **Logic:** add `staggeredImplementationByRole` to the config (3a) and `staggeredImplementationEnabled` to `resolvedOptions` (3b).
- **Implementation:** see Step 3a/3b. Mirror `suppressWalkthroughByRole` / `suppressWalkthroughEnabled` exactly.
- **Edge Cases:** roles outside lead/coder/intern map to `false` via `?? false`; the directive's `featureMode` gate is the second layer of defense for non-feature dispatches.

### `src/services/agentPromptBuilder.ts`
- **Context:** `PromptBuilderOptions` (line 221) carries addon flags; directive constants live near line 568; the three feature-mode prompt paths assemble `promptParts` arrays at lines 1150-1160 (lead), 1200-1208 (coder feature-mode), and 1283-1292 (intern).
- **Logic:** add the option field (4a), the directive constant (4b), the option read (4c), and the block injection in all three feature-mode paths (4d).
- **Implementation:** see Step 4. Use the refined directive text (4b) — not the original — because it carries the self-locating, parallel-safe, defensive, and dual-report clauses required by the edge-case audit.
- **Edge Cases:**
  - Lead/intern have no `featureFileBlock` — the directive's `[FEATURE:]` self-reference is load-bearing for these two paths.
  - Parallel/worktree mode — the directive's consolidated-append clause is load-bearing for merge-safety.
  - Non-feature coder path — excluded by the `options?.featureMode` gate.

## Files modified

| File | Change |
|------|--------|
| `src/webview/sharedDefaults.js` | Add `staggeredImplementation` checkbox to `ROLE_ADDONS` for coder, lead, intern (after `suppressWalkthrough` in each) |
| `src/services/agentConfig.ts` | Add `staggeredImplementation?: boolean` to `CustomAgentAddons` (line 26) + persistence line `if (s.staggeredImplementation === true) a.staggeredImplementation = true;` (line 202) |
| `src/services/KanbanProvider.ts` | Add `staggeredImplementationByRole` to `_getPromptsConfig` (after 4735) + `staggeredImplementationEnabled` to `resolvedOptions` (after 4346) |
| `src/services/agentPromptBuilder.ts` | Add option field (221), directive constant (568) — self-locating + parallel-safe + defensive + dual-report-aware, option read (774), and injection before `suppressWalkthroughBlock` in the 3 feature-mode prompt paths (1159 / 1207 / 1291) |

## Verification Plan

### Automated Tests
- None required for this change (per session directive, automated tests are skipped). The change is UI-checkbox + prompt-string wiring with no new logic branches worthy of a unit test beyond what manual prompt inspection covers.

### Manual Verification
1. **UI (all three roles):** Open the PROMPTS tab, select **Coder**, confirm the "Staggered Implementation" checkbox appears with the correct tooltip, after `Suppress Walkthrough Artifact`. Toggle it on, switch to **Lead** and **Intern**, confirm it appears in both. Refresh the window — confirm the toggled state persists (this exercises Step 2b's persistence line for the role-config path).
2. **Prompt output — Coder (feature mode):** With the add-on enabled, generate a coder prompt for a feature-mode dispatch (select a feature on the kanban board, copy the coder prompt). Confirm the `STAGGERED IMPLEMENTATION:` directive appears, including the `[FEATURE: ...] Plan File:` self-reference, the parallel-mode clause, the missing-file clause, and the dual-report clause. Disable the add-on — confirm the directive disappears.
3. **Prompt output — Lead and Intern (feature mode):** Generate a lead prompt and an intern prompt for the same feature-mode dispatch. Confirm the `STAGGERED IMPLEMENTATION:` directive appears in **both** (the original plan only verified coder — lead/intern are now verified because they rely on the self-locating reference, not a `FEATURE FILE:` block).
4. **Non-feature mode:** Generate a coder prompt for a non-feature dispatch (select a standalone plan). Confirm the directive does NOT appear even when the add-on is enabled (the `options?.featureMode` gate).
5. **Feature file preservation:** Manually add a `## Implementation Notes` section to a feature file (after the WORKTREES block), then trigger a feature-file rewrite (e.g. move a subtask's kanban column). Confirm the notes section survives the marker-based splice.
6. **Worktree-mode interaction (inspection only):** Enable both `Staggered Implementation` and `Worktrees Per Plan` on the coder role. Generate a feature-mode coder prompt. Confirm the directive's parallel-mode clause ("do NOT have parallel subtasks append individually … append a single consolidated note for the batch") is present, so a co-enabled worktree dispatch is safe-by-instruction.
7. **Compile:** `npm run compile` — no type errors. *(Skipped per session directive; listed here for the coder to run at implementation time.)*

## Recommendation

**Send to Coder.** Complexity 4 (Low, upper edge): multi-file but each change is mechanical pattern-mirroring of `suppressWalkthrough`; the one moderate risk (parallel-worktree append conflict) is handled in directive prose, not new state machinery. The coder should use the **refined** directive text in Step 4b (self-locating + parallel-safe + defensive + dual-report-aware), not the original.

## Review Findings

Reviewed 2026-07-09. All four files (`sharedDefaults.js`, `agentConfig.ts`, `KanbanProvider.ts`, `agentPromptBuilder.ts`) verified against plan — every requirement met, full wiring chain intact from UI toggle through to prompt output. Zero CRITICAL/MAJOR findings; three NITs deferred (directive's `PLANS TO PROCESS` reference is inaccurate for coder-feature path but harmless since `FEATURE FILE:` block provides the path; `group: 'features'` property diverges from the `suppressWalkthrough` pattern; const repeated across three paths mirrors existing convention). Advanced regression analysis confirmed no double-triggers, no race conditions with marker-based splice, no orphaned references, and no caller breakage. No code fixes applied.
