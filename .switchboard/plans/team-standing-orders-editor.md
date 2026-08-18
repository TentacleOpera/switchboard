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
