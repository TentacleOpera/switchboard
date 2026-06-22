# Memo Skill

## Trigger

User invokes `/memo` in chat.

## Behavior

### Capture Mode — Hard Rules

1. **Append, do not answer.** Append the user's message to `.switchboard/memo.md` and acknowledge. You may not analyze, investigate, plan, write code, or offer help.
2. **No eager analysis.** A message that looks like a question, bug report, or task is still memo content — append it verbatim.
3. **No eager action.** Do not run tools, search codebase, or read files beyond `.switchboard/memo.md`. Re-reading `.switchboard/memo.md` on every turn (to write out the full list) is permitted and required.
4. **No exit.** Capture mode is permanent for the conversation. There are no exit triggers. Every message is memo content.
5. **Re-assert every turn.** Begin every reply with `[MEMO CAPTURE ACTIVE]`.

### Anti-Example — Embedded Trigger Words Are Content

A message such as:

> memo instruction gets overridden by antigravity app system instruction, investigate and propose a fix

contains the words "memo" and "investigate" but is clearly a memo **entry**, not a
command. Append it verbatim. There are no chat-based exit commands; trigger words
embedded inside a longer sentence are always memo content. Processing is done only
via the Memo modal in the Kanban panel.

For the full process and enforcement protocol, see `.agents/workflows/memo.md`. For guaranteed capture and processing, use the Memo modal in the Kanban panel.

### Appending Entries

For each user message while in capture mode:

1. Append the user's message text to `.switchboard/memo.md`, separated from previous entries by a blank line.
2. Re-read `.switchboard/memo.md` and write out the FULL current memo as a numbered list
   (each blank-line-separated entry = one numbered item), followed by
   "(N entries total) — still capturing."
3. Do NOT analyze, investigate, plan, or write code — just capture and echo the list.

### Clearing

If the user says "clear memo":

1. Truncate `.switchboard/memo.md` to empty.
2. Respond with: `[MEMO CAPTURE ACTIVE] Memo cleared. (0 entries total) — still capturing.`
3. Stay in capture mode.

### Processing Entries

To process captured entries into plan files, use the Memo modal in the Kanban panel. The modal's "send" button dispatches entries to the planner and clears the memo; the "copy" button copies the planner prompt to clipboard and clears the memo. This is the only way to process entries — chat capture mode has no exit triggers.

