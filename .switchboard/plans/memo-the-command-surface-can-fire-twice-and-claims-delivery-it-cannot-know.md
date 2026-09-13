# The Command Surface Re-Arms After an Unknown Outcome, Claims a Delivery It Cannot Know, and Is Locked to One Workspace

## Goal

The phone command surface must not invite a retry that fires an agent twice, must not report a delivery it has no evidence of, and must serve every workspace (not silently lock to one). The double-dispatch race is closed with a server-side idempotency-key dedup; the workspace selector is made genuinely multi-workspace with a `/workspaces` read route and per-card `workspaceRoot` in the push projection.

### Problem analysis

Five reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They share `src/webview/command.js`, a 2,250-line file that **no test file reads** — `grep -rl "webview/command.js" src/test/` returns nothing.

This is the surface designed to be used from a phone, over a link that drops. Two of the five are specifically about what happens when it does.

## Metadata

- **Complexity:** 5
- **Tags:** command-surface, mobile, testing, bugfix
- **Project:** switchboard

## User Review Required

None. Both open decisions are resolved: Change 1 lands server-side idempotency-key dedup with this plan; Change 3 adds a `/workspaces` read route (multi-workspace, not a declared limitation).

## Complexity Audit

### Routine
- Change 2 (dispatch-chip wording) is a small, localized string/vocabulary fix in `command.js`.
- Change 5 (unit tests for `filterByProject` and `resolveTeamSeats`) is additive — two pure functions, no existing test reads the file.
- The three unknown-outcome re-arm sites are the same shape at three call sites (mission, team, advance).

### Complex / Risky
- **Idempotency-key enforcement is server-side, not client-side.** Change 1 lands both halves: the client generates a fresh UUID per gesture and sends it in the request body, AND the server's `/kanban/advance` / acked-mission path dedupes on the key. An idempotency key the server ignores is theater — the double-dispatch race is only closed if the server actually dedupes, so the server-side dedup is in scope for this plan, not a follow-up.
- **Change 3 adds a `/workspaces` read route.** This is real server work: a new endpoint that returns the list of workspaces (the DB already has `getWorkspaceMappings`), plus emitting `workspaceRoot` per card in the push projection so `extractWorkspaceProjects` no longer falls back to one constant. The selector populates from the route; card filtering uses the real per-card `workspaceRoot`. This makes the surface genuinely multi-workspace.
- **Change 4 (UAT) is blocked on external work.** A genuine zero-poll idle pass and device-layout screenshots depend on the board-payload work landing first, since that changes what the surface fetches. It is a verification pass, not a code deliverable, and is deferred.

## Edge-Case & Dependency Audit

**Race Conditions:** The core defect is a race: on a dropped connection the first request may have succeeded, so a blind retry advances a card and dispatches an agent a second time. The idempotency key makes a retry safe only if the server dedupes; without server enforcement the race is unchanged.

**Security:** The idempotency key is a client-generated UUID sent in the request body. It must not be guessable or reusable across gestures — generate a fresh UUID per launch gesture, not a stable per-card key (a stable key would suppress legitimate re-dispatch after a genuine failure was corrected).

**Side Effects:** Disabling blind re-arm changes operator workflow — on a genuinely-failed (not dropped) dispatch, the operator must explicitly re-arm or re-select. The unknown-outcome state must make "I don't know" actionable without making "try again" the default affordance.

**Dependencies & Conflicts:**
- **Server-side idempotency-key dedup** on `/kanban/advance` (and the acked mission path) is in scope for this plan (Change 1). The endpoint must store the key→result mapping for a TTL window and return the prior result on a retry with the same key instead of re-dispatching. Neither endpoint currently carries or checks an idempotency key.
- **Change 3** adds a `/workspaces` read route and emits `workspaceRoot` per card in the push projection. The DB already has `getWorkspaceMappings`; the route is new.
- **Change 4 (UAT)** depends on the board-payload work landing first; running it before would test a fetch shape that is about to change.

## Dependencies

- `sess_board_payload_rework` — Change 4 (UAT) is blocked on the board-payload work that changes what the surface fetches. Deferred until that lands.

## Adversarial Synthesis

Key risks: (1) an idempotency key the server ignores is theater — the double-dispatch race is unchanged unless `/kanban/advance` actually dedupes, so the server-side dedup is in scope, not a follow-up; (2) the three re-arm sites include a `finally` block (team action, command.js:1314-1316) that re-arms on success too, so the fix must target the unknown-outcome path specifically, not the whole gesture; (3) Change 3's `/workspaces` route must emit `workspaceRoot` per card in the push projection or the selector populates but card filtering still falls back to one constant; (4) Change 4 is a UAT pass blocked on unrelated board-payload work and should not gate the codeable changes. Mitigations: server-side dedup lands with Change 1; scope the re-arm fix to the three unknown-outcome sites; the `/workspaces` route and per-card `workspaceRoot` projection land together in Change 3; defer Change 4.

## Proposed Changes

### 1. An unknown outcome re-arms the control, so a retry can fire twice

`command.js:1877-1879` sets `setMissionChip('Outcome unknown (connection dropped)', 'unknown')` and then `btnLaunchMission.disabled = false`. The same shape appears at `:1312-1316` for the team action (the `finally` block re-arms `btn.disabled = false`) and at `:1668-1672` for advance (the `catch` sets "Advance failed (offline)" and `btnDispatch.disabled = false`).

The operator is told the outcome is unknown and simultaneously invited to try again. On a dropped connection the first request may well have succeeded, so the retry advances a card and dispatches an agent a second time.

**Fix.** Scope the fix to the surface's three unknown-outcome sites. **Client side:** generate a fresh idempotency key (UUID) per launch gesture and send it in the request body. **Server side (in scope for this plan):** `/kanban/advance` / the acked-mission path must dedupe on the key — store the key→result mapping for a TTL window and return the prior result on a retry with the same key instead of re-dispatching. The key is per-gesture (fresh UUID each time the operator initiates), never a stable per-card key, so a legitimate re-dispatch after a corrected failure is not suppressed. With server dedup, the control may safely re-arm on unknown outcome; without it the re-arm is still blind.

> **Superseded:** The original note named `/kanban/dispatch` as the endpoint.
> **Reason:** The endpoint has since moved to `/kanban/advance` and the acked mission path, and neither carries an idempotency key.
> **Replaced with:** Scope the fix to the three unknown-outcome sites on the current `/kanban/advance` / acked-mission path, with a server-side dedup dependency.

### 2. The dispatch chip claims a delivery the poll cannot observe

`KanbanDatabase.ts`'s own docblock records that `dispatched_at` is stamped **before** the send is dispatched (the operational field; see KanbanDatabase.ts:258, 390, 1019). `command.js:1586` then settles the chip to `Dispatched to ${result.seat || result.dispatchedAgent || 'agent'}` on `result.state === 'dispatched'`.

So the chip reports delivery on the strength of a timestamp written before anything was delivered.

**Fix.** Small, and mostly wording: introduce a pending and settled vocabulary, and let the chip say what is actually known — "sent" (the request was accepted) vs "delivered" (evidence the seat received it). Do not claim the latter from `dispatched_at`.

### 3. The surface can only ever show one workspace

`_readRows` emits `workspaceId` and `workspaceName` but never `workspaceRoot`; the push projection stamps one constant `resolvedWorkspaceRoot`; `extractWorkspaceProjects` (`command.js:490-507`) falls back to `currentWorkspaceRoot` for every card; and no `/workspaces` route exists.

The header selector therefore lists exactly one workspace, always.

**Fix (multi-workspace).** Add a `/workspaces` read route that returns the list of workspaces (the DB already has `getWorkspaceMappings`). Emit `workspaceRoot` per card in the push projection so `extractWorkspaceProjects` no longer falls back to one constant. The selector populates from the route; card filtering uses the real per-card `workspaceRoot`. This makes the surface genuinely multi-workspace — an operator on a phone can switch between workspaces and see/dispatch cards in each.

### 4. The surface has never met a real device **[deferred]**

`mobile-command-route-contract.test.js:156-159` asserts only the **absence** of `/kanban/plans`, `fetchBoardCards` and `setInterval` in the source. It cannot observe network traffic and it cannot observe layout.

So the two claims that matter — a genuinely zero-poll idle over the tailnet, and the layout at 390×844 and 1180×820 against the study artifact — are undischarged. This is a UAT pass, and it should be run **after** the board-payload work lands rather than before, since that changes what the surface fetches. **Deferred** — not a code deliverable in this plan; tracked as a dependency.

### 5. Nothing tests the file at all

Zero test files read `command.js`. Two of its functions are pure and trivially testable: `filterByProject` (`command.js:705`) and `resolveTeamSeats` (`command.js:1257`).

`resolveTeamSeats` matters beyond this surface. `startTeamById` refuses to start a team whose head role is already live and unparented (`teamWiring.ts:1419-1448`, refusal at `:1443-1447`), which means the roster plan's "two lead-headed teams" scenario **cannot be set up through the interface** — so the unit test is the only way that contract can be checked at all. The test should assert the refusal contract (a second head with the same role is refused with the naming message), since that is the behavior the UI enforces and the unit test is the only path to exercise it.

## Verification Plan

### Automated Tests
- Add `src/test` assertions over `filterByProject` and `resolveTeamSeats`, including the two-lead roster case that the UI cannot reach (assert the `startTeamById` refusal contract for a duplicate head role).
- Existing `mobile-command-route-contract.test.js` continues to pass (absence assertions for `/kanban/plans`, `fetchBoardCards`, `setInterval`).

### Goal Invariants
- Assert the three unknown-outcome sites (mission `:1877`, team `:1312`, advance `:1668`) do not blind-re-arm on a dropped connection — a retry carries an idempotency key and the server dedupes on it (no double-dispatch).
- Assert the dispatch chip does not render "delivered" from `dispatched_at` alone (it renders "sent" or equivalent pending vocabulary until delivery is evidenced).
- Assert the workspace selector lists every workspace from the `/workspaces` route, and card filtering uses the real per-card `workspaceRoot` (no constant fallback).
- Assert a test exists exercising `resolveTeamSeats` for the two-lead roster case the UI refuses to set up.

### Manual / UAT
1. Kill the connection mid-launch. The control does not re-arm into a blind retry, and a retry that does happen carries an idempotency key and does not double-dispatch (server dedupes on the key).
2. The chip distinguishes "sent" from "delivered", and does not claim the latter from `dispatched_at`.
3. The workspace selector lists every workspace; switching the selector filters cards by the real per-card `workspaceRoot`.
4. **[deferred]** A real-device pass records zero polls while idle over the tailnet, and layout screenshots at both study sizes — after the board-payload work lands.
