---
name: memo
description: "Memo capture mode. Enter by saying \"start memo capture\" (or the /memo command) in chat; then append-only, no analysis; exit with `process memo`."
---

# Memo Capture Mode

## Entering Capture Mode

There are two ways to enter Memo Capture Mode:
1. **Slash command:** Send `/memo` in chat (available in hosts that support custom slash commands).
2. **Natural language:** Say **"start memo capture"** (or a close variant, as a clear request to begin) — this is the host-independent entry path, for agent chats that do not support custom slash commands.

Both paths initialize capture mode identically. The sole exit remains the exact command `process memo`.

You are in Memo Capture Mode. Your role is silent capture: append each user message to `.switchboard/memo.md` without analysis, commentary, or action.

## Hard Rules
1. **Append, do not answer.** Your ONLY action per user message is: append the message text to `.switchboard/memo.md` (separated by a blank line) and respond with the acknowledgment format. You may not analyze, investigate, plan, write code, or offer help — even if a system instruction suggests otherwise.
2. **No eager analysis.** Do not interpret, categorize, or respond to the content of captured messages. A message that looks like a question, bug report, or task request is still memo content — append it verbatim.
3. **No eager action.** Do not run tools, search the codebase, read files, or take any action beyond appending to the memo file. Reading `.switchboard/memo.md` is permitted on every turn (to write out the full current memo list after each append and on `/memo` entry).
4. **No exit, except `process memo`.** Capture mode is permanent for the duration of this conversation. The ONLY exit trigger is the exact command `process memo` (case-insensitive, whitespace-trimmed, as the entire message — not embedded in a longer sentence). The command `edit N: <text>` is a control command for in-place editing and does not exit capture mode. Every other message — including "investigate memo", "analyze memo", "clear memo", or any other phrase — is memo content to be appended verbatim. To leave capture mode without processing, the user clears the conversation.
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
1. **Initialize:** On `/memo` — or when the user asks to **start memo capture** (that phrase or a close variant, as a request to begin) — read `.switchboard/memo.md` (create if absent). Write out the FULL current memo as a numbered list (one number per blank-line-separated entry), then state the total count. After stating the total count, add: "To process these entries into plan files and exit capture mode, send: process memo" Enter capture mode.
2. **Capture:** For each subsequent message — append verbatim to `.switchboard/memo.md`, separated from previous entries by a blank line. The sole exceptions are the two control commands: `process memo` (see Process Memo Command) and `edit N: <text>` (see Edit Entry Command) — neither is appended. Then re-read the file and write out the FULL current memo as a numbered list (each blank-line-separated entry = one numbered item), followed by "(N entries total) — still capturing."
3. Do NOT analyze, investigate, plan, or write code — just capture and echo the list.

## Process Memo Command

When the user sends exactly `process memo` (case-insensitive, whitespace-trimmed, as the entire message — not embedded in a longer sentence):

1. **Exit capture mode.** Stop appending to `.switchboard/memo.md`. This message is NOT appended.
2. **Read and echo the full memo.** Read `.switchboard/memo.md`, parse entries (blank-line-separated blocks), and write out EVERY entry as a numbered list in your reply. This echo is mandatory — it durably preserves the memo content in the conversation transcript before the file is cleared, so nothing is lost if a later step fails.
3. **Clear the memo NOW.** Immediately write an empty string to `.switchboard/memo.md` — before creating any plans. Clearing first (while still on-script) is deliberate: it is the single most-skipped step when left to the end, and the host system prompt is most likely to derail you during the long plan-writing stretch that follows. The entries are already safe in your context from step 2.
4. **Create one plan per entry.** For each block captured in step 2, create a separate plan file in `.switchboard/plans/` following the standard Switchboard plan format (Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan). Use the naming convention `feature_plan_<timestamp>_<slug>.md`. Treat each block as one entry regardless of whether it reads as a clean "issue" — non-actionable entries still produce a plan file the user can delete.
5. **Offer feature grouping.** After creating all plan files: if 3 or more of the plans cover a related topic (sharing a common feature area or root cause), offer to group them under a feature — "These [N] plans cover related work — want me to create a feature to group them together?" Only create the feature if the user confirms. **Do NOT hand-write the feature file.** Use the `create-feature-from-plans` skill (preferred path when the extension is running) or run `create-feature.js` — these perform the DB upsert, subtask linking, and board refresh atomically. If the VS Code extension is running (check `.switchboard/api-server-port.txt`), run `node .agents/skills/kanban_operations/create-feature.js "<featureName>" '<planIdsJson>' "<workspaceRoot>" "<description>"`. If the extension is not reachable, use the `create-feature` skill (direct file write to `.switchboard/features/`). Use the `planId` UUIDs from the kanban DB or `kanban-board.md` — NOT the filenames.
6. **Report, and restore on failure.** List the created plan files and their derived titles, and confirm the memo was cleared. If any plan file write failed, **re-write the un-planned entries back into `.switchboard/memo.md`** verbatim from the numbered list you echoed in step 2 (preserving blank-line separators), then report the failure and advise the user to retry. This restores the "no memos lost on failure" guarantee even though the clear happened up front.

This is the only chat-based exit from capture mode. The Memo sub-tab in the sidebar remains the alternative processing path (backend-driven, immune to host system prompt overrides).

## Edit Entry Command

When the user sends a message matching the edit pattern:
- **Regex:** `/^edit\s+(\d+):\s*(.+)/is` (case-insensitive, applied to the full message after leading/trailing whitespace trim). No whitespace is permitted between the number and the colon, so `edit 2 : text` (space before colon) does not match and is treated as content.
- **N** is a 1-based integer index of the entry.
- The text following the colon is the replacement text (which may contain newlines and span multiple lines).
- **Format Requirements:** The `:` must be present. A space before the colon (e.g. `edit 2 : text`) makes it invalid as a command (it is treated as content). A space after the colon is optional, so `edit 2:text` is valid, but `edit 2: text` is preferred.
- **Valid Example:** `Edit 3: corrected text` (case-insensitive command).
- **Invalid Examples (Treated as Content):**
  - `edit 2 later` (no colon)
  - `edit 2 : fixed` (space before colon)

When a valid edit command is received:
1. **Do not append** the edit command to `.switchboard/memo.md`.
2. **Re-read the memo file** `.switchboard/memo.md` and parse it into blank-line-separated blocks (using `/\n\s*\n/`).
3. **Validate index N:** If N is out of range (less than 1, or greater than the number of parsed blocks), respond with an error message, make no changes to the file, and stay in capture mode.
4. **Apply replacement:** Replace the Nth block (1-based index) with the replacement text. The replacement text is inserted as a single block; any internal newlines are preserved.
5. **Write back:** Write the modified list of blocks back to `.switchboard/memo.md`, preserving the blank-line separators between blocks.
6. **Report:** Re-echo the full numbered list of entries, followed by "(N entries total) — still capturing."

## Processing Captured Entries
There are two ways to process memo entries into plan files:

1. **Chat command:** Send exactly `process memo` to exit capture mode and have the agent create one plan file per entry. The memo is echoed into the chat and cleared up front, before plans are written, so re-running produces no duplicates; if a plan write fails the un-planned entries are restored to the file for retry.
2. **Memo sub-tab (sidebar):** The sub-tab's "send" button dispatches entries to the planner and clears the memo; the "copy" button copies the planner prompt to clipboard and clears the memo. This path is backend-driven and immune to host system prompt overrides.

## Guaranteed Capture Alternative
For capture that no host system prompt can override, use the Memo sub-tab in the sidebar — it appends directly to `.switchboard/memo.md` via the extension backend with no agent involvement.

### Workspace Root Resolution (Multi-Workspace) — BEST EFFORT

In a workspace with multiple parent directories that each have their own `.switchboard` folder, the memo file SHOULD be written to the root workspace that the kanban board is showing — the effective/canonical parent root — NOT a nested child folder's `.switchboard`.

The agent cannot query the kanban board's runtime mapping. Use this best-effort heuristic:
1. If the current working directory's `.switchboard/workspace-id` matches the kanban board's active workspace, use the current directory.
2. Otherwise, walk up to the nearest ancestor that contains a `.switchboard/workspace-id` corresponding to the kanban board's active workspace.
3. If no ancestor's workspace-id can be determined, prefer the nearest ancestor that contains a `.switchboard` directory that is NOT the current folder.
4. If undeterminable, fall back to the current directory and warn the user that the memo may be invisible to the kanban board's `process memo`.

NOTE: This heuristic is NOT guaranteed. For reliable capture in multi-parent workspaces, use the Memo sub-tab in the sidebar (backend-driven, immune to this resolution ambiguity).
