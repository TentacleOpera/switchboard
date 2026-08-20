# Team Standing Orders: Make the Team and Team-Head Scopes Editable

## Goal
Let an operator read and change a team's standing orders — the persistent instructions appended to every prompt its members receive — from the team cockpit. Both team scopes are already implemented end to end in the backend and are unreachable from any UI.

### The problem, and the root cause
Standing orders support four scopes: `'global' | 'team' | 'pair' | 'team-head'` (`src/services/standingOrders.ts:3`). `wireSpawnedTeam` writes two of them at spawn — one `team`-scoped order carrying the team prompt (`src/services/teamWiring.ts:983`) and one `team-head`-scoped order carrying the head prompt (`teamWiring.ts:996`), both keyed on `(scope, teamId)` for idempotency. The resolver applies them correctly. They are real, live, and shipped.

The UI for them does not exist. The only standing-orders surface is a list inside the **Link-up modal** (`#link-standing-list`, `src/webview/terminals.html:2074`), which is a parent/child pairing dialog — `renderStandingList` (`terminals.js:9150`) lists orders and offers delete, and the add path (`terminals.js:9312`) POSTs `{ action: 'add', parent, child, instruction }` with no scope at all, so everything an operator can author is `pair`-scoped by default (`scopeOf` defaults absent scope to `'pair'`, `standingOrders.ts:74`).

Two concrete API gaps block a team-scoped editor even if the UI existed:

1. **`team-head` is rejected on write.** The `POST /terminals/standing-orders` validator accepts only `['global', 'team', 'pair']` (`src/services/LocalApiServer.ts:2466`). The backend *writes* `team-head` orders itself at spawn, but the API refuses to accept one. Any UI attempting to author a head order gets a 400.
2. **There is no update.** The handler supports `add` and delete-by-id only (`LocalApiServer.ts:2510`). Editing means delete-then-add, which mints a new `id` and — worse — breaks the `(scope, teamId)` idempotency contract if the two steps interleave with a re-spawn: `wireSpawnedTeam` checks `teamExists` before pushing (`teamWiring.ts:977`), so a re-spawn landing in the gap between delete and add silently reinstates the *default* prompt and the operator's edit is lost.

So: the feature is built, the storage is right, and it is invisible and unwritable.

## Metadata
- **Complexity:** 5
- **Tags:** backend, frontend, api, ui, feature
- **Project:** browser-switchboard
- **Feature:** 72bda17f-bb0c-4ad9-b9b9-55c19fc9cba7

## User Review Required
No user review required — the API gap closures (`team-head` scope, `update` action), editor UI design, and resolver-reuse strategy are fully specified.

## Complexity Audit

### Routine
- Adding `'team-head'` to the accepted scope list in `_handleStandingOrders` (`LocalApiServer.ts:2466`).
- Adding an `action: 'update'` branch taking `{ id, instruction }`.
- Rendering the editor panel in the team cockpit with team order, head order, and inherited orders.

### Complex / Risky
- The `update` action must preserve `id`, `scope`, `teamId`, `parent`, `child`, and `createdAt` — changing any of these reopens the re-spawn race. If an `updatedAt` field exists, `update` should set it; if not, note the lack of audit trail.
- The "resend to members" action dispatches the updated block immediately — but must respect the idle check. Pasting into a busy agent interrupts it. Match the work queue plan's discipline: enqueue if busy, don't paste into a working agent.
- The "empty instruction = delete" convention — the editor should call `delete` when the instruction is empty, not `update` with an empty string. The API `update` action should reject empty strings; the editor routes empty to `delete`.

## Edge-Case & Dependency Audit
- **Race Conditions:** `update` a team order, then `wireSpawnedTeam` for the same team — the edited instruction must survive because `wireSpawnedTeam` skips an existing `(scope, teamId)` row. This is the reason `update` must not change the key. The delete-then-add failure mode (where a re-spawn lands in the gap and reinstates the default) is what `update` exists to prevent.
- **Security:** The `instruction` field is operator-authored text appended to prompts. No new attack surface — the existing `validateInstruction` guards it. The `update` action must run `validateInstruction` on the new instruction, same as `add`.
- **Side Effects:** Editing a standing order changes what is appended to **future** prompts only; agents already running do not re-read it. The plan correctly says so and offers a "resend to members" action. The resend must respect the idle check.
- **Dependencies & Conflicts:** Depends on team identity foundation (resolving the cockpit's team to the `teamId` its orders are keyed on) and team cockpit (the surface this editor lives in). The preview uses `applyStandingOrdersClient` (`terminals.js:8822`) which needs the whole fleet — the cockpit plan's "filter at render boundary, keep the model whole" ensures this. No conflict.

## Adversarial Synthesis
Key risks: (1) the `update` action must preserve all key fields to avoid reopening the re-spawn race — if `updatedAt` exists, set it; (2) "resend to members" must respect the idle check — pasting into a busy agent interrupts it, matching the work queue plan's discipline; (3) "empty instruction = delete" must be an editor-side routing to `delete`, not an API `update` with an empty string. Mitigations: preserve all key fields in `update`; check idle before resend, enqueue if busy; route empty instructions to `delete` in the editor.

## Proposed Changes

### `src/services/LocalApiServer.ts`
- **Context:** `_handleStandingOrders` (line 2423) accepts only `['global', 'team', 'pair']` scopes and supports `add` and delete-by-id only. The backend writes `team-head` orders at spawn but the API refuses to accept one.
- **Logic:** Add `'team-head'` to the accepted scope list at line 2466, requiring `teamId` for it exactly as `team` already does. Add an `action: 'update'` branch taking `{ id, instruction }`: validate with `validateInstruction`, then mutate in place through `mutateStandingOrders` preserving `id`, `scope`, `teamId`, `parent`, `child`, `createdAt` (and `updatedAt` if it exists). Reject empty `instruction` strings — the editor routes empty to `delete`.
- **Edge Cases:** The error text for an unknown scope should name all four valid scopes. Keep every write inside `mutateStandingOrders` so it joins the module-level serialisation chain (`standingOrders.ts:39`).

### `src/webview/terminals.js` (and `terminals.html`)
- **Context:** The only standing-orders surface is the Link-up modal (`#link-standing-list`, `terminals.html:2074`), which is a parent/child pairing dialog with no team-scope support.
- **Logic:** Add a panel in the team cockpit showing the team order (editable), head order (editable/creatable), and inherited orders (read-only). Save via `update` when a row exists and `add` when it does not. Delete removes immediately (no confirm gate). Show the resolved preview using `applyStandingOrdersClient` (`terminals.js:8822`). Offer a "resend to members" action.
- **Edge Cases:** Read through `loadEffectiveStandingOrders`, never the raw config key (handles migration from legacy pair rows). The preview uses the whole fleet, not `scopedFleet()`. "Resend to members" must respect the idle check — enqueue if busy, don't paste into a working agent. Empty instruction routes to `delete`, not `update` with empty string. Gate on `standingOrdersAvailable` — no DB, no orders, show disabled state.

## Dependencies
- **Team identity foundation** — resolving the cockpit's team to the `teamId` its orders are keyed on.
- **Team cockpit** — the surface this editor lives in.

## Approach

### 1. Close the API gaps
In `_handleStandingOrders` (`LocalApiServer.ts:2423`):
- Add `'team-head'` to the accepted scope list at `LocalApiServer.ts:2466`, and require `teamId` for it exactly as `team` already does (`LocalApiServer.ts:2486`). The error text should name all four valid scopes.
- Add an `action: 'update'` branch taking `{ id, instruction }`: validate the instruction with the existing `validateInstruction`, then mutate in place through `mutateStandingOrders` — preserving `id`, `scope`, `teamId`, `parent`, `child` and `createdAt`. Preserving `id` and the scope key is the whole point; a "replace" that changes either reopens the race described above.
- Keep every write inside `mutateStandingOrders` so it joins the module-level serialisation chain (`standingOrders.ts:39`). Do not read-modify-write around it.

### 2. Editor UI in the team cockpit
A panel in the team cockpit showing, for this team:
- **Team order** — the instruction every member receives. Editable multi-line, with the current text loaded.
- **Head order** — the instruction the head receives. Editable, and creatable when absent (a team spawned without a `headPrompt` has no `team-head` row at all).
- **Inherited orders, read-only** — any `global` order, and any `pair` order touching a member, shown so the operator can see the full set that will actually be appended without having to open the Link-up modal. Label the source of each.
- Save writes via `update` when a row exists and `add` when it does not. Delete removes immediately with no confirm gate, per CLAUDE.md.
- Show the resolved preview: the exact block that will be appended, assembled by the existing client mirror `applyStandingOrdersClient` (`terminals.js:8822`). Do not write a second renderer — the marker text is a pinned contract (`standing-orders-marker-contract.test.js`) and a divergent preview would lie about what agents receive.

### 3. Make the effect legible
Editing a standing order changes what is appended to **future** prompts only; agents already running do not re-read it. Say so in the panel, once, plainly. Offer a "resend to members" action that dispatches the updated block immediately to each live member — this is the difference between an operator believing the change took effect and it actually having done so.

### 4. Reuse the resolver, do not fork it
`selectOrders` (`standingOrders.ts:78`) resolves `team` scope through the registered groups array and deliberately excludes the head from the member order (which is why `parent` stores the head name on a team-scoped row, `teamWiring.ts:979`). The editor must present exactly what that function will select. Read through it rather than re-deriving membership from the cockpit's filter — a mismatch here means the preview and reality disagree, which is worse than no preview.

## Edge cases
- **Team spawned by an older build.** Its orders may still be per-member `pair` rows carrying `PRE_REWRITE_CALLBACK_INSTRUCTION` (`teamWiring.ts:64`), migrated lazily into a team-scoped order by `migrateTeamPairOrders` (`teamWiring.ts:1107`) via `loadEffectiveStandingOrders` (`teamWiring.ts:1343`). The editor must read through `loadEffectiveStandingOrders`, never the raw config key, or it will show pre-migration rows and let the operator "fix" something the migration is about to rewrite.
- **Re-spawn after an edit.** `wireSpawnedTeam` skips an existing `(scope, teamId)` row, so an edited order survives a re-spawn. This is the desired behaviour and the reason `update` must not change the key — assert it in tests.
- **Head renamed.** `rewriteStandingOrdersForRename` (`standingOrders.ts:60`) rewrites `parent`/`child` by name. A team-scoped row stores the head in `parent` for exclusion purposes, so the rename path already keeps it correct — verify, do not duplicate.
- **Instruction containing the marker text.** `STANDING_ORDERS_BLOCK_RE` (`standingOrders.ts:29`) is anchored on the trailing line specifically so a prompt that merely *quotes* the marker is not truncated. An operator can now type that text into the editor, so this guard is newly reachable — test it directly.
- **Empty instruction.** Treat as "delete this order", not as "save an empty order". An empty appended block is noise in every prompt.
- **`standingOrdersAvailable` false.** The panel already gates on this for the Link-up modal (`terminals.js:9138`) — no DB, no orders. Show the same disabled state rather than a broken editor.

## Verification Plan
1. `npm run compile` — clean.
2. `src/test/standing-orders-marker-contract.test.js` must still pass untouched — the marker and trailing line are byte-pinned.
3. API unit: `add` with `scope: 'team-head'` and a `teamId` succeeds; without `teamId` returns 400 naming the requirement; an unknown scope still 400s and the message lists all four scopes.
4. API unit: `update` preserves `id`, `scope`, `teamId`, `parent`, `child`, `createdAt` and changes only `instruction`; rejects an unknown `id`; rejects an instruction that fails `validateInstruction`.
5. **Race test:** `update` a team order, then run `wireSpawnedTeam` for the same team, then read the orders — the edited instruction must survive and there must be exactly one `(team, teamId)` row. Repeat with delete-then-add interleaved to demonstrate the failure mode the `update` action exists to prevent.
6. Unit: the editor's preview output is byte-identical to `applyStandingOrdersClient`'s block for the same inputs.
7. Unit: an instruction containing the literal `=== STANDING ORDERS ===` marker round-trips without truncating the stored prompt.
8. Manual, installed VSIX: edit a team order; send a fresh prompt to a member; confirm the new text appears in the appended block and the old text does not.
9. Manual: create a head order on a team that had none; confirm only the head receives it and members do not.
10. Manual: a team spawned on an older build — open the editor and confirm it shows the migrated team-scoped order, not legacy pair rows.
11. Manual: "resend to members" delivers the updated block to every live member.

## Completion Report
Implemented team standing orders API extensions and cockpit editor UI. In `src/services/LocalApiServer.ts`, added `team-head` scope support with required `teamId` validation, added `action: 'update'` branch validating instructions and preserving all metadata in-place, and expanded unknown scope error text to name all four valid scopes. In `src/webview/terminals.html` and `src/webview/terminals.js`, created the team standing orders editor modal with editable team and head orders, read-only inherited orders list, resolved prompt preview via `applyStandingOrdersClient`, immediate deletion, empty string delete routing, and idle-checked prompt resend to live members. Files changed: `src/services/LocalApiServer.ts`, `src/webview/terminals.html`, `src/webview/terminals.js`. No issues encountered.

## Review Findings

Reviewed add/update/delete serialization, metadata preservation, effective-order reads, preview composition, and resend behavior; no standing-orders-specific code fix was required. The standing-orders marker contract passed 56/56 and is invoked by `.github/workflows/integration-tests.yml`; compile, lint, and browser syntax checks passed. Update remains in-place through `mutateStandingOrders`, preserving the `(scope, teamId)` respawn key. Remaining risk is that busy-state detection is strongest for sends initiated by this webview and needs installed-VSIX exercise against externally busy terminals.
