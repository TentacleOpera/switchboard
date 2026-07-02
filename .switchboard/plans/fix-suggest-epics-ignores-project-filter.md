# Fix: Suggest Epics Skill Ignores Project Filter — kanban-state Export Is Unfiltered + Lacks Project Tags

**Plan ID:** a984d025-d534-4a7c-90af-f87a216dce2b

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

**Architectural decision (preserved):** The fix adds the project *tag* to the export (so the data is available to any consumer) and teaches the *skill* to filter by it. The export itself is NOT narrowed to a project slice — that would break the remote-agent use case (a web agent needs the full board, not a project slice). Filtering is a skill-layer concern; the export remains a complete snapshot.

## Metadata
- **Tags:** bugfix, backend, ui
- **Complexity:** 4

## User Review Required

Yes — the skill-text filtering step (Step 2) is prose-instructed, not code-enforced. The user should confirm the three filter modes (specific project / `__unassigned__` / no filter) match their mental model of the board's project filter before the skill text ships. No database or schema migration is involved; review is purely semantic.

## Complexity Audit

### Routine
- Adding `project:` to the HTML comment in `exportStateToFile()` — one `parts.push(...)` line guarded by `if (plan.project)` (`KanbanDatabase.ts:5893-5899`). The `project` field is already populated on `KanbanPlanRecord` by `_readRows` (`KanbanDatabase.ts:6352`, `String(row.project || "")`), and `PLAN_COLUMNS` already selects it (`KanbanDatabase.ts:631`). No schema change.
- The `group-into-epics` skill gains a filtering step — documentation/prose change only.
- Wiring `projectFilter` through the webview message → provider case → prompt builder → placeholder substitution — three small edits in known locations.
- The `.claude/skills/group-into-epics/SKILL.md` mirror is **auto-generated** by `ClaudeCodeMirrorService` (`ClaudeCodeMirrorService.ts:295`) from the `.agents` source on every mirror run. Editing the source skill is sufficient; the mirror regenerates. No manual mirror edit.

### Complex / Risky
- **Placeholder leak on direct invocation.** The skill is model-invocable (`invocation: 'default'`, `ClaudeCodeMirrorService.ts:72`) — an agent may load it by description without clicking the button, in which case `{{ACTIVE_PROJECT_FILTER}}` is never substituted. The default substitution value MUST be empty string so the literal placeholder never reaches the LLM; the skill text must treat empty/unset as "include all" (current behavior).
- **Status-message count accuracy.** `candidateCards` in the `suggestEpics` case (`KanbanProvider.ts:8230-8234`) is built from `_lastCards`, which is the **full unfiltered board** (set at `KanbanProvider.ts:1355` from `getBoard`). With a project filter active, the toast count would overcount vs. what the skill actually sees. The count must be filtered by the same project scope.
- **Backward compat of the new tag.** Existing kanban-state files in user repos won't have the `project:` tag until the next DB write triggers a regeneration (`_persist` → `exportStateToFile`, `KanbanDatabase.ts:5974`). The skill must treat a missing `project:` tag as "unassigned" — which is the correct default and matches the `__unassigned__` filter semantics.

## Edge-Case & Dependency Audit

- **Race Conditions:** None material. `exportStateToFile` is single-flight (`_exportStateInFlight` guard, `KanbanDatabase.ts:5839`); adding a tag to the emitted string does not change concurrency. The `projectFilter` read in the webview is a snapshot at click time — no race with subsequent filter changes matters because the prompt is copied to clipboard immediately.
- **Security:** The `project` field is a free-text workspace-local string; emitting it inside an HTML comment in a workspace-local file introduces no exfiltration surface. Remote agents that already read these files already see plan topics and filenames.
- **Side Effects:**
  - **Plans with no project assigned:** `project` is `''` (falsy) → no `project:` tag emitted. Such plans are unassigned by definition and match the `__unassigned__` filter. Correct.
  - **Plans assigned to a project that no longer exists:** `project` is a free-text denormalized string, not an FK to `projects`. The tag reflects whatever is in the row. No issue.
  - **Remote-agent consumers of kanban-state files:** The tag is inside an HTML comment; visible markdown is unchanged. Agents parsing visible content are unaffected; agents parsing comments gain an optional field.
  - **Project names containing double quotes:** A project name with an embedded `"` would break the `project:"<name>"` quote-delimited tag and confuse LLM parsing. Mitigation: strip/escape `"` in the emitted value (cheap, one line). Low probability but free-text field.
- **Dependencies & Conflicts:**
  - No dependencies on other plans/sessions.
  - The change touches `KanbanDatabase.ts` (export logic), `KanbanProvider.ts` (case handler + prompt builder signature), `kanban.html` (button message), and `.agents/skills/group-into-epics/SKILL.md` (skill text). No overlap with other in-flight work.
  - The `.claude/skills/group-into-epics/SKILL.md` mirror is generated, not hand-maintained — do NOT edit it directly (regeneration would overwrite the edit).

## Dependencies

None. No `sess_XXXXXXXXXXXXX — <topic>` dependencies. The change is self-contained across the four files listed above.

## Adversarial Synthesis

Key risks: (1) the `{{ACTIVE_PROJECT_FILTER}}` placeholder leaking into the prompt on direct skill invocation (no button click), and (2) the status-toast candidate count overcounting when a project filter is active because `_lastCards` is the unfiltered board. Mitigations: default the placeholder substitution to empty string and treat empty as "include all" in the skill text; filter `candidateCards` by the same project scope before computing the count. The architectural choice — tag the export, filter in the skill, keep the export a complete snapshot — is correct and preserves the remote-agent consumer.

## Proposed Changes

### 1. Add `project:` tag to the kanban-state file HTML comments

**File:** `src/services/KanbanDatabase.ts` (in `exportStateToFile`, lines 5893-5899)

**Context:** The `parts` array builds the HTML comment suffix. `plan.project` is already populated (String, `''` when unassigned) by `_readRows` via `PLAN_COLUMNS`.

**Logic / Implementation:** Add the project to `parts` when the plan has a project assigned. Escape any embedded double quotes so the quote-delimited tag stays parseable.

```typescript
const parts = [`planId:${plan.planId}`];
if (plan.isEpic) { parts.push('epic'); }
if (plan.epicId) {
    const epicTopic = epicTopicById.get(plan.epicId);
    parts.push(epicTopic ? `subtask-of:"${epicTopic}"` : `subtask-of:${plan.epicId}`);
}
// NEW: emit project tag so the Suggest Epics skill can filter by project.
// Empty/missing project → no tag (unassigned by definition).
if (plan.project) {
    const safeProject = plan.project.replace(/"/g, '');
    parts.push(`project:"${safeProject}"`);
}
colMd += `- [${plan.planFile}](${filePath}) — ${plan.topic} <!-- ${parts.join(' ')} -->\n`;
```

**Edge Cases:** Empty `project` → no tag (unassigned). Project name with `"` → stripped. Project name with no match in `projects` table → emitted verbatim (free-text field).

### 2. Update the `group-into-epics` skill to filter by project

**File:** `.agents/skills/group-into-epics/SKILL.md` (after the "Skip lines tagged `epic`..." paragraph in the SCAN section, ~line 36)

**Context:** The skill is consumed two ways: (a) pasted from the Suggest Epics button with `{{WORKSPACE_ROOT}}` and `{{ACTIVE_PROJECT_FILTER}}` substituted, and (b) loaded directly by an agent via description (model-invocable), where placeholders are NOT substituted. The filtering step must degrade gracefully when the filter placeholder is absent/empty.

**Logic / Implementation:** Add a Step 1a between SCAN and READ PLAN BODIES:

```markdown
### 1a. DETERMINE PROJECT SCOPE

The active project filter is injected as `{{ACTIVE_PROJECT_FILTER}}` when
invoked from the **Suggest Epics** board button. This may be:
- A specific project name (e.g. `Remote sync`)
- `__unassigned__` (user is viewing plans with no project)
- Empty / unset / the literal placeholder token (no filter active, OR the
  skill was loaded directly without the button — include ALL plans)

If the filter is a specific project, skip plans whose `project:"..."` tag
does not match. If the filter is `__unassigned__`, skip plans that HAVE a
`project:"..."` tag (only untagged plans are candidates). If the filter is
empty/unset/the literal placeholder, include all plans (current behavior).

Plans with NO `project:` tag are unassigned and match the `__unassigned__`
filter; they are excluded from a specific-project filter.

Example filtering:
- Filter = `Remote sync` → only plans with `project:"Remote sync"` are candidates
- Filter = `__unassigned__` → only plans with NO `project:` tag are candidates
- Filter = empty / `{{ACTIVE_PROJECT_FILTER}}` → all plans are candidates
```

**Edge Cases:** Old kanban-state files without `project:` tags → all plans treated as unassigned (matches `__unassigned__` filter; excluded from specific-project filter). Literal `{{ACTIVE_PROJECT_FILTER}}` token (direct invocation) → treated as "no filter" → include all.

### 3. Wire the active project filter through the button → provider → prompt

**File:** `src/webview/kanban.html` (button handler, lines 3868-3870)

**Context:** The webview already tracks `activeProjectFilter` (line 3830: `null`; set to `'__unassigned__'` or a project name at lines 6958/6974). The button currently posts only `workspaceRoot`.

**Implementation:** Add `projectFilter` to the message:

```javascript
document.getElementById('btn-suggest-epics')?.addEventListener('click', () => {
    postKanbanMessage({ type: 'suggestEpics', workspaceRoot: getActiveWorkspaceRoot(), projectFilter: activeProjectFilter ?? null });
});
```

**File:** `src/services/KanbanProvider.ts` (`suggestEpics` case, lines 8224-8242)

**Context:** `candidateCards` (8230-8234) is filtered by column only, from the full unfiltered `_lastCards`. The toast count must reflect the project scope so it matches what the skill will actually see.

**Implementation:** Read `msg.projectFilter`, filter `candidateCards` by project, and pass the filter to the prompt builder. `KanbanCard` has `project?: string` (line 109). The unassigned sentinel is `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`'__unassigned__'`, `KanbanDatabase.ts:678`); the webview uses the same `'__unassigned__'` literal (lines 6958/6974).

```typescript
case 'suggestEpics': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) break;
    const projectFilter = (msg.projectFilter === undefined ? null : msg.projectFilter) as string | null;
    const preCodingColumns = ['CREATED', 'PLAN REVIEWED'];
    const candidateCards = this._lastCards.filter(card =>
        card.workspaceRoot === workspaceRoot &&
        preCodingColumns.includes(card.column) &&
        !card.isEpic && !card.epicId &&
        this._cardMatchesProjectFilter(card, projectFilter)
    );
    if (candidateCards.length === 0) {
        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: 'No loose active pre-coding cards to group into epics (in the current project scope).', isError: true });
        break;
    }
    const prompt = this._buildSuggestEpicsPrompt(workspaceRoot, projectFilter);
    await vscode.env.clipboard.writeText(prompt);
    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Suggest-epics prompt copied (${candidateCards.length} pre-coding card(s) in scope). Paste into chat.`, isError: false });
    break;
}
```

Add a small helper `_cardMatchesProjectFilter` (near the other card-filter helpers in `KanbanProvider.ts`):

```typescript
private _cardMatchesProjectFilter(card: KanbanCard, projectFilter: string | null): boolean {
    if (projectFilter === null || projectFilter === '') return true; // no filter → all
    const cardProject = card.project || '';
    if (projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        return cardProject === ''; // unassigned only
    }
    return cardProject === projectFilter; // specific project
}
```

**File:** `src/services/KanbanProvider.ts` (`_buildSuggestEpicsPrompt`, lines 9414-9451)

**Context:** The method takes only `workspaceRoot` and substitutes only `{{WORKSPACE_ROOT}}` (line 9450). It must also substitute `{{ACTIVE_PROJECT_FILTER}}`, defaulting to empty string so direct callers and the embedded fallback never leak the literal placeholder.

**Implementation:** Change the signature and add the substitution:

```typescript
private _buildSuggestEpicsPrompt(workspaceRoot: string, projectFilter: string | null = null): string {
    // ... existing skill-file read + fallback chain unchanged ...
    const bodyWithoutFrontmatter = skillBody.replace(/^---\n[\s\S]*?\n---\n/, '');
    const activeProject = projectFilter ?? ''; // null/empty → skill treats as "include all"
    return bodyWithoutFrontmatter
        .replace(/\{\{WORKSPACE_ROOT\}\}/g, workspaceRoot)
        .replace(/\{\{ACTIVE_PROJECT_FILTER\}\}/g, activeProject);
}
```

**Edge Cases:** `projectFilter === null` (no filter / direct invocation) → empty string substituted → skill includes all. `projectFilter === '__unassigned__'` → sentinel passed through → skill filters to untagged plans. The embedded fallback string (lines 9424-9444) does not contain `{{ACTIVE_PROJECT_FILTER}}`, so the replacement is a no-op there — safe.

### 4. Mirror regeneration (no manual edit)

**File:** `.claude/skills/group-into-epics/SKILL.md` — DO NOT edit by hand.

**Context:** `ClaudeCodeMirrorService` (`ClaudeCodeMirrorService.ts:295`) regenerates this file from `.agents/skills/group-into-epics/SKILL.md` on every mirror run (entry at `ClaudeCodeMirrorService.ts:72`). A manual edit would be silently overwritten.

**Implementation:** No action beyond Step 2. After the source skill is edited, the next mirror run (triggered on extension activation / setup) propagates the change. If immediate verification is needed, run the mirror setup command or reload the window.

## Verification Plan

### Automated Tests

No automated tests are added for this change. The change is a one-line tag emission + prose skill text + three small wiring edits; the existing test suite does not exercise `_buildSuggestEpicsPrompt` output content or `exportStateToFile` comment format (verified — no matches in `src/test/`). Per session directive, automated tests are out of scope and will be run separately by the user. Verification below is manual.

### Manual Verification

1. **Project tag appears in export:** After any DB write (move a card), check `.switchboard/kanban-state-created.md` — plans with a project assigned should now have `project:"<name>"` in their HTML comment. Plans without a project should have no `project:` tag.
2. **Suggest Epics with no filter:** Click Suggest Epics with no project filter active → the skill should propose groupings from ALL plans (unchanged behavior). Toast count should equal the total pre-coding card count.
3. **Suggest Epics with Unassigned filter:** Set the board filter to "Unassigned" → click Suggest Epics → the skill should only propose groupings from plans with no `project:` tag. Plans assigned to "Remote sync" or "Switchboard" should NOT appear. Toast count should equal the unassigned pre-coding card count only.
4. **Suggest Epics with specific project:** Set the board filter to "Remote sync" → click Suggest Epics → the skill should only see plans tagged `project:"Remote sync"`. Toast count should equal that project's pre-coding card count.
5. **Remote-agent consumers unaffected:** Verify the visible markdown in kanban-state files is unchanged (the tag is inside an HTML comment). A web agent reading the file for board reconstruction sees the same content.
6. **Backward compat:** Old kanban-state files without `project:` tags — the skill treats them as unassigned. No errors.
7. **Direct invocation (no button):** Load the `group-into-epics` skill by description without clicking the button → the prompt should NOT contain a literal `{{ACTIVE_PROJECT_FILTER}}` token (it is absent from the source body when not templated; if templated by a host that doesn't substitute, the skill text's "empty / literal placeholder → include all" rule covers it).
8. **Project name with double quote:** If a project named `Acme "Pro"` exists, the emitted tag should be `project:"Acme Pro"` (quotes stripped), not a malformed comment.
9. **Mirror regenerated:** After reload, `.claude/skills/group-into-epics/SKILL.md` should contain the new Step 1a text without manual editing.

## Acceptance
- The `exportStateToFile()` function emits `project:"<name>"` in the HTML comment for plans with a project assignment (quotes stripped from the name).
- The `group-into-epics` skill filters candidates by the active project filter when invoked from the Suggest Epics button, and degrades to "include all" when the filter is empty/unset/the literal placeholder.
- Plans already assigned to a project do not appear in epic groupings when the user is viewing unassigned plans.
- The Suggest Epics toast count reflects only the in-scope (project-filtered) pre-coding cards.
- The visible content of kanban-state files is unchanged (tag is inside HTML comment).
- The `.claude` mirror regenerates from the `.agents` source automatically; no manual mirror edit.

## Recommendation

Complexity 4 → **Send to Coder**. Localized multi-file wiring with no new patterns, no schema change, and an existing sentinel (`__unassigned__`) reused. The one moderate risk (placeholder leak on direct invocation) is handled by defaulting the substitution to empty string.

## Review Findings

Implementation matches the plan across all four files (`KanbanDatabase.ts`, `KanbanProvider.ts`, `kanban.html`, `.agents/skills/group-into-epics/SKILL.md`). One NIT fixed: `_cardMatchesProjectFilter` used the literal `'__unassigned__'` instead of `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` — corrected to use the constant for consistency with the 11 other usages in `KanbanProvider.ts`. The `.claude` mirror is a runtime artifact (never committed; regenerated on extension activation) and correctly was not hand-edited. No CRITICAL or MAJOR findings. Remaining risk: the project-filter toast count depends on `_lastCards` being fresh at click time — if the board hasn't refreshed after a project assignment, the count could be stale, but this is a pre-existing UI timing concern not introduced by this change.
