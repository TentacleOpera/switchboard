# Headless Host Correctness — Boot, Catalog & Verb Rail

**Complexity:** 4

## Goal

Four first-boot and probe failures found against a booted standalone server: the darwin node-pty spawn-helper chmod is skipped because webpack rewrites require.resolve, GET /catalog 404s for every workspace except the switchboard repo, the V20 kanban migration attempts and fails on every fresh DB, and the verb rail has three correctness gaps (unguarded getSetting payload, a response dispatched as a command, and a verb handled by nobody).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone verb rail: payload guards, and two verbs that are not verbs](../plans/standalone-verb-robustness-hardening.md) — **CREATED**
- [ ] [KanbanDatabase: V20 migration fails on every fresh DB and dumps two stack traces](../plans/kanban-db-v20-migration-fresh-db-failure.md) — **CREATED**
- [ ] [Standalone: `GET /catalog` 404s for every workspace except the switchboard repo](../plans/standalone-catalog-endpoint.md) — **CREATED**
- [ ] [Standalone PTY: the darwin spawn-helper chmod never runs under the bundler](../plans/standalone-pty-spawn-helper-chmod.md) — **CREATED**
<!-- END SUBTASKS -->
