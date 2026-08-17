# The Team Roster Survives the Terminals Panel's Whole-Array Save

## Goal

A team roster row registered by the backend stays in `terminals.groups` when the terminals panel saves its own copy of that array. Team-scoped role routing then has a roster to resolve against, instead of falling back to workspace-wide resolution and picking a seat by luck.

### What is already correct — do not re-implement it

`wireSpawnedTeam` (`teamWiring.ts:712`) already treats the roster write as load-bearing. Its registration block (`:863-877`) wraps the write and returns `{ ok: false, error: 'Group registration failed: …' }` on a throw, and **all three callers honour that**: `TaskViewerProvider.ts:2905`, `bootstrap.ts:1321`, and `agentGroupInstantiation.ts:123` each check `wired.ok` and surface a `wiringError` rather than reporting a clean start. The backend's own write is also serialised through `_groupsWriteChain` (`teamWiring.ts:107`) and is idempotent by group id (`:868`).

None of that is the defect. A plan that "makes the roster write a precondition of success" would be re-writing work that already shipped.

### The actual defect — two writers, only one of them careful

`terminals.groups` has two writers with asymmetric discipline:

- **Backend** — serialised read-modify-write through `_groupsWriteChain`, merges by id, skips duplicates, never removes anything it did not add.
- **Terminals webview** — `saveSetting('terminals.groups', terminalGroups)` (`terminals.js:1536`), a **blind whole-array overwrite** of its in-memory copy, posted to `/kanban/verb/saveSetting` (`terminals.js:1417`).

So a panel holding a copy of the array read *before* a team started will, on its next save for any unrelated reason — a layout change, a group rename, a drag — write that stale array back and **delete the backend's roster row**.

The code already knows this. All three call sites carry the same comment, in the same words:

> "Push a refresh so an open panel reloads `terminals.groups` before its next whole-array save can clobber the backend-registered group."

That broadcast (`terminalsGroupsChanged`, pushed at `TaskViewerProvider.ts:2919` and `bootstrap.ts:1327`, consumed at `terminals.js:1056` which re-reads and merges by id) narrows the window. It does not close it: it is fire-and-forget, it cannot cancel a save already queued, and nothing re-asserts the row afterwards.

**Standing orders are a different config key**, so they survive the clobber untouched. That is the diagnostic signature.

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

## What changes

**1. A stale whole-array save cannot delete a group the client never saw.**

`terminals.groups` saves stop being a blind overwrite. The save carries the **revision the client last read**; the host compares it to the stored revision and:

- **Revisions match** — the client's array is current. Write it verbatim. Deletions work normally.
- **Revisions differ** — the stored array moved since the client read it. Write the client's array **plus** any stored group whose id is absent from it, because the client cannot have intended to delete a group it never saw.

A monotonic integer stored beside the array is enough. The backend bumps it on every write; the client echoes back whatever it last received.

**2. Why not simply union every save.** A union with no revision check resurrects deliberately deleted groups: an operator removing a group in the panel sends the array minus that group, which is indistinguishable from a stale array missing it. The revision is the only thing that separates "I deleted this" from "I never saw this". Do not ship the union without it.

**3. Do not solve this by changing `source`.** Marking backend rows with a new `source` value so the webview's save can be filtered looks tempting and is a trap: `loadLayoutSettings` (`terminals.js:1448`) **silently discards any group whose source is not `manual`/`role`/`worktree`**, which is exactly why `wireSpawnedTeam` writes `source: 'manual'` (`teamWiring.ts:848` names this). A new value makes the panel drop team groups entirely — a worse bug, with no error anywhere.

**4. Both `saveSetting` paths must be guarded.** `KanbanProvider.ts:11120` delegates to `this._kanbanService.saveSetting(msg)` when a service is present and otherwise falls through to an inline implementation. A guard added to only one leaves the other writing blind.

**5. Keep the broadcast.** `terminalsGroupsChanged` and the merge-by-id re-read at `terminals.js:1056` stay exactly as they are. They shrink the window; this change makes the remaining window harmless. Removing them would trade a closed hole for a slower one.

**6. One implementation covers both hosts.** `KanbanProvider` is constructed by the extension and by `bootstrap.ts`, and both serve `/kanban/verb/saveSetting`, so unlike the delivery-layer work this is not a two-host change. Confirm that at the standalone verb router rather than assuming it.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, reliability

## User Review Required

None. The revision guard, the rejection of a bare union, the `source`-value trap and the two-path guard are all settled above.

## Complexity Audit

### Routine

- A monotonic integer beside an existing config key.
- One id-keyed merge over two small arrays.
- Echoing a value the client already receives on read.

### Complex / Risky

- **Deletion must keep working.** The whole risk of this change is a merge that resurrects a group an operator deleted. Every test that matters is a deletion test.
- **Two `saveSetting` paths** (`KanbanProvider.ts:11120` service delegation vs the inline fallback below it). Guarding one is the likely partial fix.
- **The client must echo a revision it actually read.** A client that sends `0`, `undefined`, or a hardcoded value turns every save into the merge branch and deletions stop working. Treat a missing revision as "stale" (merge), never as "current" (overwrite) — the safe default protects data at the cost of a resurrected group, and the opposite loses one.
- **`_groupsWriteChain` is module-level in `teamWiring.ts`.** The host save arm must enter the *same* serialiser as the backend write, or the compare-and-merge races the very write it is protecting. Reaching it means exporting a mutator from `teamWiring.ts` rather than re-implementing the chain in `KanbanProvider`.

## Edge-Case & Dependency Audit

**Race Conditions**

- The read-compare-merge-write must be atomic with respect to `wireSpawnedTeam`'s registration. Both must run inside `_groupsWriteChain`; a second chain reintroduces the bug at a smaller window and is harder to see.
- Two panels open on the same workspace both save: each carries its own revision, each merges against the newer stored value. Last writer wins on overlapping ids, neither drops the other's unseen groups.
- A team starting while a panel saves is the exact case this exists for and is the primary test.

**Security**

- No new route, no new surface. `saveSetting` already accepts this key from the webview.

**Side Effects**

- A stale client's save now writes a slightly different array than it sent. That is the intent, and it is invisible in the panel because the merge only ever *adds back* rows the client did not know about.
- A group deleted from a panel whose revision is stale survives until that panel re-reads and deletes again. Accepted: a resurrected group is visible and removable; a lost roster is silent and breaks routing.
- The stored revision is new state on an existing key's neighbourhood. Absent revision on an existing install reads as stale → merge → no data loss. No migration needed.

**Dependencies & Conflicts**

- Touches `src/services/KanbanProvider.ts` (both `saveSetting` paths), `src/services/teamWiring.ts` (export the serialised mutator), `src/webview/terminals.js` (read and echo the revision).
- **`terminals.js` is a known divergence hazard** and `KanbanProvider.ts` is heavily contended — the project PRD's one-agent-stream-per-provider-file rule applies to both.
- Independent of `feature_plan_20260816212416_team-verbs-read-the-wrong-workspace-db.md`. That plan owns `terminals.agentGroups` (team **definitions**, resolved from the wrong root) and mentions `terminals.groups` zero times. Different key, different writer, different failure — the two can land in either order.

## Dependencies

- `sess_team_wiring_orders — wireSpawnedTeam, _groupsWriteChain, the roster registration block`
- `sess_terminals_groups_webview — loadLayoutSettings, the whole-array save, the terminalsGroupsChanged re-read`

## Adversarial Synthesis

Key risks: a merge without a revision check that resurrects deleted groups; a guard applied to one of the two `saveSetting` paths; and a compare-and-merge running outside `_groupsWriteChain`, which races the backend registration it exists to protect. Mitigations: gate the merge on a revision the client genuinely read, treat a missing revision as stale, guard both paths, and export the serialised mutator from `teamWiring.ts` rather than re-implementing the chain. Residual: a panel that never re-reads keeps re-adding a group the operator deleted until it refreshes — visible, recoverable, and strictly preferable to a roster that vanishes and degrades routing to a silent alphabetical guess.

## Proposed Changes

### `src/services/teamWiring.ts`

- **Context:** Owns `TERMINALS_GROUPS_KEY` (`:99`), `_groupsWriteChain` (`:107`), and the roster registration inside `wireSpawnedTeam` (`:863-877`).
- **Logic:** Export a serialised mutator — read the array and its revision, apply a caller-supplied transform, bump the revision, write. Re-express the existing registration in terms of it so there is exactly one writer of this key on the host side.
- **Implementation:** Keep the module-level chain; do not create a second one. The registration's idempotent skip-by-id (`:868`) and its `source: 'manual'` (`:848`) are unchanged.
- **Edge Cases:** A non-array stored value is a repair, not a merge — replace it. Preserve unknown keys on each group object; the webview writes fields the host does not model.

### `src/services/KanbanProvider.ts` — `case 'saveSetting'` (`:11120`)

- **Context:** Delegates to `this._kanbanService.saveSetting(msg)` when a service exists, with an inline implementation below it.
- **Logic:** Special-case `terminals.groups` on **both** paths: route through the exported mutator, compare the payload's revision to the stored one, and merge in unseen groups when they differ.
- **Implementation:** Return the new revision in the verb body so the client can echo it on its next save — the project PRD's return-in-body contract makes this the natural carrier, and it avoids a second round-trip.
- **Edge Cases:** A payload with no revision → merge branch. A payload whose `value` is not an array → reject with `{success:false, error}`, never write. Every other key keeps today's behaviour byte-for-byte.

### `src/webview/terminals.js` — `saveSetting` (`:1414`), the group save (`:1536`), the re-read (`:1056`, `:1554`)

- **Context:** Blind whole-array save; already merges by id on the `terminalsGroupsChanged` push.
- **Logic:** Record the revision returned by the load and by each save; send it with subsequent `terminals.groups` saves.
- **Implementation:** Plain script file, no module loading — match the surrounding style. `saveSetting` currently ignores its response (`catch { }` at `:1422`); it must now read the returned revision without becoming failure-sensitive.
- **Edge Cases:** A save that errors must not advance the stored revision, or the next save overwrites with a stale array under a current-looking revision — the one path that loses data.

## Verification Plan

1. Open the terminals panel, start a team, then trigger a panel save (rename a group, change a layout) **without** letting the panel refresh. The team's roster row is still in `terminals.groups`.
2. `resolveTeamScopedRoleTerminal` finds the team's reviewer after step 1, and a `/kanban/dispatch` to `CODE REVIEWED` reports team-scoped routing rather than `fell back to workspace-wide`.
3. Delete a group in the panel with a current revision. It stays deleted through a reload.
4. Delete a group in a panel with a stale revision. It is resurrected — the accepted trade — and deleting again from the refreshed panel removes it for good.
5. Two panels open; start a team from one and save from the other. Neither loses the other's groups.
6. A save whose payload omits the revision takes the merge branch and loses nothing.
7. A save whose `value` is not an array is rejected and the stored array is unchanged.
8. Every other `saveSetting` key round-trips exactly as before.
9. Both hosts: repeat 1-2 under `npx switchboard`, confirming the shared `KanbanProvider` arm covers standalone.
10. Concurrent `wireSpawnedTeam` and a stale panel save, run repeatedly, never produce an empty roster.

### Automated Tests

- A test writing a stale array against a bumped revision and asserting unseen groups survive.
- A test deleting a group at a current revision and asserting it stays deleted — the regression guard for the union trap.
- A test asserting a missing revision takes the merge branch.
- A test asserting both `saveSetting` paths (service present and service absent) apply the guard.
- A concurrency test interleaving the exported mutator with `wireSpawnedTeam`'s registration, asserting neither write is lost.

**Recommendation: Send to Coder** (complexity 4).
