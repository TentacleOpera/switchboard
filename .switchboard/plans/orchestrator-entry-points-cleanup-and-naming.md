# Two orchestrator entry points are dead or inconsistent, and one concept has four names — delete, and settle the vocabulary

## Goal

Reduce the orchestrator's entry points to the three that should exist, and stop the code, the UI, and the control-plane docs from using four different words for the same thing. The naming ambiguity is not cosmetic: it caused this session to mis-describe the entry points twice before the code was read carefully.

### Problem Analysis

The orchestrator is an optional project-management layer, reached deliberately. Its intended doors are `POST /kanban/orchestration/start`, the browser shell rail, and implementation.html's Manage button. Two more exist and should not.

**Dead handler.** `KanbanProvider:9480` has a live `case 'startOrchestrator'` calling `startOrchestratorFromKanban`. **No webview sends that message** — grepping `src/webview/` for it returns nothing. `kanban.html` mentions `startOrchestratorFromKanban` only in two comments (`:11901`, `:11926`), with no button and no `postMessage`. So the AUTOMATION tab button the handler exists for is not there.

**Command with no siblings.** `switchboard.startOrchestrator` is registered at `extension.ts:1335` and contributed in `package.json`. It is the **only** command matching any start-agent, start-terminal, or trigger-agent pattern — there is nothing equivalent for a coder, lead, or intern seat. A palette entry for one role and not the others is an inconsistency rather than a convenience.

**Stale documentation asserting the dead path.** `TaskViewerProvider:11288` documents itself as *"Called by the Kanban AUTOMATION tab (Start orchestrator)"*, and `LocalApiServer:4519` refers to *"the same path the AUTOMATION tab button"* takes. `CLAUDE.md` goes further and makes it normative: the orchestrator persona *"is system-launched from the AUTOMATION tab's Start orchestrator; never invoke it ad hoc."* That instruction points at a button that does not exist.

**Four names for one concept:**

| Name | Where |
|---|---|
| **Operator** | `shell.js` rail icon, tooltips, toasts |
| **Manage** | `implementation.html:1529` button label |
| **`project_manager`** | role key resolved by `_tryFleetDeliveryForRole` |
| **orchestrator** | the persona, the seat, the terminal name, the endpoints |

They are genuinely one thing. `.agents/workflows/switchboard.md` Step 2 is explicit — *"You are the orchestrator. Not a terminal you start — this one"* — so the launcher handed to a `project_manager` seat turns that agent into the orchestrator by adoption. `project_manager` is the seat; orchestrator is the persona it adopts. Nothing in the code says so.

### Root Cause

Surfaces were added over time, each naming the concept in its own register — a rail icon wanted a short label, a button wanted a verb, a role key wanted a noun. The AUTOMATION tab button was removed at some point and its handler, command, and three docblocks were left behind, so the most authoritative-looking descriptions now describe a path that no longer exists.

### Non-goals

- **Not changing the three surviving entry points.** Their behavioural differences are deliberate and stay.
- Not renaming the `orchestrator` role key, the terminal name, or any HTTP route. The endpoints and `ORCHESTRATOR_TERMINAL_NAME` are shipped contracts.
- Not merging `project_manager` and `orchestrator` into one role key. Documenting the relationship is enough; a role-key change touches persisted team state.

## Metadata

**Complexity:** 3
**Tags:** cleanup, dead-code, documentation, orchestrator

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting an unreachable handler and a command registration.
- Correcting three docblocks.

### Complex / Risky
- **The control-plane edit must go to the right file.** `CLAUDE.md` and `.claude/skills/` are generated; the source of truth is `.agents/` and `AGENTS.md`. Editing the generated copy is reverted by the next regeneration, and this same instruction appears in more than one place.
- **Deciding the user-facing word.** Whatever is chosen must be applied at every surface at once, or this plan adds a fifth name.

## Edge-Case & Dependency Audit

- **Confirm the handler is truly unreachable before deleting.** Check `src/webview/` and the browser panels, and check the verb allowlist — `dispatchProjectManager` appears in `generated/verbAllowlist.ts`, so a generated allowlist may also list `startOrchestrator` and need regenerating rather than hand-editing.
- **`stopOrchestrator` sits immediately after it** at `KanbanProvider:9488` and may have a live sender. Verify separately; do not delete by adjacency.
- **`switchboard.startOrchestrator` may be referenced in docs or keybindings.** Grep beyond `package.json` before removing, including `.agents/` and any onboarding text.
- **The tooltip at `implementation.html:1529` is already good copy** — *"Activate the Switchboard management console in a terminal agent (or copy the prompt if no PM terminal is registered). Onboards new users and drives the board — the single front door."* Whatever vocabulary is chosen should keep that sentence's accuracy, including the copy-the-prompt clause.
- **Do not delete `startOrchestratorFromKanban`.** Only the dead caller goes; the Manage path and the endpoint both depend on it.
- The `CLAUDE.md` claim appears alongside the workflow registry table, which also describes `/switchboard` as *"the primary front door"* — the corrected text must not contradict that.

## Dependencies

- Independent of the clipboard-payload and seat-guard plan, though both touch the orchestrator start path. No shared files.

## Adversarial Synthesis

The tempting shortcut is to keep the dead handler because deleting it is not strictly necessary. A handler with no sender is the exact artefact that made a docblock credible enough to mislead a reader; leaving it preserves the trap.

The tempting shortcut on naming is to standardise the code and leave the UI labels alone, since users are used to them. That keeps the split that caused the confusion, because the confusion was between code and docs, not between users and either.

## Proposed Changes

1. **Delete `case 'startOrchestrator'`** from `KanbanProvider`, after confirming no sender and regenerating the verb allowlist if it lists the verb.
2. **Delete `switchboard.startOrchestrator`** — the registration and the `package.json` contribution — after grepping for other references.
3. **Correct the three stale docblocks** at `TaskViewerProvider:11288` and `LocalApiServer:4519` so neither claims an AUTOMATION-tab caller.
4. **Correct the control-plane instruction in `.agents/` and `AGENTS.md`** to name the three real entry points, and regenerate the downstream copies rather than editing them.
5. **Settle the vocabulary and apply it everywhere at once**, including a stated relationship: `project_manager` is the seat, orchestrator is the persona it adopts via `POST /orchestration/adopt`.

### Migration

None for users. Removing a command and an unreachable handler changes no persisted state. If the verb allowlist is generated, regenerate rather than hand-edit.

## Verification Plan

1. **The three real entry points still work** — `POST /kanban/orchestration/start`, the shell rail icon, and implementation.html's Manage button.
2. **The deleted command is gone** from the palette, and nothing references it.
3. **No dead verb.** Confirm `startOrchestrator` appears in neither the handler nor any generated allowlist, and that `stopOrchestrator` still works if it has a live sender.
4. **Docs match reality.** Grep for "AUTOMATION tab" near orchestrator text and confirm no remaining claim of a button there.
5. **The control-plane edit survives regeneration.** Regenerate the downstream copies and confirm the corrected text persists.
6. **One name.** Grep the four terms and confirm each remaining use is either the settled user-facing word or a documented role key or route, with the seat-versus-persona relationship stated once.

## Outstanding Questions

None.
