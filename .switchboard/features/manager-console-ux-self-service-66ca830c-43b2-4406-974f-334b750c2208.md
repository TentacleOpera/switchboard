# Manager Console UX & Self-Service

**Complexity:** 4

## Goal

Make the manager console feel like a manager: natural-language plan lists and dispatch reports (naming the registered CLI agent), a follow-up dispatch/group offer after presenting plans, faster startup via a pre-digested Manager Snapshot in kanban-board.md, and self-service opening of agent terminals via the API instead of sending the user to the IDE.

## How the Subtasks Achieve This

- **Faster Manage-Skill Startup: Manager Snapshot Section in kanban-board.md**: extends `_writeLocalBoardMirror()` (`KanbanDatabase.ts`) to append a pre-digested `## Manager Snapshot` section (per-column plan/feature counts table, ready-made one-line board summary, active project filter) to the existing atomic `kanban-board.md` write, and folds the filter into the content hash so filter-only changes still rewrite. The skill's entry protocol then reads one small file plus `/health` instead of running a multi-file awk counting pass — startup gets near-instant, with the awk pass kept as a labeled fallback for older extension builds.
- **Manager Self-Service: Open Agent Terminals via the API Instead of Sending the User to the IDE**: adds `selectedWorkspaceRoot` to `/health` so the manager can tell whether the board's selection matches `$ROOT`, then turns the "go click in the IDE" nudges (skill §1 step 4 and the dispatch 409 message) into an offer: on a yes, fire `POST /kanban/verb/selectWorkspace` only on a genuine root mismatch, then `POST /taskViewer/verb/createAgentGrid` (the exact arm the IDE button uses; registration is synchronous), and do one confirming `/health` read to report honestly what opened.
- **Manager Console: Natural-Language Presentation & Follow-Up Offer for Plan Lists and Dispatch Reports** *(consolidated from the former "Follow-Up Offer" and "Natural-Language Presentation" subtasks)*: one prose callout in skill §2 (both copies) that owns the presentation surface — plan lists as numbered titles (no filenames/UUIDs/paths, Hard Rule 8 amended), dispatch confirmations as one sentence naming the response's `dispatchedAgent` built only from returned fields, and every non-empty plan list ending with the "dispatch any of these, or group some into a feature?" offer that acts only on an answer.

## Dependencies & sequencing

- **Cross-feature dependencies:** none — all three subtasks build on shipped surfaces (`/kanban/dispatch`, `/health`, the board-mirror writer, `createAgentGrid`/`selectWorkspace` verbs); nothing from other features must land first.
- **Shipping order within this feature:** functionally the subtasks are independent (each is coherent alone), but all three edit `switchboard-manage/SKILL.md` (both copies), so land them sequentially to avoid merge conflicts: **Snapshot** (§1 step 3) → **Self-Service Terminals** (§1 step 4 + new reference block) → **Presentation & Follow-Up** (§2 + Hard Rule 8). The two §1 edits are adjacent steps, so doing them back-to-back keeps the entry protocol coherent; the presentation callout lands last since it cross-references the final §2 text.
- **Prerequisites / guards:** `npm run mirror:check` must pass after every subtask (both skill copies edited together); no catalog regeneration needed anywhere (no new verbs — `catalog:check`/`parity:check` unchanged); the snapshot and self-service subtasks each carry an explicit older-build fallback (awk pass / manual nudge), so skill and extension can ship independently.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Faster Manage-Skill Startup: Manager Snapshot Section in kanban-board.md](../plans/feature_plan_20260711120046_manager-snapshot-kanban-board.md) — **PLAN REVIEWED**
- [ ] [Manager Self-Service: Open Agent Terminals via the API Instead of Sending the User to the IDE](../plans/feature_plan_20260711121418_manager-self-service-open-agent-terminals.md) — **PLAN REVIEWED**
- [ ] [Manager Console: Natural-Language Presentation & Follow-Up Offer for Plan Lists and Dispatch Reports](../plans/feature_plan_20260711130500_manager-presentation-and-followup.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

