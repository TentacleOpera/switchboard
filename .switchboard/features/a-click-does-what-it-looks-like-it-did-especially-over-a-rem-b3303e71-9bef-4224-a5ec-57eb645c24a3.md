# A Click Does What It Looks Like It Did, Especially Over a Remote Board

**Complexity:** 5

## Goal

Three plans where a board action waits on a host round trip and reads as broken over a remote Switchboard: the priority star is the last non-optimistic control, send-to-backlog and send-to-new are not optimistic either, and Review Plan navigation lands on an empty panel then refuses to follow the next click.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Optimistic Card Movement for Send to Backlog and Send to New Actions](../plans/feature_plan_20260803135239_optimistic_backlog_card_movement.md) — **CODE REVIEWED** — ID: d845c19b-051f-4f75-b222-7313500c58fe
- [ ] [The Priority Star Applies Optimistically, Like Every Other Board Action](../plans/priority-star-applies-optimistically.md) — **CODE REVIEWED** — ID: 20d4a089-1b82-4f49-9fd7-20d9202d062f
- [ ] [Review Plan Selects The Plan It Was Clicked On, And Stops Refetching The Whole Board To Do It](../plans/review-plan-selects-its-plan-without-refetching-the-board.md) — **CODE REVIEWED** — ID: 9a6ceb8d-add9-4606-83a2-c3f8459afb2b
<!-- END SUBTASKS -->

## Completion Summary

All three subtasks implemented and committed (635375c6). Send to Backlog/New and the priority star now apply optimistically — the visual change is instant, the backend ledger resolves on push, and a failed write reverts via the existing moveCardsFailed handler. The shared moveCardsOptimistically helper resolves through resolveDisplayColumn so hidden targets (BACKLOG outside backlog view, CREATED inside it) route to the renderBoard fallback instead of bailing as silent no-ops. The priority star uses a pendingStars ledger cleared on a matching updateBoard push (not the 2s timer) so a slow remote push cannot revert a fast local click, and a shared compareCardsByPrecedence comparator extracted from renderBoard's inline sort drives the same-column reposition. Review Plan navigation gets a WS-only cold-panel queue (10s expiry, flushed on webviewReady/sbTransportSubscribed) so a cold-open click is not lost, and selects from cache or fetches the single plan (fetchKanbanPlan verb) instead of the 2,555-plan list. Finding 3's second-click symptom was not speculatively fixed per the plan. Verification steps 1–10 against the remote board over the tailnet remain the validation path.


## Review Findings

All three subtasks reviewed together, since they share `kanban.html` and the `moveCardsOptimistically` neighbourhood. Files changed by this pass: `src/webview/kanban.html` (TTL-bounded `pendingStars`), `src/webview/project.js` (scoped-payload map merge), `src/services/PlanningPanelProvider.ts` (effective-root tag on the scoped payload, loud failure on an unmatched root), `src/test/card-priority-and-column-order-contract.test.js` (two stale anchors re-anchored, not weakened), `src/test/kanban-optimistic-board-actions-contract.test.js` (new), `package.json` + `.github/workflows/integration-tests.yml` (two gates wired), `src/services/bundledProtocols.ts` (one-line doc sync that was reddening the star's own gate). One CRITICAL (an unbounded forcing star ledger with no ack to resolve it), three MAJORs (a CI-wired gate turned red by the implementation commit; a scoped plan-fetch payload that narrowed global project/column state; a payload workspace tag that did not match the plans it carried) — all fixed. Verification: `tsc -p tsconfig.test.json` clean, eslint 0 errors, `catalog:check` / `parity:check` / `standalone-parity:check` / `push-routing:check` / `verb-returns:check` / `host-seam-parity:check` green, and a 30-suite contract sweep whose five remaining failures were each reproduced on a pristine `git archive 2405c873` tree and are therefore pre-existing.

**Feature goal verdict — achieved, with the remote-latency half provisional.** All three actions now apply within the click rather than after a host round trip, and the new gate discriminates on each mechanism. But every symptom in this feature was reported *over the tailnet* and is invisible on loopback; the plans' manual verification (remote click latency, cold-first-click, click-to-render timing) was not executed in this pass, so passing the static suites is not evidence the remote experience is fixed — only that the mechanism each plan specified is present, wired, and pinned.

## Deferred Findings

- MAJOR `src/webview/project.js:738` — a cold-open Review Plan leaves the Kanban sidebar list holding only the one fetched plan until another list fetch happens. Follows from subtask 9a6ceb8d's stated goal, so it is the author's call.
- MAJOR — every remote-latency verification step across all three subtasks is unexecuted (remote click latency, cold-first-click, click-to-render timing, Finding 4 attribution). No static gate can observe them.
- MAJOR (pre-existing, out of scope) — four CI-wired contract suites are red at `2405c873`, before this feature's implementation commit: `test:contract:panel-scrollbars`, `test:contract:headless-feature-mgmt`, `test:contract:cli-board-commands`, `test:contract:skill-preconditions`, plus `test:contract:goal-invariant-verification`. Reproduced on pristine trees at both `HEAD` and `2405c873`; unrelated to this work.
- MAJOR (pre-existing, out of scope) `scripts/check-claude-mirror.js` — `mirror:check` reports `.claude/skills/switchboard-remote/SKILL.md` content drift at HEAD.
- NIT `src/services/KanbanProvider.ts:12862` — `sourceColumn`'s hardcoded `'CREATED'`/`'BACKLOG'` fallback inside `catch` is a default indistinguishable from a read value on a revert-routing path. Narrow and plan-specified.
- NIT `src/webview/kanban.html:6457` — `PENDING_STAR_TTL_MS` is 15 s against a 2.1–2.3 s measured push; a far slower link could expire a genuinely in-flight write.
- NIT `src/webview/kanban.html:9361` — `repositionCardInColumn`'s `appendChild` reorder relies on the undocumented invariant that non-STAGING column bodies hold only `.kanban-card` children.
- NIT `src/services/PlanningPanelProvider.ts:1105` — the cold-panel queue flush is keyed on message type only, so any `webviewReady` within the 10 s window flushes a browser-originated activation.
- NIT `src/services/PlanningPanelProvider.ts:3987` — `kanbanPlanReady` from a browser-originated `fetchKanbanPlan` is also queued into `_pendingProjectMessages` and replayed into the editor panel. Idempotent.
- NIT — Finding 3 (second click not moving the selection) remains unreproduced and unfixed, as subtask 9a6ceb8d directed.
