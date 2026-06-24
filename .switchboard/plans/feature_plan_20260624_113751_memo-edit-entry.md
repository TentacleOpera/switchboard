# Memo Workflow: Allow Editing an Existing Entry (Not Just Appending)

## Goal

The `/memo` capture workflow currently only supports **append** — every user message is added as a new entry. When a user wants to correct or refine a previously captured entry, the correction is recorded as a *new* entry, leading to duplicate/contradictory entries that then each become their own plan on `process memo`. Add the ability to **edit an existing entry** in place, so corrections replace the original entry rather than spawning a new one.

### Problem Analysis

The memo workflow (`/memo`) is append-only by design (silent capture, no analysis). This is good for capture fidelity but bad for correction: a user who mistypes or wants to refine an entry has no way to do so except by sending a new message, which becomes a separate entry. At processing time (`process memo`), each entry becomes a plan file, so a correction + its original both produce plans — one of which is wrong/stale. The workflow needs a lightweight edit command that the agent can recognise and apply to the memo file in place.

**Root cause:** The memo workflow (`memo.md`, Hard Rule #4) defines exactly one control command (`process memo`) and treats every other message as append-only content. There is no mechanism to mutate an existing entry. The backend (`_parseMemoEntries` in `TaskViewerProvider.ts` line 2537) parses entries via blank-line paragraph split (`/\n\s*\n/`), so any in-place text replacement that preserves blank-line separators will remain compatible with backend processing — no backend change is needed for the chat workflow.

## Metadata

**Tags:** ux, feature, docs
**Complexity:** 3

## User Review Required

Yes — the exact edit-command syntax (`edit N: <text>`) and its regex matching rules should be reviewed by the user before implementation, since it defines a new user-facing interaction pattern. The user should confirm:
- The `edit N:` prefix format is intuitive.
- Multi-line replacement text (messages containing newlines after `edit N: `) should be accepted as a single replacement block.
- No `delete N` or `show N` commands are needed in this iteration (out of scope; the post-edit re-echo serves as confirmation).

## Complexity Audit

### Routine
- Define an edit command syntax: `edit N: <new text>` where N is the 1-based entry number.
- Update the memo workflow (`memo.md`) to recognise the edit command, replace the Nth entry in `.switchboard/memo.md`, and re-echo the full list.
- Ensure the edit command is NOT treated as a new entry (it is a control command, like `process memo`).
- Update `AGENTS.md` Memo Capture Mode section (line 100) to mention the edit command alongside `process memo`.

### Complex / Risky
- **Entry numbering stability:** Entries are blank-line-separated blocks. Editing must replace the correct block by index, preserving the blank-line separators. The agent must re-read `.switchboard/memo.md` before editing to ensure the index aligns with the last-echoed numbered list.
- **Distinguishing edit commands from content:** Like `process memo`, the edit command must be an exact-pattern match so that a message *about* editing ("I wish I could edit entry 2") is not misinterpreted as an edit. The regex must be precise (see Proposed Changes for exact specification).
- **Multi-line replacement text:** If the user's message contains newlines after `edit N: `, the full multi-line text is the replacement. Internal blank lines within the replacement are preserved; the entry remains one block because the paragraph splitter (`/\n\s*\n/`) separates *between* blocks, not within a replacement that is written as a single block.
- **Memo sub-tab parity:** The Memo sub-tab in the sidebar is backend-driven; if it should also support editing, that is a separate backend change. This plan focuses on the chat workflow only.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The memo workflow is single-conversation, agent-driven. Only one agent writes to `.switchboard/memo.md` at a time. The agent re-reads before every edit (Hard Rule #3 permits reading on every turn).
- **Security:** No new attack surface. The edit command operates on a local file with user-supplied text. No injection risk — the text is written verbatim as a markdown block, same as append.
- **Side Effects:** Editing replaces the original entry text permanently. There is no undo — but the user can re-edit the same entry. The memo file is not cleared by editing (consistent with existing append behaviour). The total entry count does not change after an edit.
- **Dependencies & Conflicts:**
  - `memo.md` and `AGENTS.md` both describe the memo protocol and must be updated in lockstep.
  - The backend `_parseMemoEntries` (`TaskViewerProvider.ts` line 2537) uses the same `/\n\s*\n/` paragraph split — chat-edited entries remain compatible with backend processing. No backend change required.
  - **Out-of-range N:** Editing entry N where N > count or N < 1 → error message, no change to file, stay in capture mode.
  - **Malformed edit command:** No colon, non-numeric N, or missing space after colon → treat as content (append verbatim). See exact regex in Proposed Changes.
  - **`process memo` after edits:** Edits are applied to the file immediately, so `process memo` sees the corrected entries. No duplicate plans.
  - **Memo file not yet created (0 entries):** `edit 1: text` → out-of-range error, no file change, stay in capture mode.

## Dependencies

None — this plan is self-contained. No other plan or session must complete first.

## Adversarial Synthesis

Key risks: (1) regex misclassification — an imprecise `edit N:` pattern could silently treat real edits as content or vice versa; (2) entry-index drift — if the agent doesn't re-read before editing, it may replace the wrong block. Mitigations: specify an exact regex with mandatory `: ` separator and flexible leading-whitespace trimming; require re-read of `.switchboard/memo.md` before every edit; post-edit re-echo serves as user confirmation. The change is workflow-documentation-only (no code), and the backend parser is already compatible with the blank-line block format.

## Proposed Changes

### .agents/workflows/memo.md — add edit command
- **Context:** The workflow defines Hard Rules for append-only capture (lines 9-17) and a single exit command (`process memo`, lines 37-46). Hard Rule #4 (line 13) states the only exit trigger is `process memo`.
- **Logic:** Add a second control command: `edit N: <new text>`. The exact recognition rule:
  - **Regex:** `/^edit\s+(\d+)\s*:\s+(.+)/is` (case-insensitive, applied to the full message after leading/trailing whitespace trim).
  - **N** is a 1-based integer. The capture group after `: ` is the replacement text (may contain newlines — `.` with `s` flag matches across lines).
  - **Mandatory:** The `:` must be present and followed by at least one space (or the text immediately). `edit 2:text` (no space) is still valid — `\s*` after colon allows zero spaces. `edit 2 :text` (space before colon) is **invalid** → treated as content.
  - When received: (1) re-read `.switchboard/memo.md`, (2) parse into blank-line-separated blocks (same `/\n\s*\n/` split as backend), (3) if N is out of range [1, count] → respond with error, no file change, stay in capture mode, (4) replace the Nth block with the replacement text, (5) write the file back preserving blank-line separators between blocks, (6) re-echo the full numbered list.
  - Do NOT append the edit command itself as an entry.
- **Implementation:**
  - Add a new section "## Edit Entry Command" after the "## Process Memo Command" section (after line 46), parallel in structure.
  - Update Hard Rule #4 (line 13) to note that `edit N: <text>` is the second control command (not content, not an exit). The edit command does NOT exit capture mode.
  - Add an anti-example: `edit 2 later` (no colon) is content, not an edit command. `edit 2 : fixed` (space before colon) is content, not an edit command. `Edit 3: corrected` (capital E) IS a valid edit command (case-insensitive).
  - Add a note: "The replacement text may span multiple lines. It is inserted as a single block. Internal blank lines are preserved."
- **Edge Cases:** Out-of-range N → error, no file change, stay in capture mode. Malformed (no colon, non-numeric N, space before colon) → treat as content and append verbatim. Zero entries → any `edit N:` is out of range.

### AGENTS.md — memo protocol section
- **Context:** AGENTS.md line 100 contains the "Memo Capture Mode — Priority Rule" paragraph, which describes the append-only behaviour and the `process memo` exit. Line 21 in the Workflow Registry table describes `/memo`.
- **Logic:** Add a note that the edit command `edit N: <text>` is supported for in-place correction of entry N, and that it does not exit capture mode.
- **Implementation:**
  - In the Workflow Registry table (line 21), update the description: `Memo capture mode — append-only, no analysis. Exit with 'process memo'. Edit entries with 'edit N: <text>'.`
  - In the Priority Rule paragraph (line 100), insert a sentence after the sentence ending with "clears the memo file on success.": "An in-place edit command `edit N: <text>` (where N is the 1-based entry number) replaces entry N without appending a new entry; it does not exit capture mode."
  - Do not restructure the paragraph — insert the single sentence in place.

## Verification Plan

### Automated Tests

Not applicable — this plan modifies workflow documentation files (`.agents/workflows/memo.md` and `AGENTS.md`), not source code. No unit, integration, or e2e tests apply. Verification is manual, following the checklist below.

### Manual Verification

- [ ] Capture 3 entries, then `edit 2: corrected text` → entry 2 is replaced, entries 1 and 3 unchanged, list re-echoed with 3 entries.
- [ ] `edit 5: …` with only 3 entries → error, file unchanged, still 3 entries, still in capture mode.
- [ ] `edit 2 later` (no colon) → treated as content, appended as entry 4.
- [ ] `edit 2 : fixed` (space before colon) → treated as content, appended as new entry.
- [ ] `Edit 3: corrected` (capital E) → valid edit, entry 3 replaced (case-insensitive).
- [ ] `edit 2: line one\nline two` (multi-line replacement) → entry 2 replaced with multi-line block; `process memo` produces one plan for it, not two.
- [ ] After an edit, `process memo` → produces plans from the corrected entries (no stale duplicate).
- [ ] `process memo` still exits capture mode normally.
- [ ] AGENTS.md Workflow Registry table (line 21) and Priority Rule paragraph (line 100) both mention the edit command.
