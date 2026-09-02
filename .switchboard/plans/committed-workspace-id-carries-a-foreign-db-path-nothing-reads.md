# The committed workspace-id file carries a machine-local database path that no reader consumes and no writer can ever correct

## Goal

Make `.switchboard/workspace-id` contain only the thing it exists to carry — the workspace UUID — and normalise the installs already carrying a second line. Today that file is under version control with an absolute path from whichever machine last wrote it, and the guard that prevents write churn also guarantees the stale path can never be repaired.

### Problem Analysis

`.switchboard/workspace-id` is tracked in git (confirmed: `git ls-files --error-unmatch` succeeds; committed in `d8516149`). In this repo it currently reads:

```
038bffef-9842-4574-96a1-69a43a280b3c
/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db
```

Line 2 is an absolute filesystem path from a different machine, distributed to every clone.

**Two writers disagree about the file's format.**

> **Superseded:** Two writers disagree about the file's format — `:494` (the `wx` first-creation writer) and `:532` (`tryWriteCommittedWorkspaceIdIfDifferent`), so the file's shape depends on which writer got there first.
> **Reason:** Code verification confirms `tryWriteCommittedWorkspaceId` (`:494`) is **dead code** — exported, zero callers anywhere in the repo (`src/`, tests, webview). The only active writer is `tryWriteCommittedWorkspaceIdIfDifferent` (`:532`), which writes two lines. The "two writers disagree" framing implied both are live; they are not.
> **Replaced with:** There is one active writer — `tryWriteCommittedWorkspaceIdIfDifferent` (`:532`) — and it writes two lines (UUID + absolute dbPath). The `wx` writer at `:494` is dead code (exported, zero callers). The fix is to change `:532` to one line and normalise existing files; the dead `wx` writer should be deleted or left with a comment noting it is unused, but it does not need reconciling because it never fires.

- `WorkspaceIdentityService.ts:494` — `tryWriteCommittedWorkspaceId`, the **dead** first-creation writer:
  ```ts
  await fs.promises.writeFile(committedPath, `${workspaceId}\n`, { flag: 'wx' });
  ```
  One line. `wx` means create-only, so it never overwrites. **Exported but zero callers — dead code.**

- `WorkspaceIdentityService.ts:532` — `tryWriteCommittedWorkspaceIdIfDifferent`, the **only active** writer:
  ```ts
  const dbPath = KanbanDatabase.forWorkspace(resolvedRoot).dbPath;
  await fs.promises.writeFile(committedPath, `${workspaceId}\n${dbPath}\n`);
  ```
  Two lines, unconditional overwrite, and the second is a resolved absolute path.

So every workspace that has ever passed through the correction path holds two lines. The dead `wx` writer's one-line format was the intended shape; the active writer never matched it.

**No reader consumes the second line.** `ensureWorkspaceIdentity` at `:565-570` is the only consumer:
```ts
const lines = fileContent.split('\n');
const trimmed = (lines[0] ?? '').trim();
if (isValidWorkspaceId(trimmed)) { ... }
```
It reads `lines[0]`, validates it as a UUID, and discards the rest. Nothing anywhere else opens the file for its contents — the only other mentions are `extension.ts:287` (which deliberately excludes it as a "deliberate setup" marker) and `TaskViewerProvider.ts:4750`, where it appears in a `safeFiles` allowlist by name, not by content.

### Root Cause

**The churn guard compares only the line it is about to overwrite the file with.** `tryWriteCommittedWorkspaceIdIfDifferent` reads its comparison value from line 0 alone (`:523`):

```ts
currentValue = (await fs.promises.readFile(committedPath, 'utf8')).split('\n')[0]?.trim() ?? '';
...
if (currentValue !== workspaceId) { /* write both lines */ }
```

It is called on the happy path — `:560` and `:573`, every time identity resolves — so on any machine where the UUID already matches, it returns without writing. That is correct for avoiding fs churn and is exactly why the foreign path is permanent: the only code that could rewrite the file declines to, precisely because the part it checks is already right.

The deeper error is that a **machine-local absolute path was written into a file whose whole purpose is to be shared**. The UUID is committed deliberately — it is what gives a workspace a stable identity across clones. `dbPath` is the opposite kind of fact: it is true only on the machine that computed it. Putting the two in one file means the sharable fact drags a non-sharable one along with it, and the reader's indifference to line 2 is the only reason nothing has broken.

### Non-goals

- **Do not untrack the file or add it to `.gitignore`.** Committing the UUID is the intended design — it is how a clone inherits its workspace identity. Only the second line is wrong.
- **Do not change the reader.** Reading `lines[0]` is already the correct, tolerant behaviour and is what makes the normalisation below safe.
- No change to `db-pointer`, which is the correct home for a machine-local database path and is untracked.

## Metadata

**Topic:** workspace-id carries only the workspace UUID
**Complexity:** 2
**Tags:** identity, config, migration, bug

## User Review Required

None. Nothing reads the second line; removing it is behaviour-preserving by inspection.

## Complexity Audit

### Routine
- Dropping `${dbPath}\n` from the `:532` write so both writers emit the same one-line format.

### Complex / Risky
- **This file shipped, so the normalisation is a migration against ~4,000 installs.** Per `CLAUDE.md`, shipped state is migrated, not silently rewritten. The mitigating fact is unusually strong here: the reader takes `lines[0]` and validates it as a UUID, so truncating to line 0 cannot change any behaviour. That must be *verified*, not assumed — the verification below greps for any other consumer before the rewrite lands.
- **The normalisation writes into a tracked file.** Every install that has a two-line file will see a one-line diff in `git status` after upgrading. That is the intended outcome and is a one-time, one-line change, but it must not fire on every activation — normalise only when line 2 is actually present, so a clean file is never touched and no repo gets a spurious dirty working tree on every launch.
- **Two machines with different UUIDs would ping-pong the committed file.** That is pre-existing (the `:530` guard writes whenever the UUID differs) and out of scope, but the normalisation must not make it worse by rewriting on equality.

## Edge-Case & Dependency Audit

**Race conditions:** `tryWriteCommittedWorkspaceIdIfDifferent` is called from two points in `ensureWorkspaceIdentity` (`:560`, `:573`) and both can run during activation. A non-atomic read-modify-write on the same file from two roots is possible; the write is a single small `writeFile`, so the worst case is one redundant identical write. Keep it that way — do not introduce a read-then-append.

**Security:** The removed line leaks a local username and directory layout into a committed file (`/Users/patrickvuleta/...`). Removing it is a small privacy improvement for any public fork; it is not the primary motivation and should not be described as a vulnerability.

**Side effects:** A one-line diff appears in the working tree of any repo whose `workspace-id` had two lines. Expected and desirable.

**Dependencies & conflicts:** None.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) assuming nothing reads line 2 rather than proving it — mitigation: the verification greps every consumer of the file before and after, and the reader's `lines[0]` slice is quoted as the reason truncation is safe; (2) normalising unconditionally on every activation, dirtying a tracked file on every launch — mitigation: rewrite only when a second line is present; (3) "fixing" this by gitignoring the file, which would break identity inheritance for clones — explicitly forbidden above; (4) treating the write guard at `:530` as the bug and loosening it, which would reintroduce fs churn on every activation — the guard is correct; the payload it writes is not; (5) framing the `wx` writer at `:494` as a live writer that needs reconciling — it is dead code (exported, zero callers), and the only active writer is `tryWriteCommittedWorkspaceIdIfDifferent` at `:532`; the fix targets the active writer, not both.

## Proposed Changes

**1. One format, from the only active writer (`WorkspaceIdentityService.ts:532`).**

```ts
await fs.promises.writeFile(committedPath, `${workspaceId}\n`);
```

Delete the now-unused `KanbanDatabase.forWorkspace(resolvedRoot).dbPath` lookup above it — it exists only to build the discarded line. The `wx` writer at `:494` (`tryWriteCommittedWorkspaceId`) is dead code (exported, zero callers) and already writes one line; delete it or leave it with a comment noting it is unused — it does not need reconciling.

**2. Normalise existing files, once, only when needed.**

> **Superseded:** In `ensureWorkspaceIdentity`, after line 0 validates, if the file has any content beyond the first line, rewrite it to `${trimmed}\n`.
> **Reason:** That placement only covers Priority 2 (file-read path). The repo's own case — a two-line file whose line-0 UUID already matches the DB — hits Priority 1 (`db.getWorkspaceId()` returns the stored id, `:557-562`), which calls `tryWriteCommittedWorkspaceIdIfDifferent` and returns *without ever reaching the Priority 2 file read*. Inside that function the `currentValue !== workspaceId` gate (`:530`) is false, so no write happens and the second line survives forever. Priority 3 (dominant id) has the same shape. Verification step 2 ("on this repo, two-line file, matching UUID, activate → one line") would **fail** with the original placement, because Priority 1 wins and never normalises.
> **Replaced with:** Put the normalisation inside `tryWriteCommittedWorkspaceIdIfDifferent` (`:506-539`), which all three priorities call. After reading the raw file content for the `currentValue` comparison, check whether the raw content has any non-empty line beyond line 0; if it does, rewrite the file to `${workspaceId}\n` (one line) **regardless of whether the UUID matches** — this is the migration. The existing `currentValue !== workspaceId` branch then handles the UUID-mismatch case (also writing one line, per change #1). A one-line file with a matching UUID hits neither branch → no write → no churn. This makes the normalisation fire on every activation path, not just Priority 2, and preserves the no-churn gate for already-clean files.

**3. Comment why the file is one line.**

A short note at both writers: this file is committed and shared across clones, so it carries only machine-independent facts. The machine-local database path belongs in `db-pointer`, which is untracked. Without this, the next person to want the db path handy will put it back.

## Verification Plan

1. `grep -rn "workspace-id" src/` and confirm `ensureWorkspaceIdentity:565-570` is the only content reader, and that it slices `lines[0]`. This is the gate that makes the truncation safe — run it before the change, and again after.
2. On this repo (two-line file, matching UUID), activate. The file becomes one line, the UUID is unchanged, and `git diff` shows exactly one removed line.
3. Activate again. The file is **not** rewritten — `git status` is clean and no write is logged. This is the no-churn gate.
4. Delete `.switchboard/workspace-id` and activate. It is recreated with one line by `tryWriteCommittedWorkspaceIdIfDifferent` (the only active writer). If the dead `wx` writer is deleted, this still holds — `tryWriteCommittedWorkspaceIdIfDifferent`'s `currentValue` read fails on a missing file, `currentValue` defaults to `''`, and the `!== workspaceId` branch writes one line.
5. Point a workspace at a different UUID so the `:530` branch fires. The file is rewritten with one line, not two.
6. Confirm the resolved workspace id is byte-identical before and after the change — `select value from config where key='workspace_id'` matches line 0 in every case above.
7. Confirm `db-pointer` still carries the machine-local database path and is still untracked (`git check-ignore -v .switchboard/db-pointer`).
8. **Migration gate:** on a copy of a workspace whose file has two lines and whose UUID does *not* match the DB, activate and confirm identity still resolves from line 0 exactly as before — the normalisation must not change which id wins.
9. Both hosts: run 2, 3 and 4 against the VS Code extension and the standalone host. `ensureWorkspaceIdentity` is called from both composition roots.

### Goal Invariants

- **Negative:** `tryWriteCommittedWorkspaceIdIfDifferent` in `WorkspaceIdentityService.ts` does not write a payload containing a second line with a dbPath.
- **Positive:** Both writers (`tryWriteCommittedWorkspaceId` at `:494` and `tryWriteCommittedWorkspaceIdIfDifferent` at `:532`) emit exactly `${workspaceId}\n` — one line.
- **Negative:** No `KanbanDatabase.forWorkspace(...).dbPath` lookup remains inside `tryWriteCommittedWorkspaceIdIfDifferent`.
- **Positive:** `ensureWorkspaceIdentity`'s reader (`:567-570`) still validates `lines[0]` as a UUID via `isValidWorkspaceId` and ignores any trailing content.
- **Negative:** A `workspace-id` file that is already one line is never rewritten by the normalisation branch (no-churn gate — the second-line check is the only trigger).
- **Positive:** The normalisation fires from all three identity-resolution priorities (DB-stored, file-read, dominant-id), because all three route through `tryWriteCommittedWorkspaceIdIfDifferent`.
