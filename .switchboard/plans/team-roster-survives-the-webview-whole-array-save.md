# The Team Roster Survives the Terminals Panel's Whole-Array Save

## Goal

A team roster row registered by the backend stays in `terminals.groups` when the terminals panel saves its own copy of that array. Team-scoped role routing then has a roster to resolve against, instead of falling back to workspace-wide resolution and picking a seat by luck.

### What is already correct — do not re-implement it

`wireSpawnedTeam` (`teamWiring.ts:785`) already treats the roster write as load-bearing. Its registration block (`:911-950`) wraps the write and returns `{ ok: false, error: 'Group registration failed: …' }` on a throw, and **all three callers honour that**: `TaskViewerProvider.ts:2918`, `bootstrap.ts:1324`, and `agentGroupInstantiation.ts:122` each check `wired.ok` and surface a `wiringError` rather than reporting a clean start. The backend's own write is also serialised through `_groupsWriteChain` (`teamWiring.ts:108`) and is idempotent by group id (`:941`).

None of that is the defect. A plan that "makes the roster write a precondition of success" would be re-writing work that already shipped.

*(Line numbers in this section were re-resolved against HEAD during the improve pass — `712 → 785`, `863-877 → 911-950`, `107 → 108`, `868 → 941`, `2905 → 2918`, `1321 → 1324`, `123 → 122`. The claims themselves are unchanged and were re-verified in the code.)*

### The actual defect — the two writers are not writing to the same row

> **Superseded:** "`terminals.groups` has two writers with asymmetric discipline… a panel holding a copy of the array read *before* a team started will, on its next save for any unrelated reason — a layout change, a group rename, a drag — write that stale array back and **delete the backend's roster row**." (The whole-array-clobber race.)
>
> **Reason:** The two writers do not share a config row, so no clobber is possible. `saveSetting`/`getSetting` prefix **every** key with `switchboard.prompts.` before touching storage (`KanbanService.ts:237` and `:211`; the inline fallback in `KanbanProvider.ts:11149` does the same). The terminals panel's `saveSetting('terminals.groups', terminalGroups)` (`terminals.js:1611`) therefore writes **`switchboard.prompts.terminals.groups`**, while `wireSpawnedTeam` writes the **bare** `terminals.groups` via `db.setConfigJson` (`teamWiring.ts:943`). Two different rows. The panel cannot delete a row it never addresses. Confirmed against the live workspace DB: `switchboard.prompts.terminals.groups` holds 624 bytes of real manual groups (`Planners`, `coding team`), and the bare `terminals.groups` key **does not exist in the `config` table at all**. Absence is the disproof — a clobber is a *write*, and a write cannot leave a row missing; a stale-array clobber would have produced a bare row containing the panel's groups.
>
> **Replaced with:** a **key-namespace split**. The backend's roster and the panel's roster are two disconnected config rows, so neither side can see the other. The routing readers read the bare key the panel never fills; the panel reads the prefixed key the backend never fills.

`terminals.groups` is addressed under **two different config keys** by two groups of code that each believe they own it:

- **Backend (bare `terminals.groups`)** — written by `wireSpawnedTeam` (`teamWiring.ts:943`); read by `resolveTeamScopedRoleTerminal` (`teamWiring.ts:1183`), the standing-order group resolution in `TaskViewerProvider.ts:518` and `:658`, and `bootstrap.ts:275`.
- **Terminals panel (`switchboard.prompts.terminals.groups`)** — written by `saveSetting('terminals.groups', terminalGroups)` (`terminals.js:1611`), read by `loadLayoutSettings` (`:1523`) and `reloadTerminalGroups` (`:1629`), both of which go through `loadSetting` → `POST /kanban/verb/getSetting` → the same `switchboard.prompts.` prefixing.

The prefixing is not incidental to the HTTP path. `terminals.js` reaches storage the same way under both hosts — `headlessPanelHtml.ts` serves the panel over `LocalApiServer` for the extension host and for `npx switchboard` alike, and `saveSetting` fetches `/kanban/verb/saveSetting` unconditionally (`terminals.js:1492`). Both hosts land in `KanbanService.saveSetting`, and both prefix.

**Two symptoms follow directly, and both are deterministic — not races:**

1. **Routing never sees the roster.** `resolveTeamScopedRoleTerminal` reads the bare key, finds nothing (`teamWiring.ts:1185` returns `null` on an empty array), and every dispatch falls back to workspace-wide resolution. This is the reported failure.
2. **The panel never seats the team.** `switchToTeamGroup` (`terminals.js:6647`) calls `reloadTerminalGroups()` and then requires the registered `groupId` to be present; the reload reads the prefixed key, the backend wrote the bare one, so the id is never there and the function returns `false` **every time**. The caller (`:6609`) then records `seatFallbackReason = 'its group did not load'` and seats the team by hand via `seatTeamWithoutGroup`.

Symptom 2 is the cheap discriminator between the two theories, and it should be checked first:

- **Key-split (this analysis):** `'its group did not load'` on **every** team start, immediately, 100% of the time.
- **Clobber (superseded):** seating **succeeds**, and the group disappears later, on some unrelated save.

The existing mitigation code is aimed at the superseded theory. All three call sites carry the same comment, in the same words:

> "Push a refresh so an open panel reloads `terminals.groups` before its next whole-array save can clobber the backend-registered group."

That broadcast (`terminalsGroupsChanged`, pushed at `TaskViewerProvider.ts:2931` and `bootstrap.ts:1329`, consumed at `terminals.js:1131` which re-reads and merges by id) cannot help: the re-read it triggers reads the prefixed key, so it reloads an array that has never contained the backend's row. It is a correct mechanism pointed at the wrong row.

**Standing orders are a different config key**, so they survive untouched. That is the diagnostic signature — and it is also the clue that was mis-read: `terminals.standingOrders` and `terminals.agentGroups` are both written bare by the backend and both **exist** in the live DB, which is exactly what a bare backend write looks like when nothing competes with it. `terminals.groups` is the one bare key that has a prefixed doppelgänger, and it is the one that fails.

### Observed live, 2026-08-17

Driving a feature with a `lead-1` team on this machine:

```
$ curl -s -X POST .../kanban/dispatch -d '{"plan":"af2bc59d-…","targetColumn":"CODE REVIEWED","from":"lead-1"}'
{"success":true,"moved":true,"dispatched":true,"dispatchedAgent":"Coding-reviewer",
 "teamRouting":"team-scoped: no reviewer on lead-1's team — fell back to workspace-wide"}

$ sqlite3 .switchboard/kanban.db "SELECT value FROM config WHERE key='terminals.groups';"
(empty)
```

Yet the standing orders for that same team are present and carry `teamId: "team_lead_1"` — the team-scoped order and the `team-head` order both installed by the same `wireSpawnedTeam` call that registered the missing roster row. Orders written, roster gone.

The dispatch still reached the right agent, because this workspace has exactly one reviewer and workspace-wide fallback had one candidate. With a second team live it would have handed the card to whichever reviewer sorted first — silently, with `success: true`.

**Re-reading of this evidence during the improve pass.** The observation is preserved verbatim because it is the primary evidence; only its interpretation changes. `(empty)` is the signature of the key split, not of a clobber. Under the clobber theory the bare key would have to *exist* and hold the panel's array; under the key split it is absent because the only writer that addresses it is `wireSpawnedTeam`, and every panel-side write goes elsewhere. The same query on the same DB today returns the same `(empty)` for the bare key while `switchboard.prompts.terminals.groups` returns a populated array — the two-row split, visible in one `SELECT`.

## What changes

**1. One row, addressed one way.** The backend's roster row and the panel's roster row become the same row: `switchboard.prompts.terminals.groups`, the key the panel already reads and writes.

The direction is forced by the install base. That key already holds every user's real manual groups on ~4,000 installs; the bare key holds, at most, rosters written since 2026-08-14. Unifying **onto the prefixed key** leaves the large, valuable dataset in place and moves the small, recent one. Unifying onto the bare key would strand `switchboard.prompts.terminals.*` for every install and would drag a dozen unrelated panel-state keys (`layoutMode`, `paneAssignments`, `pinnedPanes`, `paneModes`, `groupPrefs`, `activeGroupId`, `kanbanPane*`, `linkMode`, `linkPreset`, `osNotify`, `collapsedGroups`, `collapsedWorktrees`) into a migration none of them need.

**2. The backend must write through the scoped-settings layer, not `db.setConfigJson`.** Simply changing the string in `teamWiring.ts` to the prefixed key is **not** sufficient and would produce an intermittently-invisible roster. `_getScopedSetting` (`KanbanProvider.ts:723`) resolves project tier → workspace tier → **`globalState`** → db config, and `kanban.workspaceOverrideEnabled` is `false` on this install (verified). With both overrides off, `_updateScopedSetting` (`:761`) writes `globalState` **and** mirrors to db config, and reads prefer `globalState`. A raw `db.setConfigJson` of the prefixed key is therefore shadowed by the stale `globalState` copy on the next panel read — the roster would be in the DB and invisible to the panel. The standalone host has the same hazard with a different backing store: `globalState` there is `fileBackedMemento(standaloneStateFile)` (`bootstrap.ts:696`).

So the roster write needs a settings-accessor seam. `wireSpawnedTeam` is deliberately provider-free — it takes `db` only, and `resolveTeamScopedRoleTerminal` documents that purity as load-bearing for the standalone host (`teamWiring.ts:1166-1167`). Preserve that: add an **optional** settings accessor to `WireSpawnedTeamOptions` (a `{ get, set }` pair) that all three callers supply, rather than importing a provider into `teamWiring.ts`.

**3. Migrate the bare key — it shipped.** The bare-key write landed in `1bd39f4a` (2026-08-14) and is an ancestor of `origin/main`, so it is shipped by the project's own test. Any install that started a team on that build has real roster rows under the bare key. On first read after upgrade, import them: union bare `terminals.groups` into the prefixed array by id (prefixed wins on an id collision), then leave the bare row in place rather than deleting it, so a downgrade is not destructive. The import is idempotent — a second pass finds the ids already present and adds nothing.

**4. A stale whole-array save cannot delete a group the client never saw.** Unifying the key creates, for the first time, the exact race the superseded analysis described. So that mechanism is still needed — it was premature, not wrong. Saves of `terminals.groups` stop being a blind overwrite: the client sends the **ids it last read**, and the host writes the client's array plus any stored group whose id is absent from **both** the client's array and the ids it says it saw.

> **Superseded:** "The save carries the **revision the client last read**; the host compares it to the stored revision… A monotonic integer stored beside the array is enough. The backend bumps it on every write; the client echoes back whatever it last received."
>
> **Reason:** A monotonic counter needs a second stored key (`terminals.groupsRev` or similar) written non-atomically alongside the array; it needs its own absent-on-upgrade handling; and it answers a coarser question than the one being asked. The guard's only job is to re-add ids the client never saw, so the id set the client read **is** the revision — it carries the answer directly instead of encoding a proxy for it. It also removes the failure the plan already flagged as "the one path that loses data": a save that errors cannot advance a stored revision, because no revision is stored.
>
> **Replaced with:** the client sends `baseIds: string[]` — the group ids present in the array it last **read** (from `loadLayoutSettings` or `reloadTerminalGroups`), not the array it is sending. The host computes `unseen = storedIds \ baseIds` and writes `clientArray + stored groups whose id ∈ unseen`. No new stored state, no counter, no migration for the guard itself, and an absent `baseIds` degrades to a full union — the safe direction, and exactly the backward-compatible behaviour an older webview build needs.

Worked cases, for the implementer:

| Client read | Backend added | Client sends | Stored | `unseen` | Written | Correct? |
|---|---|---|---|---|---|---|
| `{A,B}` | — | `[A]` (deleted B) | `{A,B}` | `∅` | `{A}` | B stays deleted ✓ |
| `{A,B}` | `C` | `[A]` (deleted B) | `{A,B,C}` | `{C}` | `{A,C}` | B deleted, C survives ✓ |
| `{A,B}` | `C`, then panel re-read | `[A,B,C]` | `{A,B,C}` | `∅` | `{A,B,C}` | no-op ✓ |
| `{A,B}` (panel 2) | panel 1 deleted B | `[A,B]` | `{A}` | `∅` | `{A,B}` | B resurrected — accepted trade |

**5. Why not simply union every save.** A union with no notion of what the client saw resurrects deliberately deleted groups: an operator removing a group in the panel sends the array minus that group, which is indistinguishable from a stale array missing it. `baseIds` is the only thing that separates "I deleted this" from "I never saw this". Do not ship the union without it.

**6. Do not solve this by changing `source`.** Marking backend rows with a new `source` value so the webview's save can be filtered looks tempting and is a trap: `loadLayoutSettings` (`terminals.js:1529`) and `reloadTerminalGroups` (`:1634`) **silently discard any group whose source is not `manual`/`role`/`worktree`**, which is exactly why `wireSpawnedTeam` writes `source: 'manual'` (`teamWiring.ts:930` names this). A new value makes the panel drop team groups entirely — a worse bug, with no error anywhere.

**7. Both `saveSetting` paths must be guarded.** `KanbanProvider.ts:11143` delegates to `this._kanbanService.saveSetting(msg)` when a service is present (`:11145`) and otherwise falls through to an inline implementation (`:11147-11160`). A guard added to only one leaves the other writing blind. The cleanest shape is to put the guard **inside** `KanbanService.saveSetting` (`KanbanService.ts:232`) and have the inline fallback delegate to the same helper, so there is one implementation rather than two that must be kept in step.

**8. Keep the broadcast.** `terminalsGroupsChanged` and the merge-by-id re-read at `terminals.js:1131` stay. Today they re-read the wrong row and do nothing useful; once the key is unified they do exactly what their comments claim, and they are what makes `switchToTeamGroup` (`:6647`) find the group and seat the team. Removing them would leave symptom 2 unfixed.

**9. One implementation covers both hosts.** `KanbanProvider` is constructed by the extension and by `bootstrap.ts`, and both serve `/kanban/verb/saveSetting`, so unlike the delivery-layer work this is not a two-host change. Confirm that at the standalone verb router rather than assuming it. The `verbSchemas.ts` entry for `saveSetting` (`:469`) requires only `key`, so `baseIds` passes validation with no schema change — add it to the schema as an optional field for documentation, never as `required` (PRD contract #5: permissive and field-accurate).

## Metadata

**Complexity:** 7
**Tags:** bugfix, backend, reliability

## User Review Required

None. The direction of key unification, the settings-seam requirement, the migration of the shipped bare key, the `baseIds` guard, the rejection of a bare union, the `source`-value trap and the two-path guard are all settled above.

## Complexity Audit

### Routine

- One id-keyed set difference over two small arrays.
- Adding an optional field to a payload the schema already accepts.
- Threading an optional accessor through three existing call sites.

### Complex / Risky

- **The root cause was mis-diagnosed once already.** Before writing code, run the discriminator in Verification step 0. If a team start seats correctly and the group vanishes later, this analysis is wrong too and the plan must be re-opened rather than implemented.
- **Key unification touches five read sites and one write site across three files.** `teamWiring.ts:943` (write), `teamWiring.ts:1183`, `TaskViewerProvider.ts:518`, `TaskViewerProvider.ts:658`, `bootstrap.ts:275` (reads). Missing one leaves a reader looking at a row nothing fills — the same class of bug, one layer down, and just as silent.
- **The `globalState` precedence trap.** Writing the prefixed key with `db.setConfigJson` compiles, passes a DB-level test, and is still wrong, because `_getScopedSetting` prefers `globalState` when both overrides are off. Any test that asserts the fix by reading the DB directly will pass while the panel still sees nothing. Tests must read back through the same accessor the panel uses.
- **Shipped-state migration.** The bare key shipped on 2026-08-14. Import it rather than orphaning it; do not delete it (downgrade safety).
- **Deletion must keep working.** The whole risk of the guard is a merge that resurrects a group an operator deleted. Every test that matters is a deletion test.
- **Two `saveSetting` paths** (`KanbanProvider.ts:11145` service delegation vs the inline fallback at `:11147`). Guarding one is the likely partial fix.
- **The client must send ids it actually read.** A client that sends `[]`, `undefined`, or the array it is *saving* rather than the array it *read* breaks the guard in one of two directions: sending the saved array's ids makes every deletion look "seen" and the merge never fires; sending nothing makes every save take the union branch and deletions stop working. Treat a missing `baseIds` as "saw nothing" (full union), never as "saw everything" — the safe default costs a resurrected group; the opposite loses a roster.
- **`_groupsWriteChain` is module-level in `teamWiring.ts`.** The host save arm must enter the *same* serialiser as the backend write, or the read-diff-write races the very write it is protecting. Reaching it means exporting a mutator from `teamWiring.ts` rather than re-implementing the chain in `KanbanProvider`/`KanbanService`.

## Edge-Case & Dependency Audit

**Race Conditions**

- The read-diff-merge-write must be atomic with respect to `wireSpawnedTeam`'s registration. Both must run inside `_groupsWriteChain`; a second chain reintroduces the bug at a smaller window and is harder to see.
- The serialiser only orders writes *within one process*. The extension host and a concurrently-running `npx switchboard` on the same workspace are two processes with two module instances; the guard degrades there to last-writer-wins-plus-union, which still never drops an unseen group. Note it; do not attempt cross-process locking in this plan.
- Two panels open on the same workspace both save: each carries its own `baseIds`, each diffs against the newer stored value. Last writer wins on overlapping ids, neither drops the other's unseen groups.
- A team starting while a panel saves is the exact case this exists for and is the primary test.
- The migration import (item 3) and a concurrent save must not interleave into a lost row: run the import inside the same serialised mutator, on first read, and make it idempotent by id.

**Security**

- No new route, no new surface. `saveSetting` already accepts this key from the webview. `baseIds` is an array of ids used only for a set difference against ids already stored — it can cause a group to be *retained*, never to be read out, written elsewhere, or executed.

**Side Effects**

- A stale client's save now writes a slightly different array than it sent. That is the intent, and it is invisible in the panel because the merge only ever *adds back* rows the client did not know about.
- A group deleted from a panel with stale `baseIds` survives until that panel re-reads and deletes again. Accepted: a resurrected group is visible and removable; a lost roster is silent and breaks routing.
- Once the key is unified, backend-registered team groups become visible in the terminals panel's group list for the first time. That is the intended behaviour (`switchToTeamGroup` depends on it), but it is a **visible UI change** on upgrade: users who have started teams will see group entries they have not seen before. They are removable like any other group.
- `terminals.groups` gains `globalState` as a second backing store (via `_updateScopedSetting`), so the roster is no longer DB-only. Nothing reads it from `globalState` except the scoped accessor, which is the point.

**Dependencies & Conflicts**

- Touches `src/services/teamWiring.ts` (key + exported serialised mutator + accessor seam), `src/services/KanbanService.ts` (the guard), `src/services/KanbanProvider.ts` (inline `saveSetting` fallback delegates to the guard), `src/services/TaskViewerProvider.ts` (two reads + accessor at the call site), `src/standalone/bootstrap.ts` (one read + accessor at the call site), `src/services/agentGroupInstantiation.ts` (accessor at the call site), `src/webview/terminals.js` (track and send `baseIds`), `src/services/verbSchemas.ts` (optional field).
- **`terminals.js` is a known divergence hazard** and `KanbanProvider.ts` is heavily contended — the project PRD's one-agent-stream-per-provider-file rule applies to both. `verbSchemas.ts` is shared across all provider work; serialise that edit.
- Existing tests assert the **bare** key and will need updating in the same change: `src/test/team-scoped-role-routing.test.js:135` ("no terminals.groups key => null"), `src/test/standing-orders-marker-contract.test.js:871` (stubs the group key), and `src/test/terminal-sidebar-groupings-contract.test.js:68,88` (asserts the webview's `loadSetting`/`saveSetting` call text). The last one asserts the *webview-facing* key name, which does **not** change — only the storage key does — so it should stay green; treat a failure there as a signal that the webview call signature was changed unnecessarily.
- Independent of `feature_plan_20260816212416_team-verbs-read-the-wrong-workspace-db.md`. That plan owns `terminals.agentGroups` (team **definitions**, resolved from the wrong root) and mentions `terminals.groups` zero times. Different key, different writer, different failure — the two can land in either order.

## Dependencies

- `sess_team_wiring_orders — wireSpawnedTeam, _groupsWriteChain, the roster registration block`
- `sess_terminals_groups_webview — loadLayoutSettings, the whole-array save, the terminalsGroupsChanged re-read`
- `sess_scoped_settings_layer — _getScopedSetting / _updateScopedSetting precedence and the switchboard.prompts. prefix`

## Adversarial Synthesis

Key risks: implementing the revision guard alone, which fixes a race that cannot yet happen and leaves routing exactly as broken (the plan's original diagnosis was wrong — the two writers address two different config rows, `terminals.groups` and `switchboard.prompts.terminals.groups`); unifying the key with a raw `db.setConfigJson`, which is shadowed by `globalState` under the scoped-settings layer and yields a roster that is in the DB and invisible to the panel; missing one of the five bare-key read sites; orphaning the shipped bare key instead of importing it; and running the merge outside `_groupsWriteChain`. Mitigations: run the seating discriminator first, unify onto the prefixed key through a settings accessor seam, import the bare key idempotently inside the same serialiser, guard both `saveSetting` paths with one shared implementation, and gate the merge on `baseIds` with a missing value meaning "saw nothing". Residual: a panel that never re-reads keeps re-adding a group the operator deleted until it refreshes — visible, recoverable, and strictly preferable to a roster that vanishes and degrades routing to a silent alphabetical guess.

## Proposed Changes

### `src/services/teamWiring.ts`

- **Context:** Owns `TERMINALS_GROUPS_KEY` (`:99`), `_groupsWriteChain` (`:108`), the roster registration inside `wireSpawnedTeam` (`:911-950`), and the roster read in `resolveTeamScopedRoleTerminal` (`:1183`).
- **Logic:** Point `TERMINALS_GROUPS_KEY` at the storage key the panel uses (`switchboard.prompts.terminals.groups`) and keep it as the single constant every site imports. Export a serialised mutator — read the array, apply a caller-supplied transform, write — and re-express the existing registration in terms of it so there is exactly one writer of this key on the host side. Add an optional settings accessor to `WireSpawnedTeamOptions` and to `resolveTeamScopedRoleTerminal`'s options so the read and the write both go through `_getScopedSetting`/`_updateScopedSetting` when a caller supplies one, falling back to `db.getConfigJson`/`setConfigJson` when none is given.
- **Implementation:** Keep the module-level chain; do not create a second one. Do not import `KanbanProvider` — the accessor is a plain `{ get(key, default), set(key, value) }` pair, which preserves the documented purity at `:1166-1167` and keeps the standalone caller free of a provider. The registration's idempotent skip-by-id (`:941`) and its `source: 'manual'` (`:930`) are unchanged. Perform the bare-key import (see below) inside the mutator, once, before the transform.
- **Edge Cases:** A non-array stored value is a repair, not a merge — replace it. Preserve unknown keys on each group object; the webview writes fields the host does not model. The bare-key import must union by id with the prefixed array winning on collision, must not delete the bare row, and must be a no-op on the second run.

### `src/services/KanbanService.ts` — `saveSetting` (`:232`), `getSetting` (`:206`)

- **Context:** Both build `fullKey = 'switchboard.prompts.' + key` and delegate to the scoped accessors on `_ctx` (`:248`, `:220`), which are wired to `KanbanProvider._updateScopedSetting`/`_getScopedSetting` (`KanbanProvider.ts:7678-7679`).
- **Logic:** Special-case `key === 'terminals.groups'` in `saveSetting`: route the write through the exported `teamWiring` mutator, computing `unseen = storedIds \ baseIds` and appending the stored groups in `unseen` to the client's array. Leave `getSetting` alone — it already returns the array the client needs, and the client derives `baseIds` from it.
- **Implementation:** Put the guard here, not in `KanbanProvider`, and have the inline fallback delegate to it so there is one implementation. Return the stored array in the verb body on success — the PRD's return-in-body contract makes this the natural way for the client to resynchronise `baseIds` without a second round-trip.
- **Edge Cases:** A payload with no `baseIds`, or a `baseIds` that is not an array of strings → treat as `[]` (full union). A payload whose `value` is not an array → return `{success:false, error}`, never write. Every other key keeps today's behaviour byte-for-byte, including the `selectedRole` and `roleConfig_` branches.

### `src/services/KanbanProvider.ts` — `case 'saveSetting'` (`:11143`)

- **Context:** Delegates to `this._kanbanService.saveSetting(msg)` at `:11145` when a service exists, with an inline implementation at `:11147-11160` that duplicates the prefixing and the scoped write.
- **Logic:** Make the inline fallback call the same guarded helper rather than growing a second copy of the merge. The two paths must be indistinguishable from the caller's side.
- **Implementation:** No change to `_getScopedSetting` (`:723`) or `_updateScopedSetting` (`:761`) — their precedence is what the accessor seam exists to respect, not something to work around.
- **Edge Cases:** With no `_kanbanService` and no workspace root, `_updateScopedSetting` writes `globalState` only; the guard must still run so the returned array matches what was stored.

### `src/services/TaskViewerProvider.ts` (`:518`, `:658`, `:2918`), `src/standalone/bootstrap.ts` (`:275`, `:1324`), `src/services/agentGroupInstantiation.ts` (`:122`)

- **Context:** Three bare-key reads that feed standing-order group resolution and the standalone group list, plus the three `wireSpawnedTeam` call sites.
- **Logic:** Replace the literal `'terminals.groups'` with the exported constant and route each read through the same accessor. Supply the settings accessor at each `wireSpawnedTeam` call site.
- **Implementation:** `TaskViewerProvider` and the extension-side `bootstrap` path can hand over the `KanbanProvider` scoped accessors directly; where no provider is in scope, pass the `db`-backed pair, which is correct because that path has no `globalState` to be shadowed by.
- **Edge Cases:** The `terminalsGroupsChanged` pushes at `TaskViewerProvider.ts:2931` and `bootstrap.ts:1329` stay exactly as they are — they become load-bearing for the first time.

### `src/webview/terminals.js` — `loadSetting` (`:1472`), `saveSetting` (`:1489`), `loadLayoutSettings` (`:1523`), `saveLayoutSettings` (`:1611`), `reloadTerminalGroups` (`:1627`)

- **Context:** Blind whole-array save; already merges by id on the `terminalsGroupsChanged` push. `saveSetting` currently ignores its response (`catch { }` at `:1497`).
- **Logic:** Keep one module-scoped `lastReadGroupIds` array. Set it from the **validated** groups on every successful read — in `loadLayoutSettings` after `:1539` and in `reloadTerminalGroups` after the merge — and send it as `baseIds` on the `terminals.groups` save at `:1611`. On a successful save, adopt the ids from the array the host returns.
- **Implementation:** Plain script file, no module loading — match the surrounding style. `saveSetting` is shared by ~15 keys; add an optional third parameter rather than branching on the key name inside it, and do not make it failure-sensitive — a failed save must leave `lastReadGroupIds` untouched, which is the safe direction (the next save takes the union branch).
- **Edge Cases:** `saveSetting` early-returns under solo (`:1490`) — no roster save happens there, and `lastReadGroupIds` must not be advanced by a call that returned early. Track ids the client *read*, never the ids it is *sending*: sending the outgoing array's ids makes every deletion look "seen" and disables the guard entirely.

### `src/services/verbSchemas.ts` — `saveSetting` (`:469`)

- **Context:** Requires only `key`; extra fields pass today.
- **Logic:** Add `baseIds` as an optional array field for documentation.
- **Edge Cases:** Never `required` — a shipped webview build sends no `baseIds`, and a schema that rejects it is a regression on ~4,000 installs (PRD contract #5).

## Verification Plan

0. **Discriminator, before writing any code.** Start a team with the terminals panel open and read `reportTeamStart`'s fallback reason. `'its group did not load'` on the very first start confirms the key split. Successful seating followed by a later disappearance would mean this analysis is wrong and the plan must be re-opened.
1. Start a team. The registered group appears in the panel's group list and the team is seated by the group lock — `seatFallbackReason` is `null`, not `'its group did not load'`.
2. `resolveTeamScopedRoleTerminal` finds the team's reviewer, and a `/kanban/dispatch` to `CODE REVIEWED` reports team-scoped routing rather than `fell back to workspace-wide`.
3. Read the roster back through the same accessor the panel uses (not a raw `sqlite3` query) and confirm it is visible — the `globalState` shadowing check.
4. On an install carrying a bare `terminals.groups` row, upgrade and confirm those rosters appear in the panel's array, that the bare row is still present, and that a second start imports nothing further.
5. Open the terminals panel, start a team, then trigger a panel save (rename a group, change a layout) **without** letting the panel refresh. The team's roster row survives.
6. Delete a group in the panel with current `baseIds`. It stays deleted through a reload.
7. Delete a group in a panel with stale `baseIds`. It is resurrected — the accepted trade — and deleting again from the refreshed panel removes it for good.
8. Two panels open; start a team from one and save from the other. Neither loses the other's groups.
9. A save whose payload omits `baseIds` takes the union branch and loses nothing.
10. A save whose `value` is not an array is rejected and the stored array is unchanged.
11. Every other `saveSetting` key round-trips exactly as before, including `selectedRole` and a `roleConfig_*` key.
12. Both hosts: repeat 1-2 under `npx switchboard`, confirming the shared `KanbanProvider`/`KanbanService` arm covers standalone.
13. Concurrent `wireSpawnedTeam` and a stale panel save, run repeatedly, never produce an empty roster.

### Automated Tests

- A test asserting the backend write and the webview read resolve to the **same storage key** — the regression guard for the defect itself, and the one test that would have caught it.
- A test that writes the roster through the backend path and reads it back through the scoped accessor with a stale `globalState` value present, asserting the roster is visible.
- A migration test: a DB seeded with a bare `terminals.groups` row and a populated prefixed row ends with both sets of ids in the prefixed array, the bare row intact, and no duplicates after a second run.
- A test writing a stale array with `baseIds` missing an id and asserting the unseen group survives.
- A test deleting a group with matching `baseIds` and asserting it stays deleted — the regression guard for the union trap.
- A test asserting a missing `baseIds` takes the union branch.
- A test asserting both `saveSetting` paths (service present and service absent) apply the guard.
- A concurrency test interleaving the exported mutator with `wireSpawnedTeam`'s registration, asserting neither write is lost.
- An assertion that every reference to the roster key uses the exported constant — no remaining string literal at the five former bare-key sites.

**Recommendation: Send to Lead Coder** (complexity 7).

## Completion Report

Unified the team roster configuration key onto `switchboard.prompts.terminals.groups` across backend and terminals webview paths, guarded against stale whole-array clobbers using the `baseIds` set difference algorithm, and added an in-flight bare key migration. Introduced `TerminalGroupsSettingsAccessor` and exported atomic `mutateTerminalGroups` through `_groupsWriteChain` in `teamWiring.ts`, updated `saveSetting` handlers in `KanbanService.ts` and `KanbanProvider.ts`, updated read/write call sites in `TaskViewerProvider.ts`, `bootstrap.ts`, and `agentGroupInstantiation.ts`, added `baseIds` tracking to `terminals.js`, and documented `baseIds` in `verbSchemas.ts`. Files changed: `src/services/teamWiring.ts`, `src/services/KanbanService.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/services/agentGroupInstantiation.ts`, `src/webview/terminals.js`, and `src/services/verbSchemas.ts`. No issues encountered.

