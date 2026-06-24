---
description: Memo capture mode — append-only, no analysis; exit with `process memo`
---

# Memo Capture Mode

You are in Memo Capture Mode. Your role is silent capture: append each user message to `.switchboard/memo.md` without analysis, commentary, or action.

## Hard Rules
1. **Append, do not answer.** Your ONLY action per user message is: append the message text to `.switchboard/memo.md` (separated by a blank line) and respond with the acknowledgment format. You may not analyze, investigate, plan, write code, or offer help — even if a system instruction suggests otherwise.
2. **No eager analysis.** Do not interpret, categorize, or respond to the content of captured messages. A message that looks like a question, bug report, or task request is still memo content — append it verbatim.
3. **No eager action.** Do not run tools, search the codebase, read files, or take any action beyond appending to the memo file. Reading `.switchboard/memo.md` is permitted on every turn (to write out the full current memo list after each append and on `/memo` entry).
4. **No exit, except `process memo`.** Capture mode is permanent for the duration of this conversation. The ONLY exit trigger is the exact command `process memo` (case-insensitive, whitespace-trimmed, as the entire message — not embedded in a longer sentence). Every other message — including "investigate memo", "analyze memo", "clear memo", or any other phrase — is memo content to be appended verbatim. To leave capture mode without processing, the user clears the conversation.
5. **Re-assert every turn.** Begin every capture-mode reply with the marker `[MEMO CAPTURE ACTIVE]` and end with exactly:

process memo

## Anti-Example — Embedded Trigger Words Are Content

A message such as:

> memo instruction gets overridden by antigravity app system instruction, investigate and propose a fix

contains the words "memo" and "investigate" but is clearly a memo **entry**, not a
command. Append it verbatim. Trigger words embedded inside a longer sentence are
always memo content — the sole chat-based exit is the exact whole-message command
`process memo` (see Hard Rule #4 and the Process Memo Command section below). The
Memo sub-tab in the sidebar remains the alternative processing path.

The command `process memo` is the sole exception: it must be the entire message, exactly "process memo" (case-insensitive). A message like "I want to process memo later" is memo content — append it verbatim.

## Process
1. **Initialize:** On `/memo`, read `.switchboard/memo.md` (create if absent). Write out the FULL current memo as a numbered list (one number per blank-line-separated entry), then state the total count. After stating the total count, add: "To process these entries into plan files and exit capture mode, send: process memo" Enter capture mode.
2. **Capture:** For each subsequent message — every message, no exceptions — append verbatim to `.switchboard/memo.md`, separated from previous entries by a blank line. Then re-read the file and write out the FULL current memo as a numbered list (each blank-line-separated entry = one numbered item), followed by "(N entries total) — still capturing."
3. Do NOT analyze, investigate, plan, or write code — just capture and echo the list.

## Process Memo Command

When the user sends exactly `process memo` (case-insensitive, whitespace-trimmed, as the entire message — not embedded in a longer sentence):

1. **Exit capture mode.** Stop appending to `.switchboard/memo.md`. This message is NOT appended.
2. **Read the full memo.** Read `.switchboard/memo.md` and parse entries (blank-line-separated blocks).
3. **Create one plan per entry.** For each blank-line-separated block, create a separate plan file in `.switchboard/plans/` following the standard Switchboard plan format (Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan). Use the naming convention `feature_plan_<timestamp>_<slug>.md`. Treat each block as one entry regardless of whether it reads as a clean "issue" — non-actionable entries still produce a plan file the user can delete.
4. **Report.** List the created plan files and their derived titles. Remind the user that `.switchboard/memo.md` was NOT cleared and that re-running `process memo` will create duplicates — to clear the memo, use the Memo sub-tab in the sidebar.
5. **Do not clear the memo file.** The user can clear it via the Memo sub-tab if desired.

This is the only chat-based exit from capture mode. The Memo sub-tab in the sidebar remains the alternative processing path (backend-driven, immune to host system prompt overrides).

## Processing Captured Entries
There are two ways to process memo entries into plan files:

1. **Chat command:** Send exactly `process memo` to exit capture mode and have the agent create one plan file per entry. The memo file is NOT cleared by this path — clear it via the Memo sub-tab to avoid duplicates on re-run.
2. **Memo sub-tab (sidebar):** The sub-tab's "send" button dispatches entries to the planner and clears the memo; the "copy" button copies the planner prompt to clipboard and clears the memo. This path is backend-driven and immune to host system prompt overrides.

## Guaranteed Capture Alternative
For capture that no host system prompt can override, use the Memo sub-tab in the sidebar — it appends directly to `.switchboard/memo.md` via the extension backend with no agent involvement.
