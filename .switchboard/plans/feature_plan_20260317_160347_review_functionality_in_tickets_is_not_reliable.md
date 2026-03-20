# Review functionality in tickets is not reliable

## Goal
- Fix the actual ticket review bug: when the user clicks `Submit Comment`, the comment payload reaches the target CLI terminal but can remain sitting in the input box instead of being reliably submitted.
- Ensure the ticket review comment send path uses the same reliable terminal-send protocol as the other message-send features, including the submit/final-enter behavior needed to make the CLI actually execute the message.
- Do not broaden this into unrelated ticket-view UX changes.

## Source Analysis
- `src/webview/review.html`
  - `Submit Comment` posts a `submitComment` message with the selected text and comment payload.
  - The bug described by the user happens after this point: the payload appears in the CLI input box but is not always actually submitted.
- `src/services/ReviewProvider.ts`
  - `submitComment` forwards directly to the `switchboard.sendReviewComment` command and reports success/failure back to the webview.
  - This means the ticket review feature already has a single backend command boundary for fixing send reliability.
- `src/extension.ts`
  - `switchboard.sendReviewComment` constructs the payload and sends it by calling a **local** `sendRobustText(...)` helper defined inside `extension.ts`.
  - That local helper is a separate implementation from the shared terminal send helper used elsewhere.
- `src/services/terminalUtils.ts`
  - The codebase also has a shared `sendRobustText(...)` helper used by other send paths (`TaskViewerProvider`, `InboxWatcher`, etc.).
  - So the review-comment feature is **not** currently guaranteed to use the same messaging/send protocol as the other send-message features.
- Actual bug shape
  - This is a transport/final-submit reliability issue, not a selection UX issue and not a ticket-view layout issue.
  - The smallest correct plan is to align the review-comment send path with the shared reliable send behavior instead of trying to redesign review mode.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Align `Submit Comment` with the shared terminal-send protocol
   - **Files:** `src/extension.ts`, `src/services/terminalUtils.ts`
   - Replace the bespoke review-comment terminal send path with the same shared send helper/protocol used by the other reliable send-message features.
   - Remove the transport split where review comments use the local `extension.ts` helper while other flows use the shared helper.
   - **Clarification:** preserve the existing review-comment payload format and terminal-target resolution unless strictly required to wire in the shared send helper.
2. Ensure the review-comment path gets the same submit behavior as normal sends
   - The final submit/enter behavior for ticket review comments must match the reliable behavior already expected elsewhere in the app.
   - That includes the extra enter/double-tap behavior needed for CLI agents where a single newline can leave text sitting in the input box instead of executing.
3. Keep the fix scoped to transport reliability
   - Do **not** broaden this plan into:
     - review-mode selection redesign,
     - planner/reviewer role-routing changes,
     - ticket layout or modal changes,
     - unrelated ticket-view reliability work.
4. Add focused regression coverage
   - Add a targeted regression test proving the review-comment send path now uses the same shared send protocol/helper as the standard send flows.
   - If a direct transport-level test is awkward, add a source-level regression test that prevents the review-comment path from drifting back to a duplicated helper implementation.

### Band B — Complex / Risky
- None.

## Verification Plan
1. Open a ticket in review mode and click `Submit Comment` using a CLI terminal where the bug currently reproduces.
   - Confirm the payload is not merely written into the input box; it is actually submitted/executed.
2. Compare the review-comment send behavior against another known-good send feature in the same workspace.
   - Confirm both use the same reliable terminal-send behavior.
3. Repeat on a CLI agent terminal that historically needed the extra submit/double-tap behavior.
   - Confirm the review comment is executed without requiring manual Enter from the user.
4. Confirm the existing review-comment payload still reaches the intended target terminal with the same content shape.
5. Run targeted validation:
   - `npm run compile`
   - `npm run compile-tests`
   - targeted regression test(s) covering the review-comment transport path.

## Open Questions
- None.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260312_194738_increase_delay_to_account_for_lag_in_sending_cli_commands.md`
  - Direct overlap. That plan is specifically about terminal send robustness, pacing, and double-tap behavior.
  - This ticket-review bug should reuse that established reliability direction rather than inventing a third terminal-send variant.
- `feature_plan_20260317_062223_restore_review_feature_and_merge_ticket_view.md`
  - Related overlap because it restored the ticket review surface where `Submit Comment` lives.
  - This bug fix should stay tightly scoped to comment delivery transport and avoid reopening broader ticket-view UX work.
- `feature_plan_20260317_065103_open_plans_should_opena_new_ticket.md`
  - Shared ticket-view surface.
  - Transport changes should not affect new-ticket edit mode, rename-on-save, or other ticket behaviors.
- `feature_plan_20260317_071108_add_move_controls_to_ticket_view.md`
  - Shared ticket header surface.
  - This plan should not touch those lifecycle controls; it only fixes the comment-submit path.

## Complexity Audit

### Band A — Routine
- Route `Submit Comment` through the same shared reliable terminal-send helper/protocol as other send features.
- Remove the duplicated review-comment transport path in `extension.ts`.
- Verify the review-comment path gets the same final submit / double-tap behavior as the known-good message-send features.
- Add focused regression tests for review-comment transport alignment.

### Band B — Complex / Risky
- None.
