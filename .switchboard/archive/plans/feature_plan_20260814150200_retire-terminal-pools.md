# Retire Autoban's Terminal Pools — the Problem They Solved Is Now `clear` and Teams

## Goal

Delete the per-role terminal pool system from autoban: `terminalPools`, `managedTerminalPools`, `poolCursor` and the per-terminal `sendCounts`, the round-robin rotation that consumes them, and the verbs and commands that maintain them. Dispatch resolves to a named terminal (or a team head) instead of rotating a ring.

### Problem & background

**Pools exist to spread context load, and that problem is solved elsewhere now.** `autobanState.ts` carries `terminalPools: Record<string, string[]>` (`:30`, `:98`), a parallel `managedTerminalPools` (`:99`), `poolCursor: Record<string, number>` (`:100`), and `sendCounts` per terminal name (`:97`). Roles are `planner`, `coder`, `lead`, `reviewer`, `intern` plus any custom agents (`TaskViewerProvider.ts:8949-8963`). A dispatch for a role advances that role's cursor and sends to the next terminal in the ring (`_selectAutobanTerminal`, `:9234`; `_recordAutobanDispatch`, `:9271`).

The reason to rotate was context: one terminal handling every coding dispatch fills its context window, so work was spread across several. Two things have since taken that over — the **`clear` command**, which resets a terminal's context directly, and **agent teams**, where a head delegates to children that each carry their own context. Rotation is now machinery maintaining a state that nothing needs.

**The pools are also load-bearing in the wrong direction.** Because dispatch targets a *pool slot* rather than a *terminal*, autoban cannot address "this specific agent" or "this team's head" — which is exactly what a completion-driven, team-aware dispatch needs to do. A completion report identifies a child by `agentInstanceId`, which is a terminal identity, not a ring position. The rotation is not merely redundant; it is in the way of the sibling plans on this feature.

### What the retirement actually touches — corrected scope

The original plan scoped this to the multi-column pools UI plus the `AutobanConfigState` fields. Reading the code, both halves of that were too small.

> **Superseded:** "Most of the UI is already going. The pools section is rendered inside the multi-column branch (`kanban.html:11151`), which the sibling autoban plan deletes. What survives that deletion — and what this plan removes — is the **state, the rotation logic, and the verbs**."
> **Reason:** There are **three** pool entry points, not one. `kanban.html:11149-11257` is the multi-column copy (deleted by the sibling plan). `kanban.html:10766-10901` is a **separate single-column copy** (`terminalPoolsSectionSc`, with its own add/remove handlers at `:10837` and `:10891`). `kanban.html:6638` posts `addAutobanTerminal` from the controls strip, outside both branches. Since `single-column` is the mode that survives this feature, the copy that matters is the one the original plan assumed was already gone.
> **Replaced with:** This plan removes the **single-column pools UI, the controls-strip entry point, both config shapes, the rotation, the verbs, and the VS Code commands behind them.** The sibling autoban plan removes only the multi-column copy as a side effect of deleting its branch, and it lands first (fixed order, agreed in that plan), so this plan works against one known remaining copy rather than probing for which exist.

**`sendCounts` and `sessionSendCount` are different things and die on different cards.** The per-terminal `sendCounts` map (`:97`) breaks ties when picking the least-used terminal in the ring — pool bookkeeping, deleted here. `sessionSendCount` (`:96`) feeds `globalSessionCap` via `_getAutobanRemainingSessionCapacity` (`:9227`), which hard-stops the engine at 200 dispatches; that cap is a timer-era blast-radius bound with no job once dispatch is report-paced, and **the sibling autoban card deletes it in the same change that removes the timer.** Do not delete it here and do not preserve it — it is simply not this card's.

Note the knock-on: `_resetAutobanSessionCounters` (`:8940`) resets `sendCounts`, `poolCursor` and `sessionSendCount`. This card removes the first two, leaving it holding one field; the autoban card deletes the function outright when it removes that field. Leave the emptied function in place rather than half-gutting it from both sides.

**There is already a poolless fallback, which is most of the target resolution.** `_resolveAutobanEffectivePool` (`:9121`) returns the configured pool filtered to alive terminals *only when one is configured*, and otherwise returns the alive non-backup terminals for that role. The second branch is the behaviour this plan keeps; the change is deleting the first branch and the cursor arithmetic layered on top, and adding the team-head preference — not inventing resolution from nothing.

---

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, ui, reliability

---

## User Review Required

**None.** Five decisions made here:

* **Pools are deleted, not disabled.** No empty-pool fallback path left behind.
* **Dispatch targets a named terminal or a team head.** A role resolves to a team head where a team exists for that head role, otherwise to an alive registered terminal for that role.
* **Per-terminal `sendCounts` goes.** With no rotation and no pool display, it is an unread counter.
* **`sessionSendCount` / `globalSessionCap` are out of scope here** — not preserved, just owned by the sibling autoban card, which deletes them alongside the timer they bound.
* **No target is a loud failure**, not a silent skip.

---

## Complexity Audit

* **Score:** 5 / 10

### Routine

* Removing fields from two persisted state shapes and their normalisers.
* Deleting a rotation function and its cursor arithmetic.
* Deleting a UI section and its handlers.

### Complex / Risky

* **Dispatch target resolution is the real change.** Everything else is deletion; replacing "next terminal in the ring" with "this terminal" touches the path autoban actually uses to send work, and getting it wrong means dispatches land nowhere.
* **The state is shipped, and it lives in two shapes.** `AutobanConfigState.terminalPools` and `SingleColumnAutobanConfig.terminalPools` are separate fields with separate normalisers, kept in sync by `_syncSingleColumnTerminalPools` (`:8931`, `:9683`). Removing one and not the other leaves a half-migrated config.
* **Verb removal is a four-layer change.** The three verbs exist in the generated allowlists, in `KanbanProvider`'s arms, as `switchboard.*` VS Code commands registered in `extension.ts`, and as public methods on `TaskViewerProvider`. Deleting only the allowlist entry leaves the webview calling a verb that no longer resolves; deleting only the arm leaves a registered command with no caller.
* **Neighbour verbs share a prefix.** `resetAutobanTimers` is a live, unrelated verb sitting next to `resetAutobanPools` in the same allowlist. A prefix-matched delete takes it out.

---

## Edge-Case & Dependency Audit

### Race Conditions

* None introduced. Removing the cursor removes shared mutable dispatch state; the session-capacity check that remains is read and written on the existing autoban tick chain.

### Security

* Not a security change.

### Side Effects

* Users with configured pools lose that configuration. Their autoban keeps working, dispatching to a resolved terminal instead of a rotation. This is the intent.
* Unknown keys left in persisted state are harmless as long as the normaliser ignores rather than rejects them — which is also the rule that lets old installs upgrade cleanly.
* Managed pool terminals (`managedTerminalPools`) are terminals autoban created. Deleting the state must not orphan them: they are ordinary terminals afterwards and remain closable by the user. Do **not** close them as part of the migration.

### Dependencies & Conflicts

* **`src/services/autobanState.ts`** — `AutobanConfigState`: `terminalPools` (`:30`, `:98`), `managedTerminalPools` (`:99`), `poolCursor` (`:100`), `sendCounts` (`:97`), the default (`:65`), the normalisation (`:261-263`) and the assembly (`:286-288`). `SingleColumnAutobanConfig`: `terminalPools` (`:29`), its default (`:65` block) and its normaliser (`:79-80`). `sessionSendCount` (`:96`, `:284`) and `globalSessionCap` (`:95`) are the autoban card's, not this one's.
* **`src/services/TaskViewerProvider.ts`** — `_autobanPoolRoles` (`:8949`), `_normalizeAutobanPoolRole` (`:8964`), `_limitAutobanPool` (`:8968`), `_getConfiguredAutobanPool` (`:8976`), `_getManagedAutobanPool` (`:8980`), `_resolveAutobanEffectivePool` (`:9121`), `_autobanPoolsEqual` (`:9130`), `_reconcileAutobanPoolState` (`:9135-9200`), the cursor reset (`:8942-8946`), `_selectAutobanTerminal` (`:9234`), `_recordAutobanDispatch` (`:9271`), `_removeAutobanTerminalReferences` (`:9478`), `_removeAutobanTerminal` (`:9689`), `_resetAutobanPools` (`:9722`), `_syncSingleColumnTerminalPools` (`:8931`, called at `:9683`, `:9833`), and the pool-carrying assignments in `setAutomationModeFromKanban`'s single-column branch (`:10186`, `:10198`, `:10218`). Public entry points: `addAutobanTerminalFromKanban` (`:10282`), `removeAutobanTerminalFromKanban` (`:10483`), `resetAutobanPoolsFromKanban` (`:10488`), plus the managed-pool assignment at `:10449`.
* **Verbs and commands** — `addAutobanTerminal`, `removeAutobanTerminal`, `resetAutobanPools` in `TASKVIEWER_VERBS` and `KANBAN_VERBS` (`src/generated/verbAllowlist.ts:7`, `:15`); their arms in `KanbanProvider.ts:10968-10995`, which reach the host through `this._seams().commands.executeCommand('switchboard.*FromKanban', …)`; and the command registrations in `src/extension.ts:1752`, `:1762`, `:1792`. Removing verbs requires `npm run catalog:generate`. **`resetAutobanTimers` is a different verb and stays.**
* **`src/webview/kanban.html`** — the single-column pools section `terminalPoolsSectionSc` (`:10766-10901`) with its add (`:10837`) and remove (`:10891`) handlers; the controls-strip `addAutobanTerminal` post (`:6638`); the pool rendering at `:10414-10429` (`state.terminalPools`, `state.managedTerminalPools`, `state.sendCounts`); the `singleColumnConfig` default literal at `:10445`; and the six payload sites that ship `terminalPools: singleColumnConfig.terminalPools` (`:10506`, `:10567`, `:10593`, `:10651`, `:10691`, `:10732`). The multi-column copy at `:11149-11257` is the sibling plan's, not this one's.
* **`src/webview/implementation.html:1955-1959`** — the same five pool fields appear in a state literal here. Check whether this surface is live before editing; if it is, it must be updated in the same change or it will re-seed removed keys.
* **Sibling plan — autoban single-column.** **Lands first** (fixed order). It deletes the multi-column branch and, with it, the multi-column pools copy. It explicitly does not touch `terminalPoolsSectionSc` or the controls-strip button. Both plans edit `kanban.html`; per the PRD's one-stream-per-file rule they serialise.
* **Sibling card — turn-end notification.** Not a dependency, but the reason target resolution matters: turn-end is attributed to a seat by name via `getActiveDispatchedByTerminal`, a terminal identity, not a ring position.
* **`findTeamForHeadRole`** (`src/services/teamWiring.ts:312`) is the existing team lookup and the one the new resolution should reuse — it reads `terminals.agentGroups` from DB config, the same source the spawn path uses.

---

## Dependencies

* No schema migration — autoban state is persisted config, not a DB table.
* Requires `npm run catalog:generate` after the verb removals.
* Ordering: after the sibling autoban plan's changes 1-2.

---

## Adversarial Synthesis

Key risks: (1) **dispatch target resolution is the one non-deletion in the card** — replacing rotation with a named target touches the live send path, and a wrong resolution means work is dispatched nowhere and the board silently stalls; (2) **the state is shipped and lives in two shapes** (`AutobanConfigState` and `SingleColumnAutobanConfig`), so removing one leaves a half-migrated config and a normaliser that must ignore, not reject, now-unknown keys; (3) **`sendCounts` and `sessionSendCount` differ by a prefix and sit on adjacent lines**, so a name-matched sweep takes the second one out of a card that does not own it and lands it in the wrong change; (4) **verb removal spans four layers** (allowlist, provider arm, VS Code command registration, provider method), and a partial removal leaves the webview calling a dead verb or a registered command with no caller; (5) **prefix-matched deletion catches `resetAutobanTimers`**, an unrelated live verb. Mitigations: implement and test target resolution before deleting the rotation, so there is never a state with neither; confirm the normaliser's unknown-key behaviour explicitly against an old-shape fixture carrying all five removed keys; delete `sendCounts` by exact identifier and leave `sessionSendCount` for the card that owns it; remove all four verb layers together and run `npm run catalog:generate`; delete by exact identifier, never by prefix.

---

## Proposed Changes

**Build order:** (1) target resolution → (2) delete rotation and state → (3) delete verbs, commands and UI. Resolution lands first so dispatch is never left without a target.

### 1. Resolve a dispatch target without a pool

**Context:** `_selectAutobanTerminal` (`:9234`) currently takes `_resolveAutobanEffectivePool`'s list, rotates it by `poolCursor[role]`, breaks ties on `sendCounts`, and returns one name. The second branch of `_resolveAutobanEffectivePool` (alive, non-backup, role-matched terminals) is already poolless and is kept.

**Implementation:** replace the rotation with direct resolution for a role:
1. If a team exists whose head role matches (`findTeamForHeadRole`, `teamWiring.ts:312`), target that team's head.
2. Otherwise target an alive registered terminal for that role — the existing `_getAliveAutobanTerminalNames(role, root, /*includeBackups*/ false)` path, deterministically ordered (it already sorts by name).
3. Otherwise report **no target** and halt that lane.

Keep the session-capacity gate: if `_getAutobanRemainingSessionCapacity() <= 0`, refuse with that reason rather than a bare null.

**Logic:** dispatch should name who it is sending to. A rotation obscures that, and the sibling completion work needs a stable identity to match reports against.

**Edge cases:** **no target must be a loud failure**, not a silent skip. The current path returns `null` when the ring is empty and the caller moves on; the replacement reports "no terminal registered for role X" and halts that lane. A hollow dispatch that reports success is the failure mode this whole feature exists to remove. Distinguish "no target" from "session cap reached" in the surfaced reason — they need different responses from the user.

### 2. Delete the rotation and its state

**Implementation:** remove from `src/services/autobanState.ts` — `terminalPools` (`:30`, `:98`), `managedTerminalPools` (`:99`), `poolCursor` (`:100`), `sendCounts` (`:97`) and **`SingleColumnAutobanConfig.terminalPools` (`:29`)**: the interface fields, the defaults (`:65` in both shapes), the normalisation (`:79-80`, `:261-263`, `:285`) and the assembly (`:286-288`). Leave `sessionSendCount` (`:96`, `:284`) and `globalSessionCap` (`:95`, `:277-281`) alone — the autoban card removes them.

From `src/services/TaskViewerProvider.ts`: `_autobanPoolRoles`, `_limitAutobanPool`, `_getConfiguredAutobanPool`, `_getManagedAutobanPool`, `_autobanPoolsEqual`, `_reconcileAutobanPoolState` and its call sites (`:9807`, `:9823`), the cursor reset (`:8942-8946`), `_syncSingleColumnTerminalPools` (`:8931`) and its calls, the rotation in `_selectAutobanTerminal`, the cursor/`sendCounts` writes in `_recordAutobanDispatch` (keep the `sessionSendCount` increment), `_removeAutobanTerminalReferences` (`:9478`), and the `terminalPools` assignments in `setAutomationModeFromKanban`'s single-column branch. Keep `_normalizeAutobanPoolRole` if anything outside pools still calls it (`:6054`, `:9254`, `:9535` do) — verify before deleting.

**Edge cases:** the normaliser must **ignore** unknown keys in persisted state rather than reject the object. Verify against a fixture in the old shape — an existing install's autoban state contains all five removed keys in `AutobanConfigState` plus one in `singleColumnConfig`, and it has to load. Do not close managed pool terminals as part of the migration; they become ordinary terminals.

### 3. Delete the verbs, commands and UI

**Implementation:**
* Remove the `addAutobanTerminal`, `removeAutobanTerminal` and `resetAutobanPools` arms from `KanbanProvider.ts` (`:10968-10995`) and their entries in `TASKVIEWER_VERBS` / `KANBAN_VERBS`, then run `npm run catalog:generate`. **Do not touch `resetAutobanTimers`.**
* Remove the three command registrations in `src/extension.ts` (`:1752`, `:1762`, `:1792`) and the `TaskViewerProvider` public methods they call (`:10282`, `:10483`, `:10488`) plus the private implementations (`_removeAutobanTerminal` `:9689`, `_resetAutobanPools` `:9722`).
* Remove the single-column pools UI from `src/webview/kanban.html` — `terminalPoolsSectionSc` (`:10766-10901`), the controls-strip `addAutobanTerminal` post (`:6638`), the pool rendering at `:10414-10429`, `terminalPools` from the `singleColumnConfig` default literal (`:10445`) and from the six outbound payloads (`:10506`, `:10567`, `:10593`, `:10651`, `:10691`, `:10732`).
* Update `src/webview/implementation.html:1955-1959` if that surface is live.

**Edge cases:** no tombstone comments. Do not leave a note explaining that pools used to exist. After `catalog:generate`, click every remaining autoban control — a stale allowlist produces an "unknown verb" failure that only shows at runtime.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive.

### Automated Tests

* An old-shape autoban state containing `terminalPools`, `managedTerminalPools`, `poolCursor` and `sendCounts` — plus `singleColumnConfig.terminalPools` — loads without error; the unknown keys are ignored and every surviving key is preserved.
* `sessionSendCount` and `globalSessionCap` are untouched by this card — still present, still normalising, so the autoban card removes them from a known state.
* A dispatch for a role with a registered terminal resolves to that terminal.
* A dispatch for a role with a team resolves to the team's head.
* A dispatch for a role with **no** target reports a failure and halts the lane — it does not return success.
* "No target" and "session cap reached" are distinguishable in the surfaced reason.
* Grepping `src/` for `terminalPools`, `managedTerminalPools`, `poolCursor`, `sendCounts`, `_autobanPoolRoles`, `_syncSingleColumnTerminalPools`, `addAutobanTerminal`, `removeAutobanTerminal` and `resetAutobanPools` returns **nothing**.
* Grepping `src/` for `resetAutobanTimers` still returns its live definition and allowlist entry.
* The generated verb allowlists no longer contain the three removed verbs.

### Manual Verification

1. **Existing user with pools configured:** load, confirm autoban still dispatches and the board still works, and that previously managed terminals are still present and closable.
2. **Dispatch lands somewhere nameable:** confirm the dispatch names the terminal it sent to rather than a slot.
3. **No terminal registered:** confirm the failure is visible rather than a silent no-op.
4. **Team present:** with a team defined for the coder head role, confirm dispatch targets the head.
5. **Every remaining autoban control still works** after `npm run catalog:generate` — no "unknown verb" errors in the webview, and the timers reset button still functions.

---

## Recommendation

Complexity 5 → **Send to Coder.**

Mostly deletion; the one real change is target resolution, and it must land first so dispatch is never left without a way to choose a terminal.

**The thing to get right:** "no target" has to fail loudly. The pool path could rotate onto an empty ring and produce a dispatch that went nowhere while reporting success — the exact hollow-dispatch failure this feature exists to eliminate.

**Second:** delete `sendCounts`, not `sessionSendCount`. They differ by a prefix, sit on adjacent lines and are written by the same function, but only the first is pool bookkeeping. The second is the global session cap, which the sibling autoban card deletes alongside the timer it existed to bound — leaving it here keeps that card's starting state predictable.

**Migration:** none. Autoban state is persisted config; removed keys are ignored on load provided the normaliser tolerates unknown keys, which must be verified against an old-shape fixture covering **both** config shapes rather than assumed.

---

## Completion Report

Implemented in full, in the stated build order. **Phase 1 (target resolution):** replaced `_selectAutobanTerminal` with poolless resolution — checks `findTeamForHeadRoleInRoots` (multi-root, via `_teamLookupRoots`) for a team head, then falls back to the first alive registered terminal for the role (deterministically sorted by name), and logs a distinguishable "no terminal registered for role X" / "no alive terminal for team head role X" warning on failure. The session-capacity gate is preserved. Removed `effectivePool` from `AutobanTerminalSelection` and simplified `_recordAutobanDispatch` to only increment `sessionSendCount`. **Phase 2 (state deletion):** removed `terminalPools`, `managedTerminalPools`, `poolCursor`, `sendCounts` from `AutobanConfigState` and `terminalPools` from `SingleColumnAutobanConfig` (types, defaults, normalisation, and the now-dead `normalizeStringArrayRecord`/`normalizeCountRecord` helpers). Stripped `sendCounts` and `poolCursor` from `_resetAutobanSessionCounters` (left it holding only `sessionSendCount`). Deleted `_resolveAutobanEffectivePool`, `_autobanPoolsEqual`, `_reconcileAutobanPoolState` (replaced with `_pruneStaleBackupRegistry` for the surviving call sites), `_getConfiguredAutobanPool`, `_getManagedAutobanPool`, `_limitAutobanPool`, `_removeAutobanTerminalReferences`, `_removeAutobanTerminal`, `_resetAutobanPools`, `_syncSingleColumnTerminalPools`. Cleaned pool state updates from `_createAutobanTerminal`, `ensureWorktreeTerminals`, `setAutomationModeFromKanban`, `killTerminal`, the terminal closure handler, and `_deregisterAllTerminals` (now stops engine + resets counters inline). **Phase 3 (verbs, commands, UI):** removed the three verb arms from `KanbanProvider.ts`, three command registrations from `extension.ts`, three verb schemas from `verbSchemas.ts`, three message-handler cases from `TaskViewerProvider.ts`, the `terminalPoolsSectionSc` block and `getRolePoolEntries` from `kanban.html` (deleted `resolvedRole`, kept `scSourceCol`), the controls-strip `addAutobanTerminal` post, the pool banner, `terminalPools` from the `singleColumnConfig` default and all five payload sites, the `managedTerminalPools` module-level variable, and `sendCounts`/`terminalPools`/`managedTerminalPools`/`poolCursor` from `implementation.html` (left `globalSessionCap` and `sessionSendCount` alone). Ran `npm run catalog:generate` — the generated allowlists no longer contain the three removed verbs; `resetAutobanTimers` is intact. **Files changed:** `src/services/autobanState.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/verbSchemas.ts`, `src/extension.ts`, `src/webview/kanban.html`, `src/webview/implementation.html`, `src/standalone/bootstrap.ts`, `src/generated/verbAllowlist.ts`, `protocol-catalog.json`. **Could not do / deviations:** kept `_autobanPoolRoles` (plan said to remove it) because it is still called by surviving code — `_createAutobanTerminal` (role validation) and `ensureWorktreeTerminals` (role eligibility check); removing it would break worktree terminal creation. The normaliser ignores unknown keys by construction (it only reads named fields from the input, never rejects extra ones), so old-shape persisted state with the five removed keys loads cleanly.

**Revision (review defects 1–4 fixed):**
1. **No-target silent skip fixed.** Both call sites (`dispatchWithAutobanTerminal` and the tick path) had `if (this._autobanState.automationMode !== 'single-column')` guards around the exhaustion-stop logic. Since single-column is now the only mode, the guard was total suppression — no-target only emitted a `console.warn` to the dev console. Removed the guard at both sites; no-target and session-cap now halt the engine via `_stopAutobanForExhaustion` with a user-visible reason in both paths. Also removed the now-dead `_allEnabledAutobanRolesExhausted` helper (it was only called from those guards).
2. **Typed failure reason.** Widened `_selectAutobanTerminal` return from `AutobanTerminalSelection | null` to `AutobanTerminalSelection | AutobanTerminalSelectionFailure` where `AutobanTerminalSelectionFailure = { reason: 'no-target' | 'session-cap' }`. Both call sites now branch on `'reason' in selection` and surface the typed reason directly — no re-derivation via a second capacity check.
3. **Team lookup made functional.** The resolver now reads the full alive terminal registry (not just names) and inspects `parentInstanceId` — the field that distinguishes team heads (undefined/null) from team members (set to the head's `agentInstanceId`). When `findTeamForHeadRoleInRoots` matches a team, the resolver prefers an unparented terminal (the head) over alphabetically-earlier team members. Without a team match, any alive terminal for the role is selected. The per-dispatch multi-root DB scan is still paid, but now it changes which terminal is selected, not just a log string.
4. **Test file cleaned.** Removed 27 obsolete references from `src/test/autoban-state-regression.test.js`: pool fields from `baseState` and `normalizedNewConfig` input objects, broadcast/normalization assertions for `sendCounts`/`terminalPools`/`managedTerminalPools`/`poolCursor`, and source-text assertions for `addAutobanTerminal`, `resetAutobanPools`, `_reconcileAutobanPoolState`, `_resetAutobanPools`, `effectivePool`, `TERMINAL POOLS` UI, and the effective-pool rendering regex. Left all unrelated assertions (batch size, routing, column rules, terminal naming, shared reviewer, column-to-role mapping, auto-naming) intact.

---

## Review Findings (reviewer pass, 2026-08-15)

The deletion is complete and correctly scoped — `terminalPools`, `managedTerminalPools`, `poolCursor`, `sendCounts` and the three verbs are at zero across `src/` in all four layers (allowlist, provider arm, VS Code command, provider method), `resetAutobanTimers` survived the prefix hazard, `sessionSendCount`/`globalSessionCap` were correctly left to the sibling card, and the retained `_autobanPoolRoles` is genuinely still called from `_createAutobanTerminal` and `ensureWorktreeTerminals`. One MAJOR: removing the controls-strip post at `kanban.html:6638` left the Dispatch header's `+` **"Add a coder terminal" stepper as a live, enabled, no-op button** — the plan mis-scoped a Dispatch-view manual control as pool machinery, and `dispatch-view-contract.test.js` (which exists specifically to enforce PRD contract #6 on that stepper) stayed green because it only greps for `terminalCreateAvailable`. Restored the capability under a non-pool name so both the plan's grep and PRD #6 hold: new `addCoderTerminal` verb (`kanban.html` post → `KanbanProvider` arm → `switchboard.addCoderTerminalFromKanban` in `extension.ts` → `TaskViewerProvider.addCoderTerminalFromKanban` → the surviving `_createAutobanTerminal`), catalog and allowlist regenerated; the poolless resolver now needs those role terminals more than the pool version did. Also corrected: `bootstrap.ts`'s `terminalCreateAvailable:false` comment now names the real command. Validation: `tsc --noEmit` clean bar 5 pre-existing TS2835 errors; `catalog:check`/`mirror:check`/`verb-returns:check`/`lint` green; `test:contract:dispatch-view`, `verb-engine`, `verb-engine-kanban` and 84 other CI-wired suites pass. Remaining risk: target resolution pays a multi-root DB scan (`findTeamForHeadRoleInRoots`) on **every** dispatch, and the team-head preference (unparented terminal wins) is only covered by static reading — no test exercises a live team.

---

## Review Findings (reviewer pass 2, 2026-08-16)

Deletion re-verified and still complete: `terminalPools`, `managedTerminalPools`, `poolCursor`, `sendCounts` and the three verbs are at zero across `src/` in all four layers, `resetAutobanTimers` survived the prefix hazard (still live in `KANBAN_VERBS`), and the `addCoderTerminal` capability restored by the previous pass is intact end to end — `kanban.html:6638` post → `KanbanProvider.ts:10968` arm → `switchboard.addCoderTerminalFromKanban` → `TaskViewerProvider.ts:10207` → `_createAutobanTerminal`, with `test:contract:dispatch-view` green. Poolless target resolution in `_selectAutobanTerminal` reads correctly — team-head preference via `findTeamForHeadRoleInRoots` with an unparented-terminal tiebreak, deterministic alphabetical fallback, and a typed `{ reason: 'no-target' }` that the routed path escalates through intern→coder→lead before stopping loudly. No new findings in this card's own scope and no code changed for it in this pass; the two CRITICALs found this round both live in the sibling autoban card's run-sheet layer. Verification was run, not skipped: `tsc --noEmit` clean bar 5 pre-existing TS2835 errors, `catalog:check`/`mirror:check`/`verb-returns:check`/`lint` green, 92 CI-wired suites executed with 7 failures all reproduced red at HEAD in a baseline worktree. Remaining risk is unchanged — `_selectAutobanTerminal` pays a multi-root DB scan on every dispatch, and no automated test exercises a live team, so the head-preference branch is still covered by static reading only.
