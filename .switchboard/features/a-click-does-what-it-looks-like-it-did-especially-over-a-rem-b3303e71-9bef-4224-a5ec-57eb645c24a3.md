# A Click Does What It Looks Like It Did, Especially Over a Remote Board

**Complexity:** 5

## Goal

Three plans where a board action waits on a host round trip and reads as broken over a remote Switchboard: the priority star is the last non-optimistic control, send-to-backlog and send-to-new are not optimistic either, and Review Plan navigation lands on an empty panel then refuses to follow the next click.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Optimistic Card Movement for Send to Backlog and Send to New Actions](../plans/feature_plan_20260803135239_optimistic_backlog_card_movement.md) — **LEAD CODED** — ID: d845c19b-051f-4f75-b222-7313500c58fe
- [ ] [The Priority Star Applies Optimistically, Like Every Other Board Action](../plans/priority-star-applies-optimistically.md) — **LEAD CODED** — ID: 20d4a089-1b82-4f49-9fd7-20d9202d062f
- [ ] [Review Plan Selects The Plan It Was Clicked On, And Stops Refetching The Whole Board To Do It](../plans/review-plan-selects-its-plan-without-refetching-the-board.md) — **LEAD CODED** — ID: 9a6ceb8d-add9-4606-83a2-c3f8459afb2b
<!-- END SUBTASKS -->

## Completion Summary

All three subtasks implemented and committed (635375c6). Send to Backlog/New and the priority star now apply optimistically — the visual change is instant, the backend ledger resolves on push, and a failed write reverts via the existing moveCardsFailed handler. The shared moveCardsOptimistically helper resolves through resolveDisplayColumn so hidden targets (BACKLOG outside backlog view, CREATED inside it) route to the renderBoard fallback instead of bailing as silent no-ops. The priority star uses a pendingStars ledger cleared on a matching updateBoard push (not the 2s timer) so a slow remote push cannot revert a fast local click, and a shared compareCardsByPrecedence comparator extracted from renderBoard's inline sort drives the same-column reposition. Review Plan navigation gets a WS-only cold-panel queue (10s expiry, flushed on webviewReady/sbTransportSubscribed) so a cold-open click is not lost, and selects from cache or fetches the single plan (fetchKanbanPlan verb) instead of the 2,555-plan list. Finding 3's second-click symptom was not speculatively fixed per the plan. Verification steps 1–10 against the remote board over the tailnet remain the validation path.

