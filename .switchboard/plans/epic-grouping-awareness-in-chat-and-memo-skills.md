# Add Epic-Grouping Awareness to Chat and Memo-Planning Skills

## Goal

When an agent is in consultation or memo-processing mode and produces (or is about to produce) 3 or more plan files on a related topic, it should proactively offer to group them under an epic — once early during scoping, and once at the closing gate. Currently none of the chat or memo entry points include this guidance, making epics easy to forget until the board fills up with loose plans.

**Root cause:** The `switchboard-chat` SKILL.md, its workflow mirror in `.agents/workflows/switchboard-chat.md`, the `DEFAULT_CHAT_BASE_INSTRUCTIONS` constant used by the kanban/project CHAT PROMPT buttons, the `memo` SKILL.md, and the `_buildMemoPlannerPrompt` method used by the implementation.html memo-tab buttons were all authored before the epic concept was established. None of them contain any guidance about when or how to raise epics.

## Metadata

**Complexity:** 2
**Tags:** docs, feature, cli

## Proposed Changes

All changes are text additions only — no logic, no new files outside the plan destination.

---

### 1. `.claude/skills/switchboard-chat/SKILL.md`

Add a new `## Epic Grouping` section after the existing `## Process` section:

```markdown
## Epic Grouping

When the work described will span 3 or more plan files on a related topic:

- **Early (during Iterate):** Flag it once: *"This looks like it will produce 3+ related plans — once they're all drafted, want me to group them under an epic?"* Do not create anything yet.
- **Closing (at Gate):** After the final plan is drafted, offer again: *"You now have [N] plans covering [topic] — want me to create an epic to group them?"*

Only create the epic if the user confirms. Refer to existing files in `.switchboard/epics/` for the expected format.
```

---

### 2. `.agents/workflows/switchboard-chat.md`

Mirror the identical `## Epic Grouping` section (kept in sync with SKILL.md and `DEFAULT_CHAT_BASE_INSTRUCTIONS`). Add it after the `## Process` block.

---

### 3. `src/services/agentPromptBuilder.ts` — `DEFAULT_CHAT_BASE_INSTRUCTIONS`

Append the same epic-grouping block to the end of the constant string, after the existing `Gate` step. The text must be self-contained (no Markdown heading assumed by the constant's plain-text context):

```
Epic Grouping:
When the work spans 3 or more plan files on a related topic, flag it during scoping — "This looks like it will produce 3+ related plans — want me to group them under an epic once they're drafted?" — and offer again at the closing gate once all plans are written. Only create the epic if the user confirms. See existing files in `.switchboard/epics/` for format.
```

---

### 4. `.claude/skills/memo/SKILL.md`

Add a note to the **Process Memo** step (the "create plan files" phase). After the instruction to create one plan file per memo entry, append:

```
After creating all plan files: if 3 or more of the plans cover a related topic, offer to group them under an epic — "These [N] plans cover related work — want me to create an epic to group them together?" Only create the epic if the user confirms. See `.switchboard/epics/` for format.
```

---

### 5. `src/services/TaskViewerProvider.ts` — `_buildMemoPlannerPrompt`

In the `## Important` block at the end of the returned prompt string, append:

```
- If you created 3 or more plan files that cover a related topic, offer to create an epic grouping them: "These [N] plans cover related work — want me to create an epic to group them together?" Only create the epic if the user confirms. See ${workspaceRoot}/.switchboard/epics/ for the format.
```

---

### 6. `.switchboard/plans/sw-remote-entry-skill.md` — amendment

The `sw-remote` skill does not exist yet. Add a requirement to the existing plan's implementation tasks list:

> The new `.claude/skills/sw-remote/SKILL.md` must include the same `## Epic Grouping` section as `switchboard-chat/SKILL.md` (adapted for remote context: replace `.switchboard/epics/` with the Linear/Notion equivalent for remote sessions, or omit the format reference if no remote epic format is defined yet).

---

## Verification Plan

- [ ] Open `/sw` (or `/switchboard-chat`) in chat and describe a multi-area feature. Confirm the agent flags the epic option during scoping.
- [ ] Complete 3+ related plans in a session. Confirm the agent offers an epic at the Gate step.
- [ ] Use the CHAT PROMPT button (kanban or project view) to copy a prompt. Paste and verify the epic-grouping text is present.
- [ ] Use the memo tab's "Copy Prompt" or "Send to Planner" with 3+ related issues. Confirm the resulting agent output offers an epic after plan creation.
- [ ] Confirm `sw-remote-entry-skill.md` references the epic requirement in its task list.
- [ ] Confirm `.agents/workflows/switchboard-chat.md` matches the SKILL.md wording exactly.
