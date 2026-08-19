# Fix: Coder Reports to Lead Instead of Reviewer During Review Fix Loop

## Goal

When delegation mode activates (reviewer dispatched to CODE REVIEWED with a coder on the team), install a pair-scoped standing order on the delegated coder that redirects its callback to the reviewer. Remove it when the coder is cleared or re-dispatched by the lead. This closes the review-fix loop: reviewer → coder (fix instructions) → coder → reviewer (report back) → reviewer re-reviews.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix
**Project:** Browser Switchboard

## Root Cause

The plan `reviewer-team-with-delegation-mode.md` (line 68) specified that the coder would report to BOTH the reviewer (per fix instructions) and the lead (per standing order). The implementation activated delegation mode in the reviewer's prompt but never modified the coder's standing orders. The coder's callback is a team-scoped order with the lead's name baked into the instruction text. When the reviewer sends fix instructions, the coder does the work and reports to the lead — the reviewer never hears back.

## Fix

### src/services/standingOrders.ts

Add two helper functions:

1. `installReviewerCallbackOrder(db, coderName, reviewerName)` — adds a pair-scoped standing order (`parent: coderName`, `child: reviewerName`) with a deterministic id `review-callback:${coderName}` and an instruction telling the coder to report to the reviewer after completing fix instructions.

2. `removeReviewerCallbackOrder(db, coderName)` — removes any pair-scoped order with id `review-callback:${coderName}`.

### src/services/TaskViewerProvider.ts

- **Install**: In both delegation activation paths (single-card `_handleTriggerAgentActionInternal` ~21474, batch `dispatchToGroup` ~6905), after `reviewerDelegationMode = true` and `reviewerCoderTerminal = coder`, call `installReviewerCallbackOrder`.
- **Remove**: In `_ptyHostVerb`, when `verb === 'ptyClearTerminal'`, call `removeReviewerCallbackOrder` for the cleared terminal. Also remove when a dispatch (`hasDispatch`) targets a coder — the lead re-dispatching to the coder means review is over.

## Verification Plan

1. Unit test: `installReviewerCallbackOrder` adds a pair-scoped order with the correct parent/child and a deterministic id. `removeReviewerCallbackOrder` removes it.
2. Unit test: removing a non-existent review-callback order is a no-op (no error).
3. Manual: start a Coding team, dispatch a feature to CODE REVIEWED, verify the coder's standing orders include the reviewer callback, verify the coder reports to the reviewer after fixes.
