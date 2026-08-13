# The Spawn Primitive Must Wire The Team, Not The Wrapper

## Goal

Move standing-order installation out of the agent-group wrapper, add terminal-group registration, and make a registered group's members actually seatable — so that every parented child is wired at birth regardless of which caller spawned it, and the group it lands in can be opened.

### The problem — one root cause, three reports

All three surfaced in live runs of the terminal-coder-dispatch pattern.

**Report 1:** *"why are you as the lead agent having to dictate the standing orders? why aren't they automatically set when the terminals get created?"* The head agent queried `GET /terminals/standing-orders`, received `[]`, and hand-installed three callback orders before it could dispatch anything.

**Report 2:** *"the terminals created for feature implementation is not stored as a group."* The head and its three coders rendered as four unrelated rows; nothing on the board or in the terminals tab knew they were one unit.

**Report 3 (2026-08-13):** *"why don't the coder terminals appear?"* The operator instantiated the Feature Implementation group and could not get its three coders onto the grid. Confirmed live at the time: all four ptys were `status: "active"` with agent CLIs running (head on `claude`, three coders on `devin`), and a fresh WebSocket attach to a coder returned a clean `hello` frame. They existed and were reachable — the seating layer simply refuses to place them.

### Root cause

`spawnDelegates` (`src/standalone/ptyFleetService.ts:330`) does exactly three things: check the caps, create children with `parentInstanceId`, and name them `${parent.friendlyName}-${d.label||d.role}${suffix}`. That naming is where `Feature Implementation-coder-1` came from. It installs **no standing orders** and registers **no group**.

The standing-order wiring lives one level up, in `instantiateAgentGroupCore` (`src/services/agentGroupInstantiation.ts:136-147`), which installs `AGENT_GROUP_CALLBACK_INSTRUCTION` per worker after the head returns. That wrapper is reached from exactly one place: the Agents-tab instantiate action.

There is a second door into the same primitive. `ptyCreateTerminal` carrying a `delegates` array calls `spawnDelegates` directly (`ptyHost.ts:87-89`, `bootstrap.ts:1121-1123`), bypassing the wrapper entirely. Terminals born through that door get children, parentage and names — and no wiring at all.

So the invariant *"a head's children report to it"* is attached to **one caller** rather than to a step every caller shares. Two doors, one of them wired.

**Report 2 has a different root cause from Report 1, and it is worse.** Group registration does not live one level up — it does not exist anywhere. `instantiateAgentGroupCore` registers no group either, so the Agents-tab instantiate button has never produced one. The only writer of `terminals.groups` in the entire tree is the terminals webview (`terminals.js:1479`, from `saveLayoutSettings`). Report 2 is not "the wiring is attached to the wrong caller"; it is "this has never been implemented".

**Report 3 has a third root cause, and it silently defeats the fix for Report 2.** The seating layer excludes every parented terminal by predicate. `getGroupMembers` (`terminals.js:2452`) builds its liveness set as:

```js
const live = new Set(fleetList.filter(t => t.status !== 'exited' && !t.parentInstanceId).map(t => t.friendlyName));
```

and the `manual` branch (`:2456-2461`) filters the group's explicit `order`/`members` arrays against it. The same predicate is inlined in the `role` (`:2462`) and `worktree` (`:2464`) branches, and appears again in the auto-seat pass (`:2252`) and the derived-group builder (`:2398`) — five sites in total, all present verbatim in the shipped bundle.

Members are parented **by construction** — `spawnDelegates` passes `parent.agentInstanceId` (`ptyFleetService.ts:358`), and the auto-start plan depends on that being true as its recursion guard. So a team group registered with `members: [head, coder-1, coder-2, coder-3]` resolves to `[head]`. **Report 2's fix produces a correctly-registered group that opens to a single pane.** Nothing errors; the members are simply filtered out of their own group.

The sidebar list does *not* apply the predicate — it renders every fleet entry — which is why the operator could see the coders listed while being unable to get them onto the grid, and why the report reads as "they don't appear" rather than "the group is empty".

The dispatch skill is not wrong about this, incidentally: it tells the head to check `GET /terminals/standing-orders` first and treat an existing order as authoritative. It just describes the one path where an order would already be there.

## Metadata

**Complexity:** 7
**Tags:** backend, reliability, bugfix

## User Review Required

None.

## Complexity Audit

### Routine

- The standing-order install itself already exists, idempotency guard included (`agentGroupInstantiation.ts:136-147`). Relocating it is a move, not a rewrite.
- `mutateStandingOrders` (`standingOrders.ts:23`) already serialises concurrent read-modify-write cycles through a module-level promise chain, so the new call site inherits write safety for free.
- Child naming, caps and parentage are untouched.

### Complex / Risky

- **The chosen location does not have a database.** See the superseded callout in Design. This is the finding that changes the plan: in the extension host, `spawnDelegates` runs in a separate child process constructed without a `KanbanDatabase`, so standing-order installation placed there works under `npx` and silently no-ops on the shipped extension.
- **Group registration is net-new state written by a second writer.** `terminals.groups` is currently owned exclusively by the webview, which saves its whole in-memory array. A backend write is clobbered by the panel's next layout save.
- **The group loader silently drops unknown shapes.** `loadLayoutSettings` (`terminals.js:1393-1409`) filters on `id`/`name`/`LAYOUT_MODES.includes(layout)` and then keeps only `source ∈ {manual, role, worktree}`. A registered group with a new `source` is discarded at load with no error.
- **The parentage exclusion must be lifted for explicit membership only, not everywhere.** The predicate is at five sites and they do not mean the same thing. Two are *queries* (`role`/`worktree` derived groups, and the derived-group builder) where "gather every terminal of this kind" including children would change unrelated behaviour and re-create the bucket this plan's own Design rejects. One is the *auto-seat* pass, where placing children automatically would flood the grid on every team start. Only the `manual` branch — where the membership list was written deliberately, by an operator or by this plan's own registration — has no business second-guessing its own names. Lifting all five is the wrong change; lifting one is the fix.
- Cross-host: both `handlePtyVerb` implementations and the shared wrapper must change together or one door stays unwired — the exact divergence `agentGroupInstantiation.ts`'s header comment was written to prevent.

## Edge-Case & Dependency Audit

### Race Conditions

- **Backend write vs. webview save (the significant one).** The panel holds `terminalGroups` in memory and writes the whole array on any layout change (`terminals.js:1479`). A group registered by the backend while a panel is open is erased by the panel's next save. `saveSetting` no-ops in solo mode (`terminals.js:1365`), which narrows but does not close the window.
- **Two heads spawning concurrently.** Both register groups keyed on their own `friendlyName`. Serialise the group write through a promise chain in the style of `KanbanProvider._mutateAgentGroups` (`:4373-4392`) or the second write drops the first.
- **Standing-order writes** are already serialised by `mutateStandingOrders`; concurrent spawns cannot clobber each other's orders.
- **Wiring vs. first prompt.** A child that receives its first prompt before its order is installed gets no standing-orders block. Install before the create call returns to the caller, so `ptyCreateTerminal`'s response implies wiring is done.

### Security

- No new surface. The wiring runs host-side on a definition the operator authored; nothing is read from the wire. The existing guard that drops wire-supplied `startupCommand`/`delegates` in `handlePtyVerb` stays exactly as it is and must not be bypassed by the new hook.

### Side Effects

- Every parented child now consumes a standing-order slot against `MAX_ORDERS = 20`. Wiring was previously opt-in via one button; it is now automatic, so the cap becomes reachable by ordinary use.
- Every head with children now produces a sidebar group. Operators who have arranged panes manually will see new groups appear.
- **Parented terminals become seatable through a manual group.** Today no code path can place a child in a pane except a direct sidebar click (`sanitizePaneAssignments` does not apply the predicate, so manual assignment already works — this is why the operator could seat one by hand). After this change a manual group can seat them too. The auto-seat pass and derived role/worktree groups keep excluding children, so an operator who has not opened a team group sees no difference.
- **A team group needs a layout with enough slots.** `switchToGroup` applies the group's stored `layout`; a 4-member team registered with `'1'` resolves four members into one pane. Layout must be sized at registration — see Implementation Notes.
- `MAX_BLOCK_CHARS = 4000` bounds the whole standing-orders block for one terminal, and truncation is silent (`standingOrders.ts:70-72`).

### Dependencies & Conflicts

- **Depends on** *Retire The Delegate Join Contract* landing first: that plan edits `kill()` and removes `DelegateManager` from the same file, and rebuilds the head's prompt. Doing it after would mean writing wiring against a protocol scheduled for deletion.
- **Blocks** *A Team Starts With Its Head Role*: auto-start multiplies the number of occasions wiring happens. Landing auto-start first ships an interval in which teams start automatically and arrive unwired — the reported defect, made more frequent.
- **Shares `spawnDelegates`** with *Team Members Gain A Scope And A Relationship*, which adds the shared-member reuse branch. Same function; this lands first.
- **Shares `agentGroupInstantiation.ts`** with *A Team Starts With Its Head Role* (removes its manual call sites) and *Team Members Gain A Scope And A Relationship* (changes what a member definition contains). Sequential ownership; no concurrent edits.
- `terminals.groups` shape is asserted by `src/test/terminal-sidebar-groupings-contract.test.js` (`:68`, `:88`), which pins the load and save calls.

## Dependencies

- `sess_20260812190002 — delegate join contract removal` (must land first)
- `sess_20260812190003 — shared post-spawn team wiring (orders + group registration)`

## Adversarial Synthesis

Key risks: placing the wiring in `spawnDelegates`, which in the extension host runs in a DB-less child process — the change would pass every `npx` test and no-op for ~4,000 extension installs; a backend write to `terminals.groups` being clobbered by the terminals panel's next whole-array save; and a registered group whose `source` the webview loader does not recognise being discarded silently at load. Mitigations: install the wiring in a shared host-agnostic function called from the three sites that already hold a `KanbanDatabase` (both hosts' `handlePtyVerb` post-create hook and `instantiateAgentGroupCore`), mirroring the existing `updateMirrorRegistry` precedent; serialise the group write and push a refresh so the panel reloads before it can save; and register with a `source` the shipped loader already accepts.

The fourth risk is the quietest: registering a group whose members the seating layer then filters out, so every verification step passes on stored state while the operator still cannot open the team. `getGroupMembers` excludes parented terminals, and members are parented by construction — the two halves of this plan cancel each other unless the `manual` branch stops applying that predicate. Closed by lifting it on that one branch only, and by a verification step that types into a seated child rather than counting sidebar rows. The rejected alternative is spawning team members unparented so they pass the existing filter: it would make them invisible to `liveDelegateCount()` and both fleet caps, and it collides head-on with the auto-start recursion guard, which is *"a spawn triggers a team only when it has no `parentInstanceId`"* — unparented members would each start a team of their own.

## Design

### Wiring moves to the layer that has a database — not into `spawnDelegates`

> **Superseded:** *"Both halves move into the shared spawn path, so they run for every caller"* — i.e. install standing orders and register the group inside `spawnDelegates` (`ptyFleetService.ts:330`), with the implementation note *"the fleet service already receives a `KanbanDatabase` type import (`ptyFleetService.ts:6`), so thread the mutator through the same seam."*
> **Reason:** The type import exists and the constructor does take an optional `db` — but **in the extension host it is never passed**. `src/standalone/ptyHost.ts:43` constructs `const fleet = new PtyFleetService(workspaceRoot);` with no database and no token, because the fleet lives in a separate child process there. Only `bootstrap.ts:1679` passes one (`new PtyFleetService(workspaceRoot, db, sessionToken)`). The codebase already documents the consequence, at `TaskViewerProvider.ts:625-632`: *"the pty-host child constructs its fleet without a KanbanDatabase (`ptyHost.ts`), so `PtyFleetService.updateRegistryState()` no-ops there. Any code path that creates a terminal WITHOUT going through `handlePtyVerb` must call this, or the terminals it made are invisible to the registry."* Wiring installed in `spawnDelegates` would therefore work perfectly under `npx`, pass verification step 10 ("standalone parity"), and silently do nothing on the shipped extension — the failure shape that is hardest to catch and lands on ~4,000 installs.
> **Replaced with:** A single host-agnostic wiring function in `src/services/` — `wireSpawnedTeam({ db, headName, children })` — called from the three sites that already hold a `KanbanDatabase` after children exist. `spawnDelegates` keeps its current job exactly: caps, creation, parentage, naming.

The three call sites:

| site | why it is the right one |
| :-- | :-- |
| `TaskViewerProvider.handlePtyVerb`, `ptyCreateTerminal` post-create block (`:2181-2185`) | already resolves `const db = await this._getKanbanDb(root ?? effectiveRoot)` and already calls `updateMirrorRegistry(db)` for exactly this class of "must happen for every created terminal but needs the DB" work |
| `bootstrap.ts handlePtyVerb`, `ptyCreateTerminal` arm (`:1113-1125`) | the standalone twin; `db` is in scope |
| `instantiateAgentGroupCore` (`agentGroupInstantiation.ts`) | deliberately runs **below** `handlePtyVerb` (its header comment explains why: the wrapper overwrites `delegates` from role config), so it would otherwise miss the hook entirely |

That covers both doors *and* the wrapper. The wrapper's inline standing-order block is replaced by a call to the shared function — deleted, not duplicated; running both would double every order.

### What gets installed

1. **Standing orders.** For each child created, install the callback order with `parent: <child friendlyName>`, `child: <head friendlyName>`. Orientation is load-bearing and already documented at `agentGroupInstantiation.ts:64-77`: `parent` is the terminal that **receives** the block, `child` is the terminal it is **about**. Backwards, the head is handed a block about a worker that is never told anything, and the worker finishes silently.
2. **Group registration.** Register a terminals group whose members are the head plus its children, keyed on the **head's `friendlyName`**.

The idempotency guard that already exists in the wrapper — *"check for an existing pair before adding, so a re-run after a partial failure does not duplicate orders"* — moves down with the install. It matters more here, not less, because the function is reached from more places.

### Group registration is new work, and it has a second writer

> **Superseded:** *"`terminals.groups` is shipped state. Register through the existing group writer and shape; do not invent a parallel store for auto-created groups."*
> **Reason:** There is no backend group writer to register through. `terminals.groups` has exactly one writer in the tree — `saveLayoutSettings` in the terminals webview (`terminals.js:1479`) — and it writes the **entire** in-memory `terminalGroups` array. Framing this as "use the existing writer" hides both that the backend has to become a second writer and that the first writer will overwrite it.
> **Replaced with:** The backend becomes a second writer to a key the webview owns, and the plan must handle that explicitly: a serialised read-modify-write, and a push that makes the panel reload before it can clobber.

Three constraints follow, and none of them are optional:

- **Serialise the write.** Read-modify-write `terminals.groups` through a promise chain in the style of `KanbanProvider._mutateAgentGroups` (`:4373-4392`) — two heads spawning at once must not drop one another's group. Never write the whole array from a stale read.
- **Push, so the panel reloads before it saves.** After registering, broadcast on the `'terminals'` surface (the rail `terminalWsGateway.ts:502` already uses for `terminalsChanged`) so open panels re-read `terminals.groups` into `terminalGroups`. Without this, the next pane drag in any open panel writes a stale array and the group vanishes with no error anywhere.
- **Use a `source` the shipped loader accepts.** `loadLayoutSettings` (`terminals.js:1393-1409`) keeps a group only when `typeof g.id === 'string' && typeof g.name === 'string' && LAYOUT_MODES.includes(g.layout)`, and then returns it only when `g.source` is `'manual'`, `'role'` or `'worktree'` — anything else falls through to a legacy `assignments` branch and, failing that, becomes `null` and is filtered out. Register as `source: 'manual'` with a valid `layout` and the `{ id, name, source, layout, members, order }` shape (`terminals.js:91`). If a distinct `source: 'team'` is wanted for later UI, the loader's accepted set and `src/test/terminal-sidebar-groupings-contract.test.js` must be extended in the same change — otherwise every auto-registered group is discarded at load and the feature appears to do nothing.

### The group is keyed on the head instance, not the definition

Two live heads must produce two groups. `friendlyName` is already unique and already parent-qualified, so it is the natural key — `Feature Implementation` and `Feature Implementation-2` become distinct groups holding distinct children.

It must be a **registered** group, not a derived `role:` group. A derived role group would gather every coder in the workspace into one bucket, which is the opposite of what the report asks for.

### A registered group must be allowed to contain its own members

Registration without this is inert. `getGroupMembers` (`terminals.js:2452`) intersects a manual group's explicit `order`/`members` arrays with a liveness set that excludes every terminal carrying a `parentInstanceId` — so the group this plan registers resolves to its head alone.

**The `manual` branch stops applying the parentage predicate.** A manual group's membership is a list somebody wrote on purpose: an operator dragging terminals together, or this plan's own registration naming the head and its children. Re-deriving "should this terminal be groupable" from parentage, after the membership question has already been answered explicitly, is the layer confusing a *default* with a *rule*.

The liveness intersection itself stays — a manual group must still drop names that are dead or gone, which is what keeps a stale persisted layout from seating a terminal that no longer exists. Only the parentage clause is dropped, and only for `manual`.

**The other four sites keep the predicate, deliberately:**

| site | why it keeps excluding children |
| :-- | :-- |
| auto-seat pass (`:2252`) | children would seat themselves on every team start, displacing whatever the operator had arranged. Opening a team is opt-in. |
| derived-group builder (`:2398`) | a role bucket that counts children changes the threshold at which derived groups appear at all |
| `role` branch (`:2462`) | this is the "every coder in the workspace" bucket the Design above rejects for team use — including children makes it worse, not better |
| `worktree` branch (`:2464`) | same query semantics; children share their parent's `worktreePath` and would double every count |

Note the existing comment at `:2466-2472`: the `role`/`worktree` branches **inline** the predicate rather than reading the `live` Set, which is why the extras overlay has to re-intersect explicitly. That inlining is what makes this a one-branch change rather than a one-line one — do not "simplify" it by routing all three branches through a shared set, which would silently apply the manual branch's new behaviour to the derived ones.

### What the wrapper keeps

`instantiateAgentGroupCore` retains what is genuinely group-specific: the three-cap pre-flight (which exists so an over-cap group cannot leave an orphan head running), and resolving the head's role and name from the group definition. Its standing-order block is replaced by the shared call.

### Failure handling stays where the comment put it

The wrapper currently returns `success: true` with an error string when terminals were created but the order install failed, on the stated grounds that *"terminals are already created — do not roll back"*. Preserve that shape at the new location: a wiring failure must surface, and must not destroy live terminals to report itself. The same applies to group registration — a failed group write must not undo a successful order install, and neither must kill a terminal.

## Implementation Notes

- Caps are checked in two places today, deliberately: the wrapper pre-flights all three so nothing is created, and `spawnDelegates` re-checks its two. Keep both. The comment at `agentGroupInstantiation.ts:96-101` explains the difference between "nothing happened" and "you now have an orphan agent CLI to close by hand".
- `MAX_ORDERS = 20` is a server-side cap on standing orders. With wiring now automatic, a large fleet can reach it without anyone opening the standing-orders UI. Fail the wiring with a specific error naming the cap rather than silently installing a partial set — note that the wrapper's existing loop does the opposite today (`next.length < MAX_ORDERS` silently stops adding, `:142`), so this is a behaviour the move must correct rather than carry.
- Do not change child naming. `${parent.friendlyName}-${d.label || d.role}${suffix}` is what keeps two heads' children from colliding, and the comment at `:346-349` records why the collision counter cannot be relied on instead.
- Do not give `PtyFleetService` a database in the extension host to make the original design work. The child-process boundary is deliberate; adding DB access there duplicates a seam the codebase has already resolved with `updateMirrorRegistry`.
- The extension-host post-create hook currently fires for `ptyCreateTerminal`, `ptyCreateBatch`, `ptyCloseTerminal` and `ptyRenameTerminal`. Wire the team hook to `ptyCreateTerminal` only — a batch create has no head/child relationship to express.
- A rename of a head or child rewrites its standing orders (`rewriteStandingOrdersForRename`, `standingOrders.ts:37`) but **not** its group membership, which stores names. Either reuse the rename hook for group members or accept and document that a renamed member drops out of its group.
- **Size the registered `layout` to the membership.** `LAYOUTS` (`terminals.js:1259-1267`) gives the slot counts: `1`→1, `2h`/`2v`→2, `1x3`→3, `2x2`→4, `2x3`→6, `3x3`→9. Register the smallest layout whose `slots >= members.length` — a head plus three coders is `2x2`. Registering `'1'` passes the loader's `LAYOUT_MODES.includes(layout)` check and then resolves four members into one pane, which reproduces Report 3 through a different door. `MAX_DELEGATES_PER_PARENT` is 8, so head + members can reach 9 and `3x3` is the ceiling; a team larger than that must clamp rather than fall through to an invalid mode.

## Proposed Changes

### `src/services/teamWiring.ts` (new)

- **Context.** Nothing today owns "wire a head and its children" in a host-agnostic way.
- **Logic.** `wireSpawnedTeam({ db, headName, children })` installs one callback standing order per child (child as `parent`, head as `child`) and registers a terminals group named for the head.
- **Implementation.** Use `mutateStandingOrders` for orders. Use a new serialised mutator for `terminals.groups`. Return `{ ok, error? }` — never throw at the caller, never roll back terminals.
- **Edge Cases.** Idempotent on re-run (skip an existing `(child, head)` pair; skip an existing group id). Fail with a specific `MAX_ORDERS` error rather than a partial install. `db` absent → return an error, do not crash the create.

### `src/services/TaskViewerProvider.ts`

- **Context.** `handlePtyVerb`'s post-create block at `:2181-2185` already resolves the DB and calls `updateMirrorRegistry`.
- **Implementation.** For `ptyCreateTerminal` results carrying `delegates`, call `wireSpawnedTeam` with the same `db`, after the mirror-registry update.
- **Edge Cases.** Only when children were actually created. Surface the wiring error on the verb result; do not fail the create.

### `src/standalone/bootstrap.ts`

- **Context.** The `ptyCreateTerminal` arm at `:1113-1125` calls `spawnDelegates` directly and already has `db` in scope.
- **Implementation.** Same call, same conditions, so both hosts wire identically.
- **Edge Cases.** Must change in the same commit as the extension host.

### `src/services/agentGroupInstantiation.ts`

- **Context.** `:136-147` is the current inline standing-order install.
- **Implementation.** Replace the block with a `wireSpawnedTeam` call. Keep the three-cap pre-flight and the head-role/name resolution. Keep the *"terminals are already created — do not roll back"* result shape.
- **Edge Cases.** Runs below `handlePtyVerb`, so it needs its own call — it will not inherit the hook. Confirm the order is installed exactly once on this path, not twice.

### `src/webview/terminals.js`

**a. Reload on the registration push**

- **Context.** `loadLayoutSettings` at `:1393-1409` filters groups; `saveLayoutSettings` at `:1479` writes the whole array.
- **Implementation.** Add a message arm that re-reads `terminals.groups` into `terminalGroups` on the new push, before any subsequent save.
- **Edge Cases.** A reload that arrives mid-drag must not discard an in-flight local edit; merge by id rather than replacing wholesale if the panel has unsaved local changes.

**b. Let a manual group hold parented members**

- **Context.** `getGroupMembers` at `:2452`. The `live` set at `:2454` excludes `parentInstanceId`; the `manual` branch at `:2456-2461` filters `order`/`members` against it.
- **Logic.** Split the two questions the one set currently answers. Liveness (is this terminal still here?) applies to every branch. Parentage (should this terminal be gathered automatically?) applies only to the branches that *gather* — never to a list that was written explicitly.
- **Implementation.**

```js
    function getGroupMembers(group) {
        if (!group) { return []; }
        // Liveness only. The parentage clause that used to live here answered a
        // DIFFERENT question — "should this terminal be gathered automatically?" —
        // and applying it to `manual` made a group discard the very names it was
        // registered with. A team registers head + children explicitly
        // (teamWiring.ts); members are parented by construction
        // (ptyFleetService.ts:358), so the old set resolved every team to its head
        // alone, with no error anywhere. The role/worktree branches below still
        // exclude children — they are queries, and this is a membership list.
        const live = new Set(fleetList.filter(t => t.status !== 'exited').map(t => t.friendlyName));
```

The `role` and `worktree` branches at `:2462` and `:2464` already inline `!t.parentInstanceId` against `fleetList` rather than reading `live`, so they are unaffected by this edit and must be left exactly as they are. The extras-overlay comment at `:2466-2472` documents that inlining and stays accurate.

- **Edge Cases.** The auto-seat pass (`:2252`) and derived-group builder (`:2398`) are separate call sites with their own copies of the predicate — do not touch them. A dead child is still dropped, by the liveness half of the same set. A manual group whose members were all killed resolves to `[]`, which `switchToGroup` already handles.

## Verification Plan

1. **Report 1, on the shipped host.** In the **VS Code extension**, create a head with children through `ptyCreateTerminal` with a `delegates` payload — the door that bypasses the wrapper. `GET /terminals/standing-orders` must already list one order per child, oriented so the child receives it. Run this before the standalone check, not after: the superseded design passes under `npx` and fails here.
2. **Report 2.** After the same spawn, the terminals tab shows one group containing the head and its children, named after the head.
2a. **Report 3 — the group opens.** Switch to that group. The head **and all its children** are seated into panes, each accepting input. This is the check that catches a correctly-registered but unresolvable group: step 2 passes on membership stored in the DB, and would still pass while `getGroupMembers` filtered every child back out. Verify by typing into a coder pane, not by counting rows in the sidebar — the sidebar never applied the predicate and shows the children either way.
2b. **Derived groups did not change.** With the team live, confirm the derived `role: coder` group still excludes the team's children, and that the auto-seat pass has not placed any child into a pane on its own. A team's members appear when its group is opened and not before.
3. **The group survives a panel save.** With the group visible, drag a pane (or make any change that triggers `saveLayoutSettings`), then reload. The group is still there — this is the clobber check.
4. **Two heads, two groups.** Spawn two heads of the same shape. Two distinct groups, correct membership, no merging.
5. **Not a role group.** Confirm the auto-registered group is a registered group — a third unrelated coder elsewhere in the fleet must not appear in it.
6. **The wrapper path is unchanged in outcome.** Instantiate through the Agents-tab action; orders are installed exactly once, not twice, and a group now appears where none did before.
7. **Idempotency.** Re-run a spawn after a partial failure; no duplicate orders, no duplicate group.
8. **Order cap.** Drive the fleet to `MAX_ORDERS` and confirm a specific error naming the cap, with no partial install and no silently-skipped child.
9. **Caps still pre-flight.** Request an over-cap group and confirm nothing is created — no orphan head.
10. **Wiring failure does not roll back.** Force the order install to fail with terminals already created; the terminals survive and the error surfaces.
11. **Group shape is accepted by the loader.** Reload the panel with a registered group present and confirm it renders — a group with an unrecognised `source` is dropped silently, so this must be checked by reload, not by inspecting the DB.
11a. **Layout fits the team.** Confirm the registered `layout` has at least as many slots as the group has members (head + 3 → `2x2`). A group that opens with members resolved but panes missing is the same failure as Report 3 reached from the other side.
12. **Standalone parity.** Repeat 1–4 against `npx`.

### Automated Tests

Per the session directive, no compilation or automated-test run is part of this pass's verification; the checks above are manual. Note for the implementer: `src/test/terminal-sidebar-groupings-contract.test.js` pins the `terminals.groups` load and save calls and will need extending if the accepted `source` set changes.

## Recommendation

Complexity 7 → **Send to Lead Coder**.

## Completion Summary

Implemented the shared host-agnostic `wireSpawnedTeam({ db, headName, children })` function in a new `src/services/teamWiring.ts`, which installs one callback standing order per child (child as `parent`, head as `child`) via the existing serialised `mutateStandingOrders` and registers a `source: 'manual'` terminals group keyed on the head's `friendlyName`, with layout sized to membership and a module-level promise chain serialising the `terminals.groups` read-modify-write against concurrent heads. The inline standing-order block in `agentGroupInstantiation.ts` was replaced by a call to this function (not removed — the three-cap pre-flight and "do not roll back" result shape are preserved; `AGENT_GROUP_CALLBACK_INSTRUCTION` is re-exported for downstream consumers), and both hosts' `handlePtyVerb` post-create hooks (`TaskViewerProvider.ts` for the extension host, `bootstrap.ts` for standalone) now call `wireSpawnedTeam` after a `ptyCreateTerminal` that produced children, awaited so the create response implies wiring is done, with a `terminalsGroupsChanged` broadcast pushed on success so open panels reload before their next whole-array save can clobber. In `terminals.js`, a new `terminalsGroupsChanged` message arm merges backend-registered groups by id (never replacing in-flight local edits), and `getGroupMembers`'s `live` set was changed to liveness-only — dropping the parentage exclusion for the `manual` branch so a registered team group resolves to its head AND children, while the `role`/`worktree` branches keep inlining `!t.parentInstanceId` untouched.

## Review Findings

CRITICAL, fixed: `src/services/teamWiring.ts:474` declared `const members` for the group membership array while `members` was already destructured from `opts` at `:358` — TS2451 twice plus TS18048, so `npm run compile-tests` and `npm run compile` both failed and the extension could not be built at all; renamed to `groupMembers`. The rest holds: wiring lives in the shared host-agnostic module and is called from all three DB-holding sites, the group registers as `source: 'manual'` with its layout sized from the ladder, the `terminals.groups` write is serialised and followed by a `terminalsGroupsChanged` push, and `getGroupMembers` drops the parentage clause on the `manual` branch **only** — `role` (`:2532`), `worktree` (`:2534`), the auto-seat pass (`:2313`) and the derived-group builder (`:2459`) all still inline `!t.parentInstanceId`. Exercised `wireSpawnedTeam` functionally against a fake DB: correct orders, a `source: 'manual'` / `2x3` group, idempotent on re-run, a specific `MAX_ORDERS` error with no partial install, and `{ok:false}` rather than a crash when `db` is absent. Validation: typecheck clean, `terminal-sidebar-groupings` 38/38, plus `terminal-open-all-seating`, `terminal-pane-pinning` and `multi-parent-terminals` green; all nine static gates exit 0. Remaining risk: a renamed member still drops out of its registered group, since membership stores names and `rewriteStandingOrdersForRename` does not touch it — the outcome the plan's Implementation Notes said to accept and document.
