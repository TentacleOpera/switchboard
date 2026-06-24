# Memo Workflow: Allow Editing an Existing Entry (Not Just Appending)

## Goal

The `/memo` capture workflow currently only supports **append** — every user message is added as a new entry. When a user wants to correct or refine a previously captured entry, the correction is recorded as a *new* entry, leading to duplicate/contradictory entries that then each become their own plan on `process memo`. Add the ability to **edit an existing entry** in place, so corrections replace the original entry rather than spawning a new one.

### Problem Analysis

The memo workflow (`/memo`) is append-only by design (silent capture, no analysis). This is good for capture fidelity but bad for correction: a user who mistypes or wants to refine an entry has no way to do so except by sending a new message, which becomes a separate entry. At processing time (`process memo`), each entry becomes a plan file, so a correction + its original both produce plans — one of which is wrong/stale. The workflow needs a lightweight edit command that the agent can recognise and apply to the memo file in place.

## Metadata

**Complexity:** 3
**Tags:** workflow, memo, ux, feature

## Complexity Audit

### Routine
- Define an edit command syntax (e.g. `edit N: <new text>` where N is the entry number).
- Update the memo workflow (`memo.md`) to recognise the edit command, replace the Nth entry in `.switchboard/memo.md`, and re-echo the full list.
- Ensure the edit command is NOT treated as a new entry (it is a control command, like `process memo`).

### Complex / Risky
- **Entry numbering stability:** Entries are blank-line-separated blocks. Editing must replace the correct block by index, preserving the blank-line separators.
- **Distinguishing edit commands from content:** Like `process memo`, the edit command must be an exact-pattern match so that a message *about* editing ("I wish I could edit entry 2") is not misinterpreted as an edit.
- **Memo sub-tab parity:** The Memo sub-tab in the sidebar is backend-driven; if it should also support editing, that is a separate backend change. This plan focuses on the chat workflow.

## Edge-Case & Dependency Audit

- **Out-of-range N:** Editing entry N where N > count → error message, no change to file, stay in capture mode.
- **`process memo` after edits:** Edits are applied to the file immediately, so `process memo` sees the corrected entries. No duplicate plans.
- **Memo file not cleared:** Consistent with existing behaviour — editing does not clear the file.
- **AGENTS.md / workflow doc:** `memo.md` and `AGENTS.md` both describe the memo protocol and must be updated in lockstep.

## Proposed Changes

### .agents/workflows/memo.md — add edit command
- **Context:** The workflow defines Hard Rules for append-only capture and a single exit command (`process memo`).
- **Logic:** Add an edit control command: `edit N: <new text>` (case-insensitive prefix `edit `, N is a 1-based integer, followed by `: ` and the replacement text). When received, replace the Nth blank-line-separated block in `.switchboard/memo.md` with `<new text>`, then re-echo the full numbered list. Do NOT append the edit command itself as an entry.
- **Implementation:** Add a new section "Edit Entry Command" parallel to "Process Memo Command". Update Hard Rule #4 to note that `edit N:` is the second control command (not content). Add an anti-example: "edit 2 later" is content, not an edit command (must match `edit N: …`).
- **Edge Cases:** Out-of-range N → respond with error, no file change, stay in capture mode. Malformed (no colon, non-numeric N) → treat as content.

### AGENTS.md — memo protocol section
- **Context:** AGENTS.md describes the memo capture mode and the `process memo` exit.
- **Logic:** Add a note that the edit command `edit N: <text>` is supported for in-place correction of entry N.
- **Implementation:** Update the "Memo Capture Mode — Priority Rule" section to mention the edit command alongside `process memo`.

## Verification Plan

- [ ] Capture 3 entries, then `edit 2: corrected text` → entry 2 is replaced, entries 1 and 3 unchanged, list re-echoed with 3 entries.
- [ ] `edit 5: …` with only 3 entries → error, file unchanged, still 3 entries, still in capture mode.
- [ ] `edit 2 later` (no colon) → treated as content, appended as entry 4.
- [ ] After an edit, `process memo` → produces plans from the corrected entries (no stale duplicate).
- [ ] `process memo` still exits capture mode normally.
