# The mapping prune logs once per fleet refresh, forever — move the line to the edge and drop the read-path debug print

## Goal

Make the workspace-mapping read path quiet. A mapping whose `parentFolder` no longer exists on disk should be reported **once per distinct mapping id per process**, not once per `ptyListTerminals` call — and `KanbanDatabase.getWorkspaceMappings()` should stop printing an unconditional `console.error` diagnostic on every single read.

### Problem Analysis

Deleting a workspace folder off disk removes nothing from `workspace_mappings` — the JSON blob in kanban.db's `config` table (`KanbanDatabase.ts:1227` reader / `:1246` writer). That is deliberate: both prune implementations carry the comment *"the folder may be on a detached volume"* and neither deletes the DB row. The mapping is therefore immortal, and every read re-discovers it as stale.

Two log lines fire on that read path, and both sit on a poll:

1. **The prune line, inside the filter predicate.** It exists twice, once per host:
   - `WorkspaceIdentityService.ts:325-335` — `pruneNonExistentMappings`, the **standalone** path, called from `bootstrap.ts:1941` inside the `ptyListTerminals` verb handler.
   - `WorkspaceIdentityService.ts:299-309` — the identical `existing` filter inside `getScopedMappingsForBoard`, the **extension** path, reached from `TaskViewerProvider.ts:3852` (its `ptyListTerminals` equivalent) and from five other call sites (`workspaceUtils.ts:16`, `KanbanProvider.ts:1137` and `:1952`, `PlanningPanelProvider.ts:2266`, `TaskViewerProvider.ts:4859`).

   `ptyListTerminals` is not called once. `terminals.js:7686` polls it on a 5s `setInterval` **per visible panel**, the WebSocket push triggers a refetch on top of that, and `LocalApiServer.ts` (`:4009`, `:4462`, `:4554`, `:4663`) and `LinearAutomationService.ts:306` each call it on their own cadences. One line per stale mapping per call, with no dedupe and no memo.

2. **An unconditional read-path print.** `KanbanDatabase.ts:1230` logs `getWorkspaceMappings: dbPath=…, hasVal=…, dbReady=…` on **every** call, at `console.error` level. It is a leftover debug line: it fires even when there are zero stale mappings and zero mappings at all, and because of the level it reads as a failure in the output channel when nothing has failed.

A third, smaller instance of the same defect: `KanbanDatabase.writeDbPointer` (`:1200`) reports **success** via `console.error`.

### Root Cause

The prune log was written at the granularity of the thing it describes (a mapping) rather than the granularity of the event that matters (the mapping set *changing*). Placing it inside a `filter` predicate binds its frequency to the caller's call rate, and the caller turned out to be a 5-second poll with several independent drivers. The `getWorkspaceMappings` line and the `writeDbPointer` line are ordinary debug leftovers that were never levelled down.

### Non-goals

- **Not making the prune destructive.** The DB row still survives a missing folder — the detached-volume rationale stands and is not being revisited.
- **Not changing which mappings are pruned,** or the set the sidebar renders. Behaviour is identical; only log volume changes.
- **Not touching the dropdown-population defect.** `buildWorkspaceItems` (`workspaceUtils.ts`) emits a mapping's `workspaceFolders` children with no existence check, so a deleted workspace still appears in the board's workspace dropdown even though it is correctly hidden from the terminals sidebar. That is covered by **`workspace-dropdown-lists-every-child-with-the-parents-projects.md`**, which removes mapped children from the picker entirely — after which the missing existence check on that path has nothing left to filter. Do not fix it here, and do not fix it there either; land that plan and the question disappears.
- **Not touching `.switchboard/workspace-id`.** The machine-local db path on its second line is the same "local path outlives its machine" class, and is covered by **`committed-workspace-id-carries-a-foreign-db-path-nothing-reads.md`**.

## Metadata

**Complexity:** 2
**Tags:** logging, standalone-parity, cleanup

## User Review Required

None.

## Complexity Audit

### Routine
- Moving a log statement out of a predicate.
- Deleting a debug print.
- Levelling a success message from `error` to `log`.

### Complex / Risky
- **Two prune implementations, one per host.** The guard must land in both `pruneNonExistentMappings` and the `existing` filter inside `getScopedMappingsForBoard`, or the extension host keeps spamming while standalone goes quiet — the exact divergence CLAUDE.md forbids. Both live in the same file, so a shared helper is the natural fix; the risk is patching only the one named in the bug report.
- **Guard lifetime.** A process-lifetime `Set<string>` of already-reported mapping ids is the right scope: it survives across polls (the point) but resets on restart (so a genuinely re-broken mapping is reported again next session). Keying on the mapping **id** alone is wrong if the same id can point at a different `parentFolder` after an edit — key on `id + ':' + resolvedParent` so an edited mapping reports its new missing path once.
- **Do not suppress the recovery case.** If a detached volume comes back, the mapping stops being pruned and its guard entry should be cleared, so a later disappearance is reported again rather than silently swallowed for the rest of the session.
- **Guard lifecycle is process-lifetime, independent of `clearMappingCache`.** The guard Set must NOT be cleared by `clearMappingCache()` (which fires on workspace-folders changes and mapping-index rebuilds). A workspace-folders change does not mean a stale mapping stopped being stale — the folder is still gone. The only thing that clears a guard entry is the recovery re-arm (the mapping's parent folder existing again). State this explicitly so a coder does not wire the guard into the existing cache-clear path.

## Edge-Case & Dependency Audit

- `pruneNonExistentMappings` is exported and has exactly one production caller (`bootstrap.ts:1941`); the `getScopedMappingsForBoard` filter has six. A shared guard helper must be safe under all seven.
- The `catch` arm in both filters deliberately **keeps** the mapping on a transient FS error and logs nothing. Preserve that — do not route the catch through the new guard.
- `getWorkspaceMappings` is called from `SetupPanelProvider.ts` (`:1010`, `:1041`, `:1190`), `extension.ts:177`, and the two prune paths' upstream. Removing its log affects diagnosis of setup-panel saves; if a line is wanted there, put it at the **writer** (`setWorkspaceMappings`), which is rare, not the reader, which is hot.
- Contract tests that assert on log text: grep `src/test/` for `Pruning mapping` and `getWorkspaceMappings:` before editing. **Verified this pass:** no test asserts on either string — the `getWorkspaceMappings` hits in `workspace-identity-precedence.test.ts` and `browser-host-workspace-mappings.test.ts` are mock implementations returning mappings, not log-text assertions. Verification step 8 is therefore a confirm-not-regress check, not a fix-existing-tests check.
- No persisted state, no config keys, and no user-visible surface changes — so no migration is in scope (see CLAUDE.md's shipped-state rule; nothing shipped is being altered).

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) specifying the recovery re-arm in the audit but not in the implementation steps — the guard Set must be cleared when `fs.existsSync` returns true, or a recurring stale mapping is permanently suppressed; (2) wiring the guard into `clearMappingCache`'s lifecycle, which would clear it on unrelated workspace-folders changes; (3) making the shared-helper extraction optional, leaving the standalone-parity class of bug unresolved; (4) deleting the prune log outright, losing the only diagnostic for an invisible workspace. Mitigations: recovery re-arm is now an explicit step in Proposed Change #2; guard lifecycle is documented as process-lifetime independent of `clearMappingCache`; the shared helper is the primary change, not conditional; the log is kept and frequency-fixed.

## Proposed Changes

1. **Add a module-private reporting guard in `WorkspaceIdentityService.ts`** — a `Set<string>` keyed `` `${mapping.id}:${resolvedParent}` ``, plus a small `reportPrunedMapping(mapping, resolvedParent)` helper that logs only on first sight of a key, and a `clearPrunedMappingReport(key)` used when a mapping is found to exist again.
2. **Route both prune sites through it** — `getScopedMappingsForBoard`'s `existing` filter (`:300-313`) and `pruneNonExistentMappings` (`:324-338`). The predicate keeps returning `false`; only the `console.log` moves behind the helper. Leave both `catch` arms exactly as they are. **Recovery re-arm:** when `fs.existsSync(parent)` returns `true` and the key is in the guard Set, call `clearPrunedMappingReport(key)` so a mapping that comes back from a detached volume reports again on its next disappearance. This is the implementation step for Verification Plan #4 — without it, the recovery test fails.
3. **Delete the unconditional read-path print at `KanbanDatabase.ts:1230`.** If a diagnostic is still wanted for mapping reads, add it to `setWorkspaceMappings` instead.
4. **Level `writeDbPointer`'s success message (`KanbanDatabase.ts:1202`) from `console.error` to `console.log`.** This is a `static` method on a different call path from the `getWorkspaceMappings` print — it fires when a mapping is configured, not on every read. Its failure arm stays at `error`.
5. **Extract a private `_pruneAndReport(mappings)` helper** that both filter sites call. The two filters are byte-identical in their prune logic; the only difference is that `getScopedMappingsForBoard`'s filter runs after the scoping step. A shared helper is the structural fix for the standalone-parity class of bug (one host fixed, the other forgotten) — do not make it optional. Both call sites already return `WorkspaceDatabaseMapping[]`, so the helper's return type is unchanged and no caller signature changes. The guard Set and the `reportPrunedMapping` / `clearPrunedMappingReport` helpers live inside this shared function.

## Verification Plan

1. **Standalone, stale mapping present.** Start the standalone host in a workspace whose DB carries a mapping pointing at a non-existent `parentFolder`. Open the board and leave it for two minutes (≥24 fleet polls). Confirm **exactly one** `Pruning mapping '<id>'` line in stdout, not one per poll.
2. **Extension host, same condition.** Open the same workspace in VS Code with the mapped folder missing. Leave the terminals sidebar open for two minutes. Confirm exactly one prune line in the output channel — this is the parity check that the `getScopedMappingsForBoard` copy was fixed too.
3. **Two distinct stale mappings report separately.** With two dead mappings in the blob, confirm two lines total, one per mapping id — not one, and not two per poll.
4. **Recovery re-arms.** Recreate the missing folder, confirm the mapping reappears in the sidebar, delete it again, and confirm a **second** prune line is emitted for it in the same session.
5. **Behaviour unchanged.** With one live and one dead mapping, confirm the terminals sidebar renders exactly the live one, in both hosts — identical to before the change.
6. **The read-path print is gone.** Confirm no `getWorkspaceMappings: dbPath=` line appears in either host at any point, including startup and setup-panel saves.
7. **Clean workspace is silent.** Start standalone in a workspace with no mappings at all; confirm zero mapping-related lines on the fleet poll.
8. **`node --check` is not sufficient here** — run the contract test scripts (`npm run test:contract:*`) and confirm none assert on the removed or moved log strings.

### Goal Invariants

- **Negative:** `console.log` does not appear inside the `filter` predicate body of either `getScopedMappingsForBoard` or `pruneNonExistentMappings` in `WorkspaceIdentityService.ts`.
- **Positive:** Both prune sites call the shared reporting helper.
- **Negative:** `KanbanDatabase.ts` contains no `getWorkspaceMappings: dbPath=` log statement.
- **Negative:** `KanbanDatabase.writeDbPointer`'s success path does not call `console.error`.
- **Positive:** Both prune sites still return `false` for a mapping whose `parentFolder` is missing, and still return `true` from their `catch` arms.

## Outstanding Questions

None.
