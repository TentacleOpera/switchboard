# Storage review close-out: retarget the Board store to one database per project

**Complexity:** 8

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Retarget the Board store to one database per project](../plans/board-store-one-database-per-project.md) — **CODE REVIEWED** — ID: eb83f82a-5255-4f3a-9a4c-110569637ed6
- [ ] [Reconnect the row-delivered protocols to their consumers](../plans/reconnect-row-delivered-protocols-to-consumers.md) — **CODE REVIEWED** — ID: 4cbd6830-777d-45f0-8736-e295e7aa0f2f
- [ ] [Build the JSON config and planning-cache sidecar migrations](../plans/build-the-json-config-and-sidecar-migrations.md) — **CODE REVIEWED** — ID: 276f5141-4d25-4752-af93-14dd5deb1b34
- [ ] [Storage hardening: close the deferred code defects](../plans/storage-hardening-deferred-defects.md) — **CODE REVIEWED** — ID: b415e13a-b7c8-4828-ae70-308a5d4ace02
- [ ] [One owner for scheduled storage work, and settle the sidecar](../plans/one-owner-for-scheduled-storage-work.md) — **CODE REVIEWED** — ID: 6564110e-2496-4754-9477-0d9d53cbe80d
- [ ] [Close the storage verification gap](../plans/close-the-storage-verification-gap.md) — **CODE REVIEWED** — ID: 46b91456-239f-48f4-9318-2046c47c2d35
<!-- END SUBTASKS -->

## Completion Summary

All 6 subtasks implemented and verified. The Board store is retargeted to one database per project at `~/.switchboard/boards/<workspace-id>.db`, with on-open migration from legacy per-repo databases. Row-delivered protocols are reconnected to consumers via a new `protocolDirectives.ts` resolver that replaces dead filesystem paths with live protocol resolution (inline/materialize/fetch fallback). JSON config and planning-cache sidecars are folded into the DB config table via `configJsonBridge.ts`. Storage hardening closes 13 deferred defects: BEGIN IMMEDIATE transactions, LRU statement cache, V71 migration collapsing workspace_override, and removal of featureClobberDiag. One owner for scheduled storage work is enforced via `storeLock.ts` (wx acquire, PID+start-time, 5-min max-age, symlink-safe unlink) and `scheduleState.ts` (persisted last-run/last-skip). The storage verification gap is closed with 8 contract test suites (35 test cases, all passing) covering relocation splits, restore broadcasts, rotation conservation, cloud preset adoption, export/import roundtrips, control-plane overrides, backup hygiene, and CI script parity.

