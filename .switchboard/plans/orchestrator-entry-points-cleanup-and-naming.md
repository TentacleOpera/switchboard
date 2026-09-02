# Two orchestrator entry points are dead or inconsistent, and one concept has four names — delete, and settle the vocabulary

## Goal

Reduce the Mission Control entry points to the three that should exist, and stop the code, the UI, and the control-plane docs from using six different words for the same thing. The naming ambiguity is not cosmetic: it caused this session to mis-describe the entry points twice before the code was read carefully.

### Problem Analysis

Mission Control is an optional project-management layer, reached deliberately. Its intended doors are `POST /mission-control/start`, the browser shell rail icon, and implementation.html's Manage button. Two more exist and should not.

**Dead handler.** `KanbanProvider:10117` has a live `case 'startOrchestrator'` calling `startMissionControlFromKanban`. **No webview sends that message** — grepping `src/webview/` for `startOrchestrator` returns nothing. `kanban.html` mentions `startMissionControlFromKanban` only in comments (`:11901`, `:11926` — line numbers approximate), with no button and no `postMessage`. The AUTOMATION tab that the handler existed for moved to the Mission Control panel (`mission-control.html`) — `kanban.html:12397` records the move. So the button the handler exists for is not there.

**Dead stop handler.** `KanbanProvider:10125` has `case 'stopOrchestrator'` calling `stopMissionControlFromKanban`. **No webview sends that message either** — grepping `src/webview/` for `stopOrchestrator` or `stopMissionControl` returns nothing. Both handlers are dead by the same test.

**Command with no siblings.** `switchboard.startOrchestrator` is registered at `extension.ts:1297` and contributed in `package.json:58` (with the title "Switchboard: Start Mission Control" — the command ID was not renamed even though the title was). It is the **only** command matching any start-agent, start-terminal, or trigger-agent pattern — there is nothing equivalent for a coder, lead, or intern seat. A palette entry for one role and not the others is an inconsistency rather than a convenience.

**Test asserting the dead command.** `autoban-state-regression.test.js:152-158` explicitly asserts that `switchboard.startOrchestrator` must remain in `package.json` contributes.commands and must be registered in `extension.ts`. Deleting the command without updating this test will fail the test suite. The test must be updated or removed in the same change.

**Stale documentation asserting the dead path.** `TaskViewerProvider:11924` documents itself as *"Called by the Kanban AUTOMATION tab (Start Mission Control)"*, and `LocalApiServer:6458` refers to *"the same path the AUTOMATION tab button"* takes. `CLAUDE.md` and `AGENTS.md` go further and make it normative: the orchestrator persona *"is system-launched from the AUTOMATION tab's Start orchestrator; never invoke it ad hoc."* That instruction points at a tab that moved to a separate panel. The same files also reference `switchboard-orchestrator` as a skill name, but the skill has been renamed to `switchboard-mission-control` in `.agents/protocols/` — the control-plane docs are stale on the skill name too.

**Six names for one concept (was four, now six):**

| Name | Where | Status |
|---|---|---|
| **Mission Control** | `shell.js` rail icon, `TaskViewerProvider`, `bootstrap.ts`, `autobanState.ts`, `mission-control.html` | Dominant — the code's primary name |
| **Manage** | `implementation.html:1529` button label | Live, user-facing |
| **`project_manager`** | role key resolved by `_tryFleetDeliveryForRole` | Live, internal |
| **`mission-control`** | role key alongside `project_manager` (`ptyFleetService.ts:38`, `shell.js:454`) | Live, internal |
| **orchestrator** | `case 'startOrchestrator'`, `switchboard.startOrchestrator` command, `CLAUDE.md`/`AGENTS.md` | Dead handler + stale docs |
| **`dispatchProjectManager`** | verb in `kanban.html:6425`, `implementation.html:1812` | Live, internal |

> **Superseded:** The plan originally identified four names: Operator (`shell.js`), Manage (`implementation.html`), `project_manager` (role key), orchestrator (persona).
> **Reason:** The codebase has since been renamed. "Operator" no longer exists in `shell.js` — it now says "Mission Control". A new role key `mission-control` was added alongside `project_manager`. And the verb `dispatchProjectManager` is a sixth name the original plan missed.
> **Replaced with:** The six-name table above. "Mission Control" is the dominant name in the code; the settlement should converge the remaining stragglers to it.

They are genuinely one thing. `.agents/workflows/switchboard.md` Step 2 is explicit — *"You are the orchestrator. Not a terminal you start — this one"* — so the launcher handed to a `project_manager` seat turns that agent into Mission Control by adoption. `project_manager` is the seat; Mission Control is the persona it adopts. Nothing in the code says so.

### Root Cause

Surfaces were added over time, each naming the concept in its own register — a rail icon wanted a short label, a button wanted a verb, a role key wanted a noun. The AUTOMATION tab moved to the Mission Control panel and its handler, command, and docblocks were left behind. A partial rename from "orchestrator" to "Mission Control" updated most of the code but left the command ID, the dead handler, the test, and the control-plane docs on the old name.

### Non-goals

- **Not changing the three surviving entry points.** Their behavioural differences are deliberate and stay.
- Not renaming the `orchestrator` role key, the terminal name, or any HTTP route. The endpoints and `MISSION_CONTROL_TERMINAL_NAME` are shipped contracts.
- Not merging `project_manager` and `mission-control` into one role key. Documenting the relationship is enough; a role-key change touches persisted team state.

## Metadata

**Complexity:** 3
**Tags:** cleanup, dead-code, documentation, refactor

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting an unreachable handler and a command registration.
- Correcting three docblocks.

### Complex / Risky
- **The control-plane edit must go to the right file.** `CLAUDE.md` and `.claude/skills/` are generated; the source of truth is `.agents/` and `AGENTS.md`. Editing the generated copy is reverted by the next regeneration, and this same instruction appears in more than one place.
- **Deciding the user-facing word.** Whatever is chosen must be applied at every surface at once, or this plan adds a seventh name.
- **The test that asserts the dead command.** `autoban-state-regression.test.js:152-158` must be updated or removed in the same change — deleting the command without touching the test fails the suite.

## Edge-Case & Dependency Audit

- **Confirm the handler is truly unreachable before deleting.** Check `src/webview/` and the browser panels — verified: no webview sends `startOrchestrator` or `stopOrchestrator`. Check the verb allowlist — `generated/verbAllowlist.ts` lists both `startOrchestrator` and `stopOrchestrator`; regenerate rather than hand-edit.
- **`stopOrchestrator` sits immediately after `startOrchestrator`** at `KanbanProvider:10125` and is also dead — no sender in any webview. Both go.
- **`switchboard.startOrchestrator` is referenced in the test** `autoban-state-regression.test.js:152-158` and in two other plan files (`retire-autoban-and-batch-size.md:421`, `automation-tab-three-exclusive-modes.md`). The test must be updated; the plan references are historical and need no change.
- **The tooltip at `implementation.html:1529` is already good copy** — *"Activate the Switchboard management console in a terminal agent (or copy the prompt if no PM terminal is registered). Onboards new users and drives the board — the single front door."* Whatever vocabulary is chosen should keep that sentence's accuracy, including the copy-the-prompt clause.
- **Do not delete `startMissionControlFromKanban`.** Only the dead caller goes; the Manage path and the endpoint both depend on it.
- The `CLAUDE.md` claim appears alongside the workflow registry table, which also describes `/switchboard` as *"the primary front door"* — the corrected text must not contradict that.
- **The `switchboard-orchestrator` skill name in `CLAUDE.md`/`AGENTS.md` is stale.** The skill has been renamed to `switchboard-mission-control` in `.agents/protocols/`. The control-plane docs must be updated to reference the new name.
- **The AUTOMATION tab moved to the Mission Control panel** (`mission-control.html`), not deleted. The corrected docblocks should say "the Mission Control panel" rather than claiming the tab was removed.

## Dependencies

- Independent of the clipboard-payload and seat-guard plan, though both touch the Mission Control start path. No shared files.

## Adversarial Synthesis

Key risks: deleting the command without updating its test fails the suite silently; leaving the `switchboard-orchestrator` skill name in the control-plane docs after the skill was renamed creates a broken reference; settling on "Mission Control" but leaving the "Manage" button label adds a fifth surface to the reconciliation. Mitigations: update the test in the same change; update the skill name reference; decide explicitly whether "Manage" stays as a button label or converges.

The tempting shortcut is to keep the dead handler because deleting it is not strictly necessary. A handler with no sender is the exact artefact that made a docblock credible enough to mislead a reader; leaving it preserves the trap.

The tempting shortcut on naming is to standardise the code and leave the UI labels alone, since users are used to them. That keeps the split that caused the confusion, because the confusion was between code and docs, not between users and either.

## Proposed Changes

1. **Delete `case 'startOrchestrator'` and `case 'stopOrchestrator'`** from `KanbanProvider` (`:10117` and `:10125`), after confirming no sender (verified) and regenerating the verb allowlist if it lists the verbs (it does).
2. **Delete `switchboard.startOrchestrator`** — the registration at `extension.ts:1297` and the `package.json:58` contribution — after grepping for other references.
3. **Update `autoban-state-regression.test.js:152-158`** to remove the assertions that `switchboard.startOrchestrator` must exist, in the same change.
4. **Correct the three stale docblocks** at `TaskViewerProvider:11924` and `LocalApiServer:6458` so neither claims an AUTOMATION-tab caller — reference the Mission Control panel instead.
5. **Correct the control-plane instruction in `.agents/` and `AGENTS.md`** to name the three real entry points, update the `switchboard-orchestrator` skill name to `switchboard-mission-control`, and regenerate the downstream copies rather than editing them.
6. **Settle the vocabulary and apply it everywhere at once**, including a stated relationship: `project_manager` is the seat, Mission Control is the persona it adopts via `POST /mission-control/adopt`. "Mission Control" is the user-facing word; "Manage" may stay as a button label if the tooltip's accuracy is preserved.

### Migration

None for users. Removing a command and an unreachable handler changes no persisted state. If the verb allowlist is generated, regenerate rather than hand-edit. The test update is a code change, not a migration.

## Verification Plan

1. **The three real entry points still work** — `POST /mission-control/start`, the shell rail icon, and implementation.html's Manage button.
2. **The deleted command is gone** from the palette, and nothing references it.
3. **No dead verb.** Confirm `startOrchestrator` and `stopOrchestrator` appear in neither the handler nor any generated allowlist.
4. **Test passes.** Confirm `autoban-state-regression.test.js` passes after the command assertions are removed.
5. **Docs match reality.** Grep for "AUTOMATION tab" near Mission Control text and confirm no remaining claim of a button there. Grep for `switchboard-orchestrator` in `CLAUDE.md`/`AGENTS.md` and confirm no remaining reference.
6. **The control-plane edit survives regeneration.** Regenerate the downstream copies and confirm the corrected text persists.
7. **One name.** Grep the terms and confirm each remaining use is either "Mission Control" (the settled user-facing word) or a documented role key or route, with the seat-versus-persona relationship stated once.

### Goal Invariants

- **Negative:** `case 'startOrchestrator'` is absent from `KanbanProvider.ts`.
- **Negative:** `case 'stopOrchestrator'` is absent from `KanbanProvider.ts`.
- **Negative:** `switchboard.startOrchestrator` is absent from `extension.ts` and `package.json`.
- **Negative:** `switchboard.startOrchestrator` is not asserted in `autoban-state-regression.test.js`.
- **Positive:** `startMissionControlFromKanban` is still present in `TaskViewerProvider.ts` and its `POST /mission-control/start` route is still routed in `LocalApiServer.ts`.
- **Negative:** The string "AUTOMATION tab" does not appear near Mission Control text in `TaskViewerProvider.ts` or `LocalApiServer.ts` docblocks.
- **Negative:** The string `switchboard-orchestrator` is absent from `CLAUDE.md` and `AGENTS.md`.

## Outstanding Questions

None.
