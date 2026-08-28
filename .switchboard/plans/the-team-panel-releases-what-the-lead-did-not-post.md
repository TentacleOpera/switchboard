# The team panel releases what the lead did not post

**Project:** Browser Switchboard

## Goal

Replace `ACKNOWLEDGE COMPLETIONS` in the team panel — a button whose entire body is
`terminalBadges.delete()` — with the operator's release control: it posts
`/kanban/task/complete` for every card the scoped team holds with no completion, and it is
absent whenever there is nothing to release.

### Problem Analysis

**The button writes nothing.** `clearTeamBadges` (`terminals.js:9206`) deletes entries from
the in-memory `terminalBadges` map, re-renders, and toasts. No fetch, no DB write. It is a
light switch.

It is also redundant as a light switch. Badges already clear on focus (`:5261`, `:5349`), on
sending a prompt (`:5814` — its own comment says *"sending IS the acknowledgement"*), on
clear (`:8880`), and on close (`:8864`, `:9075`). Every way an operator touches a seat
already clears it. Nothing needs a dedicated control.

**The operator has no release control where the team is.** `completed_at` has exactly one
writer in the codebase: `LocalApiServer.ts:2469`, inside `POST /kanban/task/complete`. No
webview reaches it. The board's `completeSelected` / `completeAll`
(`KanbanProvider.ts:12040`, `:12074`) release a team only as a side effect — they write
`status='completed'`, and `getBoard` filters `status='active'`, so the card stops being
scanned. That works, but it is on the kanban board, and it releases by removing the card
rather than by asserting it finished. Mission Control's `STOP` (`mcStopMission`) calls
`releaseDispatchHolder`, but only over mission members and framed as aborting the run.

**Why held cards accumulate.** `dispatched_terminal` was added in V57 for
*"completion-broadcast pane targeting"* (`KanbanDatabase.ts:8673`) — a card→seat attribution
used to decide which pane gets the DONE badge. The release contract later re-read it as "this
seat holds this card". Three consequences follow, and together they are why a seat collects a
trail:

1. **It is per-card, not per-seat.** Dispatch writes the new card's row
   (`updateDispatchInfoByPlanFile:10117`, `attributePasteDispatch:10159` — both single-row
   `UPDATE ... WHERE plan_file = ? AND workspace_id = ?`). Nothing walks the seat's other
   cards, and no constraint says a seat holds one card. Card A → seat X survives verbatim
   when card B → seat X is written.
2. **Completion does not clear it.** `setCompletedAt` (`:3057`) is one statement over
   `completed_at` and `updated_at`. The Release Contract table in
   *one-release-signal-remove-the-reviewer-from-the-coding-team.md* lists
   `dispatched_terminal` as "cleared by: re-stage to the queue; completion" — the completion
   half is aspirational. The only writer that clears it is `releaseDispatchHolder`, reached
   from exactly two places: the escalation re-stage (`LocalApiServer.ts:3050`) and
   `mcStopMission` (`KanbanProvider.ts:9999`).
3. **The gate is on one path only.** The in-flight refusal guards `queue/next`. The lead→coder
   path does not go through it: the fleet delivery layer fires `attributePastedPrompt`, which
   stamps the subtask to the receiving seat with no check on what that seat already holds. A
   lead handing eight subtasks to two coders writes eight holder edges across two seats, and
   only a `queue/next` would ever object.

So the build-up is structural, not a leak. On this workspace `team_Coding`
(`Coding`, `Coding-coder-1`, `Coding-coder-2`, `Coding-intern`) holds 30 such cards.

**Scope decision — the dispatch side.** This plan does not change what dispatch writes. Making a
dispatch release the seat's older cards would redefine `dispatched_terminal` for the
completion broadcast that owns it, and the queue's own refusal already prevents accumulation
on the path it guards. The control is the fix here; the dispatch-side semantics are their own
plan.

**Scope decision — why this is not folded into the advance mechanic.** The obvious cheaper
design is to skip the button and have the generic advance action write the completion: an
operator moving a card forward has asserted it is done, so let the advance release the team.
Recorded here with its refutation, because it is the first thing a reader will propose and it
is a restatement of the signal the parent feature deleted.

- **Advance is agent-reachable, and the caller cannot be identified.** `moveCardForward`,
  `moveSelected`, `moveAll` and `triggerAction` are all in `src/generated/verbAllowlist.ts`, so
  any agent can `POST /kanban/verb/moveCardForward`. `LocalApiServer` carries no origin marker
  on the verb route, and webview `originatorId` stamping is a frozen no-op in the editor host,
  so there is no way to separate "an operator asserted done" from "an agent moved a card". If
  advancing writes `completed_at`, a lead releases its own team by moving a card. That is the
  deleted second signal, restored as an explicit write rather than a derived read — which
  makes it *harder* to find later, not easier.
- **Advancing usually means work is starting.** Dropping a card into a coding column fires the
  dispatch (the move↔dispatch coupling `performKanbanDispatch` calls "the exact arm a webview
  drag fires"). The move that would write the completion is the move that hands the card to a
  coder.
- **Feature advances cascade.** `moveCardToColumnWithReason` (`KanbanProvider.ts:8263`) cascades
  a feature move to every subtask, so one advance would assert completion across all of them.

Where the instinct is sound it is already implemented: advancing to `COMPLETED` via
`completeSelected` / `completeAll` writes `status='completed'`, and `getBoard` filters
`status='active'`, so the card leaves the predicate's view. At the one column where advance
unambiguously means finished, the advance mechanic already carries the release. The gap this
plan closes is the middle of the pipeline — a card moved out of a coding column is past the
coding work but is not finished, and that exact move is what the deleted signal released on.
Leads stall in the middle, which is the one place advance cannot be read as done.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, api, reliability

## User Review Required

None. Release scope, visibility rule and label are decided below.

## The habit problem, and why visibility is the answer

A permanent button becomes a step. If `RELEASE` sits in the team panel through every healthy
run, operators learn to end a run by pressing it, and that habit substitutes for the lead's
post — a second release signal re-entering as a human ritual rather than as code, where no
grep will find it. That is the failure the parent feature removed from `teamWiring.ts`.

Renaming does not fix it; a control that is always on screen reads as part of the workflow
whatever it says. **Absence does.** The button is hidden unless the scoped team currently holds
at least one card with no completion. In a healthy run the lead posts per subtask, the count is
zero, and there is no button to form a habit around. It appears only once the lead has stopped
posting — which is the moment an operator should intervene, and the button appearing *is* the
diagnosis.

That settles the label too: it carries the count — `RELEASE 3 HELD CARDS` — so it reads as a
report of a problem, not an instruction. A step whose name contains a number that is usually
zero is not a step.

`btn-team-restart` (`terminals.js:4753-4760`) already has this shape — hidden by scope, state
recomputed on every `renderSidebarList`. Follow it rather than inventing a pattern.

## Complexity Audit

### Routine

- Swapping one click handler.
- Adding a `hidden` / label update inside an existing render pass.

### Complex / Risky

- The panel cannot compute the card set. `KanbanCard` (`KanbanProvider.ts:126-151`) carries
  no `dispatchedTerminal` and no `completedAt`, and the fleet row's plan strip retires the
  moment `dispatched_at` is nulled — which is exactly when the seat has reported done and the
  card most needs releasing. The server must resolve it.
- The count is read on the 5s `renderSidebarList` cadence. It must not add a per-tick board
  scan per panel.
- The release is N completion posts from one click. Each must be independently attributed and
  survive a partial failure.
- Extracting `task/complete`'s core into a shared `completeCardInternal` helper without
  breaking the existing `task/complete` route — the helper must preserve the idempotency check,
  coding-seat resolution, `clearTerminalContext`, and event recording exactly as the current
  handler does.

## Edge-Case & Dependency Audit

### Race Conditions

- A lead posting completion between the count read and the click shrinks the set. The server
  re-resolves at release time and posts for what it finds then; `task/complete` is already
  idempotent (`LocalApiServer.ts:2399` returns the existing record without rewriting), so a
  card completed in the gap is a no-op, not an error.
- Two panels open on one team both release. Second one finds an empty set and reports zero.

### Security

- No caller-supplied plan list. The client sends the team's head name; the server derives the
  card set. A body naming arbitrary planIds would let any panel complete any card.

### Side Effects

- Cards released this way carry a `completed` plan event whose `workflow` field is
  `'operator-release'`, not `'task-complete'`. That is the audit trail for "a human asserted
  this", and it must be distinguishable from a lead's post in `plan_events`.
- The coder's terminal context is cleared via `clearTerminalContext` (same as the lead's post)
  — the shared `completeCardInternal` helper ensures this. Without it, a coder whose card the
  lead forgot to post would keep the stale context in its pane after an operator release.
- Badges for the successfully released seats clear as a consequence of the release, which is
  the coupling the current button fakes. Badges for failed releases stay lit.

### Dependencies & Conflicts

- `terminals.html` (button markup) and `terminals.js` (handler, visibility) — the same two
  files as the head-prompt work. Sequence after anything in flight there.
- `LocalApiServer.ts` gains one route and one extracted helper (`completeCardInternal`). The
  existing `POST /kanban/task/complete` route must be refactored to call the helper — this is
  an in-place refactor of an existing route, not just an addition. The `task-complete` contract
  test must still pass unchanged.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) a shadow completion path — calling `setCompletedAt` + `appendPlanEventByPlanId`
directly instead of the `task/complete` handler, skipping `clearTerminalContext` and creating
two completion paths that drift apart; (2) the button ships always-visible because the count
plumbing is deferred "for now" — that is the habit problem shipping intact, and the visibility
rule is the feature, not a polish item; (3) a client-supplied planId list, which turns a team
control into a complete-anything endpoint; (4) a per-tick board scan per open panel at 5s;
(5) partial failure reported as success, so an operator believes a team is released while a
card still blocks it; (6) the `heldUnposted` count specified as "keyed per team" when the
server cannot enumerate teams. Mitigations: extract `task/complete`'s core into a shared
`completeCardInternal` helper both routes call; the count gates rendering in the same pass
that renders the button; the request body carries only `from` and `workspaceRoot`; the count
rides the existing `ptyListTerminals` poll as a per-terminal map (one scan per poll, client
aggregates per team) rather than a new per-tick fetch; the response reports released and
failed planIds separately and the button re-renders from the fresh count rather than assuming
zero; the client clears badges only for successfully released seats.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — `POST /kanban/team/release`

Body `{ from, workspaceRoot? }`. Resolves the roster for `from` through
`resolveTeamMembers` — the same path the in-flight predicate uses, so the released set and the
refused set cannot disagree. Selects active cards whose `dispatched_terminal` is in the roster
and whose `completed_at` is NULL, and for each calls the shared completion helper (see below)
with `workflow: 'operator-release'` so the `plan_events` row is distinguishable from a lead's
post.

> **Superseded:** for each calls `setCompletedAt` plus `appendPlanEventByPlanId` with an
> `operator-release` marker in the payload
> **Reason:** This creates a shadow completion path. The `task/complete` handler
> (`LocalApiServer.ts:2399-2497`) does four things: resolves the coding seat from HOST evidence,
> writes `completed_at` via `setCompletedAt`, appends a `plan_events` row, AND clears the coder's
> terminal context via `clearTerminalContext` (`:2487`). Calling `setCompletedAt` +
> `appendPlanEventByPlanId` directly skips the seat resolution and the terminal context clear —
> so a coder whose card the lead forgot to post still has that card's context in its pane after
> an operator release. Worse, any future side effect added to `task/complete` (webhook,
> integration sync) is silently bypassed. The plan's own argument for sharing the `heldByTeam`
> predicate is the argument for sharing the completion handler.
> **Replaced with:** Extract `task/complete`'s core logic into a shared
> `completeCardInternal(db, planId, from, opts)` helper that both `POST /kanban/task/complete`
> and `POST /kanban/team/release` call. The helper performs: (1) idempotency check via
> `getPlanByPlanId`, (2) coding-seat resolution from HOST evidence (the row's
> `dispatchedTerminal` + `routedTo`, then the live fleet role), (3) `setCompletedAt`, (4)
> `appendPlanEventByPlanId` with a `workflow` field passed by the caller (`'task-complete'` for
> the lead's post, `'operator-release'` for the operator release), (5) `clearTerminalContext`
> for the resolved coding seat. The release route passes `from` as the team head name (so the
> head's own terminal is never cleared, same guard as `task/complete` at `:2463`). This gets
> `clearTerminalContext` for free and prevents future drift between the two completion paths.

Reuses the existing predicate rather than restating it: extract the `heldByTeam` test from
`_runQueuePop` (`:1925`) into a module-level helper `(p: any, teamSet: Set<string>) => boolean`
that both sites call — the in-flight refusal passes its own `teamSet` built from the roster, and
the release route passes the `teamSet` it resolved. The helper is a closure over `teamSet` in
the current code (`:1925`), so it cannot be hoisted parameterless; `teamSet` must be a parameter.
A second hand-written copy is how the gate and the release drift apart.

Returns `{ success, released: [planId], failed: [{planId, error}] }`. A per-card failure does
not abort the rest.

### 2. `src/services/LocalApiServer.ts` — held count on the fleet poll

> **Superseded:** Add `heldUnposted` (a number) to the response the panel already polls for the
> terminal list, keyed per team.
> **Reason:** The server cannot enumerate teams. `resolveTeamMembers`
> (TaskViewerProvider.ts:10688) takes a head name and returns a roster — it resolves FROM a head,
> not TO one. The `ptyListTerminals` verb goes through the `terminalVerb` seam
> (LocalApiServer.ts:3838), which is the PTY manager and has no team group knowledge. There is no
> server-side list of team heads to iterate. "Keyed per team" is infeasible from the server.
> **Replaced with:** Add `heldUnposted: { [terminalName]: number }` — a per-terminal map of
> held-uncompleted card counts. The server scans active cards once per poll (via
> `getBoard` → filter `dispatched_terminal != '' && completed_at IS NULL`), groups by
> `dispatched_terminal`, and emits the map. The client sums the counts for
> `getScopedTeamSnapshot().members` to get the scoped team's total. One scan per poll, O(members)
> client-side aggregation — not per seat, not per panel.

The augmentation happens in `_handleTerminalVerb` (LocalApiServer.ts:3838) **after** the
`terminalVerb` call returns, only for the `ptyListTerminals` verb. The handler has access to
`this._options.getKanbanDatabase?.(workspaceRoot)` — the same seam `task/complete` uses. Do NOT
modify the `terminalVerb` implementation itself (that is the PTY manager, a different layer with
no kanban coupling, and may be unavailable on the standalone host). When `getKanbanDatabase` is
absent or returns null (standalone host without a DB), omit `heldUnposted` from the response —
the client treats a missing field as zero for every terminal.

### 3. `src/webview/terminals.html:2431` — the button

Replace the `ACKNOWLEDGE COMPLETIONS` markup with a `RELEASE …` button. The label text is
written by the render pass (it carries the count), so the markup holds only the id, classes and
`hidden`.

### 4. `src/webview/terminals.js:4744` — visibility

Replace `btnTeamAck.hidden = !teamScopeId` with `hidden = !teamScopeId || heldCount === 0`,
and set the label to `RELEASE ${heldCount} HELD CARD${heldCount === 1 ? '' : 'S'}` in the same
pass. `heldCount` is computed by summing `heldUnposted[memberName]` for every member in
`getScopedTeamSnapshot().members` — the per-terminal map comes from the `ptyListTerminals`
response (proposal #2), and the team aggregation is O(members) on the client. Recomputed
on every `renderSidebarList`, exactly as `btn-team-restart` recomputes its disabled state.

### 5. `src/webview/terminals.js:9206` — the handler

`clearTeamBadges` stops being a click target. The new handler POSTs
`/kanban/team/release` with the scoped team's head name, then clears the badges for the
**successfully released** seats only — mapped from the `released` planId array in the response,
not all seats in the request. A partial failure (3 of 5 released) clears badges for the 3
succeeded seats and leaves the 2 failed seats' badges lit; the count re-fetch shows 2, the
button stays, and the operator sees the failure. Re-fetches `fetchTerminalList()` so the count
(and therefore the button) re-renders from the server. No confirm gate (CLAUDE.md).

Keep the badge-clearing code itself — it is still called by the bulk-clear paths at `:9018`
and `:9046`.

### 6. Tests

- The release set equals the in-flight refusal set: a team that 409s on `queue/next` releases
  exactly those cards, and `queue/next` then dispatches.
- The route ignores any planIds in the body.
- One failing `setCompletedAt` leaves the other releases intact and is reported in `failed`.
- A released card carries a `plan_events` row with `workflow: 'operator-release'`,
  distinguishable from a lead's `workflow: 'task-complete'` post.
- The shared `completeCardInternal` helper is called by both `POST /kanban/task/complete` and
  `POST /kanban/team/release` — a spy on the helper fires from both routes.
- An operator release clears the coder's terminal context via `clearTerminalContext` (same
  behavior as the lead's post) — the spy on `clearTerminalContext` fires for the resolved
  coding seat.
- `heldUnposted` is a per-terminal map, not a per-team map; the client sums for the scoped
  team's members.
- `terminals.js` renders the button hidden at count 0 and labelled with the count above 0.
- The panel never posts a planId it chose itself.
- Partial failure: the client clears badges only for seats whose planIds appear in the
  `released` array, not for `failed` planIds.

## Verification Plan

### Automated

- New `team-release-control-contract.test.js`, wired into `package.json` **and**
  `.github/workflows/integration-tests.yml` in the same change — a contract named in a plan
  and absent from CI is the hole this workspace keeps re-finding.
- Existing `queue-pipeline`, `task-complete`, `atomic-team-lifecycle` — the release must not
  alter the refusal, and `task/complete` must still pass after the `completeCardInternal`
  extraction (regression).
- `catalog:check` / `parity:check` if the route is exposed as a verb rather than a bare route.

### Goal Invariants

- `clearTeamBadges` has no click-handler caller.
- The button is absent whenever the scoped team holds no un-posted card.
- The button's label contains the count.
- The release request body carries no planId.
- The released set is computed by the same helper the in-flight refusal uses.
- Both `POST /kanban/task/complete` and `POST /kanban/team/release` call the same
  `completeCardInternal` helper — no second hand-written completion path.
- `heldUnposted` in the `ptyListTerminals` response is a per-terminal map
  (`{ [terminalName]: number }`), not a per-team map.
- The `heldByTeam` module-level helper takes `teamSet` as a parameter
  (`(p: any, teamSet: Set<string>) => boolean`), not a parameterless closure.
- The client clears badges only for seats whose planIds appear in the `released` array.

### Manual Verification

1. Team holding nothing: no button in the panel.
2. Lead finishes a subtask and does not post: button appears reading `RELEASE 1 HELD CARD`.
3. Click it: card gets `completed_at`, badge clears, button disappears, `queue/next` dispatches.
4. Lead posts normally through a whole feature: button never appears once.
5. On this workspace before any cleanup: reads `RELEASE 30 HELD CARDS` and clears them in one
   click.

## Recommendation

Send to Coder. The visibility rule is not separable from the button — shipping the control
always-visible delivers the habit this plan exists to prevent.

## Implementation Summary

Extracted `completeCardInternal` in `src/services/LocalApiServer.ts` as a shared core for `POST /kanban/task/complete` and the new `POST /kanban/team/release` endpoint. Exposed module-level `heldByTeam(p, teamSet)` and augmented `ptyListTerminals` with a per-terminal `heldUnposted` map. Updated `src/webview/terminals.html` and `src/webview/terminals.js` to render the button visible only when the scoped team holds uncompleted cards, labelled with the count, and wired click action to release cards via API and clear badges only for released seats. Added `team-release-control-contract.test.js` and wired it into `package.json` and `.github/workflows/integration-tests.yml`.

