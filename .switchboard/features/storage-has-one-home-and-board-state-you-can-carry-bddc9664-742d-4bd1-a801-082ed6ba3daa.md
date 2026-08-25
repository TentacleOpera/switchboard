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
- [ ] [Board state cannot survive machine loss without a third-party account — surface the state file as an explicit export/import](../plans/portable-board-state-export-import.md) — **CREATED**
- [ ] [Board state backup works and nobody knows it exists — document it, and stop telling only git that the state is unrecoverable](../plans/board-state-backup-discoverability.md) — **CREATED**
- [ ] [A Database panel in the shell rail that owns storage, and the retirement of the Setup tab that half-owns it today](../plans/database-panel-in-the-shell-rail.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Export/import and the backup documentation are independent of everything else and can ship first. The Database panel should follow **Storage Topology and the Shared/Runtime Schema Split**, because the topology decides what the panel renders.

