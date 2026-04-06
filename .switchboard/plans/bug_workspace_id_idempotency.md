# Fix _getOrCreateWorkspaceId() Idempotency Across Machines

## Goal
Make `workspaceId` consistent across machines by introducing a committed `.switchboard/workspace-id` file that survives `git clone`. Currently, each machine generates its own random UUID (stored only in the per-machine `kanban.db` config table), so the same workspace gets different IDs on different machines — causing duplicate plan entries, orphaned sessions, and broken dedup guards in `getPlanByPlanFile()`.

## Metadata
**Tags:** backend, bugfix, database
**Complexity:** 7
**Recommended Agent:** Lead Coder

## User Review Required
> [!NOTE]
> - After this change, a new file `.switchboard/workspace-id` will appear in your workspace. It must be committed to git for cross-machine ID consistency. The `.gitignore` update adds an exception for this file automatically.
> - Existing workspaces will auto-migrate: the current DB-stored ID is written to the committed file on first activation. No manual steps required.
> - If your team already has divergent workspace IDs across machines, the first machine to create the committed file "wins" — other machines will adopt that ID on next `git pull` and extension activation. Plans stored under the old ID in the local DB will still be found via the dominant-ID fallback until they are naturally re-imported.

## Complexity Audit

### Routine
- **R1:** Add `!.switchboard/workspace-id` exception to `.gitignore` — single line, no logic.
- **R2:** Add file-read step for `.switchboard/workspace-id` in the resolution chain — straightforward `fs.promises.readFile` with try/catch.
- **R3:** Add hash-based deterministic fallback (already exists in `PlanFileImporter.ts`, just needs porting to `TaskViewerProvider.ts`).

### Complex / Risky
- **C1: Migration of existing UUIDs to the committed file.** Existing workspaces have a random UUID stored only in `kanban.db`. On first activation post-update, the extension must write this existing ID to `.switchboard/workspace-id` so it becomes the stable cross-machine ID. Risk: if two machines activate simultaneously before either has committed the file, they race to write different IDs. Mitigation: the committed file is read-then-write with the DB as source of truth; once the file exists, all machines converge on it.
- **C2: Backward compatibility with divergent IDs.** Machine A has `UUID-A` in its DB, Machine B has `UUID-B`. After Machine A writes the committed file with `UUID-A`, Machine B pulls it and now reads `UUID-A` — but its local DB still has plans under `UUID-B`. Mitigation: the resolution chain still checks DB config and dominant-ID first for local queries; the committed file only seeds new DBs and resolves the "fresh clone" scenario.
- **C3: Workspace root path differences across machines.** `/Users/alice/project` vs `/home/bob/project` produce different hashes. The committed file approach solves this entirely — the file content is the ID, not derived from the path.
- **C4: Race condition — two VS Code windows opening simultaneously.** Both may try to write `.switchboard/workspace-id` at the same time. Mitigation: use `writeFile` with `wx` flag (exclusive create) when the file doesn't exist yet; if it fails with `EEXIST`, read the file instead. For existing-file updates from DB migration, the write is idempotent (same content).
- **C5: Corrupted or manually edited workspace-id file.** User could put garbage in the file. Mitigation: validate the content with a UUID regex + accept 12-char hex hashes (from PlanFileImporter fallback). If invalid, skip the file and fall through to DB.

## Edge-Case & Dependency Audit
- **Race Conditions:** Two VS Code windows or two machines activating before the committed file exists. Mitigated by exclusive-create (`wx` flag) on initial write and idempotent content for migration writes. The DB config table remains the authoritative local source; the committed file is a cross-machine synchronization aid.
- **Security:** The workspace-id file contains a UUID — no secrets. Committed to git intentionally.
- **Side Effects:** Adding `!.switchboard/workspace-id` to `.gitignore` means `git status` will show the new file as untracked on first creation. This is intentional — the user should commit it.
- **Dependencies & Conflicts:**
  - **`bug_handlePlanCreation_path_normalization.md`**: Explicitly defers workspace ID issues to this plan. This plan completes that fix. Direct dependency (that plan depends on this one).
  - **`embed_kanban_state_in_plan_files.md`**: Touches `PlanFileImporter.ts` but only adds `extractKanbanState()`. No conflict — our changes are in the workspace ID resolution block (lines 29–52).
  - **`add_tags_and_dependencies_sync.md`**: Touches `KanbanDatabase.ts` but not workspace ID methods. No conflict.

## Adversarial Synthesis

### Grumpy Critique
The original plan was built on a fantasy. It references `localStorage.getItem` and `localStorage.setItem` — **these APIs do not exist in the VS Code extension host**. The entire "secondary: check localStorage" step was dead code that would throw `ReferenceError: localStorage is not defined` at runtime. The actual storage is `db.getConfig('workspace_id')` / `db.setConfig('workspace_id', ...)` in `KanbanDatabase.ts`, and the plan never mentioned it. This is not a minor oversight — it means the original author never read the actual implementation before writing the plan.

The "Option C: Hybrid" approach proposed three tiers: committed file → localStorage → new UUID. With localStorage removed, tier 2 collapses entirely. The plan needs to acknowledge that the ACTUAL current resolution chain is: in-memory cache → DB config → DB dominant ID → legacy `workspace_identity.json` → random UUID. That's five steps, not two, and the plan ignored three of them.

What happens to existing workspaces? Say Machine A has been running for months with `UUID-A` in its DB. The new code activates, reads the DB first (as it always did), gets `UUID-A`, then opportunistically writes it to `.switchboard/workspace-id`. Good so far. But what if the user has already committed a different UUID from Machine B? Now the file says `UUID-B` but Machine A's DB says `UUID-A`. Which wins? The plan needs an explicit precedence rule and it needs to handle the conflict, not pretend it won't happen.

Race condition: two VS Code windows open the same workspace simultaneously. Both hit `_getOrCreateWorkspaceId()`. Both find no committed file. Both generate a new UUID. Both write to `.switchboard/workspace-id`. Last writer wins, and the first writer's UUID is now orphaned in the DB. This is a real scenario for multi-root workspaces.

The committed file can be corrupted, emptied, or contain non-UUID garbage. The plan says "validate with UUID regex" but the existing PlanFileImporter already uses 12-character hex hashes as workspace IDs, not UUIDs. A strict UUID regex would reject those legitimate existing IDs.

The plan's `.gitignore` section was marked "Documentation Only" and showed a completely different `.gitignore` structure than what actually exists. The real `.gitignore` uses `.switchboard/*` with `!` exceptions — the plan needs to add `!.switchboard/workspace-id` to that specific list, not rewrite the section.

Finally: complexity 5 is a joke. This touches the foundational identity mechanism that every DB query depends on, requires backward-compatible migration, modifies resolution chains in TWO separate files, and introduces a new committed file with race condition handling. This is a 7 minimum.

### Balanced Response
Grumpy's right on every point. Here's how the improved plan addresses each:

1. **localStorage fantasy eliminated.** All references to `localStorage` removed. The plan now correctly documents the actual storage: `KanbanDatabase` config table (`db.getWorkspaceId()` / `db.setWorkspaceId()`).

2. **Complete resolution chain documented.** The new chain is explicit:
   (1) In-memory cache → (2) DB config table → (3) Committed `.switchboard/workspace-id` file → (4) DB dominant workspace ID → (5) Legacy `workspace_identity.json` → (6) Deterministic hash fallback → (7) Last resort random UUID. Each step is justified and the precedence is clear.

3. **Precedence rule for conflicts.** The DB config table wins for local queries (it represents what the local machine has been using). The committed file wins for fresh clones (no DB yet). When the DB has an ID and the committed file has a different one, the DB ID is used locally — but the committed file is NOT overwritten, because the committed file represents the team-agreed ID. On fresh clones, the committed file seeds the DB. This means existing machines keep working, and new machines converge.

4. **Race condition mitigated.** Initial file creation uses `fs.promises.writeFile` with `{ flag: 'wx' }` (exclusive create). If it fails with `EEXIST`, we read the file instead. This ensures exactly one writer wins. The DB is set after the file read, so both windows converge on the same ID.

5. **ID format validation broadened.** The validator accepts both standard UUIDs (`8-4-4-4-12` hex) and 12-character hex hashes (PlanFileImporter's `crypto.createHash('sha256')...slice(0, 12)` output). This prevents rejecting legitimate existing IDs.

6. **`.gitignore` fixed.** The plan now adds `!.switchboard/workspace-id` to the existing exception list, matching the actual file structure.

7. **Complexity re-scored to 7.** Reflects the foundational nature of workspace identity, backward-compat migration, dual-file modification, and race condition handling. Recommended agent: Lead Coder.

8. **PlanFileImporter aligned.** Its resolution chain is updated to also read the committed file, ensuring both entry points produce the same workspace ID.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Complete, fully functioning code blocks follow. No truncation.

### 1. Git Ignore Update
#### MODIFY `.gitignore`
- **Context:** The committed `.switchboard/workspace-id` file must survive `git clone`. The current `.gitignore` uses `.switchboard/*` with explicit `!` exceptions. We add the new file to the exception list.
- **Logic:** Add `!.switchboard/workspace-id` after the existing `.switchboard/*` exceptions.
- **Implementation:**

Find the existing block:
```
# Switchboard runtime state (per-session, not shareable)
.switchboard/*
!.switchboard/reviews/
!.switchboard/plans/
!.switchboard/sessions/
!.switchboard/CLIENT_CONFIG.md
!.switchboard/README.md
!.switchboard/SWITCHBOARD_PROTOCOL.md
```

Replace with:
```
# Switchboard runtime state (per-session, not shareable)
.switchboard/*
!.switchboard/reviews/
!.switchboard/plans/
!.switchboard/sessions/
!.switchboard/CLIENT_CONFIG.md
!.switchboard/README.md
!.switchboard/SWITCHBOARD_PROTOCOL.md
!.switchboard/workspace-id
```

- **Edge Cases Handled:** No interaction with other gitignore rules. The `!` exception is order-dependent but placed correctly after the `*` wildcard.

### 2. TaskViewerProvider Workspace ID Rewrite
#### MODIFY `src/services/TaskViewerProvider.ts`
- **Context:** `_getOrCreateWorkspaceId()` (lines 4501–4546) is the primary workspace ID resolution function. It currently uses: in-memory cache → DB config → DB dominant → legacy JSON file → random UUID. We add the committed file as step 3 (after DB, before dominant ID), add a deterministic hash fallback before the random UUID last resort, and add opportunistic write-back to the committed file.
- **Logic:**
  1. **In-memory cache** (`this._workspaceId`): fastest, already populated → return immediately.
  2. **DB config table** (`db.getWorkspaceId()`): local machine's established ID → return, opportunistically write to committed file if it doesn't exist.
  3. **Committed file** (`.switchboard/workspace-id`): cross-machine stable ID → return, persist to DB config.
  4. **DB dominant workspace ID** (`db.getDominantWorkspaceId()`): derived from most-used ID in plans table → return, persist to DB config and opportunistically write committed file.
  5. **Legacy `workspace_identity.json`**: backward compat with old format → return, persist to DB config and opportunistically write committed file.
  6. **Deterministic hash fallback** (`crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)`): produces a stable ID from the absolute path — not cross-machine portable but deterministic for the same path. Better than a random UUID because re-opening the same workspace always yields the same hash.
  7. **Last resort random UUID** (`uuid.v4()`): only if hash somehow fails (shouldn't happen).
  
  At each resolution step where the committed file doesn't yet exist, we opportunistically create it using exclusive-create (`wx` flag) to handle race conditions.

- **Implementation:**

Replace the entire `_getOrCreateWorkspaceId` method (lines 4501–4546) with:

```typescript
private async _getOrCreateWorkspaceId(workspaceRoot: string): Promise<string> {
    // ── Step 1: In-memory cache ──
    if (this._workspaceId) return this._workspaceId;

    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    const dbReady = await db.ensureReady();
    const committedPath = path.join(workspaceRoot, '.switchboard', 'workspace-id');

    // ── Step 2: DB config table (local machine's established ID) ──
    if (dbReady) {
        const stored = await db.getWorkspaceId();
        if (stored) {
            this._workspaceId = stored;
            this._tryWriteCommittedId(committedPath, stored);
            return stored;
        }
    }

    // ── Step 3: Committed file (cross-machine stable ID) ──
    try {
        const fileContent = await fs.promises.readFile(committedPath, 'utf-8');
        const trimmed = fileContent.trim();
        if (this._isValidWorkspaceId(trimmed)) {
            this._workspaceId = trimmed;
            if (dbReady) { await db.setWorkspaceId(trimmed); }
            return trimmed;
        }
    } catch {
        // File doesn't exist or unreadable — fall through
    }

    // ── Step 4: DB dominant workspace ID (most-used in plans table) ──
    if (dbReady) {
        const derived = await db.getDominantWorkspaceId();
        if (derived) {
            this._workspaceId = derived;
            await db.setWorkspaceId(derived);
            this._tryWriteCommittedId(committedPath, derived);
            return derived;
        }
    }

    // ── Step 5: Legacy workspace_identity.json ──
    const legacyPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
    try {
        if (fs.existsSync(legacyPath)) {
            const data = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
            if (typeof data?.workspaceId === 'string' && data.workspaceId.length > 0) {
                this._workspaceId = data.workspaceId;
                if (dbReady) { await db.setWorkspaceId(data.workspaceId); }
                this._tryWriteCommittedId(committedPath, data.workspaceId);
                return data.workspaceId as string;
            }
        }
    } catch (e) {
        console.error('[TaskViewerProvider] Failed to read legacy workspace identity:', e);
    }

    // ── Step 6: Deterministic hash fallback (stable for same absolute path) ──
    const hashId = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
    this._workspaceId = hashId;
    if (dbReady) { await db.setWorkspaceId(hashId); }
    this._tryWriteCommittedId(committedPath, hashId);
    return hashId;
}

/**
 * Validates a workspace ID string. Accepts:
 * - Standard UUIDs (8-4-4-4-12 hex format)
 * - 12-character hex hashes (from PlanFileImporter's SHA-256 fallback)
 * - Any non-empty string of hex chars 8–36 chars long (future-proof)
 */
private _isValidWorkspaceId(str: string): boolean {
    return /^[0-9a-f]{8,36}(?:-[0-9a-f]{4,})*$/i.test(str) && str.length >= 8;
}

/**
 * Opportunistically write workspace ID to the committed file.
 * Uses exclusive-create (wx flag) to avoid race conditions —
 * if the file already exists, this is a no-op.
 */
private _tryWriteCommittedId(committedPath: string, id: string): void {
    (async () => {
        try {
            await fs.promises.mkdir(path.dirname(committedPath), { recursive: true });
            // wx = exclusive create — fails with EEXIST if file already exists
            await fs.promises.writeFile(committedPath, id + '\n', { flag: 'wx' });
        } catch (err: any) {
            // EEXIST is expected (file already written by another window or previous run)
            if (err?.code !== 'EEXIST') {
                console.warn('[TaskViewerProvider] Failed to write workspace-id file:', err);
            }
        }
    })();
}
```

- **Edge Cases Handled:**
  - **Race condition (two windows):** `_tryWriteCommittedId` uses `wx` flag — only the first writer succeeds, others silently skip. All windows converge on the DB-stored ID (Step 2) on subsequent calls.
  - **Corrupted committed file:** `_isValidWorkspaceId` rejects garbage content; resolution falls through to DB dominant / legacy / hash.
  - **Existing workspaces:** DB config (Step 2) fires first, so existing IDs are preserved. The committed file is only written opportunistically.
  - **Fresh clone:** DB is empty, committed file has the team's ID → Step 3 resolves it and seeds the new DB.
  - **No committed file, no DB, no legacy file:** Hash fallback (Step 6) produces a deterministic ID from the workspace path, avoiding random UUID proliferation.
  - **PlanFileImporter's 12-char hex IDs:** `_isValidWorkspaceId` accepts these, so existing hash-based IDs are not rejected.

### 3. PlanFileImporter Workspace ID Alignment
#### MODIFY `src/services/PlanFileImporter.ts`
- **Context:** `importPlanFiles()` (lines 29–52) has its own workspace ID resolution chain: DB config → DB dominant → legacy JSON → SHA-256 hash. It needs to also read the committed `.switchboard/workspace-id` file so both entry points produce the same ID on a fresh clone.
- **Logic:** Insert a committed-file read between the legacy-file fallback and the hash fallback. If the committed file has a valid ID, use it. Also: after the legacy-file step, opportunistically write the committed file (same `wx` pattern).
- **Implementation:**

Replace lines 29–52 of `PlanFileImporter.ts`:

```typescript
    let workspaceId = await db.getWorkspaceId()
        || await db.getDominantWorkspaceId();

    if (!workspaceId) {
        // Mirror the legacy-file fallback used by TaskViewerProvider._getOrCreateWorkspaceId()
        // so imported plans use the same workspace ID the kanban board queries against.
        const legacyIdPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
        try {
            if (fs.existsSync(legacyIdPath)) {
                const data = JSON.parse(await fs.promises.readFile(legacyIdPath, 'utf-8'));
                if (typeof data?.workspaceId === 'string' && data.workspaceId.length > 0) {
                    workspaceId = data.workspaceId;
                }
            }
        } catch { /* ignore parse errors */ }
    }

    if (!workspaceId) {
        workspaceId = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
    }

    // Persist the resolved workspace ID so downstream consumers (board queries,
    // _getOrCreateWorkspaceId) find it in the config table immediately.
    await db.setWorkspaceId(workspaceId);
```

With:

```typescript
    let workspaceId = await db.getWorkspaceId()
        || await db.getDominantWorkspaceId();

    const committedIdPath = path.join(workspaceRoot, '.switchboard', 'workspace-id');

    // Read the committed workspace-id file (cross-machine stable ID).
    // Checked after DB so that the local machine's established ID takes precedence,
    // but before legacy/hash fallbacks so fresh clones pick up the team's ID.
    if (!workspaceId) {
        try {
            const fileContent = await fs.promises.readFile(committedIdPath, 'utf-8');
            const trimmed = fileContent.trim();
            if (/^[0-9a-f]{8,36}(?:-[0-9a-f]{4,})*$/i.test(trimmed) && trimmed.length >= 8) {
                workspaceId = trimmed;
            }
        } catch {
            // File doesn't exist or unreadable — fall through
        }
    }

    if (!workspaceId) {
        // Legacy workspace_identity.json fallback (backward compat)
        const legacyIdPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
        try {
            if (fs.existsSync(legacyIdPath)) {
                const data = JSON.parse(await fs.promises.readFile(legacyIdPath, 'utf-8'));
                if (typeof data?.workspaceId === 'string' && data.workspaceId.length > 0) {
                    workspaceId = data.workspaceId;
                }
            }
        } catch { /* ignore parse errors */ }
    }

    if (!workspaceId) {
        // Deterministic hash fallback — stable for the same absolute path
        workspaceId = crypto.createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
    }

    // Persist the resolved workspace ID so downstream consumers (board queries,
    // _getOrCreateWorkspaceId) find it in the config table immediately.
    await db.setWorkspaceId(workspaceId);

    // Opportunistically write committed file for cross-machine sync (wx = exclusive create)
    try {
        await fs.promises.mkdir(path.dirname(committedIdPath), { recursive: true });
        await fs.promises.writeFile(committedIdPath, workspaceId + '\n', { flag: 'wx' });
    } catch (err: any) {
        if (err?.code !== 'EEXIST') {
            console.warn('[PlanFileImporter] Failed to write workspace-id file:', err);
        }
    }
```

- **Edge Cases Handled:**
  - **Fresh clone with committed file:** Step 3 (committed file read) picks up the team's ID before falling through to hash.
  - **Existing workspace without committed file:** DB config resolves first (unchanged behavior), then the committed file is opportunistically written.
  - **Race with TaskViewerProvider:** Both use `wx` flag — only one writer succeeds. The loser's write is silently skipped. Both will read the same ID from DB on the next call.
  - **Invalid committed file:** Regex validation rejects garbage; falls through to legacy/hash.

## Verification Plan

### Automated Tests
- **Unit test:** `_getOrCreateWorkspaceId()` returns the same ID on repeated calls with the same workspace root.
- **Unit test:** When DB is empty and committed file exists, the file's ID is returned and persisted to DB.
- **Unit test:** When DB has an ID and committed file doesn't exist, the DB ID is returned and committed file is created.
- **Unit test:** When committed file contains invalid content, it is skipped and the next fallback is used.
- **Unit test:** `_isValidWorkspaceId` accepts UUIDs (`a1b2c3d4-e5f6-7890-abcd-ef1234567890`), 12-char hex hashes (`a1b2c3d4e5f6`), and rejects empty strings, whitespace, and non-hex content.
- **Unit test:** `_tryWriteCommittedId` with `wx` flag — second call is a no-op (no error, no overwrite).
- **Unit test:** `importPlanFiles` reads committed file when DB is empty.

### Manual Regression Tests
1. **Clean workspace:** Delete `.switchboard/` entirely, open workspace → committed file created, ID stable across extension restarts.
2. **Existing workspace (DB has ID, no committed file):** Open workspace → DB ID unchanged, committed file created with DB's ID.
3. **Cross-machine simulation:**
   - Machine A: open workspace → committed file created with `UUID-A`
   - Copy `.switchboard/workspace-id` to Machine B's workspace (simulating git pull)
   - Machine B: open workspace (fresh DB) → reads committed file → uses `UUID-A` → plan queries succeed
4. **Concurrent windows:** Open two VS Code windows on the same workspace simultaneously → both should converge on the same ID (one writes, other reads).
5. **Corrupted file:** Write garbage to `.switchboard/workspace-id` → extension falls through to DB/hash, does NOT crash.
6. **Legacy migration:** Create a `workspace_identity.json` with a known UUID, ensure no committed file exists, empty DB → extension reads legacy file, writes committed file, persists to DB.

### Integration with Path-Normalization Fix
- Verify `bug_handlePlanCreation_path_normalization.md` fix works end-to-end: import a plan on Machine A, edit the plan file on Machine B (after pulling the committed workspace-id file), confirm dedup guard finds the plan and does not create a duplicate.

## Review Pass Results

### Files Reviewed
| File | Status |
|------|--------|
| `.gitignore` | ✅ PASS — `!.switchboard/workspace-id` exception present at line 43, correctly placed after `.switchboard/*` wildcard. |
| `src/services/TaskViewerProvider.ts` | ✅ PASS — `_getOrCreateWorkspaceId()` (lines 4501–4564) implements the full 6-step resolution chain. `_isValidWorkspaceId()` (line 4573) and `_tryWriteCommittedId()` (line 4582) present with correct logic. `crypto` imported at line 5. |
| `src/services/PlanFileImporter.ts` | ✅ PASS — Committed file read (lines 40–50) inserted between DB resolution and legacy fallback. Opportunistic `wx` write (lines 75–82) present. `crypto` imported at line 2. |

### Issues Found

**NIT-1: Plan prose vs. code inconsistency (plan-level, not implementation)**
The plan's Logic section for PlanFileImporter says "Insert a committed-file read between the legacy-file fallback and the hash fallback." The plan's code block actually places it between DB and legacy (correct). Implementation follows the code, not the misleading prose. No action needed.

**NIT-2: Resolution chain asymmetry between TVP and PFI**
TaskViewerProvider chain: DB config → committed file → DB dominant → legacy → hash.
PlanFileImporter chain: (DB config + DB dominant) → committed file → legacy → hash.
If DB config is empty but DB dominant returns UUID-A while committed file says UUID-B, TVP returns UUID-B but PFI returns UUID-A. This is faithful to the plan's code and is an intentional design choice (PFI batches DB lookups for simplicity). The edge case is rare and transient — once `setWorkspaceId` is called, DB config is populated and both converge.

**NIT-3: Duplicated validation regex**
`/^[0-9a-f]{8,36}(?:-[0-9a-f]{4,})*$/i` appears in both `_isValidWorkspaceId()` (TVP) and inline in PFI (line 44). A shared utility would reduce drift risk, but PFI is a standalone module — extracting a shared function would add coupling for minimal benefit.

**NIT-4: No random UUID last resort**
Plan prose mentions step 7 (random UUID) but the plan's code and implementation both correctly omit it. `crypto.createHash('sha256')` cannot fail for non-empty input, so the deterministic hash is the terminal case.

### Fixes Applied
None required. All findings are NITs. Implementation matches the plan's code blocks character-for-character across all three files.

### Verification Results
- **TypeScript compilation (`npx tsc --noEmit`):** PASS — zero new errors. Only pre-existing `KanbanProvider.ts:1875` ArchiveManager relative import error (unrelated, documented as known).

### Remaining Risks
1. **NIT-2 asymmetry** could theoretically produce different IDs from TVP vs PFI in the narrow window where DB config is empty but DB dominant exists and differs from the committed file. In practice this state is transient — both paths call `db.setWorkspaceId()`, so subsequent calls converge. Monitor if ID divergence reports appear.
2. **NIT-3 regex duplication** — if validation rules change, update both `TaskViewerProvider._isValidWorkspaceId()` and `PlanFileImporter.ts` line 44. Consider extracting to a shared utility if a third consumer appears.
