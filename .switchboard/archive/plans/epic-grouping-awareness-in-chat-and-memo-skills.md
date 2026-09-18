# Add Epic-Grouping Awareness to Chat and Memo-Planning Skills

## Goal

When an agent is in consultation or memo-processing mode and produces (or is about to produce) 3 or more plan files on a related topic, it should proactively offer to group them under an epic — once early during scoping, and once at the closing gate. Currently none of the chat or memo entry points include this guidance, making epics easy to forget until the board fills up with loose plans.

**Root cause:** The `switchboard-chat` SKILL.md, its workflow mirror in `.agents/workflows/switchboard-chat.md`, the `DEFAULT_CHAT_BASE_INSTRUCTIONS` constant used by the kanban/project CHAT PROMPT buttons, the `memo` SKILL.md, and the `_buildMemoPlannerPrompt` method used by the implementation.html memo-tab buttons were all authored before the epic concept was established. None of them contain any guidance about when or how to raise epics.

## Metadata

**Complexity:** 3
**Tags:** docs, feature, cli

## User Review Required

No — all changes are text additions to skill/workflow/prompt files. No logic, no data migration, no destructive operations. The only judgment call is whether to also update the unreleased `sw-remote` plan (item 7) — that is a forward-looking amendment with no migration impact.

## Complexity Audit

### Routine
- Appending a `## Epic Grouping` section to two markdown skill/workflow files (text only).
- Appending a plain-text block to one TypeScript string constant (`DEFAULT_CHAT_BASE_INSTRUCTIONS`).
- Appending a note to two memo skill/workflow files and one TypeScript method (`_buildMemoPlannerPrompt`).
- Amending one unreleased plan file (`sw-remote-entry-skill.md`) with a forward-looking requirement.

### Complex / Risky
- **Sync surface:** 7 files must receive consistent wording. Missing any one creates drift between the SKILL.md, its `.agents/workflows/` mirror, and the TypeScript prompt constant. The `agentPromptBuilder.ts` comment at line 438 explicitly warns: "DEFAULT_CHAT_BASE_INSTRUCTIONS must be kept in sync with .agents/workflows/switchboard-chat.md."
- **The memo workflow mirror (`.agents/workflows/memo.md`) was missing from the original plan** — added below as item 4b. Without it, the chat path is synced across both files but the memo path drifts for Antigravity hosts.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — all changes are static text/markdown, no runtime state.
- **Security:** None — no secrets, no credentials, no API surface touched.
- **Side Effects:** The epic-grouping prompts are advisory ("Only create the epic if the user confirms"). No automatic epic creation. Agents that ignore the guidance simply don't offer epics — no breakage.
- **Dependencies & Conflicts:** Item 7 amends `sw-remote-entry-skill.md`, which is itself an unreleased plan (the `sw-remote` skill does not exist yet). The amendment is conditional on a remote epic format that is not yet defined — acceptable for an unreleased plan. No conflict with released features.

## Dependencies

- `sw-remote-entry-skill.md` — unreleased plan amended by item 7. No blocking dependency; the amendment can be applied independently.
- No session-based (`sess_*`) dependencies.

## Adversarial Synthesis

Key risks: (1) the original plan mirrors the chat skill across both `.claude/` and `.agents/workflows/` but forgets the memo workflow mirror (`.agents/workflows/memo.md`), creating drift for non-Claude hosts; (2) the "closing gate" trigger is fuzzy — no concrete signal for when the "final plan is drafted"; (3) "related topic" is undefined, so agents may over- or under-offer. Mitigations: add the memo workflow mirror as a 7th edit location; tighten the gate trigger to "when the user signals scoping is complete OR when 3+ related plans have been drafted"; define "related" as "sharing a common feature area or root cause."

## Proposed Changes

All changes are text additions only — no logic, no new files outside the plan destination.

---

### 1. `.claude/skills/switchboard-chat/SKILL.md`

Add a new `## Epic Grouping` section after the existing `## Process` section (which ends at line 26 — the file's last line). Append to end of file:

```markdown
## Epic Grouping

When the work described will span 3 or more plan files on a related topic (sharing a common feature area or root cause):

- **Early (during Iterate):** Flag it once: *"This looks like it will produce 3+ related plans — once they're all drafted, want me to group them under an epic?"* Do not create anything yet.
- **Closing (at Gate):** When the user signals scoping is complete OR once 3+ related plans have been drafted, offer again: *"You now have [N] plans covering [topic] — want me to create an epic to group them?"*

Only create the epic if the user confirms. Refer to existing files in `.switchboard/epics/` for the expected format.
```

---

### 2. `.agents/workflows/switchboard-chat.md`

Mirror the identical `## Epic Grouping` section (kept in sync with SKILL.md and `DEFAULT_CHAT_BASE_INSTRUCTIONS`). Add it after the `## Process` block (which ends at line 26 — the file's last line). Append to end of file.

---

### 3. `src/services/agentPromptBuilder.ts` — `DEFAULT_CHAT_BASE_INSTRUCTIONS`

The constant spans lines 441–456 (template literal). Append the epic-grouping block to the end of the constant string, after the existing `Gate` step (line 456), before the closing backtick. The text must be self-contained (no Markdown heading assumed by the constant's plain-text context). Note the sync warning at line 438: *"DEFAULT_CHAT_BASE_INSTRUCTIONS must be kept in sync with .agents/workflows/switchboard-chat.md."*

```
Epic Grouping:
When the work spans 3 or more plan files on a related topic (sharing a common feature area or root cause), flag it during scoping — "This looks like it will produce 3+ related plans — want me to group them under an epic once they're drafted?" — and offer again at the closing gate once all plans are written (or once the user signals scoping is complete). Only create the epic if the user confirms. See existing files in `.switchboard/epics/` for format.
```

---

### 4. `.claude/skills/memo/SKILL.md`

Add a note to the **Process Memo Command** section (lines 46–56). After step 4 ("Create one plan per entry," line 53), insert a new step before the current step 5 ("Report, and restore on failure"):

```
5. **Offer epic grouping.** After creating all plan files: if 3 or more of the plans cover a related topic (sharing a common feature area or root cause), offer to group them under an epic — "These [N] plans cover related work — want me to create an epic to group them together?" Only create the epic if the user confirms. See `.switchboard/epics/` for format.
```

(Renumber the current step 5 to step 6.)

---

### 4b. `.agents/workflows/memo.md` — ⚠️ missing from original plan

`.agents/workflows/memo.md` is a near-identical mirror of the memo SKILL.md (84 lines, same "Process Memo Command" section at lines 45–55). It is the file Antigravity and other non-Claude hosts read. Apply the **same** edit as item 4: after step 4 ("Create one plan per entry," line 52), insert the epic-grouping step and renumber the current step 5 to step 6. Without this, the memo path drifts for non-Claude hosts while the chat path stays synced.

---

### 5. `src/services/TaskViewerProvider.ts` — `_buildMemoPlannerPrompt`

The method spans lines 2791–2824. In the `## Important` block (lines 2820–2823) at the end of the returned prompt string, append a new bullet before the closing backtick (line 2824). The `${workspaceRoot}` interpolation works because the method receives `workspaceRoot` as a parameter (line 2791):

```
- If you created 3 or more plan files that cover a related topic (sharing a common feature area or root cause), offer to create an epic grouping them: "These [N] plans cover related work — want me to create an epic to group them together?" Only create the epic if the user confirms. See ${workspaceRoot}/.switchboard/epics/ for the format.
```

---

### 6. `.switchboard/plans/sw-remote-entry-skill.md` — amendment

The `sw-remote` skill does not exist yet. Add a requirement to the existing plan's implementation tasks list:

> The new `.claude/skills/sw-remote/SKILL.md` must include the same `## Epic Grouping` section as `switchboard-chat/SKILL.md` (adapted for remote context: replace `.switchboard/epics/` with the Linear/Notion equivalent for remote sessions, or omit the format reference if no remote epic format is defined yet).

---

## Verification Plan

> **Session directives:** Compilation and automated tests are skipped — the test suite will be run separately by the user. All verification below is manual text-presence checks (no build, no test run).

### Automated Tests
- (Skipped per session directive.) No unit tests exist for prompt/skill text content; verification is manual.

### Manual Checks
- [ ] Open `/sw` (or `/switchboard-chat`) in chat and describe a multi-area feature. Confirm the agent flags the epic option during scoping.
- [ ] Complete 3+ related plans in a session. Confirm the agent offers an epic at the Gate step (or once 3+ related plans are drafted).
- [ ] Use the CHAT PROMPT button (kanban or project view) to copy a prompt. Paste and verify the epic-grouping text is present.
- [ ] Use the memo tab's "Copy Prompt" or "Send to Planner" with 3+ related issues. Confirm the resulting agent output offers an epic after plan creation.
- [ ] Confirm `sw-remote-entry-skill.md` references the epic requirement in its task list.
- [ ] Confirm `.agents/workflows/switchboard-chat.md` matches the SKILL.md wording exactly.
- [ ] **(New)** Confirm `.agents/workflows/memo.md` (item 4b) has the epic-grouping step and matches `.claude/skills/memo/SKILL.md`.
- [ ] **(New)** Confirm `DEFAULT_CHAT_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts` (line 441+) contains the epic-grouping block and is in sync with the workflow file.

## Recommendation

**Complexity: 3 → Send to Intern.** All changes are text additions across 7 files with no logic. The only risk is sync drift — mitigated by the explicit line-number references and the new item 4b. An intern can execute this in a single pass by following the numbered items in order.

## Review Findings

**Files reviewed:** `.claude/skills/switchboard-chat/SKILL.md`, `.agents/workflows/switchboard-chat.md`, `src/services/agentPromptBuilder.ts`, `.claude/skills/memo/SKILL.md`, `.agents/workflows/memo.md`, `src/services/TaskViewerProvider.ts`, `.agents/workflows/sw-remote.md` (item 6 amendment). No code changes applied. All 7 edit locations verified correct and in sync: the Epic Grouping text matches across SKILL.md, workflow mirror, and `DEFAULT_CHAT_BASE_INSTRUCTIONS`; the memo path is synced across both `.claude/` and `.agents/` files with correct step renumbering; the `_buildMemoPlannerPrompt` bullet uses `${workspaceRoot}` interpolation correctly; the sw-remote amendment is fulfilled. **NIT:** plan line numbers are stale (441→622, 2791→2977) but edits landed by content match. **No remaining risks.**
