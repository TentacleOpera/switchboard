# Fix: Suggest Epics Skill Ignores Project Filter — kanban-state Export Is Unfiltered + Lacks Project Tags

## Goal

The **Suggest Epics** board button (which invokes the `group-into-epics` skill) proposes epic groupings from **all plans in the workspace**, ignoring the project filter the user has active on their board. When the user is viewing "Unassigned" plans (or a specific project), they expect the skill to only see plans in that same scope — but it sees everything. This plan fixes the root cause: `exportStateToFile()` dumps all active plans regardless of project, and the exported kanban-state files carry no `project:` tag, so neither the skill nor a human reading the files can distinguish which plans belong to which project.

### Problem Analysis & Root Cause

**Two linked defects:**

1. **`exportStateToFile()` uses `getBoard()`, not `getBoardFilteredByProject()`.**
   `KanbanDatabase.ts:5845` calls `this.getBoard(workspaceId)`, which queries `WHERE workspace_id = ? AND status = 'active'` — no project filter (`KanbanDatabase.ts:2476-2484`). A project-filtered method exists (`getBoardFilteredByProject`, `KanbanDatabase.ts:2714`) but is not used by the export. Result: the kanban-state files contain every active plan in the workspace, including plans already assigned to projects like "Remote sync" or "Switchboard".

2. **The kanban-state file format has no `project:` tag in the HTML comment.**
   `KanbanDatabase.ts:5893-5899` builds the comment from only `planId`, `epic`, and `subtask-of:`. The `project` field is not emitted. So even if the skill tried to filter, it has no data to filter on — the information is not in the file.

**Why this matters:** The `group-into-epics` skill (`.agents/skills/group-into-epics/SKILL.md:20`) reads `kanban-board.md` → `kanban-state-*.md` files. It has no project context. When the user clicks "Suggest Epics" while viewing unassigned plans, the skill proposes groupings that include plans already assigned to "Remote sync" and "Switchboard" projects — plans the user is not looking at and does not want grouped.

**Root cause:** The export was designed as a workspace-wide snapshot for remote-agent visibility (a web agent with no DB access reads these files to reconstruct the board). Project filtering was treated as a UI-layer concern in `KanbanProvider` and never propagated to the file export. The skill was then built on top of the unfiltered export, inheriting the gap.

## Metadata
- **Tags:** bug, backend, kanban, export, group-into-epics, project-filter
- **Complexity:** 4

## Complexity Audit

### Routine
- Adding `project:` to the HTML comment in `exportStateToFile()` (one line)
- The `group-into-epics` skill text gains a filtering step (documentation change)

### Complex / Risky
- **Whether to filter the export itself or filter in the skill.** Filtering the export would break the remote-agent use case (a web agent needs the full board, not a project slice). The correct fix is to **add the project tag to the export** (so the data is available) and **teach the skill to filter by it** — not to change what the export contains.
- **Backward compat of the new tag.** Existing kanban-state files in user repos won't have the `project:` tag until the next DB write triggers a regeneration. The skill must treat missing `project:` as "unassigned" (empty string), which is the correct default.

## Edge-Case & Dependency Audit
- **Plans with no project assigned:** `project` field is `''` or `NULL` in the DB. The tag should emit `project:` with an empty value or omit the tag entirely. Omitting is cleaner — plans without a project tag are unassigned by definition, matching the skill's existing behavior.
- **Plans assigned to a project that no longer exists:** The `project` field is a free-text string, not a FK to the `projects` table. The tag reflects whatever is in the DB row. No issue.
- **Remote-agent consumers of kanban-state files:** Adding a tag inside an HTML comment does not change the visible content of the file. Remote agents that parse the visible markdown are unaffected. Agents that parse the comments gain a new optional field.
- **`exportStateToFile()` regeneration timing:** The files regenerate on every `_persist()` call (`KanbanDatabase.ts:5974`). After this fix ships, the next DB write (any card move, plan creation, etc.) regenerates the files with the new tag. No manual regeneration needed.
- **No dependencies on other files** — the change is in `KanbanDatabase.ts` (export logic) and `.agents/skills/group-into-epics/SKILL.md` (skill text).

## Proposed Changes

### 1. Add `project:` tag to the kanban-state file HTML comments

**File:** `src/services/KanbanDatabase.ts` (in `exportStateToFile`, ~line 5893-5899)

Add the project to the parts array when the plan has a project assigned:

```typescript
const parts = [`planId:${plan.planId}`];
if (plan.isEpic) { parts.push('epic'); }
if (plan.epicId) {
    const epicTopic = epicTopicById.get(plan.epicId);
    parts.push(epicTopic ? `subtask-of:"${epicTopic}"` : `subtask-of:${plan.epicId}`);
}
// NEW: emit project tag so the Suggest Epics skill can filter by project
if (plan.project) {
    parts.push(`project:"${plan.project}"`);
}
colMd += `- [${plan.planFile}](${filePath}) — ${plan.topic} <!-- ${parts.join(' ')} -->\n`;
```

Plans with no project emit no `project:` tag — they are unassigned by default.

### 2. Update the `group-into-epics` skill to filter by project

**File:** `.agents/skills/group-into-epics/SKILL.md` (Step 1: SCAN section)

Add a project-filter step after reading the board snapshot. The skill must determine the active project filter and skip plans that don't match.

Add after the existing "Skip lines tagged `epic`..." paragraph:

```markdown
### 1a. DETERMINE PROJECT SCOPE

If invoked from the **Suggest Epics** board button, the user's active project
filter is injected as `{{ACTIVE_PROJECT_FILTER}}`. This may be:
- A specific project name (e.g. `Remote sync`)
- `__unassigned__` (user is viewing plans with no project)
- Empty/unset (no filter active — include ALL plans)

If the filter is a specific project or `__unassigned__`, skip plans whose
`project:"..."` tag does not match. Plans with NO `project:` tag are
unassigned and match the `__unassigned__` filter.

If the filter is empty/unset, include all plans (current behavior).

Example filtering:
- Filter = `Remote sync` → only plans with `project:"Remote sync"` are candidates
- Filter = `__unassigned__` → only plans with NO `project:` tag are candidates
- Filter = empty → all plans are candidates
```

### 3. Wire the active project filter into the Suggest Epics button

**File:** `src/services/KanbanProvider.ts` or `src/webview/kanban.html` (wherever the "Suggest Epics" button copies the skill text)

The button currently copies the skill text with `{{WORKSPACE_ROOT}}` injected. It must also inject `{{ACTIVE_PROJECT_FILTER}}` with the current value of `this._projectFilter` (or the webview's `activeProjectFilter` variable).

Search for where the Suggest Epics button is wired — it likely posts a message or calls a function that builds the clipboard text. Add the project filter to that injection.

If the button is in `kanban.html`, the webview already has `activeProjectFilter` in scope. The copy handler should replace `{{ACTIVE_PROJECT_FILTER}}` with the current value (or `__unassigned__` if the filter is the unassigned sentinel, or empty string if no filter is active).

### 4. Mirror the skill change in `.claude/skills/group-into-epics/SKILL.md`

If a Claude Code mirror exists at `.claude/skills/group-into-epics/SKILL.md`, apply the same Step 1a text. (Check whether the mirror is auto-generated by `ClaudeCodeMirrorService` or hand-maintained.)

## Verification Plan

1. **Project tag appears in export:** After any DB write, check `kanban-state-created.md` — plans with a project assigned should now have `project:"<name>"` in their HTML comment. Plans without a project should have no `project:` tag.
2. **Suggest Epics with no filter:** Click Suggest Epics with no project filter active → the skill should propose groupings from ALL plans (unchanged behavior).
3. **Suggest Epics with Unassigned filter:** Set the board filter to "Unassigned" → click Suggest Epics → the skill should only propose groupings from plans with no `project:` tag. Plans assigned to "Remote sync" or "Switchboard" should NOT appear.
4. **Suggest Epics with specific project:** Set the board filter to "Remote sync" → click Suggest Epics → the skill should only see plans tagged `project:"Remote sync"`.
5. **Remote-agent consumers unaffected:** Verify the visible markdown in kanban-state files is unchanged (the tag is inside an HTML comment). A web agent reading the file for board reconstruction sees the same content.
6. **Backward compat:** Old kanban-state files without `project:` tags — the skill treats them as unassigned. No errors.

## Acceptance
- The `exportStateToFile()` function emits `project:"<name>"` in the HTML comment for plans with a project assignment.
- The `group-into-epics` skill filters candidates by the active project filter when invoked from the Suggest Epics button.
- Plans already assigned to a project do not appear in epic groupings when the user is viewing unassigned plans.
- The visible content of kanban-state files is unchanged (tag is inside HTML comment).
