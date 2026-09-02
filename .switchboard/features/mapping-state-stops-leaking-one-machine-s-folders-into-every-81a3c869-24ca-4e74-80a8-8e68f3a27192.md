# Mapping state stops leaking one machine's folders into every other

**Complexity:** 4

## Goal

Workspace mappings persist a machine's folder layout into state that outlives that machine, and three surfaces now read it wrong. The board's workspace picker lists every mapped child alongside its parent and repeats the parent's whole project list under each, producing dozens of options that resolve to a handful of boards - and selecting one silently applies a repo filter on a dimension plans are not organised by. The committed workspace-id file carries an absolute database path from whichever machine last wrote it, distributed to every clone, with a churn guard that makes the stale path unrepairable. And the prune that hides a mapping whose folder no longer exists logs from inside a filter predicate on a five-second poll, so a deleted workspace re-announces itself forever. Fixing them together keeps one rule: mapping state records what is configured, never where one machine happened to put it.

## How the Subtasks Achieve This

- **The workspace dropdown lists every mapped child alongside its parent**: the largest of the three and the only one users see. Mapped children share the parent's database (`_getKanbanDb:2568-2573`), so listing them offers N copies of one board — measured live at 72 options resolving to 8 distinct boards. It removes children from the picker, keys `_getAllWorkspaceProjects` by effective root so one project list stops being written under nine keys, and retires the repo-scope filter that selecting a child silently applied.
- **The committed workspace-id file carries a machine-local database path**: the same leak in the file layer. `.switchboard/workspace-id` is tracked in git and its second line is an absolute db path from whichever machine last wrote it; the churn guard compares only line 0, so the stale path can never be repaired. It unifies the two writers on a one-line format and normalises existing files once.
- **The mapping prune logs once per fleet refresh, forever**: the diagnostic layer. A mapping whose folder is gone is deliberately never deleted from the DB, so every read rediscovers it — and the log sits inside a filter predicate driven by a 5s poll. It moves the line behind a once-per-`id:parentFolder` guard in both hosts and drops an unconditional read-path debug print.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The mapping prune logs once per fleet refresh, forever — move the line to the edge and drop the read-path debug print](../plans/prune-and-mapping-read-log-spam.md) — **PLAN REVIEWED** — ID: d8009809-5922-4fa5-91a6-7537953e396f
- [ ] [The committed workspace-id file carries a machine-local database path that no reader consumes and no writer can ever correct](../plans/committed-workspace-id-carries-a-foreign-db-path-nothing-reads.md) — **PLAN REVIEWED** — ID: 2e30c6d8-5fc1-47e8-b5d3-5b1f74490a22
- [ ] [The workspace dropdown lists every mapped child alongside its parent, and selecting one filters the board by a repo — a dimension plans are not organised on](../plans/workspace-dropdown-lists-every-child-with-the-parents-projects.md) — **PLAN REVIEWED** — ID: d9cadeea-f2b7-487e-a4b2-e7ff3a78d3ed
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; the three touch different files and can be executed in parallel.

Two notes for whoever codes them:

- The dropdown subtask makes part of the prune subtask moot. Once mapped children leave the picker, `buildWorkspaceItems`'s missing existence check on that path has nothing left to filter — the prune subtask's Non-goals already says not to fix it in either place.
- The prune subtask must land in **both** composition roots. Standalone reaches the prune through `pruneNonExistentMappings` (`bootstrap.ts:1941`); the extension reaches an identical copy inside `getScopedMappingsForBoard` (`TaskViewerProvider.ts:3852`, plus five other callers). Fixing one host leaves the other spamming.

### Regression provenance

The dropdown behaviour is new. Before `efe6e936` (2026-08-28, on `origin/main`), `buildWorkspaceItems`' mapped branch iterated mappings and pushed **only** `resolvedParent` — children were never emitted. That commit rewrote the function around a host-root visibility rule and added the `// Also emit member children of this mapping` block. The repo-scope filter it activates is much older (`isChildWorkspace`, 2026-05-28) and was unreachable from the picker until children appeared in it.

The other two predate that: the `workspace-id` second line arrived in `dd7d5b85` (2026-05-12, "v1.5.9: DB-first architecture"), the prune log in `1bd39f4a` (2026-08-14), and the `getWorkspaceMappings` debug print in `84f104e6` (2026-05-28).

## Team Dispatch Instructions

### The mapping prune logs once per fleet refresh, forever — move the line to the edge and drop the read-path debug print
- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - Exactly one `Pruning mapping '<id>'` line per stale mapping per process, in **both** hosts (standalone via `pruneNonExistentMappings` and extension via `getScopedMappingsForBoard`), not one per 5s poll.
  - No `getWorkspaceMappings: dbPath=` line appears in either host at any point (the `:1230` debug print is deleted).
  - `writeDbPointer`'s success path uses `console.log`, not `console.error`.
  - Both prune sites still return `false` for a missing `parentFolder` and `true` from their `catch` arms; recovery (folder recreated then re-deleted) re-arms and emits a second line in the same session.
- **Must not touch:** the dropdown-population defect in `buildWorkspaceItems` (owned by the dropdown subtask); `.switchboard/workspace-id` (owned by the workspace-id subtask); the DB row — the prune stays non-destructive.

### The committed workspace-id file carries a machine-local database path that no reader consumes and no writer can ever correct
- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - `.switchboard/workspace-id` carries only the UUID on one line; the second dbPath line is gone from both writers.
  - On a two-line file with a matching UUID, activation rewrites to one line (one `git diff` removed line); a second activation does **not** rewrite (no-churn gate).
  - The normalisation fires from all three identity-resolution priorities (DB-stored, file-read, dominant-id), not just the file-read path.
  - The resolved workspace id is byte-identical before and after (DB `workspace_id` config matches line 0); `db-pointer` still carries the machine-local db path and stays untracked.
  - Both hosts normalise — `ensureWorkspaceIdentity` runs in the extension and the standalone host.
- **Must not touch:** the reader (`lines[0]` slice is already correct); `.gitignore` (the file stays tracked — untracking breaks clone identity inheritance); `db-pointer`.

### The workspace dropdown lists every mapped child alongside its parent, and selecting one filters the board by a repo — a dimension plans are not organised on
- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - The board dropdown shows one option per board (mapping parents + unmapped roots), not per mapped child — 8 options, not 72, on the reporting control plane.
  - Mapped children appear nowhere in the dropdown; an unmapped single-folder workspace still appears.
  - `selectWorkspace` has no `isChildWorkspace`/`_repoScopeFilter` branch; `grep -rn "_repoScopeFilter|getRepoScopeFilter|setRepoScopeFilter" src/` returns no hits outside tests, and `kanban.html` has no `activeWorkspaceFilter`/`msg.activeFilter`.
  - `plans.repo_scope` column and `getBoardFilteredByProject`'s `repoScope` parameter remain (only the provider-level filter and its webview consumers are gone).
  - A stored child selection resolves to its parent on upgrade (no blank picker); the board re-pushes on every workspace/project/column switch (cache keys intact).
  - `control-plane-repo-scope.test.js` passes after its source-text assertions on the filter are removed; the DB-level `repo_scope` assertions stay green.
- **Must not touch:** the mapping config / setup panel; `_getKnownRoots` (the API's accepted-root set stays — child paths remain valid API arguments); the `repo_scope` column; `buildWorkspaceItems`'s contract for non-picker callers (TicketsPanelProvider, PlanningPanelProvider, TaskViewerProvider memo) — the picker-only derivation is separate.

