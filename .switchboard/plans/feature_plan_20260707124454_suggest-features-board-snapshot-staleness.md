# Fix: kanban-board.md snapshot gets stale — refresh more reliably

**Plan ID:** 284e5aee-746e-4889-983f-cab07da5cf10

## Goal

The `kanban-board.md` board snapshot that the Suggest Features prompt points the agent at (`cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md`) gets outdated — it falls behind the live kanban DB state and does not refresh often enough. Restore the local file mirror that was wrongly retired to a no-op, and fix the staleness bug in its refresh mechanism so the file stays current with the DB.

### Problem / background / root cause

**The local file mirror was wrongly retired.** Commit `ca80a8a` (Jul 6) replaced `KanbanDatabase.exportStateToFile()` with a no-op (`KanbanDatabase.ts:6870-6872`):

```ts
private async exportStateToFile(): Promise<void> {
    return;
}
```

The commit comment claims "the bidirectional board-state mirror was the file-based git control plane, which is gone" and that "Board read-visibility is now the one-directional snapshot publisher (`BoardSnapshotPublisher`, orphan branch `switchboard/board`)." This is **wrong**: the `BoardSnapshotPublisher` (orphan branch) is an **opt-in option for remote agents** (`switchboard.boardStateExport === 'read-only-snapshot'`, gated at `KanbanDatabase.ts:6855-6862` and `6937-6939`). It does NOT replace the local `kanban-board.md` file mirror that local agents read. The Suggest Features prompt (`group-into-features/SKILL.md:19-20`) tells the agent to `cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md` — a local file, not an orphan branch. With the no-op, the next VSIX build from current `src/` will stop writing the file entirely.

The installed 1.7.5 VSIX still has the real `exportStateToFile` (built before the no-op was compiled into `dist/`), so the file IS being written today — but it's stale. Observed state: DB has 15 plans in CREATED, the file has 9; the file's `*Updated:*` timestamp is ~4 hours behind the latest DB `updated_at`.

**The old implementation has a staleness bug.** The pre-retirement `exportStateToFile` (visible at `ca80a8a~1:src/services/KanbanDatabase.ts:6474-6590`) is called from `_persist` as fire-and-forget:

```ts
void this.exportStateToFile(); // fire-and-forget, no debounce
```

Inside the method, a single-flight + boolean-pending debounce collapses rapid mutations:

```ts
if (this._exportStateInFlight) { this._exportStatePending = true; return; }
this._exportStateInFlight = true;
try { /* ...async getBoard + writeFile per column... */ }
finally {
    this._exportStateInFlight = false;
    if (this._exportStatePending) {
        this._exportStatePending = false;
        void this.exportStateToFile(); // trailing re-run
    }
}
```

Two failure modes produce staleness:

1. **Stuck in-flight flag.** If the async export throws in a way that bypasses the `finally` (e.g. an unhandled rejection in the `void this.exportStateToFile()` re-run chain, or the process restarts mid-export), `_exportStateInFlight` stays `true` and every subsequent `_persist` call just sets `_exportStatePending = true` without ever executing the export body. The file freezes.

2. **Floating promise dropped on restart.** `void this.exportStateToFile()` is a floating promise — not chained to `_writeTail` or any await chain. If the extension host restarts (reload, crash, VSIX reinstall) between `_persist` completing and the async export finishing, the write is lost. The next `_persist` after restart should re-trigger it, but if no DB write happens after restart (e.g. the user only reads the board), the file stays stale indefinitely.

3. **Heavy board amplifies both.** With ~1,500 plans across 12 columns, each export reads the full board (`getBoard`) and writes 12+ per-column files + `kanban-board.md` (each with `mkdir` + `writeFile` + `rename`). A single export takes significant time, widening the window for both failure modes.

**Root cause summary:** the local mirror was wrongly retired (it's the default for local agents, not replaced by the remote orphan-branch publisher), and the old implementation's fire-and-forget + single-flight debounce can drop trailing writes, leaving the file stale.

## Metadata

**Tags:** backend, bugfix, board-snapshot, kanban, suggest-features
**Complexity:** 5

## User Review Required

Yes. Before implementation, the user should review:
- The proposed un-retirement of `exportStateToFile` — the plan restores a feature that was deliberately killed in commit `ca80a8a`. The user should confirm this is desired (the Suggest Features prompt depends on the file, but the retirement may have been intentional for other reasons).
- The 500ms debounce window — the user should confirm this staleness is acceptable for non-click-time reads of `kanban-board.md`.
- The click-time flush in `suggestFeatures` — recommended MANDATORY (the suggest-features action is user-initiated and infrequent), but the user should confirm the latency is acceptable.
- The dependency on `ca80a8a~1` for the old implementation source — if the commit is unreachable (rebased/squashed), the coder needs the full serialization code inlined in the plan or written as a complete spec.

## Complexity Audit

### Routine
- Restoring `exportStateToFile` from `ca80a8a~1` — the real implementation already exists in git history; it's a copy-back, not new code.
- Keeping the `BoardSnapshotPublisher` orphan-branch call in `_persist` (`KanbanDatabase.ts:6937-6939`) unchanged — it's a separate, opt-in path for remote agents.
- Updating the stale `kanban-auto-export.test.ts` assertions if the implementation shape changes.

### Complex / Risky
- **Fixing the staleness without reintroducing churn.** The old single-flight + boolean-pending debounce was added to prevent "refresh-driven export churn and the shared-.tmp rename race" (comment at `ca80a8a~1:6477-6479`). The fix must preserve churn prevention while guaranteeing the trailing write always happens. Approach: replace the boolean-pending flag with a `scheduleExport()` debounce that (a) coalesces rapid mutations into one write, (b) always fires a trailing write after the debounce window, and (c) chains the export promise to `_writeTail` so it survives process lifecycle within a session. Do NOT await the export in `_persist` (that would serialize every board mutation behind 12 file writes — unacceptable latency for 1,500 plans).
- **Content-hash skip.** Reuse `BoardSnapshotPublisher`'s SHA256 content-hash pattern (`BoardSnapshotPublisher.ts:119-156`): skip the write if the serialized board hasn't changed. This prevents redundant I/O when `_persist` fires for non-board changes (e.g. `imported_docs`, `config`, `activity_log` writes that also call `_persist`).
- **Per-column file format.** The old implementation writes `**Column:** <col>` lines inside each `kanban-state-*.md` file (for the GitStateProvider inbound signal). Preserve this format — do NOT flatten to a single table (the suggest-features skill and GitStateProvider depend on the per-column files).
- **Published extension (~4,000 installs).** The 1.7.5 VSIX still has the real writer, so users on 1.7.5 are unaffected until they upgrade. The fix restores the writer in `src/` so the next VSIX build continues to write the file. No migration needed — the file is overwritten on the next `_persist` after upgrade.

## Edge-Case & Dependency Audit

- **`boardStateExport` setting.** The local mirror must be **independent** of the `switchboard.boardStateExport` opt-in. That setting gates the orphan-branch publisher only (`_isBoardSnapshotEnabled`, `KanbanDatabase.ts:6855-6862`). The local mirror is always-on for local agents.
- **Non-git workspaces.** The local mirror writes to `.switchboard/` via plain `fs.writeFile` — no git dependency. Works in non-git workspaces. (The orphan-branch publisher skips non-git workspaces at `BoardSnapshotPublisher.ts:82-84` — that's its concern, not the local mirror's.)
- **`_resolveExportRoot()`.** The old implementation resolves the export root (control-plane root vs workspace root) via `_resolveExportRoot()`. Preserve this — it's how control-plane users get the mirror in their control-plane repo. If `_resolveExportRoot` was also retired, restore it from `ca80a8a~1`.
- **Rapid mutations.** The debounce + content-hash skip handles this: rapid `_persist` calls coalesce into one export after the debounce window, and the content hash prevents redundant writes if the board state hasn't changed.
- **Suggest Features click-time freshness.** The debounce window (e.g. 500ms) means the file can be up to 500ms stale at click time. Optional hardening: in `KanbanProvider`'s `suggestFeatures` handler (`KanbanProvider.ts:9440-9460`), flush the export before copying the prompt. This guarantees freshness at click time.
- **Dependencies** — none. No other plan edits `exportStateToFile` or `_persist`'s call to it. The Issue 5 plan edits `group-into-features/SKILL.md` section 1a wording (different section than the `cat` target in the SCAN step) — no conflict.

## Dependencies

None — standalone bugfix. No other plan edits `exportStateToFile` or `_persist`'s call to it. The project-scope-wording plan (same feature) edits `group-into-features/SKILL.md` section 1a (different section than the `cat` target in the SCAN step) — no conflict. Coordinate so both edits land on the same SKILL.md file.

## Adversarial Synthesis

Key risks: (1) the Proposed Changes skeleton omits the serialization logic (`// ... same as ca80a8a~1:6494-6582 ...`) — the coder cannot execute without the full old source, and the commit `ca80a8a` may be unreachable after a rebase; inline the complete serialization code or write a full spec. (2) `_resolveExportRoot()` is confirmed ABSENT from the current source (grep: zero matches) — its contract (returns workspace `.switchboard/` path by default, or control-plane root if configured) must be documented in the plan, not referenced to a commit. (3) The stuck-flag root cause is not actually fixed — the new single-flight + boolean-pending pattern (`_localMirrorInFlight` / `_localMirrorPending`) has the IDENTICAL failure mode as the old one (`_exportStateInFlight` / `_exportStatePending`); add an activation-time flush call so a stuck flag self-heals on extension reload. (4) The click-time flush in `suggestFeatures` should be MANDATORY, not optional — the suggest-features action is the primary consumer of this file. Mitigations: inline the full old source or write a complete serialization spec; document `_resolveExportRoot` contract; add startup/activation flush; make the `suggestFeatures` flush mandatory.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — un-retire `exportStateToFile` and fix the staleness

Restore the real implementation from `ca80a8a~1:src/services/KanbanDatabase.ts:6474-6590`, but replace the single-flight + boolean-pending debounce with a debounced + content-hash-skipped approach (mirroring `BoardSnapshotPublisher`'s pattern). Delete the no-op at `:6870-6872` and the misleading retirement comment at `:6863-6868`.

```ts
// Replace the no-op with a debounced, content-stable local mirror writer.
private _localMirrorDebounce: NodeJS.Timeout | null = null;
private _localMirrorLastHash: string | null = null;
private _localMirrorInFlight = false;
private _localMirrorPending = false;
private static readonly LOCAL_MIRROR_DEBOUNCE_MS = 500;

private _scheduleLocalMirror(): void {
    if (this._localMirrorDebounce) clearTimeout(this._localMirrorDebounce);
    this._localMirrorDebounce = setTimeout(() => {
        this._localMirrorDebounce = null;
        void this._writeLocalBoardMirror();
    }, KanbanDatabase.LOCAL_MIRROR_DEBOUNCE_MS);
}

private async _writeLocalBoardMirror(): Promise<void> {
    if (!this._workspaceRoot || !this._db) return;
    if (this._localMirrorInFlight) { this._localMirrorPending = true; return; }
    this._localMirrorInFlight = true;
    try {
        const workspaceId = await this.getWorkspaceId();
        if (!workspaceId) return;
        const exportRoot = this._resolveExportRoot(); // restore from ca80a8a~1 if also retired

        const allPlans = await this.getBoard(workspaceId);
        // ... serialize per-column files + kanban-board.md (same as ca80a8a~1:6494-6582) ...

        // Content-hash skip: don't rewrite if the board content hasn't changed.
        const hash = crypto.createHash('sha256').update(md).digest('hex');
        if (hash === this._localMirrorLastHash) return;
        this._localMirrorLastHash = hash;

        // ... write per-column files + kanban-board.md via tmp+rename ...
    } catch (error) {
        console.error('[KanbanDatabase] Failed to export state to file:', error);
    } finally {
        this._localMirrorInFlight = false;
        if (this._localMirrorPending) {
            this._localMirrorPending = false;
            void this._writeLocalBoardMirror(); // trailing re-run
        }
    }
}
```

Wire it into `_persist` (replace the no-op call at `:6933`):

```ts
if (result) {
    this._scheduleLocalMirror(); // debounced + content-stable local file mirror
    void this._writeKanbanStateBackup();
    if (this._boardSnapshotPublisher && this._isBoardSnapshotEnabled()) {
        this._boardSnapshotPublisher.schedulePublish(); // opt-in remote orphan-branch (unchanged)
    }
}
```

**Key differences from the old implementation:**
- **Debounce.** `_scheduleLocalMirror()` coalesces rapid `_persist` calls into one export after 500ms. The old code called `exportStateToFile()` directly on every `_persist` (fire-and-forget, no debounce) — the single-flight flag was the only coalescing, and it was fragile.
- **Content-hash skip.** The SHA256 hash prevents redundant writes when `_persist` fires for non-board changes (activity_log, config, etc.). The old code always rewrote all files.
- **Trailing write guarantee.** The `_localMirrorPending` flag + `finally` re-run ensures a trailing write always happens after the debounce window, even if the in-flight export is slow. The old code had the same pattern but without the debounce, the floating promise was more likely to be dropped.

### 2. Restore `_resolveExportRoot()` if retired

Check whether `_resolveExportRoot()` (the method that resolves control-plane root vs workspace root) was also retired in `ca80a8a`. If so, restore it from `ca80a8a~1`. The local mirror needs it to write to the correct root for control-plane users.

### 3. `src/services/KanbanProvider.ts` — optional click-time flush

In the `suggestFeatures` handler (`KanbanProvider.ts:9440-9460`), add a synchronous flush before building the prompt to guarantee freshness at click time:

```ts
case 'suggestFeatures': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) break;
    const db = this._getKanbanDb(workspaceRoot);
    if (db) { await db.flushLocalBoardMirror(); } // expose _writeLocalBoardMirror as public
    // ...existing candidateCards filter + _buildSuggestFeaturesPrompt...
}
```

Only needed if the 500ms debounce staleness is unacceptable. Default: include it — the suggest-features action is user-initiated and infrequent, so the flush cost is negligible.

### 4. `src/test/kanban-auto-export.test.ts` — update assertions

The test asserts `kanban-board.md` is written with per-column `kanban-state-{slug}.md` links. With the restored implementation, this is correct again. Remove any assertions that were added for the no-op behavior. Verify the test passes against the restored implementation.

## Verification Plan

> **Session directive:** Compilation and automated tests are SKIPPED per session directives (SKIP COMPILATION, SKIP TESTS). Steps below referencing `npm test` or `npm run build` should be deferred to the user's discretion. The Verification Plan is retained for manual execution guidance.

1. **Unit:** Run `npm test` (or the relevant mocha suite for `kanban-auto-export.test.ts`). Confirm `kanban-board.md` is written with the per-column table format, and each `kanban-state-{slug}.md` file exists with the correct column heading and plan lines.
2. **Content-stable:** Trigger a `_persist` with a non-board change (e.g. `activity_log` insert). Confirm `kanban-board.md` is NOT rewritten (content hash unchanged → skip).
3. **Staleness fix — rapid mutations:** Insert 5 plans in quick succession via `upsertPlans`. Confirm the file is written once (debounced) after ~500ms and contains all 5 plans (trailing write captures latest DB state).
4. **Staleness fix — stuck flag recovery:** Simulate an export error (e.g. make `.switchboard/` temporarily unwritable). Confirm `_localMirrorInFlight` is reset in the `finally` block and the next `_persist` triggers a successful write after permissions are restored.
5. **Manual (installed VSIX):** Move a plan from CREATED to PLAN REVIEWED on the board. Click **Suggest Features**. Paste the clipboard into an agent and run `cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md`. Confirm the snapshot shows the plan in PLAN REVIEWED (not stale CREATED).
6. **Non-git workspace:** Repeat step 5 in a workspace without `.git`. Confirm the local mirror still writes (independent of the orphan-branch publisher).
7. **Remote publisher unaffected:** With `switchboard.boardStateExport === 'read-only-snapshot'` enabled, confirm the orphan-branch publisher still pushes to `switchboard/board` as before. The local mirror is additive and does not touch it.

---

**Recommendation:** Complexity 5 (Mixed) → **Send to Coder.** The core change is a copy-back of retired code plus a debounce/content-hash improvement — routine in isolation, but elevated by the unstuck-flag root cause (not actually fixed by the rename), the `_resolveExportRoot()` restoration requirement, and the dependency on an unverifiable git commit for the old source. The coder must inline the full serialization logic or write a complete spec — the skeleton in Proposed Changes is insufficient.

**Stage Complete:** PLAN REVIEWED
**Stage Complete:** CODER CODED
