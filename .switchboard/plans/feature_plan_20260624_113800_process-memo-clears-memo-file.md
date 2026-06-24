# process memo: Clear the Memo File After Processing

## Goal

When the user runs `process memo`, the agent creates one plan file per captured entry but currently leaves `.switchboard/memo.md` untouched. Re-running `process memo` then creates duplicate plan files. Fix this by having `process memo` **clear the memo file** after successfully creating all plan files, so re-running is safe.

### Problem Analysis

The memo workflow (`memo.md`, step 4 of "Process Memo Command") explicitly states: "Do not clear the memo file. The user can clear it via the Memo sub-tab if desired." This was an intentional design choice to give the user a manual clear path, but in practice it creates a footgun: the agent's own report reminds the user that re-running creates duplicates, yet does nothing to prevent them. The correct behaviour is for `process memo` to clear the memo file once the plan files have been written, eliminating the persistent duplicate risk. The Memo sub-tab remains as an alternative processing path (it already clears on send/copy).

## Metadata

**Complexity:** 2
**Tags:** bugfix, ux, docs

## User Review Required

No — this is a workflow/documentation behaviour change with no source-code or data-migration impact. The change narrows a footgun (duplicate plans on re-run) and aligns the chat `process memo` path with the existing Memo sub-tab clear behaviour. No user data is at risk beyond the memo file itself, which is the explicit target of the change.

## Complexity Audit

### Routine
- Update `memo.md` "Process Memo Command" step 4: replace the "Do not clear" instruction with "Clear `.switchboard/memo.md` after all plan files are created successfully."
- Update `memo.md` "Process Memo Command" step 5: remove the "do not clear" reinforcement or repurpose it to state the clear-on-success behaviour.
- Update `memo.md` "Processing Captured Entries" section (line 52): change "The memo file is NOT cleared by this path" to "The memo file is cleared after all plan files are created."
- Update the report text in step 4: remove the "memo was NOT cleared" warning; instead confirm the memo was cleared.
- Update `AGENTS.md` "Memo Capture Mode — Priority Rule" section: add "and clears the memo file" to the `process memo` description.

### Complex / Risky
- **Partial-failure safety:** If plan file creation fails partway, clearing the memo would lose unprocessed entries. The clear should only happen after all plan files are successfully written. If any write fails, do NOT clear and report the failure. (Residual risk: LLM error detection is imperfect — see Adversarial Synthesis.)
- **Memo sub-tab parity:** The sub-tab already clears on its send/copy paths, so this brings the chat path in line with the sub-tab path.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `process memo` is a single-agent, sequential operation. No concurrent writers to `.switchboard/memo.md` during processing.
- **Security:** No security implications — the memo file is a local capture buffer, not a credential or sensitive store.
- **Side Effects:**
  - Re-run safety: After clearing, re-running `process memo` finds an empty memo and produces zero plans (correct, no duplicates).
  - Memo sub-tab: Unaffected — it has its own clear logic independent of the chat path.
  - Non-existent memo file: If `process memo` is run without `.switchboard/memo.md` ever being created (e.g., user never ran `/memo`), the clear operation is a graceful no-op — do not error, just produce zero plans.
  - Interruption window: If the agent is interrupted mid-processing (session crash, user closes terminal), some plan files may exist while the memo is not yet cleared. Re-running would create duplicates for the already-created entries. This window is narrow (duration of processing only) and is a strict improvement over the current infinite-window behaviour.
- **Dependencies & Conflicts:**
  - `AGENTS.md` / `memo.md` lockstep: Both describe the `process memo` behaviour and must be updated together to avoid contradiction.
  - No data migration — this is a workflow behaviour change only.
  - No source-code changes required — the Memo sub-tab's backend clear logic is already independent.

## Dependencies

- None — this is a self-contained workflow/documentation change with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the plan originally missed the "Processing Captured Entries" section in `memo.md` (line 52) which also states "NOT cleared" — without updating it, the file would self-contradict; (2) partial-failure safety relies on LLM error detection, which is imperfect but is the best mitigation available for prose-instruction workflows; (3) a narrow interruption window remains where mid-processing crashes could still produce duplicates on retry. Mitigations: update both "not cleared" locations, keep the "do NOT clear on failure" instruction, and soften the "eliminates entirely" claim to "eliminates the persistent duplicate risk."

## Proposed Changes

### .agents/workflows/memo.md — Process Memo Command step 4 (line 44)
- **Context:** Step 4 currently says: "Report. List the created plan files and their derived titles. Remind the user that `.switchboard/memo.md` was NOT cleared and that re-running `process memo` will create duplicates — to clear the memo, use the Memo sub-tab in the sidebar."
- **Logic:** After all plan files are created successfully, clear `.switchboard/memo.md` (write empty content). If any plan file write fails, do NOT clear and report the failure so the user can retry. The report should confirm the memo was cleared.
- **Implementation:** Replace step 4's text with: "Report. List the created plan files and their derived titles. Confirm that `.switchboard/memo.md` was cleared after all plan files were created successfully. If any plan file write failed, do NOT clear the memo — report the failure and advise the user to retry."
- **Edge Cases:** Empty memo at `process memo` time → zero plans, memo stays empty, no error. Non-existent memo file → zero plans, no error (clear is a no-op).

### .agents/workflows/memo.md — Process Memo Command step 5 (line 45)
- **Context:** Step 5 currently says: "Do not clear the memo file. The user can clear it via the Memo sub-tab if desired."
- **Logic:** This step is now redundant with the updated step 4. Remove it or repurpose it to reinforce the clear-on-success behaviour.
- **Implementation:** Remove step 5 entirely. The clear-on-success instruction now lives in step 4.

### .agents/workflows/memo.md — Processing Captured Entries section (line 52)
- **Context:** Line 52 currently says: "Chat command: Send exactly `process memo` to exit capture mode and have the agent create one plan file per entry. The memo file is NOT cleared by this path — clear it via the Memo sub-tab to avoid duplicates on re-run."
- **Logic:** This is a second location in the same file that states "NOT cleared." It must be updated to match the new clear-on-success behaviour, or the file will self-contradict.
- **Implementation:** Change to: "Chat command: Send exactly `process memo` to exit capture mode and have the agent create one plan file per entry. The memo file is cleared after all plan files are created successfully, so re-running produces no duplicates."
- **Edge Cases:** None beyond those already covered in step 4.

### AGENTS.md — Memo Capture Mode — Priority Rule section
- **Context:** The section currently says: "The sole exit trigger is the exact command `process memo` (case-insensitive, as the entire message) — it exits capture mode and processes all entries into plan files (one per entry)."
- **Logic:** This sentence doesn't explicitly say "not cleared" but also doesn't say "cleared." Add the clear behaviour for completeness and consistency with `memo.md`.
- **Implementation:** Change "processes all entries into plan files (one per entry)" to "processes all entries into plan files (one per entry) and clears the memo file on success."
- **Edge Cases:** None — this is a descriptive protocol statement, not executable logic.

## Verification Plan

### Automated Tests

No automated tests — this is a workflow/documentation change with no source-code impact. Verification is manual:

- [ ] Capture 3 entries, run `process memo` → 3 plan files created, `.switchboard/memo.md` is empty afterwards.
- [ ] Re-run `process memo` immediately → 0 new plans (memo is empty), no duplicates.
- [ ] Simulate a plan file write failure → memo is NOT cleared, error reported, user can retry.
- [ ] `process memo` on an empty memo → 0 plans, no error, memo stays empty.
- [ ] `process memo` when `.switchboard/memo.md` does not exist → 0 plans, no error (graceful no-op).
- [ ] Verify `memo.md` has no remaining "NOT cleared" statements in either the "Process Memo Command" or "Processing Captured Entries" sections.
- [ ] Verify `AGENTS.md` Memo Capture Mode section states the memo is cleared on success.

---

**Recommendation:** Complexity is 2 → **Send to Intern**. This is a straightforward documentation/workflow change across two files (`memo.md` and `AGENTS.md`) with no source-code or data-migration impact.
