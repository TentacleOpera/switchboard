# Plan: Fix Suggest Features Button — Copied Prompt Confuses Agents

## Goal

Rewrite `_buildSuggestFeaturesPrompt` in `KanbanProvider.ts` so the "Suggest Features" button copies a compact **pointer prompt** (candidate plan list + skill file path + explicit task directive, with a skip-scan directive since the candidate list is already pre-filtered) instead of dumping the raw `group-into-features/SKILL.md` body verbatim. The pasted text must read as a task to *execute*, not a skill *definition* for reference.

### Problem

When the user clicks "Suggest Features" on the kanban board, the copied text is a raw skill definition dump. Agents receiving the paste don't understand they're being asked to execute a procedure — they think the user is just sharing a skill definition for reference. The result: the agent does nothing useful, or asks "what do you want me to do with this?"

### Root Cause

`_buildSuggestFeaturesPrompt` in `KanbanProvider.ts` (line 11776) does the minimum:
1. Reads `group-into-features/SKILL.md`
2. Strips YAML frontmatter
3. Substitutes `{{WORKSPACE_ROOT}}` and `{{ACTIVE_PROJECT_FILTER}}`
4. Copies the raw body to clipboard

**No wrapper prompt is added.** The agent receives the SKILL.md body verbatim — starting with `# Skill: Group Into Features` and `## When to Use` (metadata about triggers and buttons). This reads as a skill *definition* for reference, not a task to execute.

### Contrast with `copyRefinePrompt` (the working pattern)

`PlanningPanelProvider.ts` line 6804 wraps skill content in a clear task directive:
```
You are refining a ticket...

## Skill Instructions
[skill content]

## Ticket to Refine
[concrete data: title, description, ID, file path]

Read... Produce... Write... Report back.
```

The suggest-features button has no such wrapper, no concrete data, and no closing directive.

## Fix

**Don't inline the skill body at all.** Instead, give the agent:
1. A list of candidate plans (titles, planIds, columns)
2. The path to the skill file
3. A clear instruction to read and execute that skill against these plans
4. An explicit placeholder-substitution directive (see Corrections below)

This eliminates all frontmatter stripping, section removal, and placeholder substitution *from the build method* — the agent reads the skill file itself and follows it, applying the placeholder map supplied in the wrapper.

### Corrections applied during improve pass

The original plan's proposed code and rationale had three defects, corrected here with audit callouts. The pointer-prompt *approach* is upheld; only the implementation details and one false claim are superseded.

> **Superseded:** Proposed code used `c.title` to render candidate card titles: `` `- **${c.title}** (planId: ${c.planId}, column: ${c.column})` ``
> **Reason:** `KanbanCard` (KanbanProvider.ts lines 110-125) has no `title` field — it has `topic`. The proposed code would emit `**undefined** (planId: abc-123, column: CREATED)`, producing a candidate list of nameless entries.
> **Replaced with:** Use `c.topic` (falling back to `c.planFile` then `'Untitled'` to match the board's own rendering convention, e.g. line 1694 `topic: row.topic || row.planFile || 'Untitled'`):
> `` `- **${c.topic || c.planFile || 'Untitled'}** (planId: ${c.planId}, column: ${c.column})` ``

> **Superseded:** "the skill file's placeholders are already resolved when the agent reads it. Either way, the `_buildSuggestFeaturesPrompt` method no longer needs to transform the skill body."
> **Reason:** False. The skill file on disk (`.agents/skills/group-into-features/SKILL.md`) contains literal `{{WORKSPACE_ROOT}}` (lines 18, 98) and `{{ACTIVE_PROJECT_FILTER}}` (line 38). These are resolved *only* by the substitution code at KanbanProvider.ts lines 11813-11815 — the code this plan deletes. An agent reading the raw skill file sees `cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md` literally and may stall, ask, or hallucinate a path.
> **Replaced with:** The build method still does not transform the skill body, BUT the wrapper prompt now carries an explicit **Placeholder Map** section telling the agent to substitute `{{WORKSPACE_ROOT}}` → `<workspace root>` and `{{ACTIVE_PROJECT_FILTER}}` → `<active project or '(unassigned)'>` when following the skill. This preserves the simplification (no regex/substitution in build code) without orphaning the placeholders.

> **Superseded:** "If the skill file is missing, agent should report it can't find the file (graceful failure)."
> **Reason:** This is a regression, not graceful failure. The current code degrades to a 20-line embedded procedure (lines 11786-11806) when the skill file is missing; `copyRefinePrompt` — the exemplar this plan cites — likewise keeps an embedded fallback (PlanningPanelProvider.ts lines 6790-6794). Calling the weaker behavior "graceful" misrepresents the trade-off.
> **Replaced with:** A missing skill file is treated as a **broken install** (the skill ships with the extension). The wrapper points the agent at the canonical `.agents/` path; if the file is absent the agent reports it cannot read the file and stops. This is an *accepted* regression versus the embedded fallback, documented honestly — not "graceful." Rationale: the pointer approach's value (single source of truth, no procedure duplication) outweighs preserving a fallback for a corrupted-install edge case. If parity with `copyRefinePrompt` is later desired, re-add a minimal embedded fallback — out of scope for this plan.

## Metadata

**Tags:** bugfix, refactor, ux
**Complexity:** 3

## User Review Required

Yes. Review the three superseded callouts above — especially the accepted regression on the embedded fallback (the plan deliberately drops the missing-skill-file fallback that `copyRefinePrompt` keeps). Confirm you accept that trade-off before dispatch. Also confirm the placeholder-map directive in the wrapper reads naturally to you.

## Complexity Audit

### Routine
- Single-file change: `src/services/KanbanProvider.ts`.
- Rewrites one method (`_buildSuggestFeaturesPrompt`, ~40 lines) and one call site (line 10104).
- Reuses the existing `candidateCards` array already computed in the `suggestFeatures` case (lines 10094-10099).
- No new dependencies, no new types, no DB schema changes.
- Pattern (wrapper + skill-path pointer) is already established by `copyRefinePrompt`.

### Complex / Risky
- Placeholder-substitution hand-off: the build method no longer substitutes, so the wrapper must instruct the agent to apply the placeholder map. If the directive is unclear, agents may read literal `{{WORKSPACE_ROOT}}` and stall. (Mitigated by the explicit Placeholder Map section in the wrapper.)
- Accepted regression: dropping the embedded fallback for a missing skill file. Low-probability (skill ships with extension) but a real behavior change vs. today.

## Edge-Case & Dependency Audit

**Race Conditions**
- None. `_buildSuggestFeaturesPrompt` is a pure string builder; `candidateCards` is a snapshot from `_lastCards` already filtered in the case block. No concurrent mutation of the prompt.

**Security**
- `workspaceRoot` and `projectFilter` are interpolated into the prompt string. Both originate from the extension's resolved workspace/project state (not user-supplied free text from the webview), so injection risk is negligible. The skill path is constructed via `path.join` from `workspaceRoot` — same pattern as the existing code.

**Side Effects**
- Clipboard write (unchanged behavior).
- Removes the `fs.readFileSync` call inside `_buildSuggestFeaturesPrompt`. The method no longer touches the filesystem at build time — the agent reads the skill file at execution time instead. This is the intended simplification.
- `path` and `fs` imports remain used elsewhere in the file; no dead-import lint risk.

**Dependencies & Conflicts**
- Depends on `.agents/skills/group-into-features/SKILL.md` existing at runtime (read by the agent, not by the build method). The skill file is part of the extension install.
- No conflict with `copyRefinePrompt` / `refineFeature` — those keep their inline-body + fallback approach; this plan only touches the suggest-features path. The divergence is intentional and documented above.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the proposed code referenced `c.title` which doesn't exist on `KanbanCard` (it's `topic`) — would emit `**undefined**` candidate titles; (2) deleting the placeholder-substitution code orphans literal `{{WORKSPACE_ROOT}}`/`{{ACTIVE_PROJECT_FILTER}}` in the skill file the agent reads raw; (3) dropping the embedded fallback regresses missing-skill-file behavior vs. `copyRefinePrompt`. Mitigations: use `c.topic || c.planFile || 'Untitled'`; add an explicit Placeholder Map directive to the wrapper; accept the fallback regression honestly as a broken-install case rather than mislabeling it "graceful."

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context.** The `suggestFeatures` case (line 10085) already computes `candidateCards` (lines 10094-10099) — a pre-filtered array of loose pre-coding cards in the active project scope. Today this array is used only to gate the "no candidates" warning (line 10100) and to count cards in the status message (line 10106); it is *not* passed to `_buildSuggestFeaturesPrompt`. The build method (line 11776) instead reads the skill file, strips frontmatter, substitutes placeholders, and returns the raw body — producing the confusing "skill definition" paste.

**Logic.** Change the build method to accept `candidateCards` and emit a compact pointer prompt: a task directive, a workspace block, a candidate-plan list, a placeholder map, and a closing directive. Remove the file read, frontmatter strip, substitution, and embedded fallback. Change the call site to pass `candidateCards`.

**Implementation.**

1. **Call site (line 10104)** — pass `candidateCards`:
```typescript
const prompt = this._buildSuggestFeaturesPrompt(workspaceRoot, projectFilter, candidateCards);
```

2. **Rewrite `_buildSuggestFeaturesPrompt` (line 11776)** — replace the entire method body with:
```typescript
private _buildSuggestFeaturesPrompt(
    workspaceRoot: string,
    projectFilter: string | null = null,
    candidateCards: KanbanCard[] = []
): string {
    const skillPath = `${workspaceRoot}/.agents/skills/group-into-features/SKILL.md`;
    const activeProject = projectFilter ?? '(unassigned)';

    const candidateList = candidateCards.length > 0
        ? candidateCards.map(c =>
            `- **${c.topic || c.planFile || 'Untitled'}** (planId: ${c.planId}, column: ${c.column})`
          ).join('\n')
        : '(No candidate cards found — read the board snapshot to discover them.)';

    return `You are grouping loose Switchboard plans into features.

Read and execute the skill at ${skillPath} against the candidate plans listed below.

## Workspace
- **Root:** ${workspaceRoot}
- **Active project filter:** ${activeProject}

## Candidate Plans (${candidateCards.length} found)
${candidateList}

## Skip the SCAN Step
The candidate plans above are already filtered to the pre-coding columns (CREATED, PLAN REVIEWED) and the active project scope. **Do NOT re-scan the board or re-read \`${workspaceRoot}/.switchboard/kanban-board.md\`.** Start at the skill's READ PLAN BODIES step (step 2) using the candidate list above.

## Placeholder Map
The skill file contains literal placeholders that are NOT pre-substituted. When following the skill, substitute:
- \`{{WORKSPACE_ROOT}}\` → \`${workspaceRoot}\`
- \`{{ACTIVE_PROJECT_FILTER}}\` → \`${activeProject}\`

Follow the skill's procedure from step 2 onward: read plan bodies, propose feature groupings, and wait for user approval before creating any features. Report back with your proposed groupings.`;
}
```

3. **Delete the embedded fallback and substitution logic (lines 11778-11815)** — the `skillPath`/`skillBody`/`fs.readFileSync` block, the `.agent/` legacy fallback, the embedded fallback string (lines 11786-11806), the frontmatter-strip regex (line 11811), and the `.replace(...)` chain (lines 11813-11815) are all removed. The method no longer reads the filesystem.

**Edge Cases.**
- **Empty candidate list:** the case block already returns early with a warning at line 10100-10102 before reaching the build call, so `candidateCards` is non-empty in practice. The `(No candidate cards found...)` branch is a defensive fallback only.
- **`projectFilter` null/undefined:** rendered as `(unassigned)`, matching the skill's "untagged plans only" project-scope rule (SKILL.md `### 1a. PROJECT SCOPE`).
- **`c.topic` empty:** falls back to `c.planFile`, then `'Untitled'` — matches the board's own rendering convention (line 1694).
- **Skill file missing at runtime:** the agent reads the path given, fails to open it, and reports back. This is an accepted regression (broken-install case); see the superseded callout above.

## Verification Plan

> Per session directives: **no compilation step** and **no automated tests** are run as part of this plan's verification. Verification is manual.

### Automated Tests
- None run (skipped per session directive). The change is a pure string-building refactor of a clipboard-prompt method with no new branches beyond the existing candidate-filter logic; existing unit coverage of `KanbanProvider` is unaffected.

### Manual Verification
- Click "Suggest Features" on the kanban board with ≥1 loose pre-coding card present → paste into a fresh agent chat.
- Confirm the pasted text begins with `You are grouping loose Switchboard plans into features.` (a task directive), NOT `# Skill: Group Into Features`.
- Confirm the **Candidate Plans** section lists each card with its real topic (not `undefined`), planId, and column.
- Confirm the **Placeholder Map** section is present and shows the resolved workspace root and project filter.
- Paste into an agent and confirm: it reads the skill file at the given path, **skips the SCAN step** (does not re-read `kanban-board.md`) and starts at READ PLAN BODIES using the provided candidate list, applies the placeholder map (does not stall on `{{WORKSPACE_ROOT}}`), proposes feature groupings, and waits for approval before creating features.
- With the active project filter set to a real project, confirm only that project's cards appear in the candidate list and the wrapper's `Active project filter` reflects the project name.
- With no project filter, confirm `Active project filter: (unassigned)` and only untagged cards appear.
- (Regression check) Temporarily rename/remove the skill file, click the button, paste into an agent — confirm the agent reports it cannot read the file and stops (do not expect an embedded procedure; this is the accepted regression).

## Recommendation

Complexity 3 → **Send to Intern.** The implementation is a single-file method rewrite plus a one-line call-site change, following a pattern already established by `copyRefinePrompt`. The correctness caveats (`c.topic`, placeholder map, accepted fallback regression) are already resolved *in this plan* — the coder is implementing the corrected version above, not the original draft.

## Completion Summary

Implemented the pointer-prompt rewrite of `_buildSuggestFeaturesPrompt` in `src/services/KanbanProvider.ts`. The method now accepts the pre-filtered `candidateCards` array and emits a compact task directive (workspace block, candidate plan list with `c.topic || c.planFile || 'Untitled'`, skip-scan directive, explicit placeholder map, closing directive) instead of dumping the raw `group-into-features/SKILL.md` body. Removed the `fs.readFileSync` call, the `.agent/` legacy fallback, the embedded fallback string, the frontmatter-strip regex, and the `.replace()` placeholder-substitution chain — the method no longer touches the filesystem. Updated the call site at line 10104 to pass `candidateCards`. No issues encountered; red-team review passed (empty-list guard, null projectFilter, backtick escaping, dead-import check, signature backward-compat all verified). Per session directives, no compilation or automated tests were run; verification is manual per the plan's Manual Verification section.

## Review Findings

Reviewer pass (in-place) against plan requirements. Implementation matched the plan's corrected code verbatim (signature, wrapper structure, placeholder map, skip-scan directive, `c.topic || c.planFile || 'Untitled'` fallback). Regression audit traced the single caller (line 10104), confirmed no orphaned references to the removed embedded fallback / substitution logic, confirmed `fs`/`path` imports still used elsewhere (78/136 refs), and confirmed the skill file exists with the literal placeholders the wrapper documents.

**MAJOR fix applied:** the candidate-list line omitted `c.planFile` when `c.topic` was non-empty, so the agent received planId + column + topic but **no file path**. The skill's step 2 (READ PLAN BODIES) says "read the full plan file" and assumes the agent has file paths from step 1 (SCAN reads `kanban-board.md` for the planId→file mapping). The wrapper tells the agent to **skip SCAN** — so the agent had no way to resolve planId → file without violating the skip directive, creating the exact "agent stalls / asks / hallucinates" failure this plan was meant to eliminate. Fixed by adding `, file: ${c.planFile}` to the candidate-list line (KanbanProvider.ts:11790). `planFile` is a workspace-relative path (e.g. `.switchboard/plans/foo.md`), so the agent can read it directly given the workspace root.

**NIT (not fixed):** `activeProject = projectFilter ?? '(unassigned)'` displays `(unassigned)` when `projectFilter === null`, but `_cardMatchesProjectFilter(card, null)` returns ALL cards (tagged + untagged), so the label is slightly misleading in the pre-refresh edge case. In practice `_projectFilter` defaults to `__unassigned__` (never null after first board load), and the candidate list is authoritative (step 1a PROJECT SCOPE is skipped), so no functional impact. The skill's step 1a sentinel for "no project" is empty/`__unassigned__`/literal placeholder — `(unassigned)` is none of those, but step 1a is skipped so the value is never consumed.

**Files changed:** `src/services/KanbanProvider.ts` (one line: candidate-list now includes `file:` field).
**Validation:** no compilation / tests run per session directives. Manual verification per the plan's Manual Verification section remains the gate; the `file:` fix should be confirmed by pasting the prompt and verifying the agent reads plan bodies directly from the listed paths without re-reading `kanban-board.md`.
**Remaining risks:** the accepted missing-skill-file regression (documented in the plan); the `(unassigned)` label nit above.
