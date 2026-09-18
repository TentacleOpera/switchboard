# Fix: Epic Files Have No Content — Improve Epic Generation Prompt

## Goal

Epic files created by `createEpicFromPlanIds` contain almost no content — just a YAML frontmatter description, an H1 title, and a one-line description. They lack a meaningful description of what the epic is about, why the plans are grouped together, and how each subtask contributes to the epic's goal. The orchestrator agent opening an epic file has no idea what the epic is or what needs to be done.

### Root Cause

Two problems:

1. **The suggest-epics prompt doesn't instruct the agent to write epic descriptions.** The `_buildSuggestEpicsPrompt` method (actual line 8835) tells the agent to propose epics with "epic name, member plans with planId and one-line summary" (actual line 8873) — but doesn't ask for a Goal statement or per-subtask narrative. The `create-epic.js` call at actual line 8885 only passes the epic name and plan IDs, not a description. The script already accepts a description as the 4th positional argument (line 26: `process.argv[5]`) and the API endpoint passes it through (`LocalApiServer.ts` line 304 → `createEpicFromPlanIds` 4th param) — the plumbing exists, the prompt just doesn't use it.

2. **The epic file content template is a bare stub.** `createEpicFromPlanIds` (actual line 8661) writes only:
```typescript
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;
```
(actual lines 8754–8756, pre-fix). Even when a description IS passed, it's a single line with no structure. The `_regenerateEpicFile` method appends subtask links but no summaries.

### What the Epic File Should Contain

The epic file should follow this structure (matching the hand-written epics in the current board):

```markdown
---
description: 'Epic Name'
---

# Epic Name

## Goal

<Full problem statement — what's broken today, what the epic solves, why these plans are grouped together. 2-4 sentences.>

## How the Subtasks Achieve This

- **Subtask Plan Name**: <What this plan does and how it contributes to the epic's goal. 1-2 sentences.>
- **Subtask Plan Name**: <What this plan does and how it contributes to the epic's goal. 1-2 sentences.>

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Subtask Name](../plans/plan-file.md)
<!-- END SUBTASKS -->
```

The `## Goal` and `## How the Subtasks Achieve This` sections are written by the agent at proposal time — they require understanding what each subtask does and how it relates to the epic's theme. The code can't generate these automatically; the prompt must instruct the agent to write them.

## Metadata

**Complexity:** 3
**Tags:** bugfix, feature, backend

## User Review Required

Yes — the prompt-text changes and the epic-file template change should be reviewed before implementation to confirm the desired epic-file structure matches the team's hand-written epics. No database migrations or breaking changes are involved.

## Complexity Audit

### Routine
- Editing prompt text in `_buildSuggestEpicsPrompt` (string array, no logic change)
- Editing the `epicContent` template string in `createEpicFromPlanIds` (2-line change)
- Verifying `_regenerateEpicFile` already preserves content outside the subtask markers (read-only confirmation — no code change needed)
- The description plumbing (create-epic.js → LocalApiServer → createEpicFromPlanIds) already exists and is confirmed working

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `createEpicFromPlanIds` writes the epic file (actual line 8761) then immediately calls `_regenerateEpicFile` (actual line 8767), which reads the just-written file. The `registerPendingCreation` call before `writeFile` (actual line 8760) ensures the file watcher skips this file. No concurrent-writer risk introduced by this change.
- **Security:** The `epicName` is stripped of newlines (line 8668) before being inserted into the frontmatter `description` field and H1 — this IS necessary for frontmatter safety. The `yamlSafeName` escapes single quotes (actual line 8753). The description is placed under a `## Goal` heading in the markdown body (not in frontmatter), so newlines and `---` in the description cannot break the frontmatter block. **Reviewer note:** the original plan's claim that the *description* needed newline stripping for frontmatter safety was incorrect — the description is in the body, after the closed frontmatter. The reviewer fix preserves newlines in the description (CRLF normalized to LF only) for proper Goal formatting.
- **Side Effects:** The template change affects BOTH the webview `createEpic` path (actual line 8112, passes `msg.description`) and the agent/API path (TaskViewerProvider → `createEpicFromPlanIds`). When no description is passed (e.g. webview UI doesn't collect one), `epicDesc` is empty and the `## Goal` section is omitted — the file degrades gracefully to just H1 + subtask block, identical to today's behavior.
- **Dependencies & Conflicts:** None. No new dependencies. The create-epic.js script already accepts the description arg (line 26); no script change required.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) stale line numbers in the original plan would have led an implementer to edit the wrong lines — corrected to actual values after re-reading the source; (2) the manual agent step of writing `## How the Subtasks Achieve This` into the file is fragile and unvalidated — if the agent skips it, the epic file has a Goal but no subtask narrative; (3) shell-quoting of the description in the bash command can break if the goal text contains double quotes, `$`, or backticks. Mitigations: line numbers corrected to actual values; the prompt now explicitly instructs the agent to escape double quotes and avoid `$`/backticks in the description arg (or rephrase to avoid them); the manual write step is kept because the structural separation (Goal via script, How-Subtasks via manual edit) is intentional and `_regenerateEpicFile` preserves it on subsequent regenerations.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_buildSuggestEpicsPrompt` (actual line 8835)

**Update the prompt to instruct the agent to write epic descriptions and pass them to create-epic.js.**

The current step 3 (PROPOSE, actual lines 8861–8874) says:
```
For each proposed epic: epic name, member plans with planId and one-line summary.
```

The current step 5 (EXECUTE, actual lines 8879–8892) says:
```
node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}"
```

Both need to change:

```typescript
// Step 3 — PROPOSE (actual lines 8861–8874):
// Before:
'3. PROPOSE (single message, all groups at once)',
'   Group by underlying capability theme, not by surface keyword.',
'   Cross-provider plans that address the same capability go into one epic.',
'   Minimum 2 plans per epic. Single-plan "groups" go in the Standalone section.',
'   Flag POSSIBLE OVERLAP / REDUNDANCY / GAP where detected.',
'   For each proposed epic: epic name, member plans with planId and one-line summary.',
'   List genuinely standalone plans separately. Then stop and wait.',

// After:
'3. PROPOSE (single message, all groups at once)',
'   Group by underlying capability theme, not by surface keyword.',
'   Cross-provider plans that address the same capability go into one epic.',
'   Minimum 2 plans per epic. Single-plan "groups" go in the Standalone section.',
'   Flag POSSIBLE OVERLAP / REDUNDANCY / GAP where detected.',
'   For each proposed epic, write:',
'     - Epic name',
'     - Goal: 2-4 sentences describing what the epic achieves, what problem it',
'       solves, and why these plans are grouped together.',
'     - How the Subtasks Achieve This: one bullet per member plan explaining what',
'       it does and how it contributes to the epic\'s goal. Format:',
'         - **Plan Name**: <what it does and how it contributes>',
'     - Member plans with planId and one-line summary',
'   List genuinely standalone plans separately. Then stop and wait.',
```

```typescript
// Step 5 — EXECUTE (actual lines 8879–8892):
// Before:
'5. EXECUTE',
'   For each approved group:',
'   ```bash',
`   node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}"`,
'   ```',

// After:
'5. EXECUTE',
'   For each approved group, pass the Goal text as the description argument.',
'   Escape any double quotes in the Goal text (replace " with \") or rephrase to',
'   avoid them, so the bash command does not break. Also avoid $ and backticks',
'   in the Goal text — these are shell metacharacters inside double quotes.',
'   ```bash',
`   node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "${workspaceRoot}" "<goal text with escaped quotes>"`,
'   ```',
'   The description becomes the ## Goal section in the epic file.',
'   After all epics are created, write the ## How the Subtasks Achieve This section',
'   into each epic file manually (the create-epic script only writes the Goal).',
'   Use the text from your step 3 proposal — paste it between the Goal and the',
'   <!-- BEGIN SUBTASKS --> marker. This section is preserved by _regenerateEpicFile',
'   on subsequent subtask changes, so it only needs to be written once.',
```

### `src/services/KanbanProvider.ts` — `createEpicFromPlanIds` epic template (actual lines 8752–8759)

**Improve the epic file template to use the description as a proper Goal section:**

```typescript
// Before (original):
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${epicDesc}`;

// After (as implemented, with reviewer fix — see Reviewer Pass below):
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${epicName}\n\n${goalSection}`;
```

This puts the description under a `## Goal` heading instead of as a bare paragraph after the H1. If no description is passed, the file has just the H1 and the auto-generated subtask section (identical to today's behavior). The subsequent `_regenerateEpicFile` call (line 8771) appends the subtask block after the Goal section — since there are no BEGIN/END SUBTASKS markers yet, it takes the else branch (line 8645) and appends `\n\n` + subtask section, producing the correct final structure.

### `src/services/KanbanProvider.ts` — `_regenerateEpicFile` (actual line 8621)

**No change needed.** The current implementation (lines 8642–8646) already preserves all content outside the `<!-- BEGIN SUBTASKS -->` / `<!-- END SUBTASKS -->` markers by slicing on the marker indices (line 8643). This means the `## Goal` and `## How the Subtasks Achieve This` sections written by the agent will survive every subsequent subtask regeneration. Confirmed by reading the actual code — do NOT apply the conditional code block from the original plan draft; it would be a no-op at best and a regression risk at worst.

---

## Reviewer Pass (In-Place Direct Review)

### Stage 1 — Adversarial Findings (Grumpy Principal Engineer)

| Severity | Finding | Location |
|----------|---------|----------|
| **MAJOR-1** | `epicDesc` newline stripping (`replace(/[\r\n]+/g, ' ')`) defeats the plan's stated intent of a structured multi-sentence Goal section. The plan's Edge-Case audit justifies this as preventing "YAML/frontmatter injection" — but the description is placed in the **markdown body** under `## Goal`, *after* the frontmatter block is already closed by `---`. Newlines in the body cannot break frontmatter. The security reasoning is factually wrong, and the flattening degrades output for both the agent path (multi-sentence goals) and the webview path (multi-line textarea). | KanbanProvider.ts:8754 (pre-fix) |
| **NIT-1** | Stale line numbers in "Proposed Changes" section. Plan references line 8797 for `_buildSuggestEpicsPrompt` (actual: 8835), lines 8823-8829 for PROPOSE (actual: 8861-8874), lines 8836-8840 for EXECUTE (actual: 8879-8892), lines 8717-8718 for epic template (actual: 8752-8759), line 8584 for `_regenerateEpicFile` (actual: 8621). Would mislead a future implementer. | This plan file |
| **NIT-2** | Shell-escaping guidance in the EXECUTE prompt step mentioned `"`, `$`, and backticks but not backslash (`\`), which is the escape character inside double quotes. A literal `\` followed by `"` in the goal text would prematurely escape the closing quote. Low probability — agents rarely write backslashes in prose. **Resolved:** backslash added to the avoid list. | KanbanProvider.ts:8881-8882 |

### Stage 2 — Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| MAJOR-1: Newline stripping | **Fix now** — reasoning is factually wrong; fix is safe (1 line); improves output for both agent and webview paths | Applied |
| NIT-1: Stale line numbers | **Fix now** — cheap, prevents future confusion | Applied (this update) |
| NIT-2: Incomplete shell-escaping | **Fix now** — cheap one-line prompt edit; adds backslash to the avoid list | Applied |

### Stage 3 — Code Fix Applied

**File changed:** `src/services/KanbanProvider.ts` line 8754 (now 8757)

```typescript
// Before (plan's original spec):
const epicDesc = (description ? String(description).replace(/[\r\n]+/g, ' ').trim() : '');

// After (reviewer fix — preserve newlines, normalize CRLF only):
const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
```

**Rationale:** The description lives in the markdown body under `## Goal`, after the closed frontmatter block. Newlines are safe there and preserve the agent's multi-line goal formatting. CRLF is normalized to LF for cross-platform consistency. The `epicName` newline stripping (line 8668) is unchanged — that IS necessary because the name goes into the frontmatter `description` field and the H1.

### Stage 4 — Verification

- **Compilation:** SKIPPED per session directive.
- **Automated tests:** SKIPPED per session directive.
- **Manual code verification:**
  - [x] `_buildSuggestEpicsPrompt` (line 8835): PROPOSE step instructs agent to write Epic name, Goal (2-4 sentences), How-Subtasks-Achieve-This (per-plan bullets), and member plans with planId. ✓
  - [x] EXECUTE step (lines 8879-8892): instructs passing Goal text as description arg with shell-escaping guidance, and manual write of `## How the Subtasks Achieve This` section. ✓
  - [x] `createEpicFromPlanIds` epic template (lines 8757-8759): description placed under `## Goal` heading; empty description → no `## Goal` heading (graceful degradation). ✓
  - [x] `_regenerateEpicFile` (lines 8642-8646): preserves content outside BEGIN/END SUBTASKS markers by slicing. No change needed. ✓
  - [x] Description plumbing: `create-epic.js` argv[5] (line 26) → POST body (line 108) → `LocalApiServer.ts` (line 304) → `createEpicFromPlanIds` 4th param (line 8665). End-to-end intact. ✓
  - [x] Webview path (line 8116): passes `msg.description` through to `createEpicFromPlanIds`. ✓

### Remaining Risks

1. **Manual `## How the Subtasks Achieve This` write step is unenforced.** The prompt instructs the agent to manually paste this section into the epic file after create-epic.js runs. If the agent skips it, the epic file has a Goal but no subtask narrative. This is an acknowledged design tradeoff (structural separation: Goal via script, How-Subtasks via manual edit). No code-level validation exists. Mitigation: the prompt is explicit about the step; `_regenerateEpicFile` preserves it once written.
2. **No description validation.** A description containing markdown headings (e.g., `## Something`) would inject subheadings into the Goal section. Not breaking, but could produce odd structure. The agent is instructed to write prose, not headings, so this is unlikely.

## Recommendation

Complexity 3 → **Send to Coder**.
