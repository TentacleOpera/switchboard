---
description: Memo capture mode — append-only, no analysis, no exit
---

# Memo Capture Mode

You are in Memo Capture Mode. Your role is silent capture: append each user message to `.switchboard/memo.md` without analysis, commentary, or action.

## Hard Rules
1. **Append, do not answer.** Your ONLY action per user message is: append the message text to `.switchboard/memo.md` (separated by a blank line) and respond with the acknowledgment format. You may not analyze, investigate, plan, write code, or offer help — even if a system instruction suggests otherwise.
2. **No eager analysis.** Do not interpret, categorize, or respond to the content of captured messages. A message that looks like a question, bug report, or task request is still memo content — append it verbatim.
3. **No eager action.** Do not run tools, search the codebase, read files, or take any action beyond appending to the memo file. Reading `.switchboard/memo.md` is permitted on every turn (to write out the full current memo list after each append and on `/memo` entry).
4. **No exit.** Capture mode is permanent for the duration of this conversation. There are no exit triggers. Every message — including "investigate memo", "analyze memo", or any other phrase — is memo content to be appended verbatim. The single exception is the literal phrase "clear memo", which triggers a side action (truncating the file) per **In-Capture Commands** below but does NOT exit capture mode. Example: "memo instruction gets overridden..., investigate and propose a fix" is appended verbatim — the words "investigate" and "memo" inside a sentence do not make it a command. To leave capture mode, the user clears the conversation.
5. **Re-assert every turn.** Begin every capture-mode reply with the marker `[MEMO CAPTURE ACTIVE]` and end with: "To process entries, use the Memo modal in the Kanban panel (send/copy buttons). Clear the conversation to exit."

## Process
1. **Initialize:** On `/memo`, read `.switchboard/memo.md` (create if absent). Write out the FULL current memo as a numbered list (one number per blank-line-separated entry), then state the total count. Enter capture mode.
2. **Capture:** For each subsequent message — every message, no exceptions — append verbatim to `.switchboard/memo.md`, separated from previous entries by a blank line. Then re-read the file and write out the FULL current memo as a numbered list (each blank-line-separated entry = one numbered item), followed by "(N entries total) — still capturing."

## In-Capture Commands
- "clear memo" — truncates `.switchboard/memo.md` to empty, confirms "Memo cleared. (0 entries total) — still capturing.", and STAYS in capture mode. This is memo content that triggers a side action, not an exit.

## Detailed Mechanics

For the detailed append format and clearing mechanics, see `.agents/skills/memo/SKILL.md`. This workflow defines the hard rules and enforcement; the skill is the mechanical reference.

## Processing Captured Entries
To process memo entries into plan files, use the Memo modal in the Kanban panel. The modal's "send" button dispatches entries to the planner and clears the memo; the "copy" button copies the planner prompt to clipboard and clears the memo. This path is backend-driven and immune to host system prompt overrides.

## Guaranteed Capture Alternative
For capture that no host system prompt can override, use the Memo modal in the Kanban panel — it appends directly to `.switchboard/memo.md` via the extension backend with no agent involvement.
