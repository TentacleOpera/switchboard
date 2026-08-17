# Editing a Team Actually Changes the Team

## Goal

A team edited in the TEAMS tab is the team that starts. Add an intern to a team, restart it, and the intern is in the roster, receives its team-scoped standing orders, and is routable by team-scoped role resolution. Today the roster is written once at a team's first start and never again, so every subsequent edit is silently discarded — the UI accepts the change, the definition stores it, and nothing downstream ever sees it.

### Problem analysis — this is a bug, not a limitation

**Reproduced live on this machine, 2026-08-17.** The operator added an intern to the Coding team. Three artifacts hold "the team", and only one of them got the edit:

| artifact | key | state |
|---|---|---|
| **Definition** — what the TEAMS tab edits | `terminals.agentGroups` → `group-coding-mswk2w8r` | `coder×2`, `reviewer×1`, **`intern×1`** (`scope: per-team`, `relationship: reports-to-head`) |
| **Roster** — what standing orders and role routing read | `switchboard.prompts.terminals.groups` → `team_lead_1` | `lead-1`, `lead-1-coder-1`, `lead-1-coder-2`, **`lead-1-coder-3`** — no intern |
| Terminal grid group — cosmetic seating only | `…groups` → `grp_1786765519974_4t987` "coding team" | includes `lead-1-intern` |

The roster disagrees with the definition in **both directions**: it is missing the intern that was added, and it still carries `lead-1-coder-3` from a time when the team had three coders (the definition says two, and no such terminal is live). It is not a stale copy of the current definition — it is a frozen snapshot of whatever the team looked like the first time it was ever started.

**The cause is one branch.** `wireSpawnedTeam` builds the correct roster on every run — `const groupMembers = [headName, ...childNames]` (`teamWiring.ts:1002`) is the actual spawned team, computed fresh — and then throws it away (`:1014-1018`):

```js
await mutateTerminalGroups({ db, settings: opts.settings }, (current) => {
    // Idempotent — skip if a group with this id already exists.
    if (current.some((g) => g && g.id === groupId)) { return current; }
    return [...current, group];
});
```

`groupId` is derived from the head name (`:880-881`), so it is stable across restarts. The first start writes the roster; every start after that hits the early return. The comment calls this "idempotent", and that is the error: idempotence means *running twice has the same effect as running once*, not *the second run is a no-op*. Writing the same computed roster twice is already idempotent. Skipping makes it write-once.

**Why the head name really is stable across a restart — verified, not assumed.** `ptyFleetService.create()` allocates `${role}-1` and increments its collision counter only against `this.terminals` (`ptyFleetService.ts:222-227`), and `kill()` **deletes** the entry from that map before tearing the pty down (`:656`), taking the delegate subtree with it (`:652-655`). Stopping `lead-1` therefore frees the name, and the next start of that team is `lead-1` again → `team_lead_1` again → the branch above fires. Both hosts share this allocator: the extension host reaches it through `ptyHost.ts:69`'s `ptyCreateTerminal`, the standalone host through `bootstrap.ts:1265`. The one caveat is that `groupId` is `opts.teamId || 'team_' + …headName…` (`:880-881`) — the `teamId` override exists on the options type but **no caller passes it today** (`TaskViewerProvider.ts:3058`, `bootstrap.ts:1364`, `agentGroupInstantiation.ts:123`), so the head-derived form is the only one in play.

**What breaks downstream.** The roster is not decoration — it is the membership set three mechanisms resolve against:

- `selectOrders`' `team` branch (`standingOrders.ts:111-119`) does `groups.find(g => g.id === o.teamId)` then `group.members.includes(targetName)`. A seat absent from the roster receives **no** team-scoped standing order. That is why the intern was never told to report back to its head.
- `selectOrders`' `team-head` branch (`:120-131`) has the same membership requirement for the head.
- `resolveTeamScopedRoleTerminal` (`teamWiring.ts:1276`) resolves a role to a seat *on this team* through the same array; a seat missing from it falls back to workspace-wide resolution and is picked by luck. Note its `candidatesIn` helper prefers `g.order` over `g.members` when `order` is non-empty (`:1322-1324`) — so a refresh that updated `members` and left `order` frozen would fix standing orders and leave routing broken.

So the observable symptom is not "the TEAMS tab looks wrong" — it is a seat that silently receives no standing orders and is invisible to team-scoped routing, which is exactly the failure that produced this plan.

### The second half of the bug — the panel writes the stale roster back

**Found during the improve pass, 2026-08-17. Fixing only `wireSpawnedTeam` does not fix the bug.** The roster row now lives at `switchboard.prompts.terminals.groups` (`TERMINALS_GROUPS_KEY`, `teamWiring.ts:99`) — the *same* row the terminals panel reads and saves. Two writers, one row, and the panel side is built on the assumption that the backend never modifies an existing entry. `reloadTerminalGroups`' docblock says so in as many words (`terminals.js:1629-1639`):

> "Merge, not replace: … New groups (ids not yet in memory) are added; existing ones keep their local state — **the backend only adds, never modifies** (idempotency: skip existing group id in teamWiring.ts)."

That assumption is exactly what this plan invalidates, and the code enforcing it runs on the team-start path itself:

1. The backend upserts `team_lead_1` with the intern.
2. The host pushes `terminalsGroupsChanged`; the start path calls `switchToTeamGroup` (`terminals.js:6661-6667`, from `:6623`), whose **first statement** is `await reloadTerminalGroups()`.
3. `reloadTerminalGroups` skips any id already in memory (`:1651-1656`). `team_lead_1` is already in memory from the previous start, so the panel **keeps its stale copy** — no intern.
4. `switchToTeamGroup` then calls `switchToGroup(groupId)` (`:2533`), which calls `saveLayoutSettings()` → `saveSetting('terminals.groups', terminalGroups)` (`:1624`).
5. Host-side, `saveSetting` preserves only rows the client never saw — `current.filter(g => !baseIdSet.has(g.id) && !clientIds.has(g.id))`, then `[...value, ...unseen]` (`kanbanService.ts:268-271`; mirrored at `KanbanProvider.ts:11172-11175`). `team_lead_1` is in `clientIds`, so the **client's stale copy is written** and the fresh upsert is gone — within milliseconds of the start that produced it.

This is deterministic, not a race, and it is on the primary path: the operator edits the team in the TEAMS tab, which *is* the terminals panel, so the panel is open by construction. It also explains why the current append-only behaviour looks correct the first time — on a first start the id is new, `reloadTerminalGroups` adds it, and the panel's copy is the backend's copy.

The `baseIds` mechanism is not at fault and needs no change. It exists to stop a client deleting a row it never saw; it was never meant to arbitrate a row both sides hold. The arbitration belongs where the freshness is: the panel must take the backend's spawn-authoritative fields on reload.

### Not an open question

An earlier plan flagged this as a `[user]` decision — whether it should be its own plan or fold into a broader roster-lifecycle effort. That was miscategorised. Whether a user-visible edit takes effect is not a design choice, and "which plan file does it live in" is triage, not a question for the operator. It is a bug with one cause and one fix, and it gets one plan: this one.

## Metadata

> **Superseded:** **Complexity:** 3
> **Reason:** The improve pass established that the fix is not confined to one branch in `teamWiring.ts`. The panel's `reloadTerminalGroups` explicitly encodes the append-only backend contract this change breaks, and undoes the upsert on the same code path that triggers it — so the change spans a second file (`src/webview/terminals.js`), inverts a documented cross-process contract, and touches shipped webview state on ~4,000 installs. That is a mixed 5, not a routine 3.
> **Replaced with:** **Complexity:** 5

**Complexity:** 5
**Tags:** backend, ui, reliability

## User Review Required

None.

## Architecture Decision — upsert the roster on every team start; the boundary is start, not edit

**Replace skip-if-exists with upsert.** On every `wireSpawnedTeam` run, the row for `groupId` gets the freshly computed `members` and `order`. `wireSpawnedTeam` already knows the truth — `groupMembers` is the team it just spawned — so this is writing a value that is already correct rather than deriving a new one.

**The refresh boundary is team START, not team EDIT.** The roster names **live terminals**. Adding an intern to a definition does not create a terminal, so writing `lead-1-intern` into the roster at edit time would name a seat that does not exist, and `selectOrders` would resolve an order for a dead name. Re-materialising when the team is actually spawned is the only point where the roster can be both fresh and true. Concretely: edit the team, restart it, the roster is correct. No edit-time hook, no watcher, no reconciliation pass.

**Preserve unknown keys on the existing row.** Merge over the stored object rather than replacing it, so any field a webview or a future version added survives — the same posture the codebase already takes for shipped state. `id`, `name`, and `source: 'manual'` are re-asserted because both `loadLayoutSettings` (`terminals.js:1537-1541`) and `reloadTerminalGroups` (`:1644-1648`) discard a group whose `source` is not `manual`/`role`/`worktree`, or whose `layout` is not in `LAYOUT_MODES`.

**Only `members` and `order` are spawn-authoritative — `layout` is not.**

> **Superseded:** "Only `members`, `order`, and `layout` are authoritative from the spawn; everything else on the row is carried through untouched."
> **Reason:** `layout` is operator-authored state on exactly these rows. The layout picker writes `group.layout = requested` for a `source: 'manual'` group (`terminals.js:838-839`), and its own comment states this is *"the only way the operator can author 'planners are 2×2'"*. Making `layout` spawn-authoritative would silently revert that choice on every team restart — trading one silently-discarded user edit for another, in a plan whose entire premise is that silently discarding user edits is the bug. `members` and `order` have no such competing writer: nothing reorders `group.order` by hand; the panel only appends a newly-added terminal (`:2857`) and filters out a removed one (`:4571`), both of which the next spawn recomputes correctly anyway.
> **Replaced with:** `members` and `order` are replaced from the spawn on every start. `layout` is written **only on first registration** (the append path, unchanged) and is carried through untouched on an existing row, alongside every other unknown key. `layoutForTeamSize` therefore still sizes a brand-new team's grid, and never re-sizes one the operator has since tuned.

**Stale members are removed, not merged.** The new `members` array **replaces** the old one; it is not a union. A union would keep `lead-1-coder-3` forever, which is half the bug. The spawned team is the whole truth.

**The panel must stop pinning existing rows.** `reloadTerminalGroups` refreshes the same two fields — `members` and `order` — on an id it already holds, and leaves every other local field alone. This is the minimum that closes the loop and it deliberately preserves the reason "merge, not replace" was written: a reload arriving mid-drag must not discard in-flight local edits, and after this change it still does not — it only adopts the two fields the backend now owns. Because `switchToTeamGroup` reloads *before* `switchToGroup` saves (`terminals.js:6662` then `:6664`), the corrected local copy is what the subsequent whole-array save writes back. The two sides then agree on the same authoritative-field set, in the same order, with no new mechanism, no new message, and no change to `baseIds`.

**No migration.** Nothing is deleted or reformatted — the first start after upgrade overwrites the row with a correct value. An install whose team is never restarted keeps exactly what it has today, which is the current behaviour. Existing wrong rows self-heal on the next start, including the `team_lead_1` row that prompted this.

### Scope boundary — the team *prompt* is a separate write-once, and stays out of this plan

Seventy lines above the roster registration, the standing-order install is the **same** skip-if-exists shape, keyed on `(scope, teamId)` (`teamWiring.ts:943-945` for the `team` order, `:961-963` for `team-head`). Editing a team's `prompt` or `headPrompt` in the TEAMS tab therefore also never reaches a started team — the first start's text is frozen for the life of that `groupId`. This plan does **not** change it, deliberately and not by oversight:

- The failure this plan exists to fix is membership, and membership is fully fixed without it. A newly-added seat receives the team order because the order is *per team*, not per member — restoring it to the roster is sufficient.
- The roster has one writer; the order text does not. `mutateStandingOrders` rows are editable by the operator through the link-up / standing-orders UI, so an unconditional overwrite on every team start would clobber hand-edited instructions — a new instance of this plan's own bug, pointed the other way.
- Refreshing persisted order text is the subject matter of `a-stale-standing-order-can-still-reach-a-live-agent.md`, which already owns the detect-and-rewrite mechanism for superseded instructions. Duplicating a competing rewrite here would give one row two rewriters.

Recorded so the next reader does not mistake the omission for an unnoticed gap.

## Complexity Audit

### Routine

- The write primitive already exists. `mutateTerminalGroups` (`teamWiring.ts:128`) serialises the read-modify-write through `_groupsWriteChain`, handles the bare-key legacy import, and normalises a non-array read to `[]`. Only the transform callback changes.
- `groupMembers`, `order` and `layout` are already computed on every run (`:1002-1011`) — nothing new is derived, a value already in hand simply stops being discarded.
- The webview change is a few lines inside an existing function that already iterates the validated array and already holds the local entry by id.
- No schema, no config key, no new verb, no new broadcast, no `LocalApiServer` route, no `/panels` manifest row.

### Complex / Risky

- **A documented cross-process contract inverts.** `reloadTerminalGroups`' docblock asserts "the backend only adds, never modifies". Leaving that sentence in place after the change is how the next reader restores the bug — the same failure mode as the `// Idempotent` comment.
- **Shipped webview state, ~4,000 installs.** `switchboard.prompts.terminals.groups` holds every user's real manual groups. A transform that drops or malforms an entry corrupts panel state well beyond teams. The `[...value, ...unseen]` host merge (`kanbanService.ts:270`) will faithfully persist whatever the panel hands it.
- **Two rewriters of the same row must agree on the authoritative-field set.** If the backend takes `layout` and the panel does not (or vice versa), the row oscillates between starts. The set is `members` + `order`, stated identically on both sides.
- **`order` is load-bearing for routing, not cosmetics.** `resolveTeamScopedRoleTerminal` reads `order` in preference to `members` (`teamWiring.ts:1322-1324`), so a partial refresh is a silently wrong fix.

## Edge-Case & Dependency Audit

**Race Conditions**

- Two heads spawning concurrently: unchanged. Both writes go through `mutateTerminalGroups`' `_groupsWriteChain`, and an upsert is order-independent across *different* ids. Two starts of the *same* `groupId` cannot overlap — `startTeamById` refuses a second head while the first is live (`teamWiring.ts:781-790`).
- Backend upsert vs. panel save: this is the race the change creates and the reload fix closes. Ordering on the start path is fixed by construction (`reloadTerminalGroups` at `terminals.js:6662`, `switchToGroup`'s save at `:6664`). A save triggered by an *unrelated* action (layout pick, pin, pane drag) between the upsert and the panel's reload writes the stale copy; the next `terminalsGroupsChanged` reload no longer papers over it — it corrects it, because the reload now refreshes existing ids. That is the substantive difference from today, where the stale copy is permanent.
- A reload landing mid-drag: preserved behaviour. Only `members`/`order` are adopted; `layout`, group prefs, and every other local field survive, as the original "merge, not replace" rationale intended.

**Security**

- None. No new network surface, no new persisted secret, no widened input. The roster is derived host-side from terminals the host itself just spawned — never from the wire. Panel input still lands in the existing schema-validated `saveSetting` arm (`verbSchemas.ts:472`).

**Side Effects**

- The roster row is rewritten on every team start rather than once. `terminalsGroupsChanged` already fires on every successful registration, so broadcast volume is unchanged.
- A team whose membership genuinely shrank loses seats from the roster. That is intended (verification 3) and it means any team-scoped standing order for a removed seat stops resolving — the correct outcome, since the seat is not live.
- Teams that never restart are untouched, so no install changes state on upgrade alone.

**Dependencies & Conflicts**

- `src/services/teamWiring.ts` and `src/webview/terminals.js` are both high-traffic files in the current team/terminals work. Per the PRD's orchestration discipline, serialise this against any other stream editing either file — in particular `team-roster-survives-the-webview-whole-array-save.md` (which authored `baseIds`, `lastReadGroupIds`, and the shared-key unification this plan builds on) and `a-stale-standing-order-can-still-reach-a-live-agent.md` (same file, standing-order region).
- Depends on the key unification already being in place: `TERMINALS_GROUPS_KEY = 'switchboard.prompts.terminals.groups'` with the optional settings accessor threaded from all three callers. Present at HEAD (`teamWiring.ts:99`, `:128`); this plan assumes it and does not re-implement it.
- Behaviour-preserving for the shipped extension in the PRD's sense: no verb signature changes, no provider refactor, per-provider tests unaffected. The `verb-returns`, `parity` and `push-routing` ratchets are untouched — no arm's `break`/`return` shape changes and no raw `postMessage` is added.
- Both hosts are covered without host-specific code: `wireSpawnedTeam` stays provider-free and `terminals.js` is served identically by `headlessPanelHtml.ts` under the extension host and under `npx switchboard`.

## Dependencies

- `sess_XXXXXXXXXXXXX — terminals.groups key unification, baseIds save protocol (team-roster-survives-the-webview-whole-array-save)`
- `sess_XXXXXXXXXXXXX — standing-order rewrite/detection for superseded instruction text (a-stale-standing-order-can-still-reach-a-live-agent)`

## Adversarial Synthesis

Key risks: (1) the upsert alone is a no-op in real use — the terminals panel re-reads the row, keeps its stale copy for a known id, and writes it back on the same start path, so both writers must be changed together or the fix is invisible; (2) over-claiming authority — taking `layout` from the spawn would silently revert the operator's per-group layout, reproducing this plan's own bug in the opposite direction; (3) two stale comments (`// Idempotent` in `teamWiring.ts`, "the backend only adds, never modifies" in `reloadTerminalGroups`' docblock) now assert the opposite of the code and are the most likely vector for a future regression. Mitigations: change both sides in one commit with an identical authoritative-field set (`members`, `order`) and nothing more; rewrite both comments as part of the change; land a regression test asserting a second `wireSpawnedTeam` run with different children replaces membership, and a webview-level test asserting the reload adopts refreshed members for an id it already holds.

## Proposed Changes

### `src/services/teamWiring.ts` — roster registration (`:1013-1018`)

- **Context:** `mutateTerminalGroups` (`:128`) already serialises the read-modify-write through `_groupsWriteChain`, imports the legacy bare `terminals.groups` key, and coerces a non-array read to `[]`, so concurrency and migration are solved. The transform callback is the only thing that needs to change.
- **Logic:** In the transform, find the index of the row whose `id === groupId`. Absent → append `group` as today (`layout` included — a new row must carry a valid `LAYOUT_MODES` value or both webview validators drop it). Present → return a copy of the array with that entry replaced by the existing object merged with **only** the spawn-authoritative fields: `{ ...existing, id: groupId, name: headName, source: 'manual', members: groupMembers, order: groupMembers }`. `existing.layout` and every unknown key survive.
- **Implementation:** Keep it inside the single `mutateTerminalGroups` call — do not add a second read or a second mutator, which would reopen the read-modify-write window the chain exists to close. Do not mutate `current[i]` in place; return a new array (the transform's contract is a returned array, and `current` is already a shallow copy of the stored value, so an in-place edit would be invisible-but-lucky rather than correct). Build the `group` literal (`:1004-1011`) as today for the append path and derive the merged object from it, so the two paths cannot drift on field names. Replace the `// Idempotent — skip if a group with this id already exists.` comment (`:1015`): it now describes the opposite of the code, and leaving it is how the next reader restores the bug. State the new rule — *upsert; `members`/`order` come from this spawn, `layout` and unknown keys are preserved.*
- **Edge cases:** A stored entry that is not an object, or is `null`, with a matching id → replace it wholesale with `group` rather than spreading over it (a spread of `null` silently yields a bare object with no `layout`, which both webview validators then discard — the row would vanish from the panel). A stored entry whose `layout` is missing or not in `LAYOUT_MODES` → fall back to the computed `layout` so the merged row stays loadable. A run that spawns **zero** children (head only) → unreachable in practice, since `wireSpawnedTeam` returns early on an empty `childNames` (`:872-879`); no special handling. A `groupId` colliding with a hand-made group of the same id → the spawn wins; `groupId` is `team_`-prefixed and derived from a live head terminal name, which the operator cannot duplicate on a live fleet, and no caller passes the `opts.teamId` override.

### `src/webview/terminals.js` — `reloadTerminalGroups` (`:1640-1663`)

- **Context:** The merge-by-id skip (`:1651-1656`) is the second half of the bug. It exists so a reload arriving mid-drag does not discard in-flight local edits, and it justified itself on a backend contract — "the backend only adds, never modifies" — that this change ends.
- **Logic:** Keep the existing validation filter (`:1644-1648`) unchanged; it is what stops a malformed row entering panel state. For each validated group: if the id is **not** in memory, push it as today. If it **is**, assign only `members` and `order` from the incoming row onto the existing local object, leaving `layout` and every other local field untouched. Track whether anything actually changed so the existing `renderSidebarList()` / `renderGroupTabStrip()` calls (`:1658-1661`) fire on a refresh as well as on an add — a roster whose membership changed but whose id set did not must still redraw. `lastReadGroupIds` (`:1657`) is unaffected: it tracks ids, and the id set is unchanged by a refresh.
- **Implementation:** Guard the field copy — only assign `members`/`order` when the incoming value is an array, so a partial row cannot blank a populated local one. Rewrite the docblock (`:1629-1639`): the "backend only adds, never modifies" sentence is now false and is the single most likely place a future reader reverts this. State the replacement contract — *the backend owns `members` and `order` for rows it registers; every other field is the panel's.*
- **Edge cases:** An id present locally but absent from the backend read (a panel-created manual group) → untouched; this loop never removes. The same id arriving twice in one read → last wins, harmless. A refresh landing while the group is the active one → `renderSidebarList()`/`renderGroupTabStrip()` already redraw; seating is recomputed on the next `switchToGroup`, and `switchToTeamGroup` calls it immediately after the reload on the start path (`:6662-6664`), which is the case that matters.

### `src/services/teamWiring.ts` — `wireSpawnedTeam` docblock

- **Context:** The function's contract is now "the roster reflects the most recent spawn", which is a behaviour change for anything that assumed write-once.
- **Logic:** State it in one line on the docblock, naming the authoritative fields (`members`, `order`) so the panel-side rule and this one are checkable against each other.
- **Implementation:** No other caller depends on write-once — all three call sites (`TaskViewerProvider.ts:3058`, `bootstrap.ts:1364`, `agentGroupInstantiation.ts:123`) check only `wired.ok`. Confirm that before landing rather than assuming it.

## Verification Plan

1. Start a team. Add an intern to it in the TEAMS tab. Restart the team. The roster row's `members` contains the intern.
2. **With the terminals panel open** (the normal case — the TEAMS tab is in it), repeat step 1 and re-read `switchboard.prompts.terminals.groups` *after* the panel has finished seating the team. The intern is still there. This is the step that fails if only `teamWiring.ts` is changed.
3. Send a prompt to that intern. It carries the team-scoped standing order naming its head — the symptom that produced this plan.
4. Remove a member from the definition and restart. The roster **loses** that member; it is not a union. Specifically, a roster holding a `-coder-3` from an earlier three-coder team drops it once the team starts with two.
5. Set a non-default layout on the team's group with the layout picker (e.g. 2×2), then restart the team. The layout is **still** 2×2 and `members` is refreshed — the operator's authored layout is not reverted.
6. Restart a team whose definition has not changed. The roster is byte-identical to what it was — an upsert of the same value is not a visible change.
7. A team started for the first time still registers correctly — the append path is unchanged, and the new row carries a valid `LAYOUT_MODES` layout so the panel loads it.
8. Add an unknown key to a stored roster row by hand, then restart the team. The key survives; `members`/`order` are refreshed.
9. `resolveTeamScopedRoleTerminal` routes a role to the newly added seat after the restart, rather than falling back to workspace-wide resolution. Confirms `order` was refreshed, not just `members`.
10. Start two teams concurrently. Both rows are present and correct — the write chain still serialises.
11. Under `npx switchboard`, the same edit-restart cycle produces the same roster, including step 2's panel round-trip.
12. An edit **without** a restart changes nothing — the roster still names only live terminals, and no order resolves to a seat that does not exist.
13. Trigger an unrelated panel save (pin a pane) immediately after a team start, then let the next `terminalsGroupsChanged` reload land. The roster converges on the backend's value rather than staying stale.

### Automated Tests

- A test asserting a second `wireSpawnedTeam` run with **different** `children` replaces `members` and `order` on the existing row — the direct regression guard, and the one test that would have caught the original half of this.
- A test asserting the replacement is not a union: a member present in the stored row and absent from the new spawn is gone afterwards.
- A test asserting `layout` on an existing row is **preserved** across a re-run whose member count maps to a different `layoutForTeamSize` rung — the guard for the superseded design decision above.
- A test asserting unknown keys on the stored row survive the upsert.
- A test asserting the first-registration append path is unchanged and writes a `LAYOUT_MODES`-valid `layout`.
- A test asserting a `null`/non-object stored entry with a matching id is replaced rather than spread over.
- A webview-level test over `reloadTerminalGroups` asserting an id already in `terminalGroups` has its `members`/`order` refreshed from the incoming read while `layout` and an unknown local field are preserved, and that a redraw is triggered on a members-only change.
- Re-run `standing-orders-marker-contract.test.js`, `team-autostart-workspace-scope.test.js` and `team-scoped-role-routing.test.js` unchanged — `wireSpawnedTeam`'s groupId return contract and the order-install behaviour must be untouched by this.

**Recommendation: Send to Coder** (complexity 3).

## Completion Report

- **Implemented:** Implemented the full two-sided roster upsert fix across backend and webview:
  1. In `src/services/teamWiring.ts` (`wireSpawnedTeam`), updated `mutateTerminalGroups` to perform an in-place upsert for existing `groupId` rows, replacing spawn-authoritative fields `members` and `order` (stale members dropped, non-union) while preserving operator-authored `layout` and unknown custom fields.
  2. In `src/webview/terminals.js` (`reloadTerminalGroups`), updated the reload loop to adopt backend-authoritative `members` and `order` for groups already in memory, triggering redrawing (`renderSidebarList`/`renderGroupTabStrip`) on membership change while leaving local UI fields untouched.
- **Files Changed:**
  - `src/services/teamWiring.ts` — replaced skip-if-exists with upsert preserving `layout` and custom keys; defined the layout whitelist (`TERMINALS_LAYOUT_MODES` after review — see below); updated docblocks.
  - `src/webview/terminals.js` — updated `reloadTerminalGroups` and docblock to adopt refreshed `members`/`order` on existing groups.
  - `src/test/standing-orders-marker-contract.test.js` — added automated unit tests verifying first-registration append, member update and stale member drop (non-union), layout preservation, unknown keys preservation, and non-object entry replacement.
- **Issues Encountered:** None.

## Review Findings

Reviewed against the plan; the upsert design, non-union replacement, `null`-entry handling, unknown-key preservation, rewritten comments and unchanged `{ ok, groupId }` return contract are all correct, and all three call sites (`TaskViewerProvider.ts:3069`, `bootstrap.ts:1368`, `agentGroupInstantiation.ts:123`) read only `ok`/`groupId`, so nothing depended on write-once. One CRITICAL fix applied: the merged row validated the operator's stored `layout` against `TEAM_LAYOUT_LADDER`, which deliberately omits `2v` because a stacked pair is never *auto*-picked — so a restart silently reverted the one layout only a human can author, reproducing this plan's own bug in the direction its superseded-decision block forbids; replaced with `TERMINALS_LAYOUT_MODES`, mirroring the panel's `LAYOUTS` keys, plus a parity gate. Two MAJOR test gaps closed: the plan-required webview-level `reloadTerminalGroups` test did not exist (added six executed cases covering members/order adoption, layout and unknown-field preservation, redraw-on-change, no-redraw-when-unchanged, non-array guard, and malformed-row filtering), and the layout-preservation test pinned `2x2` — a mode inside the ladder, so it passed against both the correct and the broken implementation; mutation-checked that the new `2v` gate goes red without the fix. Also fixed a one-line duplicate-row bug in `reloadTerminalGroups` (`existingMap` was not updated on push, so the same id twice in one read appended two rows into shipped panel state) and asserted a `LAYOUT_MODES`-valid `layout` on the append path. Files changed: `src/services/teamWiring.ts`, `src/webview/terminals.js`, `src/test/standing-orders-marker-contract.test.js`; verification green — standing-orders-marker 54/54, team-autostart-scope 22/22, team-scoped-routing 41/41, terminal-sidebar-groupings 48/48, stage-marker-commit 39/39, `tsc -p tsconfig.test.json` clean, eslint clean, and the verb-returns / parity / push-routing ratchets pass; every named check is invoked by `.github/workflows/integration-tests.yml` (lines 177, 696, 207). Remaining risk (out of scope, pre-existing): `mutateTerminalGroups` re-imports the legacy bare `terminals.groups` key on every write and never clears it, so an operator-deleted row resurrects on the next team start — that code belongs to `team-roster-survives-the-webview-whole-array-save.md`.
