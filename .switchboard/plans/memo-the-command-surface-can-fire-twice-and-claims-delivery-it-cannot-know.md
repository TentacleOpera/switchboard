# The Command Surface Re-Arms After an Unknown Outcome, Claims a Delivery It Cannot Know, and Is Locked to One Workspace

## Goal

The phone command surface must not invite a retry that fires an agent twice, must not report a delivery it has no evidence of, and must either serve every workspace or say that it serves one.

### Problem analysis

Five reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They share `src/webview/command.js`, a 2,045-line file that **no test file reads** — `grep -rl "webview/command.js" src/test/` returns nothing.

This is the surface designed to be used from a phone, over a link that drops. Two of the five are specifically about what happens when it does.

## Metadata

- **Complexity:** 5
- **Tags:** command-surface, mobile, testing, bugfix

## User Review Required

Change 3 is a decision between building a route and declaring a limitation. The rest are defects.

## Proposed Changes

### 1. An unknown outcome re-arms the control, so a retry can fire twice

`command.js:1857-1859` sets "Outcome unknown (connection dropped)" and then `btnLaunchMission.disabled = false`. The same shape appears at `:1293-1295` for the team action and `:1649-1651` for advance.

The operator is told the outcome is unknown and simultaneously invited to try again. On a dropped connection the first request may well have succeeded, so the retry advances a card and dispatches an agent a second time.

The memo entry named `/kanban/dispatch`; the endpoint has since moved to `/kanban/advance` and the acked mission path, and **neither carries an idempotency key**. Scope the fix to the surface's three unknown-outcome sites and give the request an idempotency key rather than re-enabling blind.

### 2. The dispatch chip claims a delivery the poll cannot observe

`KanbanDatabase.ts:10310`'s own docblock records that `dispatched_at` is stamped **before** the send is dispatched. `command.js:1566` then settles the chip to "Dispatched to \<seat\>" on `result.state === 'dispatched'`.

So the chip reports delivery on the strength of a timestamp written before anything was delivered. Small fix, and mostly wording: introduce a pending and settled vocabulary, and let the chip say what is actually known.

### 3. The surface can only ever show one workspace **[decision]**

`_readRows` (`KanbanDatabase.ts:11041-11103`) emits `workspaceId` and `workspaceName` but never `workspaceRoot`; the push projection stamps one constant `resolvedWorkspaceRoot`; `extractWorkspaceProjects` (`command.js:479-482`) falls back to `currentWorkspaceRoot` for every card; and no `/workspaces` route exists.

The header selector therefore lists exactly one workspace, always. Decide between adding a read route that serves the list, and stating in the UI that the surface is single-workspace.

### 4. The surface has never met a real device

`mobile-command-route-contract.test.js:155-159` asserts only the **absence** of `/kanban/plans`, `fetchBoardCards` and `setInterval` in the source. It cannot observe network traffic and it cannot observe layout.

So the two claims that matter — a genuinely zero-poll idle over the tailnet, and the layout at 390×844 and 1180×820 against the study artifact — are undischarged. This is a UAT pass, and it should be run after the board-payload work lands rather than before, since that changes what the surface fetches.

### 5. Nothing tests the file at all

Zero test files read `command.js`. Two of its functions are pure and trivially testable: `filterByProject` (`:685`) and `resolveTeamSeats` (`:1237`).

`resolveTeamSeats` matters beyond this surface. `startTeamById` refuses to start a team whose head role is already live and unparented (`teamWiring.ts:1231-1244`), which means the roster plan's "two lead-headed teams" scenario **cannot be set up through the interface** — so the unit test is the only way that contract can be checked at all.

## Verification Plan

1. Kill the connection mid-launch. The control does not re-arm into a blind retry, and a retry that does happen carries an idempotency key and does not double-dispatch.
2. The chip distinguishes "sent" from "delivered", and does not claim the latter from `dispatched_at`.
3. The workspace selector lists every workspace, or the UI states that it serves one.
4. A real-device pass records zero polls while idle over the tailnet, and layout screenshots at both study sizes.
5. `src/test` contains assertions over `filterByProject` and `resolveTeamSeats`, including the two-lead roster case that the UI cannot reach.
