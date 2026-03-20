# Autoban bugs

## Goal
Fix 2 bugs with autoban:

1. coder to reviewer and lead coder to review fire at same time. The logic should be OR, not and. It should be: on tick, sends 1 plan to reviewer, either from lead coder OR coder. It shouldn't be on tick, send 1 plan from lead coder and 1 plan from coder.

2. when adding a backup terminal, it asks for a name for the terminal. That is dumb. it should just be numbered sequentially. So reviewer 2, reviewer 3, reviewer 4 etc. don't ask me for a name. 

## Source Analysis
- `src/services/TaskViewerProvider.ts`
  - `_startAutobanEngine()` starts one timer per enabled autoban rule. After the split-coded-column work, that means independent timers for `LEAD CODED` and `CODER CODED`.
  - `_autobanTickColumn()` routes both of those source columns to `reviewer`, so the current architecture can legitimately produce two reviewer sends in the same interval window.
  - `_addAutobanTerminal()` currently falls back to `vscode.window.showInputBox(...)` when the webview sends `addAutobanTerminal` without a requested name. The default seed is `<RoleLabel> Backup`, then uniqueness is handled by suffixing.
- `src/webview/implementation.html`
  - The Autoban panel already sends `vscode.postMessage({ type: 'addAutobanTerminal', role })` with no name, so the backend prompt path is what the user is hitting today.
  - Pool UI, send caps, reset controls, and per-role backup terminal management already exist; this fix should refine that implementation rather than replace it.
- `src/services/autobanState.ts`
  - Current state already contains terminal pool and send-accounting fields. This bug plan should avoid reworking that schema unless strictly necessary for the shared reviewer-lane fix.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260317_055724_add_seaprate_column_for_coder_and_lead_coder.md`
  - Direct overlap. The bug exists because `CODED` was split into `LEAD CODED` and `CODER CODED`.
  - This plan must preserve the separate visible columns and only change reviewer dispatch coordination.
- `feature_plan_20260317_054643_add_upper_limit_of_autoban_sends.md`
  - Direct overlap in `TaskViewerProvider.ts`, `implementation.html`, `autobanState.ts`, and `src/test/autoban-state-regression.test.js`.
  - The no-prompt sequential naming fix must not regress terminal pools, managed backup-terminal tracking, send caps, or reset behavior.
- `feature_plan_20260315_084645_add_more_controls_to_autoban_config.md`
  - Shared autoban state and rules code. The reviewer-lane fix must not disturb PLAN REVIEWED complexity/routing behavior.
- `feature_plan_20260316_231438_autoban_needs_countdown_in_ui.md`
  - Related timing surface. If reviewer dispatch coordination adds shared locks or timestamps, verify existing per-column countdown behavior still reflects reality.
- `feature_plan_20260316_222047_live_feed_not_registering_autoban_moves.md`
  - Shared dispatch path. After this fix, reviewer autoban logging should emit once per actual send, not once per coded source-column timer.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Remove manual naming from autoban-created backup terminals
   - **File:** `src/services/TaskViewerProvider.ts`
   - **Method:** `_addAutobanTerminal()`
   - Remove the `showInputBox()` fallback when no explicit name is supplied from the webview.
   - Generate names automatically from the role label and the existing primary terminal convention:
     - `Planner 2`, `Planner 3`, ...
     - `Coder 2`, `Coder 3`, ...
     - `Lead Coder 2`, `Lead Coder 3`, ...
     - `Reviewer 2`, `Reviewer 3`, ...
   - Reuse the existing uniqueness scan across terminal registry state, live VS Code terminals, and `_registeredTerminals`.
   - **Clarification:** numbering is per role and should skip occupied names rather than renaming or compacting existing terminals.
2. Keep the Autoban UI one-click
   - **File:** `src/webview/implementation.html`
   - Keep `ADD TERMINAL` as a single action with no extra prompt flow.
   - Only update helper text if it still implies user-supplied names; do not add new controls.
3. Update regression coverage for terminal creation behavior
   - **Files:** existing autoban regression tests under `src/test`
   - Replace tests that currently assert the prompt path exists with tests that assert:
     - no prompt is required,
     - first autoban-created backup terminal is `RoleLabel 2`,
     - subsequent terminals increment sequentially,
     - collisions skip to the next available suffix.

### Band B — Complex / Risky / High Complexity
1. Treat `LEAD CODED` and `CODER CODED` as one reviewer dispatch lane
   - **File:** `src/services/TaskViewerProvider.ts`
   - Keep separate Kanban columns and separate source-column discovery intact.
   - Change the coded-to-review autoban decision so one effective reviewer tick can produce at most one reviewer dispatch across both coded columns combined.
   - Do **not** revert the split-column model.
2. Add shared cross-column candidate selection for reviewer sends
   - When a coded-column autoban timer fires, collect eligible cards from both `LEAD CODED` and `CODER CODED`.
   - Apply the existing oldest-first intent across the combined candidate set, then take one batch total for reviewer.
   - Preserve current filtering for in-flight sessions and existing terminal/session-cap exhaustion logic.
   - **Clarification:** if both coded columns have eligible cards, choose the oldest eligible cards globally rather than hard-coding a lead-first or coder-first preference.
3. Prevent same-window double dispatches to reviewer
   - Add a shared reviewer-lane guard so that after one coded-to-review autoban dispatch succeeds, the companion coded-column timer in the same interval window becomes a no-op instead of sending another batch.
   - The guard should be based on actual reviewer dispatch state, not merely “which timer fired first,” so retries/failures still behave correctly.
4. Keep reviewer dispatch accounting consistent
   - Ensure only real reviewer sends increment send counters, session send counts, and live-feed/autoban dispatch logging.
   - No-op second timers must not look like successful sends.

## Verification Plan
1. Seed one eligible card in `LEAD CODED` and one eligible card in `CODER CODED`, with both reviewer autoban rules enabled on the same interval.
   - Confirm the first coded-to-review interval sends exactly one reviewer batch total, not two.
2. Leave both cards in place across two intervals.
   - Confirm the remaining card is picked up on the next interval rather than being skipped indefinitely.
3. Set `batchSize` greater than 1 and place multiple cards across both coded columns.
   - Confirm reviewer autoban takes a single combined batch total per interval, not one batch per source column.
4. Add reviewer backup terminals repeatedly from the Autoban panel.
   - Confirm there is no name prompt.
   - Confirm created names are `Reviewer 2`, `Reviewer 3`, `Reviewer 4`, etc.
5. Repeat terminal creation for `Coder` and `Lead Coder`.
   - Confirm numbering is role-specific and skips any occupied names cleanly.
6. Remove a managed backup terminal, then add another one.
   - Confirm the next created name stays unique and does not collide with still-live terminals or stale registry entries.
7. Use `CLEAR & RESET`.
   - Confirm autoban-created backup terminals are removed/reset as before and the no-prompt naming logic still works afterward.
8. Validate that reviewer autoban activity/logging reports one dispatch per actual coded-to-review send.
9. Run existing repo validation:
   - `npm run compile`
   - `npm run compile-tests`
   - targeted autoban regression tests that cover pool state / terminal creation behavior.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Remove the backup-terminal naming prompt from `_addAutobanTerminal()`.
- Auto-generate sequential role-based terminal names (`Reviewer 2`, `Coder 2`, etc.).
- Update existing autoban regression tests to reflect no-prompt sequential naming.
- Light UI/help-text cleanup only if current copy still implies manual naming.

### Band B — Complex / Risky
- Coordinate `LEAD CODED` and `CODER CODED` so reviewer autoban behaves as a shared OR lane instead of two independent reviewer sends.
- Merge cross-column card selection without breaking oldest-first behavior, in-flight session locking, send caps, or reviewer dispatch logging.
- Prevent the second coded-column timer from creating a false-positive “successful” reviewer dispatch in the same interval window.
