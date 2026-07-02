# Git-Native Remote Control Channel

**Complexity:** 8

**Coordination contract:** [Remote Control Production Readiness — Cross-Epic Sequencing & Coordination Plan](../plans/feature_plan_20260701_remote-control-production-sequencing.md) — **epic 6 of 7** in the program dispatch order.

## Goal

Manifest import is the working git-native remote-control path today: a repo-connected web agent writes plan files plus a manifest.json and the extension ingests them. The board-state mirror is its outbound counterpart. This epic makes the git channel production-grade in both directions: ingest stops silently swallowing entries and surfaces rejections, while the mirror gains explicit, configurable destinations with bidirectional state deltas instead of forced commits to main.

## How the Subtasks Achieve This

- **Fix Manifest Silent-Failure**: Hardens the inbound half of the git channel — bare filenames in `planFile` are accepted instead of silently rejected, rejection becomes a first-class state with a visible count/signal instead of a consumed-and-deleted manifest, and the workflow docs stop showing the misleading path examples that trigger the bug.
- **Board State Remote Mirror: Configurable Export Destinations + Git-Native Remote Control**: Builds the outbound half and closes the loop — a `boardStateExport` setting (`none` / control-plane / wiki / Notion / Linear) decouples board-state mirroring from the development repo's git history, and a `GitStateProvider` on the existing remote-control provider seam reads column changes back from the mirror, giving git-native destinations the same bidirectional control Notion/Linear already have.

## Dependencies & sequencing

- The two subtasks are independent and can land in either order; the manifest fix is small (cx 5) and unblocks reliable remote plan ingest immediately.
- The mirror plan's inbound state signal depends on the startup reconciler (`kanban-startup-reconciler.md`, Epic: Remote Planning Infrastructure) for offline catch-up, and its `**Column:**` line export is net-new.
- The mirror plan's git-tracking changes must stay consistent with the `.switchboard/` git-tracking audit (`gitignore-rules-audit.md`, unassigned): the audit keeps the mirror carve-outs that the `none` export mode removes per-workspace.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix Manifest Silent-Failure: Bare Filenames Rejected + Rejections Invisible](../plans/fix-manifest-silent-failure.md) — **CODE REVIEWED**
- [ ] [Board State Remote Mirror: Configurable Export Destinations + Git-Native Remote Control](../plans/board-state-remote-mirror-channels.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

**Epic-level review:** Both subtasks implemented and reviewed in-place. The manifest fix (cx 5) was verified correct against its plan — auto-resolve, rejected state, consume-not-retain, and 4 doc files all match. One MAJOR fix applied: mixed rejected+deferred manifests no longer cause infinite re-toast loops (toast gated on `consumed`). The mirror plan (cx 8) had three fixes applied: cumulative diff dedup in `GitStateProvider` (MAJOR — was causing spurious agent dispatches and duplicate comments), `.gitignore` catch-all excluding `.switchboard/` (CRITICAL — mirror files would be gitignored), and `.gitignore` overwrite destroying user content (MAJOR). Interface compliance (`capabilities`, `pushProjectContext`, `archiveCard`) was already present in the implementation. **Remaining epic-level risk:** the startup reconciler dependency is satisfied via `reconcileOnce()` in `RemoteControlService` + `TaskViewerProvider` startup call, but has not been end-to-end tested with an actual offline period.
