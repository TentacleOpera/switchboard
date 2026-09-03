# The command surface's mission view is a composer the design struck out, and every one of its controls is inert

## Goal

Replace `/command`'s mission composer with the flow the approved layout study specifies — select a mission, see its members, launch, watch progress — and give the launch an outcome the operator can read without going back to the desktop board.

### Problem Analysis

Two defects, reported together and sharing a cause.

**A. Every control in the mission view does nothing.** The view renders a populated candidate dropdown, an enabled `Stage` button, a members list and an enabled `LAUNCH MISSION` button. All four are dead unless a mission already exists, because all three mutators open with the same guard:

- `addSelectedMissionMember` — `if (!activeMission || !missionAddMemberSelect?.value) return;` (`command.js:1225`)
- `removeMissionMember` — `if (!activeMission) return;` (`:1256`)
- `launchActiveMission` — `if (!activeMission) return;` (`:1276`)

`activeMission` is set only by `fetchMissionsState` from `GET /kanban/mission/active` (`:433`), which returns `null` when there is no active mission. **`command.js` never calls `POST /kanban/mission/create`** — the route exists at `LocalApiServer.ts:3154`, and the only mission endpoints the surface calls are `active`, `member/add` and `member/remove` (`:433`, `:1235`, `:1258`). There is no path from the empty state to a mission, and the three guards fail silently: no chip, no notice, no console warning.

**B. There is no feedback on launch even when a mission does exist.** `launchActiveMission` posts `/kanban/queue/next` and, on `res.ok`, calls `fetchMissionsState()` and re-renders. It **never reads the response body**, so a 200 carrying `{success: false}` or a "nothing ready" refusal is indistinguishable from a launch. The Mission view has no status chip at all — Dispatch has `dispatchStatusChip` and Move has `moveStatusChip`; Mission has none, so there is nowhere for an outcome to be written even if one were read. And the single `fetchMissionsState()` fires the instant the POST returns, before the queue pop has settled, so the indirect signal is a stale read too.

The operator's only recourse is to open the desktop board and look.

### Root Cause

**The view was built to a shape the design had already rejected.** `command-surface-rebuilt-to-the-approved-layout-study.md` lists this as departure 8 of 14:

> **The Mission view grew a composer** — `+ New Mission` and an `ADD MEMBER` select-plus-Add row. The study's absent-list strikes out "Mission name field"; its mission view is select → members → Launch → progress.

That plan sits in **CODE REVIEWED**. Twelve of its fourteen items did land — the surface today has no emoji, a ghost primary button, a 2px radius scale, the dispatch column picker, `hidden`-until-acted status chips, and the `nav-jet.svg` fallback. Departures **6** (two information architectures at the 600px and 900px breakpoints, still present at `command.html:800` and `:810`) and **8** (this composer) were not done, and the card advanced anyway.

So the composer is not merely broken — it is scope the design deleted, half-built, never wired to the one endpoint that would have made it function. Repairing it would be building further into a rejected direction.

**Corollary:** the "split into two views" the operator sees is `mission-staging-container` (State A) and `mission-progress-container` (State B) at `command.html:929` and `:945`, toggled solely on `isMissionInFlight()`. With `activeMission` null, State B is unreachable and State A is inert, so the view has exactly one visible mode and it does nothing.

### Non-goals

- **No mission name field, and no text input of any kind.** The study strikes out the name field explicitly, and the surface's keyboard-never-opens rule is non-negotiable — there is no `<input>`, `<textarea>`, `contenteditable`, `prompt()` or `confirm()` anywhere in `command.html` today and this plan adds none.
- **No confirmation dialog on launch or on member removal.** Buttons act immediately.
- Not fixing departure 6 (the two breakpoint layouts). It is real and still outstanding, but it is a layout concern across every view, not a mission concern; it belongs back on the layout-study card.

## Metadata

**Topic:** Command surface mission view follows the layout study and reports its outcomes
**Complexity:** 5
**Tags:** webview, ui, mobile, command-surface, bug

## User Review Required

None. The target flow is specified by the approved layout study: select → members → Launch → progress.

## Complexity Audit

### Routine
- Adding a `missionStatusChip` and the `clearChip`/`hidden` discipline the other two views already use.
- Reading the `/kanban/queue/next` response body and mapping its fields to chip text.

### Complex / Risky
- **Deciding what the mission select lists.** "Select a mission" presupposes missions exist. If none do, the view needs an honest empty state naming where missions are created, not a dead dropdown. This is the failure mode being fixed; do not reproduce it one level up.
- **The launch outcome vocabulary.** `/kanban/queue/next` pops from the same `performKanbanDispatch` machinery as the Dispatch view, and its refusals are specific: no reviewer on the origin team, team already in flight (the one-in-one-out contract), nothing staged. Each needs distinct chip text, or the operator learns nothing beyond "it didn't work".
- **Settle timing.** Re-reading mission state immediately after the POST is the current bug. The refresh must be driven by the response body, not by an optimistic re-fetch.

## Edge-Case & Dependency Audit

**Race conditions:**
- `renderMissionView` rebuilds the candidate `<select>` on every board push (`:891-914`). A selection made between two pushes is lost — the same wholesale-rebuild hazard the workspace select has. The mission select must round-trip its value.
- A mission that goes in-flight while the operator is staging flips State A to State B mid-interaction. The transition must not strand a half-finished action without a chip.

**Security:** None new; all endpoints already exist and are auth-gated.

**Side effects:** The candidate-picker block shares the project filter with Dispatch and Move (`:896-898`). The project-scoping plan in this feature replaces that guard with a shared helper — this plan must consume the helper rather than reinstating an inline copy.

**Dependencies & conflicts:** Edits `renderMissionView`, which the project-scoping plan also edits. Land that one first.

## Dependencies

- **`command-workspace-row-shows-every-project.md`** — extracts the `filterByProject` helper this plan's candidate/member listing consumes. Land first to avoid a conflicting edit to the same block.

## Adversarial Synthesis

Key risks: (1) repairing the composer instead of removing it — wiring `POST /kanban/mission/create` to a `+ New Mission` button would make the controls work while moving further from the study, and would need a name, which is struck out; mitigation: the composer is deleted, and mission creation stays where the design puts it; (2) the new mission select reproducing the original defect by rendering enabled over an empty list — mitigation: an explicit empty state that names where missions come from, and a disabled Launch when nothing is selected; (3) reading `res.ok` and not the body, which is the exact shape of defect B — mitigation: every outcome path in the verification asserts specific chip text, not merely that a chip appeared; (4) the candidate select losing its selection to a board push — mitigation: round-trip the value as `populateColumnDropdowns` already does at `:349-352`.

## Proposed Changes

**1. Delete the composer (`command.html:930-933`).**

Remove `mission-add-member-select` and `btn-add-mission-member`, and remove `addSelectedMissionMember` (`command.js:1224-1253`) and its candidate-population block (`:891-914`).

**2. A mission select in its place.**

One `cmd-select` listing the workspace's missions by name, sourced from a new sibling route `GET /kanban/mission/list` (not by extending `GET /kanban/mission/active`, which `fetchMissionsState` depends on for its single-mission return shape — changing that response breaks every caller). Selecting one sets `activeMission` locally and renders its members read-only. Round-trip the selection across board pushes.

When the list is empty, render the members area as an empty state reading that no missions exist for this workspace and naming the board as where they are created — and disable Launch. No dropdown left enabled over nothing.

**3. Keep Remove; drop Stage.**

Per-member `Remove` stays (`:878-890`) — it is in the study's members list and it works, since it only runs when a mission is already selected. Staging new members is composition and moves off this surface with the composer.

**4. A mission status chip.**

Add `mission-status-chip` alongside the launch button, following the `clearChip` + `hidden` discipline the other two views use. `launchActiveMission` reads the parsed body and writes:
- dispatched → the popped card's topic and receiving seat, `status-chip success`
- nothing staged / nothing ready → that reason verbatim, `status-chip unknown`
- refusal (team in flight, no seat on the origin team) → the server's `message` field (human text, not the `reason` machine code), `status-chip unknown`
- non-OK or thrown → `Outcome unknown (connection dropped)`, matching `executeDispatch`'s wording at `:1159`

**Settle timing:** The `/kanban/queue/next` response carries the dispatch result (which card popped, which seat received it) but does NOT carry the full updated mission state. Therefore: write the chip from the response body immediately, then schedule a delayed `fetchMissionsState()` after a short timeout (e.g., 500ms) to let the queue pop settle — not a blind immediate re-fetch (the current bug), and not "from the response" (which doesn't carry mission state). The board push will also trigger a re-render via `updateBoard`, which is the authoritative refresh path.

## Verification Plan

1. On a workspace with **no** mission, open `/command` → Mission. The view shows an explicit empty state naming where missions are created; Launch is disabled; there is no Stage control and no candidate dropdown.
2. Create a mission on the desktop board. The phone's Mission view lists it in the select after the next board push, showing its members.
3. Press LAUNCH MISSION with a staged, dispatchable card. The chip names the card and the receiving seat. Confirm against the desktop board that this is the card that actually ran.
4. Press LAUNCH MISSION with nothing ready. The chip states that reason; it does not read as a success and it does not stay blank.
5. Launch against a team already in flight. The chip carries the server's one-in-one-out refusal text.
6. Stop the server and press LAUNCH MISSION. The chip reads `Outcome unknown (connection dropped)`.
7. While a mission is in flight, confirm State B renders members with their seats and the elapsed clock, and that no staging control is reachable.
8. Force a board push while a mission is selected. The selection survives.
9. Grep `command.html` for `<input`, `<textarea`, `contenteditable`, `prompt(` and `confirm(` — zero hits, as today.
10. Both hosts: run 1-4 against the VS Code extension and the standalone host.

### Goal Invariants

- Assert `mission-add-member-select` and `btn-add-mission-member` are absent from `command.html` (the composer is deleted, not merely hidden).
- Assert `addSelectedMissionMember` is absent from `command.js` (the function is deleted, not repurposed).
- Assert `missionStatusChip` (or `mission-status-chip`) exists as an element in `command.html` and is written to by `launchActiveMission` (the view now reports outcomes).
- Assert `launchActiveMission` reads `await res.json()` and branches on the parsed body's content — not merely `res.ok` (the response body is consumed, not just the status code).
- Assert `command.js` does not call `POST /kanban/mission/create` (mission creation stays on the desktop board, per the design study).
- Assert grepping `command.html` for `<input`, `<textarea`, `contenteditable`, `prompt(`, `confirm(` returns zero hits (the keyboard-never-opens rule is preserved).

## Implementation Summary

Deleted the mission composer (candidate select + Stage button + `addSelectedMissionMember`) from both `command.html` and `command.js`. Replaced it with a mission select dropdown sourced from the existing `GET /kanban/missions` route, which lists the workspace's missions by name. Selecting a mission sets `activeMission` locally and renders its members read-only with per-member Remove buttons. When no missions exist, an explicit empty state names the desktop board as where missions are created, and Launch is disabled. The selection round-trips across board pushes via `selectedMissionId`. Added `mission-status-chip` alongside the launch button; `launchActiveMission` now reads `await res.json()` and writes distinct chip text for each outcome (dispatched card+seat → success, queue empty → unknown, refusal error text → unknown, connection drop → unknown). Settle timing fixed: chip written from response body immediately, delayed `fetchMissionsState()` after 500ms replaces the old blind immediate re-fetch.

## Review Findings

Files changed in this review pass: `src/webview/command.js`. One CRITICAL fix: `launchActiveMission` posted `{ workspaceRoot }` only, and `dispatchNextFromQueue` hard-400s on a missing `from` (`src/services/LocalApiServer.ts:2383`), so LAUNCH MISSION could never dispatch a card — it was refused before it reached the queue, and the plan's new chip reported that refusal very clearly while the button stayed dead. Added `resolveLaunchOriginSeat()`, which resolves the selected mission's own team head, then any live lead, then any live coder — the same precedence the desktop Run-queue button uses (`KanbanProvider.ts:12873-12886`) — and refuses with an honest chip when no seat is live rather than posting a request that cannot succeed. Everything else in this subtask verified clean: the composer is deleted from both files, `addSelectedMissionMember` is gone, `POST /kanban/mission/create` is never called, `launchActiveMission` branches on the parsed body, `GET /kanban/missions` genuinely returns `{missions}` with hydrated members, and `command.html` has zero hits on `<input`/`<textarea`/`contenteditable`/`prompt(`/`confirm(`. Verification: `tsc` clean, `eslint` 0 errors, `npm test` green; the launch outcomes themselves have no automated coverage, so steps 3-6 of the Verification Plan remain unexecuted and this verdict is provisional.

## Deferred Findings

- MAJOR — `renderMissionView`'s empty-list branch nulls `activeMission` unconditionally, so a mission that exists but is filtered out of `missionList` by a failed `fetchMissionList` (a network blip leaves `missionList` at its previous value, but a 200 with a malformed body sets it to `[]`) silently disables Launch with an empty-state message that says no missions exist (`src/webview/command.js:1039-1042`).
- NIT — `removeMissionMember` checks `res.ok` only and shows no chip on failure, so a refused removal is silent; the plan kept Remove but did not extend the chip discipline to it (`src/webview/command.js:1736`).
- NIT — the 500ms delayed `fetchMissionsState()` is a fixed timeout, not a settle signal; a slower pop still re-reads stale mission state, and the board push is what actually corrects it (`src/webview/command.js:1806`).
