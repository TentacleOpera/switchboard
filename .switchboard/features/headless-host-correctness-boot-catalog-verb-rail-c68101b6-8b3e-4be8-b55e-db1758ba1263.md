# Headless Host Correctness — Boot, Catalog & Verb Rail

**Complexity:** 4

## Goal

Four first-boot and probe failures found against a booted standalone server: the darwin node-pty spawn-helper chmod is skipped because webpack rewrites require.resolve, GET /catalog 404s for every workspace except the switchboard repo, the V20 kanban migration attempts and fails on every fresh DB, and the verb rail has three correctness gaps (unguarded getSetting payload, a response dispatched as a command, and a verb handled by nobody).

## How the Subtasks Achieve This

- **Standalone verb rail: payload guards, and two verbs that are not verbs** (`standalone-verb-robustness-hardening.md`): removes the two dead outbound message types the browser transport turns into failing HTTP requests — `exportAgentAsSkillResult` posted as a command from `kanban.html:4790`, and `fetchFeatureDocuments` posted from `project.js:1071` with no handler in either host. (The third original item — the unguarded standalone `getSetting`/`saveSetting` arms — was found already fixed in `src/` during the 2026-08-04 improve pass: the arms were deleted in commit `30d82f8` and the verbs are now schema-gated and guarded via the generic dispatch path; the plan file records this in a Superseded callout.)
- **KanbanDatabase: V20 migration fails on every fresh DB and dumps two stack traces** (`kanban-db-v20-migration-fresh-db-failure.md`): stamps the current baseline migration version inside `createIfMissing()` — the sole DB-creation path — so the version-gated historical chain (V20–V57, including the doomed `INSERT INTO plans_v20 SELECT *`) is skipped on databases born at the current schema, and downgrades benign `already exists` skips to stack-free log lines. First boot stops training users to ignore migration errors.
- **Standalone: `GET /catalog` 404s for every workspace except the switchboard repo** (`standalone-catalog-endpoint.md`): supplies a `catalogProvider` in the standalone bootstrap that resolves `protocol-catalog.json` from the CLI install root (confirmed shipped in the npm package) before the workspace fallback, restoring the agent-discovery endpoint the orchestration skill depends on, and rewords the misleading 404 message.
- **Standalone PTY: the darwin spawn-helper chmod never runs under the bundler** (`standalone-pty-spawn-helper-chmod.md`): replaces the webpack-rewritten `require.resolve` with a guarded `__non_webpack_require__` resolver so the `spawn-helper` chmod actually executes, closing a latent every-terminal-spawn-fails failure on any install path that drops the `+x` bit.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. Each subtask is a self-contained bugfix against the standalone host; nothing from other features must land first. (Adjacent plans named in subtask files — `standalone-persist-ui-settings`, `standalone-board-verb-rail-fallthrough` — interact only cosmetically and are not blockers.)
- **Shipping order within this feature:** subtasks are independent and can land in any order — they touch disjoint files (`kanban.html`/`project.js`, `KanbanDatabase.ts`, `bootstrap.ts`/`LocalApiServer.ts`, `ptyBackend.ts`). If a tie-break is wanted, land the PTY chmod and catalog fixes first (user-facing failures), then the V20 migration (log noise, but the riskiest file — review it alone), then the verb-rail deletions (trivial).
- **Prerequisites / guards:** the V20 subtask's schema-equivalence diff (stamped-fresh vs migrated-fresh DB) must pass before that subtask is called done — it is the guard against converting log noise into skipped-migration corruption. The catalog and PTY fixes must be verified against a packed/built CLI, not an unbundled run (bundler-versus-filesystem behaviour is the bug class in both).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone verb rail: payload guards, and two verbs that are not verbs](../plans/standalone-verb-robustness-hardening.md) — **PLAN REVIEWED**
- [ ] [KanbanDatabase: V20 migration fails on every fresh DB and dumps two stack traces](../plans/kanban-db-v20-migration-fresh-db-failure.md) — **PLAN REVIEWED**
- [ ] [Standalone: `GET /catalog` 404s for every workspace except the switchboard repo](../plans/standalone-catalog-endpoint.md) — **PLAN REVIEWED**
- [ ] [Standalone PTY: the darwin spawn-helper chmod never runs under the bundler](../plans/standalone-pty-spawn-helper-chmod.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

