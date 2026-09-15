# Fourteen Single Defects That Belong to No Cluster — Drained

## Goal

Closed 2026-09-15. This card was a holding pen for fourteen unrelated reviewer findings from the
2026-09-04 triage of `.switchboard/memo.md`, collected so they would reach the board without adding
fourteen cards to it. Its own closing condition was *"this card is closed when it is empty, not when
a batch is done."* It is now empty: every item is an individually addressable card.

### What happened to each item

All fourteen were re-checked against HEAD on 2026-09-15 before splitting; the cited line numbers had
drifted since 2026-09-04 and were corrected in the new cards.

| # | Item | Now |
|---|---|---|
| 1 | Role defaults still allow subagents | `1d9e84f4` — standalone, carries the decision |
| 2 | `alert()` reports a failed claim-clear | `ad17cd5d` → *Browser panel action feedback* |
| 3 | Nothing checks Tailscale ACL posture | `19589962` → *Tailnet* |
| 4 | A batch's sibling cards are never cleared | `9a6b88f6` — standalone, carries the either/or |
| 5 | Catalog reddens on line-number churn | `e60773a0` |
| 6 | Team autostart worktrees accumulate | `c0a77a16` — standalone, carries the decision |
| 7 | Save and Preview resolve one path to two files | `83683921` |
| 8 | Plan-path and database-instance identity fail open | `da617321` — **half only**, see below |
| 9 | Only two routes validate `workspaceRoot` | `47813a3d` |
| 10 | Head names not shell-escaped in curl recipes | `b83fd389` |
| 11 | A third client-side copy of the complexity route | `ddcd5f00` |
| 12 | Rail team slots can never show dispatched state | `c392a897` — carries the decision |
| 13 | Remote-control provider exclusivity undisclosed | `61538e63` |
| 14 | Raw `<cliPath>` placeholder + two stale port-file prompts | `ff91fd86` |

**Item 8 shipped half.** Its database-instance half — `forWorkspace` caching on a non-realpath'd
string — is fixed: `fs.realpathSync` is applied at `KanbanDatabase.ts:2012` and `:2034`, consistent
with *Enforce one database instance per path and fix the is_feature clobber* having completed. Only
the `_ensureRelativePlanFile` fail-open half (`:15080`), explicitly unowned in the original, carried
forward.

**Four items were verified still live rather than assumed**, as the sample: `alert(` at
`connections.js:576`; **2,065** `"line":` fields in `protocol-catalog.json` (up from the 2,028 the
original recorded, so that exposure grew); `subagentPolicy = 'default'` at `KanbanProvider.ts:6955`;
and no ACL handling anywhere — a word-boundary `\bacl\b` search of `src/` returns nothing, where a
naive `grep -i acl` returns 19 substring false positives and makes it look handled.

### Why this is recorded rather than deleted

This card is the artifact of the problem *Reviewer Findings Become Short Backlog Cards, Not a Memo
Nobody Drains* (`c5818617`) exists to fix: reviewer risks accumulating in a memo instead of landing
as addressable cards at review time. Landing that plan stops new holding pens forming; it does not
drain one that already exists. Keeping this record makes the second half visible, and stops anyone
re-deriving the fourteen items from a memo that has moved on.

## Metadata

**Complexity:** 1
**Tags:** docs

## User Review Required

No. The card's own closing condition is met.

## Proposed Changes

None — the work left this card. Move it to Completed.
