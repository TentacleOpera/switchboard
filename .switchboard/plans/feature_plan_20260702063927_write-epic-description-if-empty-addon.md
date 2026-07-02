# Add "Write Epic Description If Empty" Planner Add-on + Dependencies Section to Suggest Epics Skill

**Plan ID:** 6A880190-1501-47E6-A35E-7E838A237E75

## Goal

### Problem
When an epic is created via `create-epic.js` or the promote-to-epic flow without going through the "Suggest Epics" skill, the resulting epic file contains only auto-generated scaffolding: a title, a `**Complexity:**` line, and the `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->` block. It is missing the three descriptive sections that make an epic self-documenting:

- `## Goal` — 2-4 sentences describing what the epic achieves and why the plans are grouped.
- `## How the Subtasks Achieve This` — one bullet per member plan explaining its contribution.
- `## Dependencies & sequencing` — cross-epic dependencies, shipping order within the epic, and prerequisites.

Compare the sparse epic (`projects-improvements-78f49206-...md`, no Goal/How/Dependencies sections) with a complete one (`epic-creation-and-specification-ux-...md`, which has Goal + How but still lacks Dependencies & sequencing). The `## Dependencies & sequencing` convention is already established in multiple shipped epics (e.g. `remote-epic-structure-...md`, `linear-sync-channel-features-...md`, `note-codebase-docs-...md`) but is not produced by either the Suggest Epics skill or the planner add-on. The sparse form is the default output of `_regenerateEpicFile` and `create-epic.js`; the descriptive form is only produced when a human manually writes those sections.

### Root Cause
There is no prompt-level mechanism that instructs the planner agent to backfill missing descriptive sections when it is dispatched against an epic's subtask plans. The planner already receives the epic plan file path in its plan list (the non-subtask entry tagged `[EPIC: ...]`), but nothing in the prompt tells it to inspect the epic file and write a `## Goal` / `## How the Subtasks Achieve This` / `## Dependencies & sequencing` section if they are absent. The Suggest Epics skill (`group-into-epics/SKILL.md`) defines the format for Goal and How sections, but (a) it is only invoked via the dedicated SUGGEST EPICS button — not during normal planner dispatch, and (b) it does not include a `## Dependencies & sequencing` section in its PROPOSE step even though it reads dependencies in step 2.

### Desired Outcome
Two changes:

1. **New planner add-on** — Add a checkbox, **"Write Epic Description If Empty"**, to the prompt builder in `kanban.html`. It is **ON by default**. When enabled, the generated planner prompt includes a directive instructing the planner to read the epic file, check whether `## Goal`, `## How the Subtasks Achieve This`, and `## Dependencies & sequencing` are present, and backfill any that are missing — without touching the auto-generated subtasks block.

2. **Update Suggest Epics skill** — Add `## Dependencies & sequencing` to the PROPOSE step (step 3) and the EXECUTE step (step 5) of `group-into-epics/SKILL.md`, so epics created via the SUGGEST EPICS button also get this section.

## Metadata

- **Tags:** backend, ui, feature, docs
- **Complexity:** 4
- **Files touched:** `src/webview/sharedDefaults.js`, `src/webview/kanban.html`, `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`, `.agents/skills/group-into-epics/SKILL.md`

## User Review Required

None. The add-on is default-on and purely additive; users who dispatch against epics get better epic files, users who don't are unaffected. The SKILL.md edit is text-only and consumed as a pasted prompt.

## Complexity Audit

### Routine
- New checkbox in hardcoded planner HTML block — mirrors `plannerAddonAdviseResearch` (kanban.html:2956).
- New entry in `ROLE_ADDONS.planner` array (sharedDefaults.js:59-74) with `default: true`.
- New key in `DEFAULT_ROLE_CONFIG.planner.addons` (sharedDefaults.js:21) — `writeEpicDescriptionIfEmpty: true`.
- New load/save line in kanban.html JS; new ID in the listener forEach (kanban.html:4072). The camelCase derivation at :4080 produces `writeEpicDescriptionIfEmpty` correctly — no `addonIdMap` entry needed.
- New optional field on `PromptBuilderOptions` (agentPromptBuilder.ts:148) after `adviseResearchIfUnsure` (:203).
- New directive constant near `ADVISE_RESEARCH_DIRECTIVE` (:415).
- Conditional injection in planner branch after the adviseResearch block (agentPromptBuilder.ts:774-776), gated on `options?.epicMode` (:234, read at :713).
- New mapping in `KanbanProvider._resolvePromptBuilderOptions` after the `adviseResearchIfUnsure` line (KanbanProvider.ts:3357). `epicMode` is set at KanbanProvider.ts:3408.
- Text-only edit to `group-into-epics/SKILL.md` PROPOSE step (:68) and EXECUTE step (:89).

### Complex / Risky
- None. No schema migrations, no DB changes, no new message types. The SKILL.md is consumed as a pasted prompt (`_buildSuggestEpicsPrompt` strips YAML frontmatter and substitutes `{{WORKSPACE_ROOT}}`) — not parsed by code.

## Edge-Case & Dependency Audit

**Race Conditions:** None. The directive is generated at prompt-assembly time (single-threaded). The planner writes the epic file during its run; `_regenerateEpicFile` (KanbanProvider.ts:9117) only replaces content between BEGIN/END SUBTASKS (:9142-9147) and BEGIN/END WORKTREES (:9179-9184) markers, preserving everything outside — including newly written sections. No concurrent write path.

**Security:** None. No user input flows into the directive text; the directive is a static constant. The epic file path is already present in the plan list (existing behaviour).

**Side Effects:** The planner will write to the epic `.md` file when sections are missing. This is the intended behaviour and is idempotent (subsequent runs see the sections present and no-op). No other files are touched by the directive.

**Dependencies & Conflicts:** This plan edits `agentPromptBuilder.ts` (planner branch) and `KanbanProvider.ts` (`_resolvePromptBuilderOptions`) — the same files touched by the sibling plan "Prompt Builder Redundancy Cleanup" (feature_plan_20260702123609). **Execution order: that plan must land first** (it restructures the planner branch and the suffix assembly); this plan's additive directive then slots into the refactored branch. If executed in parallel the two will produce merge conflicts on the same lines.

| Edge Case / Dependency | Handling |
|---|---|
| Epic file has `## Goal` but not `## How the Subtasks Achieve This` or `## Dependencies & sequencing` (or any subset) | Directive instructs planner to backfill only the missing section(s), preserving existing content. |
| Epic file has none of the three sections (pure auto-generated scaffolding) | Directive instructs planner to write all three sections. |
| Epic file already has all three sections | Directive instructs planner to leave them untouched (no-op). |
| Dispatch is NOT an epic dispatch (no subtasks, `epicMode` false) | Directive is omitted entirely — only injected when `options.epicMode === true`. Avoids noise on single-plan dispatches. |
| Auto-generated `<!-- BEGIN SUBTASKS -->` block | Directive explicitly forbids modifying the auto-generated subtasks block (same constraint as `_regenerateEpicFile` and the Suggest Epics skill). |
| `_regenerateEpicFile` runs after the planner writes the sections | `_regenerateEpicFile` only replaces content between the `BEGIN/END SUBTASKS` markers and the `BEGIN/END WORKTREES` markers — it preserves everything outside them, including newly written `## Goal`, `## How the Subtasks Achieve This`, and `## Dependencies & sequencing` sections. Safe. |
| Existing users with saved planner config that lacks the new key | Default-on via `?? true` fallback in load logic and `default: true` in `ROLE_ADDONS` — consistent with `adviseResearch` (also default-on). No migration needed; missing key reads as `true`. |
| Custom agents derived from planner | `ROLE_ADDONS` only drives the dynamic renderer for non-planner roles. The planner block is hardcoded HTML, so custom agents are unaffected. |
| Caveman output mode is also on | The directive is a planning instruction, not chatty output; it survives caveman compression (same as `ADVISE_RESEARCH_DIRECTIVE`). |
| Epic has no cross-epic dependencies (all subtasks are self-contained) | `## Dependencies & sequencing` section should still be written — it documents the internal shipping order (which subtask should land first) and explicitly states "No cross-epic dependencies" if true. An epic with a single subtask can note "Single subtask — no internal ordering." |
| Suggest Epics skill is used but epic has no dependencies | Same: the PROPOSE step should include a `## Dependencies & sequencing` entry that states "No cross-epic dependencies; subtasks are independent" rather than omitting the section. |
| Section naming variant: `## Dependencies` vs `## Dependencies & sequencing` | The directive and skill both standardize on `## Dependencies & sequencing` (the most common form in existing epics). If an epic already has `## Dependencies` (without `& sequencing`), the planner should treat it as present and not duplicate — the backfill check matches on `## Dependencies` as a prefix. |

## Dependencies

- `feature_plan_20260702123609_prompt-builder-redundancy-cleanup.md` — Prompt Builder Redundancy Cleanup. Must land FIRST. Both plans edit the planner branch of `agentPromptBuilder.ts` and `_resolvePromptBuilderOptions` in `KanbanProvider.ts`; the redundancy cleanup restructures those branches, this plan adds into them. Reverse order risks merge conflicts on the same lines.

## Adversarial Synthesis

Key risks: (1) line-number drift in the original plan would have sent the coder to wrong locations — corrected against verified source. (2) cross-plan collision on `agentPromptBuilder.ts` / `KanbanProvider.ts` — mitigated by sequencing (redundancy cleanup first). (3) directive text quality — the 200-word directive is correct but dense; acceptable since it mirrors the established `ADVISE_RESEARCH_DIRECTIVE` pattern. No data-migration, schema, or concurrency risks.

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` — add addon metadata + default

Add the new addon to `ROLE_ADDONS.planner` (after `adviseResearch` would be ideal, but `adviseResearch` is not in the `ROLE_ADDONS.planner` array — it's only in the hardcoded HTML. Place it after `cavemanOutput` in the array for logical grouping):

```js
// In ROLE_ADDONS.planner array, after the cavemanOutput entry:
{ id: 'writeEpicDescriptionIfEmpty', label: 'Write Epic Description If Empty', tooltip: 'When dispatched against an epic, backfill missing ## Goal, ## How the Subtasks Achieve This, and ## Dependencies & sequencing sections in the epic file', default: true },
```

Add the key to `DEFAULT_ROLE_CONFIG.planner.addons`:

```js
// Line 21 — add writeEpicDescriptionIfEmpty: true to the planner addons object:
planner: {
    workflowFilePath: '.agents/workflows/improve-plan.md',
    addons: { switchboardSafeguards: true, constitution: false, aggressivePairProgramming: false, gitProhibition: false, clearAntigravityContext: false, cavemanOutput: true, adviseResearch: true, writeEpicDescriptionIfEmpty: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: true }
},
```

### 2. `src/webview/kanban.html` — add checkbox + load/save wiring

Add the checkbox in the planner add-ons HTML block, after the `plannerAddonAdviseResearch` label (kanban.html:2956, before the Subagent Policy radio group):

```html
<label class="checkbox-item" title="When dispatched against an epic, backfill missing ## Goal, ## How the Subtasks Achieve This, and ## Dependencies & sequencing sections in the epic file">
  <input type="checkbox" id="plannerAddonWriteEpicDescriptionIfEmpty">
  <span>Write Epic Description If Empty</span>
  <span class="tooltip">When dispatched against an epic, backfill missing ## Goal, ## How the Subtasks Achieve This, and ## Dependencies & sequencing sections in the epic file</span>
</label>
```

Add the load line in the `if (currentRole === 'planner')` block (after the adviseResearch load):

```js
document.getElementById('plannerAddonWriteEpicDescriptionIfEmpty').checked = config.addons?.writeEpicDescriptionIfEmpty !== false;
```

Add the checkbox ID to the planner add-on listener array (kanban.html:4072):

```js
['plannerAddonSwitchboardSafeguards', 'plannerAddonConstitution', 'plannerAddonDesignSystemDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonClearAntigravityContext', 'plannerAddonCavemanOutput', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests', 'plannerAddonAdviseResearch', 'plannerAddonWriteEpicDescriptionIfEmpty'].forEach(id => {
```

The existing `addonIdMap` (kanban.html:4076) + `id.replace('plannerAddon', '')` logic at :4080 will derive the correct key `writeEpicDescriptionIfEmpty` automatically (no special mapping needed — the camelCase derivation `addonId.charAt(0).toLowerCase() + addonId.slice(1)` produces `writeEpicDescriptionIfEmpty`).

### 3. `src/services/agentPromptBuilder.ts` — add option + directive + injection

Add the option field to `PromptBuilderOptions` (agentPromptBuilder.ts:148, after `adviseResearchIfUnsure` at :203):

```ts
/** When true (default), instructs the planner to backfill missing ## Goal,
 *  ## How the Subtasks Achieve This, and ## Dependencies & sequencing sections
 *  in the epic file when dispatched against an epic. Only injected for
 *  epic-mode dispatches. */
writeEpicDescriptionIfEmpty?: boolean;
```

Add the directive constant near the other planner directives (after `ADVISE_RESEARCH_DIRECTIVE`, agentPromptBuilder.ts:415):

```ts
export const WRITE_EPIC_DESCRIPTION_DIRECTIVE = `EPIC DESCRIPTION BACKFILL: The epic file path is included in the plan list above (the entry tagged [EPIC: ...]). Read that file. If it is missing any of these three sections, write them now following this format:
- ## Goal: 2-4 sentences describing what the epic achieves, what problem it solves, and why these plans are grouped together.
- ## How the Subtasks Achieve This: one bullet per member plan (subtask) explaining what it does and how it contributes to the epic's goal. Format: "- **<Plan Name>**: <what it does and how it contributes>"
- ## Dependencies & sequencing: bullet list covering (a) cross-epic dependencies — what must land first from other epics, if any; (b) shipping order within this epic — which subtask should be coded/merged before which, and why; (c) prerequisites or guards that must be in place. If there are no cross-epic dependencies and the subtasks are independent, state that explicitly (e.g. "No cross-epic dependencies; subtasks are independent and can land in any order"). If there is only one subtask, note "Single subtask — no internal ordering."
If all three sections already exist with substantive content, leave them untouched. If only some are missing, backfill only the missing ones. Treat a section titled "## Dependencies" (without "& sequencing") as present — do not duplicate it. Do NOT modify the auto-generated "<!-- BEGIN SUBTASKS -->" block or the "<!-- BEGIN WORKTREES -->" block — write your sections between the title/complexity and the BEGIN SUBTASKS marker. Read each subtask plan file to ground the Goal, How bullets, and dependency analysis in the actual plan content, not just titles.`;
```

In the planner branch of `buildKanbanBatchPrompt`, read the option and inject the directive. Add after the `adviseResearchIfUnsure` block (agentPromptBuilder.ts:774-776), gated on `epicMode` (option at :234, read at :713):

```ts
const writeEpicDescriptionIfEmpty = options?.writeEpicDescriptionIfEmpty ?? true;
// ... later in the planner branch, after the adviseResearch injection:
if (writeEpicDescriptionIfEmpty && options?.epicMode) {
    plannerBase += '\n\n' + WRITE_EPIC_DESCRIPTION_DIRECTIVE;
}
```

The `epicMode` gate ensures the directive only appears when the dispatch actually includes subtask plans of an epic (set at `KanbanProvider.ts` line 3408).

### 4. `src/services/KanbanProvider.ts` — pass the config flag through

In `_resolvePromptBuilderOptions`, add the mapping after the `adviseResearchIfUnsure` line (KanbanProvider.ts:3357):

```ts
writeEpicDescriptionIfEmpty: plannerConfig?.addons?.writeEpicDescriptionIfEmpty ?? true,
```

### 5. `.agents/skills/group-into-epics/SKILL.md` — add Dependencies & sequencing to PROPOSE + EXECUTE

The Suggest Epics skill already reads dependencies in step 2 ("Extract: goal, problem summary, dependencies, tags") but never writes them into the epic. Add a `## Dependencies & sequencing` section to both the PROPOSE step and the EXECUTE step.

**Step 3 (PROPOSE)** — add a new bullet to the "For each proposed epic, write:" list (after "Member plans with planId and one-line summary"):

```markdown
- Dependencies & sequencing: bullet list covering (a) cross-epic dependencies —
  what must land first from other epics, if any; (b) shipping order within this
  epic — which subtask should be coded/merged before which, and why; (c)
  prerequisites or guards. If there are no cross-epic dependencies and the
  subtasks are independent, state that explicitly. If there is only one
  subtask, note "Single subtask — no internal ordering."
```

**Step 5 (EXECUTE)** — update the manual-write instruction (currently SKILL.md:101-105) to include the new section. The current text says:

> After all epics are created, write the ## How the Subtasks Achieve This section
> into each epic file manually (the create-epic script only writes the Goal).
> Use the text from your step 3 proposal — paste it between the Goal and the
> `<!-- BEGIN SUBTASKS -->` marker.

Change to:

> After all epics are created, write the ## How the Subtasks Achieve This and
> ## Dependencies & sequencing sections into each epic file manually (the
> create-epic script only writes the Goal). Use the text from your step 3
> proposal — paste both sections between the Goal and the
> `<!-- BEGIN SUBTASKS -->` marker. This section is preserved by
> _regenerateEpicFile on subsequent subtask changes, so it only needs to be
> written once.

## Verification Plan

1. **Build check:** `npm run compile` succeeds with no type errors.
2. **Unit test — agentPromptBuilder:**
   - Add a test in `src/services/__tests__/agentPromptBuilder.test.ts` mirroring the `adviseResearchIfUnsure` suite:
     - `writeEpicDescriptionIfEmpty: true` + `epicMode: true` → prompt contains `EPIC DESCRIPTION BACKFILL` and `## Dependencies & sequencing`.
     - `writeEpicDescriptionIfEmpty: false` + `epicMode: true` → prompt does NOT contain it.
     - `writeEpicDescriptionIfEmpty: true` + no `epicMode` → prompt does NOT contain it (non-epic dispatch is unaffected).
     - `undefined` + `epicMode: true` → prompt contains it (default ON).
3. **Manual UI check (installed VSIX):**
   - Open the kanban board → agent config → Planner → Add-ons.
   - Confirm the "Write Epic Description If Empty" checkbox appears, is checked by default, and has the correct tooltip (mentions all three sections).
   - Toggle it off, reload the webview, confirm the state persists (saved to `state.json`).
   - Dispatch a planner prompt against an epic's subtasks → confirm the generated prompt text includes the `EPIC DESCRIPTION BACKFILL` directive and mentions `## Dependencies & sequencing`.
   - Dispatch a planner prompt against a single non-epic plan → confirm the directive is absent.
4. **Epic file safety:** After a planner run with the directive, confirm `_regenerateEpicFile` does not clobber the newly written `## Goal` / `## How the Subtasks Achieve This` / `## Dependencies & sequencing` sections (it only touches the BEGIN/END SUBTASKS and BEGIN/END WORKTREES blocks).
5. **Suggest Epics skill check:** Click SUGGEST EPICS on the kanban board → confirm the copied prompt text includes the `Dependencies & sequencing` bullet in the PROPOSE step and the updated EXECUTE step mentioning both `## How the Subtasks Achieve This` and `## Dependencies & sequencing`.

## Recommendation

**Complexity: 4 → Send to Coder.** Sequenced after the sibling redundancy-cleanup plan lands.
