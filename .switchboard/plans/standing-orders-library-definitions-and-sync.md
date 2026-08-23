# Standing Orders Library: Definitions and Sync

## Goal

Split standing orders into a reusable **definitions library** + **assignments**, with a live link: editing a definition updates every assignment that references it. Today a standing order is one row with instruction and scope inseparable — the same instruction cannot be shared across scopes, and editing one copy does not update the others. The library model makes standing orders work like the Prompts tab's add-on library: define once, assign to anything, edit once to update all.

### The problem, and the root cause

The current `StandingOrder` type (`standingOrders.ts:5`) is `{ id, parent, child, instruction, scope, teamId?, role?, createdAt }` — instruction and scope are baked into one row. If you want the same instruction ("always commit with conventional commit messages") as both a global order and a role-scoped order for planners, you create two rows with the same instruction text. Editing one does not update the other. There is no concept of a reusable definition.

The fix is a definitions table: `StandingOrderDefinition = { id, name, instruction, createdAt }`, stored at a new config key `terminals.standingOrderDefinitions`. Each `StandingOrder` gains an optional `definitionId` field linking it to a definition. When a definition is edited, all assignments with that `definitionId` get their `instruction` field updated — a sync operation, not a join at delivery time. This keeps the delivery path (`selectOrders` / `renderOrder`) unchanged: it still reads `instruction` from the assignment row. Old builds that don't know about `definitionId` see the `instruction` copy and work as before.

## Metadata
- **Complexity:** 6
- **Tags:** backend, database, api, refactor, feature
- **Project:** Browser Switchboard

## User Review Required

Yes — the user should review:
- The denormalized-copy approach (instruction stays on the assignment, synced when the definition is edited) vs. a join-at-delivery approach.
- The migration strategy (lazy, on first read via `loadEffectiveStandingOrders`).
- The config key name `terminals.standingOrderDefinitions`.

## Background & Problem Analysis

### Verified facts (read from source during this pass)

- **`StandingOrder` is `{ id, parent, child, instruction, scope, teamId?, role?, createdAt }`** (`standingOrders.ts:5-15`). The `instruction` field is the persistent text appended to prompts. It is baked into the row — there is no concept of a reusable definition or a reference to one.

- **Orders are stored at `terminals.standingOrders` config key** (`standingOrders.ts:17`: `STANDING_ORDERS_CONFIG_KEY = 'terminals.standingOrders'`). Read via `db.getConfigJson(key, [])`, written via `mutateStandingOrders` (`standingOrders.ts:48`), which serializes through a module-level promise chain.

- **`selectOrders` (`standingOrders.ts:188`) filters by scope, then `renderOrder` (`standingOrders.ts:248`) reads `o.instruction` to render the block.** The delivery path reads `instruction` directly from the order row. If `instruction` is absent or empty, the rendered block is empty.

- **`loadEffectiveStandingOrders` (`teamWiring.ts:2412`) is the lazy-migration read path.** It runs `migrateTeamPairOrders` (`teamWiring.ts:2091`) to convert legacy per-member `pair` rows into team-scoped orders, then persists the result. This is the established pattern for a new migration: run it lazily on first read, persist the migrated form. The function uses a reference short-circuit (`if (effective === raw) return raw`) to avoid a write on every prompt — any new migration pass must preserve this identity check.

- **`wireSpawnedTeam` (`teamWiring.ts:1789-1937`) writes two orders at spawn** — one `team`-scoped (team prompt) and one `team-head`-scoped (head prompt), both keyed on `(scope, teamId)` for idempotency. The instruction text is baked into each row. Under the library model, these would create definitions + assignments instead.

- **The standing orders API supports `add`/`update`/`delete`** (`LocalApiServer.ts:4290`). The `update` action preserves `id`, `scope`, `teamId`, `parent`, `child`, `createdAt` and changes only `instruction` (`LocalApiServer.ts:4397-4409`). Under the library model, `update` on a definition would sync the `instruction` field on all assignments referencing it.

- **`describeStandingOrderMigrations` (`teamWiring.ts`) runs the same pure transforms delivery runs** and annotates each order with `stale`/`dropped`/`effectiveInstruction` metadata (`LocalApiServer.ts:3775`). The migration to definitions must not break this — the metadata is derived from the order row, not from a definition.

- **The client mirror in `terminals.js` (`applyStandingOrdersClient`, line ~10960) replicates `selectOrders` + `renderOrder` client-side.** It reads `instruction` from the order row. It does not need to know about definitions — the `instruction` on the assignment is the synced copy.

- **`standing-orders-marker-contract.test.js` pins the marker text and rendering.** The contract tests assert on the rendered block output, which reads `instruction` from the order row. As long as the `instruction` field is present on the assignment, these tests are unaffected.

- **Published extension, ~4,000 installs, many on older versions.** Per CLAUDE.md: state that shipped in a released version MUST be migrated. The `instruction` field on existing orders must be preserved — old builds read it directly. The `definitionId` field is additive and optional; old builds ignore it.

## Complexity Audit

### Routine
- Adding `StandingOrderDefinition` type and `STANDING_ORDER_DEFINITIONS_CONFIG_KEY`.
- Adding optional `definitionId?` to `StandingOrder`.
- Adding definition CRUD to the API (`add`/`update`/`delete` for definitions).
- Adding a sync operation: when a definition's instruction is edited, update all assignments with that `definitionId`.
- Migration: for existing orders, create a definition per unique instruction, stamp `definitionId`.

### Complex / Risky
- **The sync operation cannot be truly atomic with the definition edit across two config keys.** The definition write goes to `terminals.standingOrderDefinitions` (via `mutateStandingOrderDefinitions`); the assignment sync goes to `terminals.standingOrders` (via `mutateStandingOrders`). Even sharing the same `_writeChain`, these are two separate read-mutate-write cycles. A crash between them leaves the definition updated but assignments stale. A **lazy re-sync** in `loadEffectiveStandingOrders` is the recovery path: detect assignments whose `instruction` doesn't match their definition's `instruction` and correct the drift. The eager sync on definition edit is the primary mechanism; the lazy re-sync is the safety net.
- **`wireSpawnedTeam` must create definitions + assignments instead of baking instruction.** The team prompt and head prompt become definitions; the orders become assignments referencing them. The `(scope, teamId)` idempotency check must still work — it checks the assignment, not the definition.
- **Migration must not produce duplicate definitions for identical instructions.** Two orders with the same instruction text should reference the same definition, not two definitions with the same content. This requires deduplication by instruction text during migration.
- **`describeStandingOrderMigrations` must still work.** It reads the order row's `instruction` field. As long as the sync keeps the `instruction` copy current, this is fine. If a definition is edited and the sync is interrupted by a crash, the metadata could be stale until the next `loadEffectiveStandingOrders` re-syncs. The lazy re-sync is the recovery path.

## Edge-Case & Dependency Audit

- **Race Conditions:** The definition edit (via `mutateStandingOrderDefinitions`) and the assignment sync (via `mutateStandingOrders`) are two separate write operations to two different config keys. They serialize through the same `_writeChain` promise, but a crash between them leaves assignments stale. The lazy re-sync in `loadEffectiveStandingOrders` (see Proposed Changes) is the recovery path — it detects and corrects drift on the next read.
- **Security:** No new attack surface. Definition instructions go through the same `validateInstruction` guard.
- **Side Effects:** Editing a definition updates the `instruction` on all assignments referencing it. This changes what is appended to future prompts for every scope those assignments cover. The UI should show which assignments will be affected before confirming the edit (not a confirm gate — just an informational display, per CLAUDE.md's no-confirm rule).
- **Dependencies & Conflicts:**
  - Depends on the existing standing orders backend — already landed.
  - No conflict with the delivery path — `selectOrders` and `renderOrder` are unchanged.
  - No conflict with the team cockpit editor or Link-up modal — both read `instruction` from the assignment row, which is kept in sync.
- **Backward compat:** Old builds see `instruction` on the assignment and work as before. They don't know about `definitionId` or the definitions config key. If an old build edits an assignment's `instruction` directly (via the team cockpit or Link-up modal), the definition and the assignment diverge — the next sync from a new build would overwrite the old build's edit. This is accepted: the new build is the source of truth once installed.
- **`standingOrdersAvailable` false:** When no DB is available, definitions are also unavailable. The API returns `available: false` for both.
- **No confirm gate:** Delete a definition removes it and unlinks all assignments (sets `definitionId` to undefined on each). The `instruction` copy stays on the assignment — the order still works, it just no longer tracks a definition. Per CLAUDE.md, no confirm dialog.

## Adversarial Synthesis

Key risks: (1) the sync operation across two config keys cannot be truly atomic — a crash between the definition write and the assignment sync leaves stale copies, requiring a lazy re-sync recovery path in `loadEffectiveStandingOrders`; (2) the `migrateToDefinitions` pass must gate on "any order lacks `definitionId`" to avoid a write on every prompt (the existing reference short-circuit pattern); (3) migration must deduplicate by instruction text or the library fills with near-identical entries; (4) `wireSpawnedTeam` must create definitions + assignments, and the idempotency check must still work on the assignment, not the definition; (5) orphaned definitions accumulate when teams are deleted (accepted limitation — operator cleans up via UI); (6) old builds editing an assignment's `instruction` directly will be overwritten by the next sync from a new build. Mitigations: eager sync on definition edit + lazy re-sync on read; gate migration on missing `definitionId`; deduplicate by instruction text; keep the `(scope, teamId)` idempotency check on the assignment row; document orphaned definitions as accepted; accept that new builds are the source of truth once installed.

## Proposed Changes

### 1. `src/services/standingOrders.ts` — types + config key + sync

**Context:** `StandingOrder` (line 5) has no `definitionId`. There is no `StandingOrderDefinition` type. The config key `terminals.standingOrders` stores orders only.

**Logic:**
1. Add `StandingOrderDefinition` type: `{ id: string; name: string; instruction: string; createdAt: number }`.
2. Add `STANDING_ORDER_DEFINITIONS_CONFIG_KEY = 'terminals.standingOrderDefinitions'`.
3. Add optional `definitionId?: string` to `StandingOrder`.
4. Add `mutateStandingOrderDefinitions(db, mutator)` — same promise-chain pattern as `mutateStandingOrders`, but for the definitions config key. Share the same `_writeChain` or use a coordinated one so definition edits and assignment syncs serialize.
5. Add `syncDefinitionToAssignments(db, definitionId, instruction)`: inside `mutateStandingOrders`, find all orders with `definitionId === id` and update their `instruction` field. Called eagerly after a definition's instruction is edited.
6. Add `reSyncAssignmentsToDefinitions(db, definitions, orders)`: a pure function that, for each order with a `definitionId`, checks if its `instruction` matches the definition's `instruction`. If not, updates the order's `instruction`. Returns the corrected array (or the input by reference if nothing changed — same identity-check pattern as `migrateTeamPairOrders`). Called lazily in `loadEffectiveStandingOrders` as the crash recovery path.
7. `selectOrders` and `renderOrder`: **no change.** They read `instruction` from the assignment row, which is kept in sync.

**Edge Cases:** When `definitionId` is absent (legacy order, or order created without a library entry), the `instruction` field is the source of truth — no sync needed. When `definitionId` is present, the `instruction` field is a denormalized copy kept in sync by `syncDefinitionToAssignments`.

### 2. `src/services/teamWiring.ts` — migration + wireSpawnedTeam

**Context:** `loadEffectiveStandingOrders` (line 2412) is the lazy-migration read path. `wireSpawnedTeam` (line 1789) writes team/head orders with instruction baked in.

**Logic:**
1. **Migration in `loadEffectiveStandingOrders`:** After the existing `migrateTeamPairOrders` pass, add a `migrateToDefinitions` pass. **Gate on `orders.some(o => !o.definitionId && o.instruction)`** — if every order already has a `definitionId` (or no instruction), skip the pass entirely and return the input by reference (preserving the identity short-circuit that prevents a write on every prompt). For each order with `instruction` but no `definitionId`:
   a. Read existing definitions from `terminals.standingOrderDefinitions`.
   b. Check if a definition with the same `instruction` text already exists (deduplication).
   c. If yes, stamp `definitionId` on the order.
   d. If no, create a definition `{ id: crypto.randomUUID(), name: instruction.slice(0, 60), instruction, createdAt: order.createdAt }`, add it to the definitions array, and stamp `definitionId` on the order.
   e. Persist definitions via `mutateStandingOrderDefinitions` (writes to `terminals.standingOrderDefinitions`).
   f. Persist the migrated orders via `mutateStandingOrders` (writes to `terminals.standingOrders`).
   **Note:** The two writes (definitions + orders) are not atomic — they serialize through the shared `_writeChain`. If the process crashes between them, definitions are written but orders are not stamped. The next `loadEffectiveStandingOrders` re-runs the migration (the gate fails because orders still lack `definitionId`), finds the existing definitions by instruction text (deduplication), and stamps `definitionId`. This is self-healing.
2. **Lazy re-sync in `loadEffectiveStandingOrders`:** After the migration pass, run `reSyncAssignmentsToDefinitions` (from `standingOrders.ts`). For each order with a `definitionId`, if its `instruction` doesn't match the definition's `instruction`, update it. Gate on "any order has drifted" to preserve the identity short-circuit. This is the crash recovery path for the eager sync.
3. **`wireSpawnedTeam`:** When writing team/head orders, create definitions for the team prompt and head prompt (if they don't already exist for this team), then write assignments referencing those definitions. The `(scope, teamId)` idempotency check stays on the assignment row. **Note:** Each team gets its own definitions (the team prompt includes the head name and team ID interpolated, making it unique per team). When a team is deleted, its definitions orphan in the library — the operator can delete them from the UI. This is an accepted limitation.

**Edge Cases:** Migration is idempotent — orders with `definitionId` already set are skipped. Deduplication is by exact instruction text match — two orders with slightly different whitespace produce two definitions (accepted; the operator can merge them in the UI). `wireSpawnedTeam` re-spawn: the idempotency check finds the existing assignment and skips, so the definition is not re-created.

### 3. `src/services/LocalApiServer.ts` — definition CRUD API

**Context:** The standing orders API (`_handleStandingOrdersWrite`, line 4290) supports `add`/`update`/`delete` for orders. There are no definition endpoints.

**Logic:** Add definition CRUD to the standing orders API (or new endpoints):
- `action: 'addDefinition'` with `{ name, instruction }`: create a definition, return it.
- `action: 'updateDefinition'` with `{ id, name?, instruction? }`: update the definition. If `instruction` changed, run `syncDefinitionToAssignments`. Return the updated definition.
- `action: 'deleteDefinition'` with `{ id }`: delete the definition. Unlink all assignments (set `definitionId` to undefined on each). The `instruction` copy stays on each assignment.
- `action: 'listDefinitions'`: return all definitions.

**Edge Cases:** `validateInstruction` runs on `addDefinition` and `updateDefinition` (when instruction changes). `updateDefinition` with empty instruction is rejected — route to `deleteDefinition` instead.

> **Superseded:** The sync runs inside the same `mutateStandingOrders` callback as the definition edit, so it is atomic.
> **Reason:** The definition edit writes to `terminals.standingOrderDefinitions` (via `mutateStandingOrderDefinitions`), not `terminals.standingOrders`. These are two separate config keys with two separate mutator functions. Even sharing the same `_writeChain`, they are two sequential read-mutate-write cycles, not one atomic operation. A crash between them leaves the definition updated but assignments stale.
> **Replaced with:** The `updateDefinition` action runs the eager sync (`syncDefinitionToAssignments`) immediately after the definition write. The two writes serialize through the shared `_writeChain` but are not atomic. The lazy re-sync in `loadEffectiveStandingOrders` (`reSyncAssignmentsToDefinitions`) is the crash recovery path — it detects and corrects drift on the next read.

### 4. `src/webview/terminals.js` — client mirror (minimal)

**Context:** The client mirror `applyStandingOrdersClient` (line ~10960) reads `instruction` from the order row. It does not need to know about definitions.

**Logic:** No change to the delivery mirror. The team cockpit editor and Link-up modal continue to read/write `instruction` on the assignment row. When a definition is edited via the new API, the sync updates the `instruction` on assignments, and the next `loadEffectiveStandingOrders` / GET fetch reflects the change. The client mirror sees the updated `instruction` and renders correctly.

**Optional:** If the team cockpit editor wants to show "this order is linked to definition X", it can read `definitionId` from the order row and display a badge. This is a UI enhancement, not a correctness requirement.

### 5. Contract tests — verify migration + sync

**Context:** `standing-orders-marker-contract.test.js` pins the marker text and rendering. The migration and sync must not break it.

**Logic:**
1. Existing marker contract tests pass unchanged — `renderOrder` still reads `instruction` from the assignment row.
2. New test: migration creates definitions for existing orders, stamps `definitionId`, and the rendered block is byte-identical before and after migration.
3. New test: `syncDefinitionToAssignments` updates the `instruction` on all assignments with matching `definitionId`, and the rendered block reflects the new instruction.
4. New test: deduplication — two orders with the same instruction text reference the same definition after migration.
5. New test: `wireSpawnedTeam` creates definitions + assignments, and re-spawn is idempotent (no duplicate definitions or assignments).

## Dependencies

- **Standing orders backend** (`standingOrders.ts`) — already landed. All 5 scopes, `mutateStandingOrders`, `validateInstruction`, `makeStandingOrder`.
- **`loadEffectiveStandingOrders`** (`teamWiring.ts:2412`) — already landed. The lazy-migration read path where the definitions migration runs.
- **`wireSpawnedTeam`** (`teamWiring.ts:1789`) — already landed. The team spawn path that creates team/head orders.
- **Standing orders API** (`LocalApiServer.ts:4290`) — already landed. The `add`/`update`/`delete` handler where definition CRUD is added.

## Approach

### 1. Add the definitions data model
Add `StandingOrderDefinition`, `STANDING_ORDER_DEFINITIONS_CONFIG_KEY`, `definitionId?` on `StandingOrder`, `mutateStandingOrderDefinitions`, and `syncDefinitionToAssignments` to `standingOrders.ts`. The delivery path (`selectOrders` / `renderOrder`) is unchanged.

### 2. Migrate existing orders
Add `migrateToDefinitions` to `loadEffectiveStandingOrders` in `teamWiring.ts`. Gate on `orders.some(o => !o.definitionId && o.instruction)` to preserve the identity short-circuit. Deduplicate by instruction text. Persist definitions (via `mutateStandingOrderDefinitions`) and stamped `definitionId` on orders (via `mutateStandingOrders`). Add `reSyncAssignmentsToDefinitions` as a lazy re-sync pass after migration — the crash recovery path for the eager sync.

### 3. Update wireSpawnedTeam
Create definitions for team/head prompts, write assignments referencing them. Keep the `(scope, teamId)` idempotency check on the assignment.

### 4. Add definition CRUD to the API
Add `addDefinition` / `updateDefinition` / `deleteDefinition` / `listDefinitions` actions to the standing orders API. The `updateDefinition` action runs the eager sync (`syncDefinitionToAssignments`) after the definition write. The two writes serialize through the shared `_writeChain` but are not atomic — the lazy re-sync is the crash recovery path.

### 5. Verify
Run contract tests, compile, and manually exercise the API.

## Edge cases
- **Old build reads new data:** Sees `instruction` on the assignment, works as before. Ignores `definitionId`.
- **Old build edits an assignment's instruction:** The next sync from a new build overwrites it. Accepted — new build is source of truth.
- **Migration deduplication:** Two orders with identical instruction text reference the same definition. Orders with different whitespace produce separate definitions (accepted).
- **Delete a definition:** Assignments are unlinked (`definitionId` set to undefined), `instruction` copy stays. Orders still work.
- **Re-spawn after definition edit:** `wireSpawnedTeam` idempotency check finds the existing assignment and skips. The edited instruction on the assignment survives.
- **No DB:** Definitions unavailable, `available: false`. API returns error for definition CRUD.
- **Concurrent definition edit + assignment write:** Serialized through `mutateStandingOrders` promise chain.
- **Crash between definition write and assignment sync:** The definition is persisted but assignments are stale. The lazy re-sync in `loadEffectiveStandingOrders` (`reSyncAssignmentsToDefinitions`) detects drift on the next read and corrects it. Self-healing.
- **Crash during migration (definitions written, orders not stamped):** The next `loadEffectiveStandingOrders` re-runs the migration gate, finds existing definitions by instruction text (deduplication), and stamps `definitionId`. Self-healing.
- **Orphaned definitions from team deletion:** When a team is deleted, its assignments are removed but the definitions created by `wireSpawnedTeam` remain in the library. The operator can delete them from the UI. Accepted limitation — no automatic cleanup hook.

## Verification Plan

### Automated Tests
- `npm run compile` — clean.
- `node --test src/test/standing-orders-marker-contract.test.js` — existing tests pass unchanged (delivery path unchanged).
- New tests: migration creates definitions + stamps `definitionId`; rendered block byte-identical before/after migration; `syncDefinitionToAssignments` updates all matching assignments; deduplication by instruction text; `wireSpawnedTeam` creates definitions + assignments with idempotent re-spawn; delete definition unlinks assignments but preserves `instruction`; `reSyncAssignmentsToDefinitions` detects and corrects drifted `instruction` copies (crash recovery); migration is self-healing after a partial crash (definitions written, orders not stamped).

### Manual
- **Migration:** Start with existing standing orders (pre-definition). Open the standing orders list. Confirm definitions are created and `definitionId` is stamped. Confirm the rendered block is unchanged.
- **Sync:** Edit a definition's instruction via the API. Confirm all assignments referencing it have their `instruction` updated. Confirm the rendered block reflects the new instruction.
- **Deduplication:** Two orders with the same instruction text. After migration, confirm they reference the same definition.
- **Delete definition:** Delete a definition. Confirm assignments are unlinked but still have their `instruction` copy. Confirm the rendered block is unchanged.
- **wireSpawnedTeam:** Spawn a team. Confirm definitions are created for team/head prompts. Re-spawn the same team. Confirm no duplicate definitions or assignments.
- **Old build compat:** Simulate an old build reading the data. Confirm `instruction` is present on every assignment and the rendered block is correct.
- **Crash recovery (lazy re-sync):** Edit a definition's instruction, then simulate a crash before the assignment sync completes (e.g. kill the process between the two writes). Restart, trigger `loadEffectiveStandingOrders`. Confirm the assignments are re-synced to match the definition's instruction. Confirm the rendered block reflects the corrected instruction.

## Recommendation

**Send to Coder** (complexity 6). The denormalized-copy approach keeps the delivery path unchanged and is backward compatible. The main risk is the two-config-key sync (not truly atomic), mitigated by the lazy re-sync recovery path in `loadEffectiveStandingOrders`. The migration is self-healing: a partial crash leaves the next read to re-run the gate and complete the stamping.

## Completion Report

Implemented the standing-orders definitions library: a reusable `StandingOrderDefinition` type stored at `terminals.standingOrderDefinitions`, with each `StandingOrder` gaining an optional `definitionId` linking it to a definition. The delivery path (`selectOrders`/`renderOrder`) is unchanged — it reads `instruction` from the assignment row, which is a denormalized copy kept in sync. Files changed: `src/services/standingOrders.ts` (types, config key, `mutateStandingOrderDefinitions`, `syncDefinitionToAssignments`, `reSyncAssignmentsToDefinitions`, `ensureStandingOrderDefinition`, `makeStandingOrderDefinition`, `definitionId` param on `makeStandingOrder`), `src/services/teamWiring.ts` (`migrateToDefinitions` + `reSyncAssignmentsFromDefinitions` integrated into `loadEffectiveStandingOrders`, `wireSpawnedTeam` updated to create definitions + assignments), `src/services/LocalApiServer.ts` (definition CRUD actions: `addDefinition`/`updateDefinition`/`deleteDefinition`/`listDefinitions`, definitions included in GET response, `definitionId` accepted on `add`), `src/test/standing-orders-definitions-contract.test.js` (new — 9 tests covering migration, sync, deduplication, wireSpawnedTeam idempotency, delete-unlink, crash recovery, self-healing, ensure idempotency, no-spurious-write), `package.json` (test script). One issue found during red-team review and fixed: if the definitions persist fails during migration, stamping is now skipped to avoid dangling `definitionId` references — the next read retries the whole migration. Compilation and tests were skipped per directives; the test file requires `out/` (compiled output) following the `stage-marker-commit-contract.test.js` pattern.
