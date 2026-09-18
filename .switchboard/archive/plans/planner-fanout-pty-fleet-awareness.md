# Planner Fan-Out: Make the Round-Robin See the Terminals-Pane Fleet

**Feature:** 9e7c314d-9604-42ce-91bd-5ce0fa520e8b

## Goal

Make the planner round-robin distribute a batch move across terminals that live in the browser Terminals pane, not just terminals that live in VS Code. Today a batch move of plans Created → Planned collapses onto a single terminals-pane agent no matter how many are running, because the pool-resolution helper cannot see them at all.

### The problem

Filling a grid with nine planners and moving nine plans forward looks like fan-out and is not. All nine plans are bundled into one prompt and sent to one terminal; the other eight sit idle. Nothing in the UI says so — the board reports "Distributed 9 plan(s)", the cards move, and the operator discovers it only by watching eight panes do nothing.

### Root cause — two liveness routes, both closed to PTY rows

All line references verified against the working tree on 2026-08-08.

1. A batch move of planner cards runs `KanbanProvider._distributePlannerDispatch` (`src/services/KanbanProvider.ts:5664`), which opens by resolving the pool:

   ```ts
   const { terminals, locationKey } = await tvp.getRoleTerminalSet('planner', workspaceRoot);
   if (terminals.length === 0) { /* fallback: ONE dispatch for every card */ }
   ```

2. `getRoleTerminalSet` (`src/services/TaskViewerProvider.ts:5645`) enumerates `_getAliveAutobanTerminalRegistry(workspaceRoot)` (line 8547) and filters by role.

3. That helper reads the persisted registry (`runtime.terminals` in the DB config) — which **does** contain the PTY rows — and then applies a liveness test that PTY rows cannot pass (lines 8575-8592):

   ```ts
   const isLocal = pidMatch || (nameMatch && ideMatches);
   const heartbeatAlive = !Number.isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < 60_000;
   const alive = isLocal || (heartbeatAlive && ideMatches);
   ```

   - `pidMatch` / `nameMatch` are computed from `vscode.window.terminals`. A PTY terminal is a `node-pty` process owned by the fleet service; it is not a VS Code terminal and appears in neither set.
   - `ideMatches` compares the row's `ideName` against `vscode.env.appName`. PTY rows are written with `ideName: PTY_IDE_NAME` = `'switchboard-pty'` (`src/standalone/ptyFleetService.ts:14`, written at 332-343 in the standalone host and mirrored at `TaskViewerProvider.ts:2033-2043` in the extension host). That string matches no appName and none of the Antigravity/VS Code cross-cases, so `ideMatches` is **always false** for a PTY row.
   - `heartbeatAlive` is dead too: neither writer emits a `lastSeen` field on a PTY row, so `Date.parse(undefined)` is `NaN`. And even a live heartbeat is `&&`-gated on `ideMatches`.

   Both routes to `alive` are therefore closed, and every PTY row is dropped.

The codebase already states this in as many words, at `TaskViewerProvider.ts:8389-8393`:

> Per-surface routing: an api-originated dispatch prefers a live PTY of the requested role, because that is the fleet the calling surface (the browser cockpit) can actually display. `_getAliveAutobanTerminalRegistry` **cannot supply one** — it keeps a row only on a VS Code pid/name match or a heartbeat, and PTY rows have none of those — so the fleet is consulted directly here.

That comment is on `_resolveAgentTerminalForPlan` (line 8379), which works around the gap for the **single-target** case with its own `ptyListTerminals` call. Nothing does the equivalent for the **pool** case, so `getRoleTerminalSet` — the only pool resolver — returns an empty array.

### What the empty pool actually costs

`_distributePlannerDispatch` takes its no-live-terminals branch (5677-5701): it moves every card, then issues **one** `switchboard.triggerBatchAgentFromKanban` for all ids with `targetTerminalOverride` undefined. That resolves a single agent via `_resolveAgentTerminalForPlan`, whose PTY branch is a `.find()` — the first active terminal of the role (8394-8401). Every plan lands there.

The round-robin path below it (5743-5785) — the buckets, the persisted cursor, the concurrent per-terminal dispatch — is never reached. It is correct code that this fleet can never enter.

### Both hosts, not just the extension

`KanbanProvider` is shared, and the standalone host constructs and wires a `TaskViewerProvider` into it (`src/standalone/bootstrap.ts:725`, `767`), so `_distributePlannerDispatch` is live under `npx switchboard` too. There, PTY is the *only* fleet and `vscode.window.terminals` is empty by construction — so the pool is empty on every move. The fix must therefore not be expressed in terms of the extension-only `_ptyHostPort` / `_ptyHostVerb` pair, or it will fix one host and leave the other exactly as broken.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, feature

## User Review Required

None.

## Reconcile Before Building

1. `src/services/TaskViewerProvider.ts` and `src/services/KanbanProvider.ts` both carry uncommitted local changes as of 2026-08-08. Re-grep `getRoleTerminalSet`, `_getAliveAutobanTerminalRegistry`, `_distributePlannerDispatch` and `getPlannerRotationCursor` rather than trusting line numbers here.
2. **One agent stream per provider file** (project PRD). These two files must be edited by a single stream, not two parallel ones.
3. Confirm `_isAutobanBackupTerminalInfo` (used as a filter inside `getRoleTerminalSet`, line 8650) does not classify a PTY row as a backup — if it keys on a field PTY rows happen to carry, the widened pool would still come back empty and the symptom would be unchanged.
4. Confirm `_readTerminalRegistryState` resolves to the same DB config store in the standalone host as it does in the extension host. The whole fix rests on the registry already containing the PTY rows in both.
5. Check when `PtyFleetService.purgePtyTerminals(db)` runs (called at `TaskViewerProvider.ts:1944`). It is the existing defence against stale PTY rows surviving an unclean shutdown, and this change makes stale rows more consequential — a dead row in the pool costs a whole bucket of plans, not just a failed single dispatch.

## Design

### Widen liveness for PTY rows, gated on the caller's surface

`purpose:'pty'` rows do not need VS Code liveness evidence, because their writer already maintains them: both `PtyFleetService.updateRegistryState()` (standalone, 321-349) and `updateMirrorRegistry` (extension, 2021-2050) rewrite the **entire** `purpose:'pty'` partition from the live fleet on every change, preserving other writers' rows verbatim. The row's own `status` field is therefore the authority on whether that terminal is alive.

Add an opt-in to the two helpers, defaulted off:

```ts
_getAliveAutobanTerminalRegistry(workspaceRoot, opts?: { allowPtyFleet?: boolean })
getRoleTerminalSet(role, workspaceRoot, opts?: { allowPtyFleet?: boolean })
```

When `allowPtyFleet` is true, a row with `purpose === 'pty' || ideName === PTY_IDE_NAME` is alive iff `status !== 'exited'`. Every other row keeps the existing test unchanged. When `allowPtyFleet` is false — the default, and therefore every existing caller — the function is byte-for-byte what it is today.

This satisfies the PRD's byte-compatibility contract (shipped VS Code behaviour is untouched, and the new capability is default-OFF) and its host-agnosticism contract (the test reads a persisted row, not a `vscode.*` surface or an extension-only port).

> **Rejected alternative:** call `ptyListTerminals` from `getRoleTerminalSet`, mirroring what `_resolveAgentTerminalForPlan` does at 8394-8401.
> **Why:** that path is guarded on `this._ptyHostPort`, which is set only when the extension host spawns its PTY child (1996) and is undefined in the standalone host — so it would fix `npx switchboard` not at all. It also adds an HTTP round trip inside a function the comment at `KanbanProvider.ts:5747-5751` already warns is expensive enough that it must not be called twice per dispatch.

### Thread the surface discriminator through

`_distributePlannerDispatch` already carries `options.apiOriginated` and already forwards it to every `triggerBatchAgentFromKanban` call (5700, 5773). Pass the same value into the pool resolution:

```ts
const { terminals, locationKey } =
    await tvp.getRoleTerminalSet('planner', workspaceRoot, { allowPtyFleet: !!options?.apiOriginated });
```

**The resolution gate and the delivery gate must stay the same flag.** `handleKanbanBatchTrigger` derives `allowPtyFleet` from the same `apiOriginated` (`TaskViewerProvider.ts:5432`) and uses it for both agent resolution and `_dispatchExecuteMessage`. Resolving a PTY pool for a caller that cannot deliver to a PTY would produce a bucket list whose every send fails — the precise "routing a sidebar dispatch to a terminal the user is not looking at" failure the `allowPtyFleet` discriminator was introduced to prevent (see the note at 8406-8411).

Standalone's registration of `switchboard.triggerBatchAgentFromKanban` ignores its `_apiOriginated` parameter and always routes to the PTY fleet (`bootstrap.ts:832-837`), which is correct there — PTY is the only fleet. Do not "fix" that to honour the flag; it would disable dispatch in the standalone host entirely.

### `locationKey` and the rotation cursor

`getRoleTerminalSet` derives `locationKey` from the set's resolved `worktreePath`s, falling back to the workspace root when there are none and to a `terminals.join('|')` name signature when they are mixed (5653-5667). PTY rows carry `worktreePath`, so nothing special is needed — but two consequences must be stated:

- A pool of PTY planners all created in the main checkout has no `worktreePath`, so `worktreePaths.size === 0` and the key is `path.resolve(workspaceRoot)`. That is the **same key** a pool of VS Code planners in that workspace would produce, so the persisted cursor is shared between them. Acceptable: an arbitrary starting offset is harmless in a round robin.
- A mixed VS Code + PTY pool falls to the name-signature branch, which the existing comment already calls "not expected." Growing the pool changes the signature and therefore the key, silently starting a fresh cursor. Also harmless, also worth a comment rather than a fix.

`advancePlannerRotationCursor` adds `plans.length` once per batch (5785); a pool that grew from 3 to 9 still resolves via `cursor % terminals.length`. **No migration, and no reset.** Resetting to 0 on pool growth would over-load the first terminal for anyone who fills repeatedly.

### Ordering is lexicographic — stable, not numeric

`getRoleTerminalSet` sorts with `a.localeCompare(b)` (5651), so `planner-10` sorts before `planner-2`. At grid scale (≤ 9) this never arises, and the round robin needs only a *stable* order, not a numeric one. Leave it, and say so in a comment — the sidebar's `terminalNameSuffix` comparator does sort numerically, so the two surfaces can disagree about "the first planner" and someone will eventually notice.

### Fix the false success report while here

`_distributePlannerDispatch` dispatches buckets with `Promise.allSettled` and only `console.error`s a rejection (5777-5782), then unconditionally posts:

```
Distributed ${dispatchedIds.length} plan(s) across ${terminals.length} planner terminal(s).
```

With an empty pool that message was unreachable, so the defect was latent. Making the pool non-empty makes it live: every bucket can reject and the board still claims success, while the cards have already been moved forward. Report the shortfall — how many buckets failed and which terminals — using the existing `showStatusMessage` push with `isError: true`, in the same shape as the `moveCardsFailed` push already used for failed column writes (5739-5741).

Do **not** roll back the column moves on a failed bucket. They are persisted before dispatch deliberately ("Pre-move only dispatched cards (optimistic UI). Persist BEFORE the slow /clear+send chain so the move sticks immediately", 5718-5721), and the single-dispatch path has its own rollback story. Reporting is the fix; re-architecting the move/dispatch ordering is not in this plan.

Leave the cursor advancing by `plans.length` regardless of bucket outcome. A skipped index in a round robin costs nothing, and making the advance conditional per bucket would require unwinding a concurrent partition.

### The dispatch limit becomes live

`const limit = !options?.skipLimit && await tvp.getLimitDispatchToTerminals('planner', workspaceRoot);` (5710) caps the batch at `terminals.length` oldest plans when the Agents-tab limit is on. With an empty pool this was unreachable; with nine planners it means a nine-plan cap per move, and the held remainder is already reported in the status suffix (5787-5789).

The two board call sites differ and must stay differing: the forward-move path passes `skipLimit: true` (`KanbanProvider.ts:9197`) and the drag path does not (9337). Verify both against the new behaviour rather than assuming one covers the other.

### Not in scope

- Fan-out for roles other than `planner`. The cursor, the helper name (`getPlannerRotationCursor`), and `_distributePlannerDispatch` are all planner-specific. Generalising them is a separate plan; `role-grid-fill-terminals.md` documents the limitation in its UI.
- Mixed-provider distribution. One role means one pool means one provider, unchanged.
- Any change to the single-plan dispatch path (`TaskViewerProvider.ts:19375-19390`), which already resolves and advances correctly for one card at a time.

## Complexity Audit

### Routine

- Adding an options parameter with a default that preserves existing behaviour, and threading one boolean from an existing call site.
- Reporting failed buckets through an existing push shape.

### Complex / Risky

- **Silently widening the pool for a caller that cannot deliver to it.** The resolution gate and the delivery gate are the same flag by design; decoupling them turns a working single dispatch into N failing ones.
- **Two hosts, one function.** The extension host has `vscode.window.terminals` and a PTY child on a port; the standalone host has neither. A fix expressed against `_ptyHostPort` passes review, passes extension-host tests, and leaves `npx switchboard` broken.
- **Stale registry rows now cost a whole bucket.** Previously a dead PTY row could only lose a single dispatch; in a pool it silently swallows its share of the batch.
- **Behaviour changes for anyone already running terminals-pane planners.** They currently get one busy agent; after this they get N. That is the intent, but it is a live behaviour change on the board, not a new opt-in surface.

## Edge-Case & Dependency Audit

### Race Conditions

- The registry is read once per dispatch and the fleet can change under it. A terminal that exits between the read and the send loses its bucket; the failure report above is what makes that visible.
- `_getAliveAutobanTerminalRegistry` awaits `Promise.all` over PID resolution with a 1s per-terminal timeout. `_distributePlannerDispatch` deliberately reuses its single call rather than re-invoking (the comment at 5747-5751); preserve that — do not add a second resolution for the widened path.
- Buckets dispatch concurrently and the clipboard paste steps serialise behind `_clipboardLock`; nothing about widening the pool changes that, but the wall-clock claim in the existing comment ("~2.5-3x, NOT single-terminal time") only becomes true once the pool is non-empty.

### Security

- No new external input. The role string is already normalised through `_normalizeAutobanPoolRole` / `_normalizeAgentKey`, and every resolved name still passes `_isValidAgentName` before being used as a path segment (5450, 19399).
- Registry rows are persisted state written by trusted local writers; the widened branch reads two fields (`purpose`/`ideName`, `status`) and no path-like values it did not already read.

### Side Effects

- The persisted rotation cursor now advances on batch moves that previously took the fallback branch and never touched it. Existing cursor values remain valid under `% terminals.length`.
- The Agents-tab dispatch limit becomes observable for terminals-pane users for the first time.
- More concurrent agent CLIs receiving prompts at once — which is the point, and is bounded by grid capacity on the creation side.

### Dependencies & Conflicts

- Shares no files with the other subtasks in this feature (they are all `src/webview/*`), so it parallelises with them cleanly.
- `verbSchemas.ts` is untouched — `getRoleTerminalSet` is an internal helper, not a verb arm, so the PRD's HTTP-boundary schema contract does not apply here.
- No verb return-contract change, so no ratchet baseline movement.

## Dependencies

- None. Ships on its own and improves fan-out for any terminals-pane planner pool, however it was created.
- **`role-grid-fill-terminals.md` depends on this**, not the reverse. That plan creates the pool cheaply; this one is what makes the pool mean anything.

## Adversarial Synthesis

Key risks: fixing only the extension host by keying the widened branch on `_ptyHostPort`, which leaves `npx switchboard` exactly as broken while every extension-host test goes green; decoupling the resolution gate from the delivery gate, which converts one working dispatch into N failing ones; and shipping on top of a status message that reports success even when every bucket rejected. Mitigations: the widened liveness test reads only persisted registry fields so it is host-agnostic by construction, both gates derive from the single `apiOriginated` flag with a test asserting the pairing, and the false-success report is fixed in the same change.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context:** `_getAliveAutobanTerminalRegistry` (8547), `getRoleTerminalSet` (5645), `PTY_IDE_NAME` import (29), `_resolveAgentTerminalForPlan`'s existing PTY branch and its explanatory comment (8379-8404).
- **Logic:** Add `opts?: { allowPtyFleet?: boolean }` to both; when set, treat a `purpose:'pty'` / `PTY_IDE_NAME` row as alive iff `status !== 'exited'`; leave every other row's test untouched.
- **Implementation:** Branch inside the existing per-row loop before the `isLocal` computation, so the VS Code path is not merely equivalent but literally unchanged. Add a comment pointing at 8389-8393 so the two workarounds are legible as one story.
- **Edge cases:** Row missing `status`; row carrying both `purpose:'pty'` and a real VS Code pid (treat the PTY branch as authoritative); `allowPtyFleet` omitted (identical output to today).

### `src/services/KanbanProvider.ts`

- **Context:** `_distributePlannerDispatch` (5664) — pool resolution (5676), fallback branch (5677-5701), bucket partition (5752-5758), concurrent dispatch and result handling (5768-5782), status message (5790-5794).
- **Logic:** Pass `{ allowPtyFleet: !!options?.apiOriginated }` into `getRoleTerminalSet`; report rejected buckets instead of only logging them.
- **Implementation:** Keep the single resolution call; do not re-resolve for the report.
- **Edge cases:** All buckets reject; some reject; pool of exactly one (must still take the bucket path, not the fallback).

## Verification Plan

### Automated Tests

1. **Unit — PTY rows are invisible by default.** With a registry containing only `purpose:'pty'` planner rows and no VS Code terminals, assert `getRoleTerminalSet('planner', root)` (no options) returns `[]` — byte-identical to today.
2. **Unit — PTY rows are visible when allowed.** Same registry with `{ allowPtyFleet: true }` returns all active PTY planners, in `localeCompare` order.
3. **Unit — exited PTY rows are excluded.** A `status:'exited'` PTY row is absent from the pool in both modes.
4. **Unit — VS Code liveness is unchanged.** With a mixed registry, assert the non-PTY rows resolve exactly as they do today in both modes (pid match, name+ide match, heartbeat, and each of their negatives).
5. **Unit — backups still excluded.** Assert `_isAutobanBackupTerminalInfo` still filters, and that a PTY row is not mistaken for a backup.
6. **Unit — `locationKey` for a PTY pool.** No worktree paths → the resolved workspace root; one shared worktree → that path; mixed → the name signature. Assert growing the pool inside one worktree keeps the key stable.
7. **Unit — resolution and delivery gates are the same flag.** Assert `_distributePlannerDispatch` derives the `allowPtyFleet` it passes to `getRoleTerminalSet` from the same `options.apiOriginated` it forwards to `triggerBatchAgentFromKanban`. This is the pairing whose divergence turns one working dispatch into N failing ones.
8. **Unit — bucket partition.** With 4 PTY planners and 8 plans, assert 4 buckets of 2, assigned from the persisted cursor via `(cursor + i) % terminals.length`, and **one** `triggerBatchAgentFromKanban` per bucket carrying that bucket's `terminalName` — not one call per plan.
9. **Unit — cursor advances once, by `plans.length`.** Assert a single `advancePlannerRotationCursor(locationKey, 8)`, not eight increments, and that a pre-existing cursor of 7 against a 9-terminal pool resolves without reset or error.
10. **Unit — pool of one still takes the bucket path.** One PTY planner produces one bucket with an explicit `terminalName`, not the undefined-target fallback.
11. **Unit — empty pool still falls back.** With no planners of any kind, assert the existing single-dispatch fallback branch runs unchanged.
12. **Unit — failed buckets are reported.** With every bucket rejecting, assert an `isError: true` status push naming the failure count; assert the success message is not also posted. With some rejecting, assert both the dispatched count and the failure count are reported.
13. **Unit — column moves are not rolled back on bucket failure.** Assert the pre-dispatch moves persist, matching the documented optimistic-UI ordering.
14. **Unit — the dispatch limit.** With the limit on, 9 PTY planners and 20 plans, assert 9 dispatched and the held-count suffix present; assert the forward-move call site's `skipLimit: true` bypasses it and the drag call site's absence of it does not.
15. **Host parity — standalone.** Assert the widened branch reads only persisted registry fields and references neither `vscode.*` nor `_ptyHostPort`, and exercise `getRoleTerminalSet` under a test seam bundle with no `vscode` reachable. Per the PRD, "it compiles" is not the acceptance signal.
16. **Manual (VSIX).** Create 4 planners in the Terminals pane, batch-move 8 plans Created → Planned from the browser board, and confirm each pane receives one prompt covering two plans. Repeat from the VS Code kanban webview and confirm the PTY fleet is **not** targeted there. Then kill one planner's process without closing it and confirm the failure is reported rather than silently swallowed.

## Recommendation

Complexity 5 — **Send to Coder.**

## Review Findings

Implementation is sound and host-agnostic: the widened branch in `_getAliveAutobanTerminalRegistry` reads only persisted registry fields (`purpose`/`ideName` via `_isFleetTerminalInfo`, then `status`), touches no `vscode.*` surface and no `_ptyHostPort`, is default-OFF so every existing caller is byte-identical, and leaves the `_isAutobanBackupTerminalInfo` filter in `getRoleTerminalSet` intact. One deliberate deviation from the plan: `_distributePlannerDispatch` passes `allowPtyFleet: true` unconditionally rather than gating on `options.apiOriginated` — that flag was removed from this path since the plan was written (see `browser-planner-dispatch-surface.test.js`, which pins the host-derived policy), and gating on it would both restore the single-terminal collapse for sidebar moves and leave the standalone host, where PTY is the only fleet, permanently empty; delivery is surface-agnostic through `_resolveAgentTerminalForPlan`/`_dispatchExecuteMessage`, so resolution and delivery still agree. A comment recording that reasoning was added at the call site. Verification items 1–5, 7–9 and 12–13 were added as contract assertions to `src/test/browser-planner-dispatch-surface.test.js` (12/12 passing, up from 7), covering default-off invisibility, exited-row exclusion, backup filtering, single resolution per dispatch, single cursor advance by `plans.length`, the `isError` failure push, and no rollback of the optimistic column moves. Remaining risk: `locationKey` behaviour for mixed VS Code + PTY pools and the live dispatch limit are untested outside manual VSIX.
