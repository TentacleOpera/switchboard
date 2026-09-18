# The command surface's four views tell the truth

**Complexity:** 5

## Goal

Seven defects reported from a phone across all four views of /command: the workspace row shows every project, dispatch hangs for twenty seconds, launching a mission reports nothing, one live lead seat heads two teams at once, only a team head's terminal can be opened, and every team draws the same generic jet. Each view currently shows the operator something that is not true — a scope that is wider than its label, a pending state that outlasts the work, a control that does nothing, a roster row attributed to the wrong seat. This feature makes each of the four views report its own state accurately, so the phone stops being a surface you have to verify against the desktop board.

## How the Subtasks Achieve This

- **Workspace row is labelled "unassigned" and implemented as "all projects"**: splits the `__unassigned__` sentinel, which currently means both "cards with no project" (what the label promises) and "apply no project filter" (what the code does) at three render sites. Extracts one `filterByProject` helper the other two view plans consume, so the scoping fix is made once rather than three times.
- **Dispatch holds "Dispatching…" for ~20s**: splits `POST /kanban/dispatch` into an acknowledgement (the card moved, a seat was chosen) and a confirmation (the prompt finished pasting), which today settle seconds apart but are reported as one fact. The paced paste stays exactly as it is — it is why prompts arrive intact; the plan makes the wait invisible rather than shorter.
- **Mission view is a composer the design struck out**: removes the `ADD MEMBER` composer that the approved layout study rejected as departure 8 and that never worked anyway — nothing in `command.js` calls `POST /kanban/mission/create`, so all three mission mutators silently early-return. Replaces it with the study's select → members → Launch → progress flow, and adds the status chip the view has always lacked, so a launch reports its own outcome.
- **Team roster matches seats by role alone**: replaces role-matching with `parentInstanceId` membership resolution in a single exclusive-claim pass, so one live lead seat can no longer head two lead teams at once. Hides unstarted, member-less seed teams, and extends the read-only terminal viewer to any seat on a team rather than only its head.
- **Command surface ignores host capabilities**: makes `/command` honour the `data-host-capabilities` contract it is already served and currently discards. It is the only browser panel that reads none of it — `transport.js` applies gating classes that name elements in `kanban.html` and `terminals.html`, and `command.html` carries zero of them — so on this host it offers a MISSION view that the host has declared it does not have.
- **Team icons collapse to one generic jet**: gives the file-based art path a per-role fallback so surfaces outside `kanban.html` stop painting every team with the same `nav-jet.svg`. The picker, the palette endpoint and the save carry-forward already shipped — this is the default that makes them visible without the operator picking one icon per team.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The command surface's workspace row is labelled "unassigned" and implemented as "all projects"](../plans/command-workspace-row-shows-every-project.md) — **CODER CODED** — ID: 4f8d1b39-e09f-41d4-8eb9-71beaef1ae1d
- [ ] [Dispatch from the command surface holds "Dispatching…" for ~20s because the HTTP response waits for the prompt to finish pasting](../plans/command-dispatch-blocks-until-the-prompt-finishes-pasting.md) — **CODER CODED** — ID: dab6848d-f693-4df3-b331-ec0e6bd3e626
- [ ] [The command surface's mission view is a composer the design struck out, and every one of its controls is inert](../plans/command-mission-view-composer-is-inert-and-off-spec.md) — **CODER CODED** — ID: 6d63a879-1be8-4479-a683-51cc4d839499
- [ ] [The command surface's team roster matches seats by role alone, so one live lead heads every lead team — and only the head is ever viewable](../plans/command-teams-view-resolves-membership-by-role.md) — **CODER CODED** — ID: 7a19570a-59a5-4292-af61-d47852ffb7ce
- [ ] [Team icons: the picker shipped, but every team outside kanban.html falls back to the same generic jet](../plans/command-team-icons-collapse-to-one-generic-jet.md) — **CODER CODED** — ID: 0a3d3147-ba29-4964-b679-924e09eea547
- [ ] [The command surface is the only browser panel that ignores host capabilities, so it offers controls the host has declared it does not have](../plans/command-surface-ignores-host-capabilities.md) — **CODER CODED** — ID: 43ba5021-f5f7-42c6-8b3b-81ff150044a1
<!-- END SUBTASKS -->

## Dependencies & sequencing

Two ordering constraints, both from shared edits rather than shared behaviour:

1. **The workspace-row plan lands first.** It extracts the `filterByProject` helper that the mission plan's candidate listing consumes. Landing them in the other order means writing the inline guard twice and then deleting it.
2. **The team-roster plan lands before the team-icons plan.** The roster plan restructures `renderTeamRow` and adds per-seat rows; the icons plan then resolves art for both the team row and those new seat rows in one pass.

The dispatch plan is independent of all four — it touches `executeDispatch` and `LocalApiServer`, and no other subtask opens either. It can run in parallel at any point.

3. **The capabilities plan lands after the mission plan.** Both edit the Mission view's nav wiring; gating a view that is still a composer means doing the work twice.

The mission and team-roster plans do not depend on each other and can run in parallel once the workspace-row plan has landed.

## Team Dispatch Instructions

### The command surface's workspace row is labelled "unassigned" and implemented as "all projects"
- **Seat:** Intern
- **Acceptance:**
  - Selecting `(unassigned)` shows only project-less plans; selecting `(all)` shows every plan; selecting a named project shows only that project's plans (regression gate).
  - The mission candidate dropdown honours the same scope in all three states.
  - A board push while `(unassigned)` is selected does not silently widen the list.
  - Zero inline `currentProject !== '__unassigned__'` guards remain — all filtering goes through `filterByProject`.
- **Must not touch:** None specified.

### Dispatch from the command surface holds "Dispatching…" for ~20s because the HTTP response waits for the prompt to finish pasting
- **Seat:** Coder
- **Acceptance:**
  - The chip leaves `Dispatching…` in under 1 second and reports the receiving seat by name.
  - The chip subsequently settles to a delivered state; the terminal shows the complete prompt (no truncation, no interleaving).
  - Dispatch to a no-role column returns 400 immediately; dispatch with no terminals live returns 409 immediately.
  - CLI `npx switchboard dispatch` and desktop drag-drop behave exactly as before (regression — neither sends `ack`).
  - Page reload mid-delivery resolves the card's state from the poll endpoint.
- **Must not touch:** `CHUNK_SIZE`, `CHUNK_DELAY_MS`, and `SUBMIT_DELAY_MS` in `terminalUtils.ts` — pacing must not be reduced. `performKanbanDispatch`'s existing blocking contract must be preserved verbatim for its five in-process callers.

### The command surface's mission view is a composer the design struck out, and every one of its controls is inert
- **Seat:** Coder
- **Acceptance:**
  - No mission → explicit empty state naming where missions are created; Launch disabled; no Stage control and no candidate dropdown.
  - Mission created on desktop → phone lists it in the select after the next board push, showing its members.
  - LAUNCH with a staged, dispatchable card → chip names the card and the receiving seat.
  - LAUNCH with nothing ready → chip states that reason (not blank, not success).
  - Zero hits on `<input`, `<textarea`, `contenteditable`, `prompt(`, `confirm(` in `command.html`.
- **Must not touch:** No mission name field, no text input of any kind. No confirmation dialog on launch or member removal. Do not call `POST /kanban/mission/create`. Do not fix departure 6 (the two breakpoint layouts). Do not extend `GET /kanban/mission/active`'s response shape — use a sibling list route.

### The command surface's team roster matches seats by role alone, so one live lead heads every lead team — and only the head is ever viewable
- **Seat:** Coder
- **Acceptance:**
  - Exactly one row for Coding; "Lead team", "Planning team", "Review team" absent (unstarted seeds hidden).
  - With two lead-headed teams live, each row names a different seat (regression gate for the role-collision bug).
  - Dispatch to Coding's lead → only Coding flips to WORKING.
  - Tapping a coder seat opens the viewer titled to that seat, loading its scrollback and live output.
  - Ten seat switches → one open terminal socket, not ten.
- **Must not touch:** Do not delete seed teams from storage. No change to `seatTeam` (team starting/seating is correct). Terminal viewer stays read-only — no input, no send.

### Team icons: the picker shipped, but every team outside kanban.html falls back to the same generic jet
- **Seat:** Coder
- **Acceptance:**
  - Teams with different `headRole` values show different art on `/command` (core gate — today they are identical).
  - A custom icon picked in the desktop TEAMS tab shows on the phone; clearing it returns to the role default, not `nav-jet.svg`.
  - An unknown `headRole` renders `nav-jet.svg` with no request for a path containing that string (traversal guard).
  - No request 404s: every `/static/icons/team-*.png` referenced resolves.
  - `OLD_SEEDED_AGENT_GROUP` migration still fires on a workspace with the exact old seed value.
- **Must not touch:** No new picker, no new endpoint, no manifest. Do not migrate `terminals.agentGroups` to stamp `icon` onto existing rows. Do not convert `kanban.html`'s inline symbols to files. Numbered pack originals stay untouched.

### The command surface is the only browser panel that ignores host capabilities, so it offers controls the host has declared it does not have
- **Seat:** Intern
- **Acceptance:**
  - On the standalone host with the governing capability false, MISSION is absent from both the phone nav bar and the tablet rail; no mission pane is reachable.
  - DISPATCH, MOVE, and TEAMS are present and fully functional (gating is surgical).
  - Corrupt `data-host-capabilities` to invalid JSON → every view renders (fail-open, not blank).
  - `switchView('mission')` from the console is refused by the `viewPanes` guard.
  - TEAMS disappears on a host with `terminalFleet: false`; surface lays out correctly with remaining nav entries.
- **Must not touch:** Do not change any capability's computed value. Do not hide a nav item for a capability that is true. No new capability names.

## Relationship to the layout-study card

`command-surface-rebuilt-to-the-approved-layout-study.md` (**CODE REVIEWED**) listed fourteen departures from the approved study. Thirteen landed. Re-verified at HEAD: the complexity palette is the study's exact `#4caf50 / #8bc34a / #ffeb3b / #ff9800 / #f44336` (`command.html:418-422`) with a dedicated `.comp-unknown` grey; card rows are flat 52px with hairline separators (`:345-351`); the tablet rail is 300px (`:171`); there are no emoji; the primary button is a ghost; radii are 2px. The two remaining `@media` blocks (`:800`, `:810`) change padding and swap the phone nav bar for the tablet rail — they do **not** reinstate the two information architectures the study rejected.

The one departure still outstanding is **8**, the Mission view composer, which is subsumed by the mission subtask in this feature. When that lands, the layout-study card is fully discharged.

## Completion Summary

All six subtasks implemented and committed (3969f263). The command surface's four views now report their own state accurately: workspace row splits the `__unassigned__` sentinel into explicit `__all__`/`__unassigned__`/named scopes via a single `filterByProject` helper; dispatch splits into ack + delivery-poll so the chip clears in under a second while the paced paste continues; the mission composer is replaced with the study's select → members → Launch flow with a status chip; team roster resolves membership by `parentInstanceId` in an exclusive-claim pass so one lead seat can no longer head two teams; `/command` honours `data-host-capabilities` gating MISSION on `automation` and TEAMS on `terminalFleet`; and per-role icon fallbacks (`TEAM_ROLE_ART`) give teams outside `kanban.html` distinct art without a new picker or endpoint.

## Review Findings

Reviewed all six subtasks in-place; files changed in this pass are `src/webview/command.js`, `src/webview/command.html`, `src/services/LocalApiServer.ts` and the regenerated `protocol-catalog.json`. Two CRITICALs were fixed: the team roster's seed-visibility filter had re-implemented the role match the roster plan exists to delete (so "Lead team" still rendered beside "Coding", and on a fresh install the seed could claim the operator's lead seat), and LAUNCH MISSION posted `/kanban/queue/next` without the `from` the route hard-400s on, so the mission flow could never dispatch a card. Four MAJORs were also fixed: seat rows laid out beside the state badge instead of under the head line; the ack chip presented a role in the seat's grammatical slot; the delivery poll reported the previous run's terminal as the current seat; and `_ackedDispatchState` grew unbounded. Two CI gates were red at HEAD before this pass and are now green — `compile-tests` (an implicit `any` in the dispatch subtask's own `delivery.catch`) and `catalog:check` (stale by this feature's new `/kanban/dispatch/state` endpoint). Verification: `tsc -p tsconfig.test.json` 0 errors, `eslint src` 0 errors, `npm test` green, plus `parity:check`, `push-routing:check`, `standalone-fork:check`, `host-seam-parity:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, `mirror:check`, `icons:parity` and six contract suites — none of which discriminates on any of the four views' behaviour, so every subtask's verdict is provisional pending its manual Verification Plan.

## Deferred Findings

- MAJOR — head attribution on the Teams view is still role-based with exclusive claim, not membership-based: `team.head` does not exist on `terminals.agentGroups` rows (only on `switchboard.prompts.terminals.groups`, which no webview verb exposes). See the roster plan's own Deferred Findings (`src/webview/command.js:1200`).
- MAJOR — `dispatched_at` advances when a send is registered, not when the paced paste finishes, so the delivery poll's `dispatched` state slightly overstates completion (`src/services/KanbanDatabase.ts:10265`).
- MAJOR — `/command`'s capability gating removes nav entries and `viewPanes` registrations but leaves the gated pane in the served DOM (`src/webview/command.js:105`).
- MAJOR — the roster plan's regression gate "two lead-headed teams live" is unreachable through the UI because `startTeamById` refuses a second live head of the same role (`src/services/teamWiring.ts:1233`).
- Per-subtask NITs are listed under each subtask plan's own `## Deferred Findings`.
