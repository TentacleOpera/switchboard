# process memo: Clear the Memo File After Processing

## Goal

When the user runs `process memo`, the agent creates one plan file per captured entry but currently leaves `.switchboard/memo.md` untouched. Re-running `process memo` then creates duplicate plan files. Fix this by having `process memo` **clear the memo file** after successfully creating all plan files, so re-running is safe.

### Problem Analysis

The memo workflow (`memo.md`, step 4 of "Process Memo Command") explicitly states: "Do not clear the memo file. The user can clear it via the Memo sub-tab if desired." This was an intentional design choice to give the user a manual clear path, but in practice it creates a footgun: the agent's own report reminds the user that re-running creates duplicates, yet does nothing to prevent them. The correct behaviour is for `process memo` to clear the memo file once the plan files have been written, eliminating the duplicate risk entirely. The Memo sub-tab remains as an alternative processing path (it already clears on send/copy).

## Metadata

**Complexity:** 1
**Tags:** workflow, memo, bug, ux

## Complexity Audit

### Routine
- Update `memo.md` "Process Memo Command" step 4/5: after all plan files are created, truncate `.switchboard/memo.md` to empty.
- Update the report text: remove the "memo was NOT cleared" warning; instead confirm the memo was cleared.
- Update AGENTS.md memo section if it repeats the "not cleared" claim.

### Complex / Risky
- **Partial-failure safety:** If plan file creation fails partway, clearing the memo would lose unprocessed entries. The clear should only happen after all plan files are successfully written. If any write fails, do NOT clear and report the failure.
- **Memo sub-tab parity:** The sub-tab already clears on its send/copy paths, so this brings the chat path in line with the sub-tab path.

## Edge-Case & Dependency Audit

- **Re-run safety:** After clearing, re-running `process memo` finds an empty memo and produces zero plans (correct, no duplicates).
- **Memo sub-tab:** Unaffected — it has its own clear logic.
- **AGENTS.md / memo.md lockstep:** Both describe the `process memo` behaviour and must be updated together.
- **No data migration** — this is a workflow behaviour change only.

## Proposed Changes

### .agents/workflows/memo.md — Process Memo Command step 4/5
- **Context:** Step 4 currently says "Do not clear the memo file." Step 5 reinforces this.
- **Logic:** After all plan files are created successfully, clear `.switchboard/memo.md` (write empty content). If any plan file write fails, do NOT clear and report the failure so the user can retry.
- **Implementation:** Replace step 4's "Do not clear" instruction with "Clear `.switchboard/memo.md` after all plan files have been created successfully." Update the report text to confirm the memo was cleared instead of warning it was not. Remove step 5 (the "do not clear" reinforcement) or repurpose it to state the clear-on-success behaviour.
- **Edge Cases:** Empty memo at `process memo` time → zero plans, memo stays empty, no error.

### AGENTS.md — Memo Capture Mode section
- **Context:** The memo protocol section mentions `process memo` and the "not cleared" behaviour.
- **Logic:** Update to state that `process memo` clears the memo file after successfully creating plan files.
- **Implementation:** Edit the relevant sentences in the "Memo Capture Mode — Priority Rule" and any processing-path description.

## Verification Plan

- [ ] Capture 3 entries, run `process memo` → 3 plan files created, `.switchboard/memo.md` is empty afterwards.
- [ ] Re-run `process memo` immediately → 0 new plans (memo is empty), no duplicates.
- [ ] Simulate a plan file write failure → memo is NOT cleared, error reported, user can retry.
- [ ] `process memo` on an empty memo → 0 plans, no error, memo stays empty.
