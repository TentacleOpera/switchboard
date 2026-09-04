# Storage Has One Home, and Board State You Can Carry

**Complexity:** 6

## Goal

Give storage a single operator-facing surface, and make board state survivable without a third-party account. A Database panel in the shell rail states where board state actually lives, lets the operator choose an authoritative store, and retires the Setup tab that half-owns this today. Alongside it, the serialiser that already runs gets an explicit export and import, and the backup that already protects users becomes findable.

## How the Subtasks Achieve This

- **A Database panel in the shell rail that owns storage** — the surface that states where board state lives, owns store selection, and exposes integrity, backup and portability; retires the Setup tab that half-owns this today.
- **Surface the state file as an explicit export and import** — account-free portability; the serialiser already exists and already runs, it is simply written somewhere nobody looks.
- **Board state backup works and nobody knows it exists** — closes the discoverability gap without adding a nag, and stops telling only git that the state is unrecoverable.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Board state cannot survive machine loss without a third-party account — surface the state file as an explicit export/import](../plans/portable-board-state-export-import.md) — **PLAN REVIEWED** — ID: afe4fd67-0786-4aea-80cd-822dc6704dcb
- [ ] [Board state backup works and nobody knows it exists — document it, and stop telling only git that the state is unrecoverable](../plans/board-state-backup-discoverability.md) — **PLAN REVIEWED** — ID: 73eaecb7-c038-4f5f-aab9-1de2ec417e0b
- [ ] [A Database panel in the shell rail that owns storage, and the retirement of the Setup tab that half-owns it today](../plans/database-panel-in-the-shell-rail.md) — **CODER CODED** — ID: 3e1f6644-9398-424f-99b3-c8995d1adbb6
<!-- END SUBTASKS -->

## Dependencies & sequencing

Export/import and the backup documentation are independent of everything else and can ship first. The Database panel should follow **Storage Topology and the Shared/Runtime Schema Split**, because the topology decides what the panel renders.

## Reconciled End-State

The cross-subtask reconciliation audit (improve-feature pass) resolved one contradiction and confirmed the execution order:

- **Contradiction resolved:** Subtask 1 originally proposed surfacing export/import in the Setup panel. Subtask 3 retires the Setup panel's database section. Export/import now surfaces in the Database panel's "This machine" section (subtask 3), with command palette entries as the user-facing path until the panel lands. See the Superseded callout in subtask 1's Proposed Change #5.
- **Setup panel copy (subtask 2) is interim:** The corrected copy lands in Setup first, then moves to the Database panel when subtask 3 retires the Setup section.
- **Notion buttons move:** `backupToNotion` and `restoreFromNotion` move from Setup to the Database panel's "Projections" section (subtask 3). Command palette entries (subtask 2) are orthogonal and coexist.
- **`restoreFromBackup` is the single import path:** Subtask 1 extends the existing method (richer return type, workspace-id mismatch surfacing, separated skip counts) rather than creating a second import method.
- **Both hosts share the panel manifest:** `getPanelsManifest()` and `getPanelHtmlById()` in `headlessPanelHtml.ts` plus one route arm in `LocalApiServer.ts` serve both the extension and the standalone host. No divergence risk for the panel itself.
- **Stale analysis corrected:** `DATABASE_OPERATIONS_ANALYSIS.md` claimed the Setup panel's database handlers were missing. They exist and work at `TaskViewerProvider.ts:15814-15893`. The controls are in `setup.html`, not `implementation.html`. All file/line references in subtask 3 have been corrected.

