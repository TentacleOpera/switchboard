# Split Kanban Board Export into Per-Column Markdown Files

## Goal

The single `kanban-board.md` file has grown to 276 KB+, exceeding the Read tool's 256 KB limit and making it impossible for agents to read in one shot. This plan splits the export into one small file per column, and converts `kanban-board.md` into a lightweight index that links to each per-column file.

### Core Problem

`exportStateToFile()` writes all columns into a single file. At ~4,000 installs with active plans, this file will only grow. Agents that need to check a specific column (e.g. "what's in CREATED?") are forced to load the entire board anyway.

### Solution

- Generate `.switchboard/kanban-state-{slug}.md` per column alongside the existing `kanban-board.md`.
- `kanban-board.md` becomes an index: header + table of links to each per-column file.
- All per-column files are `!`-negated in `.gitignore` so they are tracked like `kanban-board.md`.

---

## Column Slug Mapping

| Column Name | File |
|---|---|
| CREATED | `kanban-state-created.md` |
| BACKLOG | `kanban-state-backlog.md` |
| CONTEXT GATHERER | `kanban-state-context-gatherer.md` |
| PLAN REVIEWED | `kanban-state-plan-reviewed.md` |
| LEAD CODED | `kanban-state-lead-coded.md` |
| CODER CODED | `kanban-state-coder-coded.md` |
| CODE REVIEWED | `kanban-state-code-reviewed.md` |
| CODED | `kanban-state-coded.md` |
| COMPLETED | `kanban-state-completed.md` |

---

## Implementation Steps

### 1. Add `_columnSlug()` helper in `KanbanDatabase.ts`

Add a private static method that maps a `VALID_KANBAN_COLUMNS` value to its file-safe slug:

```
CREATED            → "created"
BACKLOG            → "backlog"
CONTEXT GATHERER   → "context-gatherer"
PLAN REVIEWED      → "plan-reviewed"
LEAD CODED         → "lead-coded"
CODER CODED        → "coder-coded"
CODE REVIEWED      → "code-reviewed"
CODED              → "coded"
COMPLETED          → "completed"
```

Implementation: lowercase + replace spaces with hyphens (no special cases needed for the current column set).

### 2. Refactor `exportStateToFile()` (KanbanDatabase.ts ~line 5451)

Current flow:
- Build one big markdown string with all columns.
- Atomic-write to `_stateFilePath` (`kanban-board.md`).

New flow:
1. Loop over `VALID_KANBAN_COLUMNS` and build a per-column markdown string containing only that column's plans (same format as today: `## {COLUMN}` header + plan list).
2. Atomic-write each to `.switchboard/kanban-state-{slug}.md` using the existing `tmpPath → rename` pattern.
3. Build a new `kanban-board.md` content that is just an index:
   ```markdown
   # Kanban Board

   *Workspace: {workspaceId}* · *Updated: {ISO timestamp}*

   | Column | File |
   |---|---|
   | CREATED | [kanban-state-created.md](./kanban-state-created.md) |
   | BACKLOG | [kanban-state-backlog.md](./kanban-state-backlog.md) |
   | ... | ... |
   ```
4. Atomic-write the index to `_stateFilePath` as before.

All writes are fire-and-forget and chained via `_writeTail` — no change to the concurrency model.

### 3. Update `WorkspaceExcludeService.TARGETED_RULES` (WorkspaceExcludeService.ts ~line 9)

The `.gitignore` managed block is **not static** — it is regenerated from `TARGETED_RULES` every time a user runs setup. Editing `.gitignore` directly would be overwritten on the next setup run.

Add `'!.switchboard/kanban-state-*.md'` to `TARGETED_RULES` immediately after the existing `'!.switchboard/kanban-board.md'` entry:

```typescript
'!.switchboard/kanban-board.md',
'!.switchboard/kanban-state-*.md',
```

The glob covers all nine per-column files without listing them individually. `WorkspaceExcludeService.apply()` will write this into the managed block on next setup invocation; the existing `.gitignore` in the repo should also be updated manually to match so new contributors get it immediately (no setup run required).

### 4. Update regression test (`src/test/git-ignore-custom-default-regression.test.js`)

This test asserts the exact contents of `TARGETED_RULES`. Add the new glob entry to the expected array so the test continues to pass.

---

## What Was Missing from the Original Plan

Step 3 originally said "update `.gitignore` directly." That is wrong — the managed block is owned by `WorkspaceExcludeService.TARGETED_RULES` and regenerated on setup. A direct `.gitignore` edit would be overwritten. The fix is to update `TARGETED_RULES` (which drives both generation and the setup.html preview display), then also patch the committed `.gitignore` to match.

---

## What Stays the Same

- `kanban-board.md` path (`_stateFilePath`) and its git tracking — no renames, no migration.
- Atomic write pattern (`tmp → rename`) — reused verbatim for each new file.
- `_writeTail` promise chaining — all writes are appended to the same tail.
- All existing agent consumers that read `kanban-board.md` continue to work; they now get a fast index instead of a 276 KB wall.

---

## Out of Scope

- Updating agent consumers to read per-column files directly (can be a follow-on once files exist and agents are updated to prefer them).
- Pruning/archiving old per-column files if a column is ever renamed (extremely rare; file would simply stop updating).

---

## Metadata

**Complexity:** 4
**Tags:** backend, feature, performance
