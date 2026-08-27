# The Team In-Flight Predicate Already Exists — Expose It To The Rail

## Goal

Show, on each team's rail slot, whether that team is currently holding work. Free reads
as the plain accent icon; dispatched reads as the accent icon plus a state indicator. The
signal is not invented for this plan — the server already computes exactly this predicate
to refuse double-dispatch, and it is currently visible only as a 409 error string.

### The problem, and the root cause

The rail's per-team `light` (`terminals.js:1707`) has three values: `done`, `active`,
`exited`. `active` means *at least one member process is alive* — not *this team is
working*. So the rail can distinguish a running team from a dead one and cannot
distinguish an idle team from a grinding one, which is the distinction the operator
actually needs when deciding where to send the next card.

The other candidate signal is worse. `dispatchInFlight` (`terminals.js:239`) counts
`ptySendPrompt` HTTP requests still in flight, and `resendStandingOrders` uses it to label
members idle or busy (`terminals.js:11875`). It drops to zero the instant the POST
returns, while the agent works for the next ten minutes. It is a request counter wearing
the name of a work state.

**The real predicate is already implemented server-side.** `LocalApiServer.ts:1924-1954`,
in the team-dispatch handler:

```
A team is in flight when any card belonging to it is held by a team member and has
no completion post (completed_at is NULL).
```

`heldByTeam(p) = !p.completedAt && p.dispatchedTerminal && teamSet.has(p.dispatchedTerminal)`

Its comment is emphatic about the semantics: *"Exactly ONE fact releases a team:
`completed_at` (the lead's explicit POST /kanban/task/complete). Board position
(kanban_column) is not part of the predicate — moving a card never releases a team."*

That is dispatch → completion post, atomic at the team level: any member holding work
means the team is dispatched. It matches the required semantics exactly. It is computed on
every dispatch attempt and then thrown away, surviving only inside a 409 message.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, backend, api, ui, feature
- **Feature:** 4c1323fb-a025-467f-b289-88f50b1f8347

## User Review Required

No user review required — plan is in PLAN REVIEWED status and ready for dispatch.

## Complexity Audit

### Routine
- Adding `inFlight: boolean` to the `GET /terminals/teams/<groupId>/queue` response body.
- Storing `_teamInFlight` alongside `_teamQueueDepths` in `terminals.js`.
- Emitting `dispatched: _teamInFlight.get(g.id)` in `buildTeamsForShell`.
- Rendering a shape-based state indicator on a slot with `dispatched: true`.

### Complex / Risky
- Extracting `heldByTeam` and its fresh-read scan from the dispatch handler into a shared helper — the load-bearing part of the plan. A second, parallel implementation for the rail is the failure mode to avoid. The helper must support a short-circuit mode: the rail only needs the boolean (stop at first held card), while the dispatch gate needs to scan all candidates for the 409 error message. Without short-circuit, the rail path does N per-candidate `db.getPlanByPlanId` reads on every poll cycle — a performance regression.
- Preserving the fresh-read behaviour verbatim — the existing scan re-reads every candidate row via `db.getPlanByPlanId` before concluding. This is a fail-open the gate exists to close. The helper keeps it; the rail path can tolerate the cost WITH short-circuit.
- Composition-root wiring — if the endpoint needs a new option hook, wire it in both `TaskViewerProvider.ts` and `bootstrap.ts`.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Poll latency: the dispatched state is only as fresh as the queue poll. A card dispatched a moment ago shows free until the next tick. Acceptable for an indicator; NOT acceptable as a gate — nothing in the UI may use this flag to decide whether a dispatch is allowed. The server's 409 remains the only authority. State this in a code comment.

**Security:**
- No new attack surface. Read-only endpoint extension.

**Side Effects:**
- `releaseDispatchHolder` clears `dispatchedTerminal` when a card returns to the queue, so the predicate frees the team without a completion post. The rail inherits this for free.
- A dispatched team whose members all died: `inFlight` is true (no completion post) while `light` is `exited`. Both facts are real. Precedence: absent/dead rendering wins over dispatched, since a dead team cannot be sent work — but the held card is still held and should be surfaced in the Terminals panel.

**Dependencies & Conflicts:**
- **Team-slots plan** — the dispatched indicator renders on a team slot. Slots must exist before this plan's indicator can render. Slots can ship first wearing no indicator.
- **Colour plan** — the indicator is a shape channel (not a second hue) because the accent is already spent on team-ness. The colour plan's "selection becomes a shape" decision and this plan's "dispatched becomes a shape" decision must not collide — the dispatched indicator must be visually distinct from the selection bar.

## Dependencies

- **Team-slots plan** — must have created the three fixed slots. The dispatched indicator renders on a slot; without slots, there is no surface to render on.
- **Colour plan** — must have freed the accent from selection. The dispatched indicator is a shape channel by design, but the colour plan's selection-bar shape and this plan's dispatched indicator must be visually distinct.

## Adversarial Synthesis

Key risks: (1) performance regression from per-candidate `db.getPlanByPlanId` reads on every poll cycle — the dispatch handler runs the scan once per attempt (rare), but the queue poll runs continuously. The helper MUST support a short-circuit mode (stop at first held card) for the rail path. (2) Poll latency vs dispatch gate authority — the flag is an indicator, not a gate; the 409 is the authority. (3) Shape collision between selection bar and dispatched indicator — must be visually distinct. Mitigations: (1) add short-circuit parameter to the helper, (2) plan explicitly states 409 is the authority, (3) plan specifies "an accent arc or inset ring distinct from the deleted completion pulse, or a small filled corner mark."

## No migration

Clean break. Read-only derived state, nothing persisted. CLAUDE.md's migration rule is
waived for this release.

## Scope: both composition roots

The read endpoint is served by `LocalApiServer`, shared. But the resolver hooks it depends
on are wired per host and this is exactly the divergence class CLAUDE.md warns about — the
four `PlanIngestionEngine` queue seams were wired in `extension.ts` only for a month and
every gate stayed green. If this endpoint needs a new option hook, wire it in **both**
`TaskViewerProvider.ts` and `bootstrap.ts` in the same diff, and confirm by reading both
composition roots side by side. A `Promise<void>` seam that is never wired is
indistinguishable from one that works.

## Implementation

1. **Extract the predicate.** Lift `heldByTeam` and its fresh-read scan out of the
   dispatch handler into a single exported helper — `resolveTeamInFlight(workspaceRoot,
   teamMemberNames) → { inFlight: boolean, planId?, dispatchedTerminal? }`. The dispatch
   handler then calls the helper instead of inlining it, so there is exactly one
   definition of "in flight" and the 409 and the rail cannot drift apart. **This is the
   load-bearing part of the plan** — a second, parallel implementation for the rail is the
   failure mode to avoid.
2. **Preserve the fresh-read behaviour verbatim.** The existing scan re-reads every
   candidate row via `db.getPlanByPlanId` before concluding, because a stale board row
   whose fresh read shows a completion must not end the scan (`LocalApiServer.ts:1934`).
   That is a fail-open the gate exists to close. The helper keeps it; the rail path is a
   read and can tolerate the cost.
3. **Serve it on the existing per-team route.** `GET /terminals/teams/<groupId>/queue`
   (`LocalApiServer.ts:4725`) is already polled per team by `refreshTeamQueueDepths`
   (`terminals.js:1642`). Add `inFlight` to its response body. No new endpoint, no new
   poll, no new fetch loop — the transport for per-team server facts already exists and
   already runs.
4. **Store and relay.** Alongside `_teamQueueDepths`, keep `_teamInFlight`. In
   `buildTeamsForShell` (`terminals.js:1743`), emit `dispatched: _teamInFlight.get(g.id)`
   beside the existing `queueDepth`.
5. **Render.** In `renderTerminalSection`, a slot with `dispatched: true` gets the state
   indicator. Per the colour plan, the accent is already spent on team-ness, so the
   indicator is a **shape** channel, not a second hue: an accent arc or inset ring
   distinct from the deleted completion pulse, or a small filled corner mark. It must not
   be a solid accent border on the button — that reads as panel selection
   (`shell.html:348`).
6. **Stale beats absent.** `refreshTeamQueueDepths` already comments "stale depth beats no
   depth" and keeps the last value on fetch failure. Same for `inFlight`: keep the last
   known value rather than flickering to free, because flickering to free invites a
   dispatch the server will 409.

## Edge cases

- **Poll latency.** The dispatched state is only as fresh as the queue poll. A card
  dispatched a moment ago shows free until the next tick. Acceptable for an indicator;
  **not** acceptable as a gate — nothing in the UI may use this flag to decide whether a
  dispatch is allowed. The server's 409 remains the only authority. State this in the
  code comment or someone will wire it into a client-side guard.
- **A team holding two cards.** The predicate scans every candidate and does not stop at
  the first (`LocalApiServer.ts:1936`). `inFlight` is a boolean either way; do not reduce
  it to a count without deciding what the rail should do with the number.
- **A card whose holder was released.** `releaseDispatchHolder` clears
  `dispatchedTerminal` when a card returns to the queue, so the predicate frees the team
  without a completion post. Correct, and the rail inherits it for free.
- **A dispatched team whose members all died.** `inFlight` is true (no completion post)
  while `light` is `exited`. Both facts are real. Decide the precedence explicitly:
  absent/dead rendering wins over dispatched, since a dead team cannot be sent work — but
  the held card is still held, and that is a condition worth surfacing in the Terminals
  panel rather than silently.
- **Non-running slots.** Do not poll `/terminals/teams/<null>/queue` for a dim slot.
- **External-headed teams** (`POST /teams/create-external`, `LocalApiServer.ts:3358`) have
  a non-terminal lead. Confirm `teamSet` membership resolves for them, or their slot
  reports free forever.

## Verification plan

1. `npm run compile` clean.
2. Dispatch a card to a team; confirm its slot shows dispatched within one poll interval.
3. Post `/kanban/task/complete`; confirm the slot returns to free.
4. **Move the card between columns without completing it**; confirm the slot stays
   dispatched — this is the specific behaviour the server comment pins and the most likely
   thing to be got wrong.
5. Attempt a second dispatch to a dispatched team; confirm the 409 still fires and its
   message still names the held card, i.e. the extraction did not change the gate.
6. Kill the network to the queue endpoint mid-session; confirm the last known state is
   held rather than flickering to free.
7. Dispatch to a team, then kill every member; confirm the precedence decision renders as
   specified and the held card is still discoverable.
8. Both hosts, with both composition roots read side by side for the resolver wiring.

### Goal Invariants

- Assert `resolveTeamInFlight` is an exported function in `src/services/LocalApiServer.ts` (or a shared module) that returns `{ inFlight: boolean, planId?, dispatchedTerminal? }`.
- Assert the team-dispatch handler at `src/services/LocalApiServer.ts:1938` calls `resolveTeamInFlight` instead of inlining `heldByTeam`.
- Assert `GET /terminals/teams/<groupId>/queue` response body includes an `inFlight: boolean` field.
- Assert `buildTeamsForShell` in `src/webview/terminals.js` emits `dispatched: boolean` on each team entry.
- Assert the rail renders a shape-based state indicator on slots with `dispatched: true`, distinct from the selection bar.
- Assert nothing in the UI uses the `inFlight` flag to gate a dispatch — the 409 remains the only authority.
- Assert `resolveTeamInFlight` supports a short-circuit mode (stops at first held card) for the rail path.
- Assert the 409 error message still names the held card after extraction (gate behaviour unchanged).
