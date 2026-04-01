# DB not initialised in a new repo

## Goal
When Switchboard MCP tools are invoked in a workspace that has never been opened by the VS Code extension, the `kanban.db` either does not exist or has no `workspace_id` in its config table. The tools hard-fail with "Not a switchboard workspace — no workspace identity in DB." The fix is to (1) add auto-initialization logic inside the MCP server so MCP tools bootstrap the workspace themselves, and (2) expose an explicit `init_workspace` MCP tool agents can call deliberately.

## User Review Required
> [!NOTE]
> - No breaking changes or manual steps required. The fix is purely additive — existing initialized workspaces are unaffected.
> - The MCP server (`register-tools.js`) will now write to disk for the first time (previously read-only). The write is idempotent and atomic (write-to-temp then rename).
> - `crypto.randomUUID()` is used to generate workspace IDs; this requires Node.js ≥ 14.17. The MCP server already targets this runtime, so no version bump is needed.

## Metadata
**Tags:** backend, database
**Complexity:** Low

## Complexity Audit
### Routine
- Adding `ensureWorkspaceIdentityInMcp()` helper function to `register-tools.js`
- Replacing the hard-failure branch in `get_kanban_state` with auto-init + proceed
- Adding `init_workspace` MCP tool (read + conditional write)
- Schema fragment used is a single `CREATE TABLE IF NOT EXISTS config` — fully idempotent and consistent with the canonical definition in `KanbanDatabase.ts`

### Complex / Risky
- **Concurrent write race:** If the VS Code extension and the MCP server both try to initialize the DB at the same moment, the file-level rename (`writeFileSync` + `renameSync`) ensures the last writer wins atomically, and both writes produce the same `CREATE TABLE IF NOT EXISTS` schema. The only risk is two different `workspace_id` UUIDs being generated; mitigated by checking the config table first inside a single sql.js open-read-write cycle (not a separate read then write).
- **WAL-mode DB conflict:** If the DB was created by the TypeScript extension using WAL journal mode, reading the raw bytes via sql.js without the WAL file applied may read a stale snapshot. However, the MCP server already reads the DB this way (line 2322 of `register-tools.js`), so this is a pre-existing condition, not introduced by this fix.

## Edge-Case & Dependency Audit
- **Race Conditions:** VS Code extension calls `_initialize()` (TypeScript `KanbanDatabase`) concurrently with the MCP server's new helper. Both use `CREATE TABLE IF NOT EXISTS` (idempotent) and `INSERT OR REPLACE` (idempotent). The rename-swap write strategy (`dbPath.tmp` → `dbPath`) makes each individual write atomic at the OS level. Worst case: one party's UUID is overwritten by the other's — acceptable because the extension's `_getOrCreateWorkspaceId()` will re-read from DB on next call and stabilize.
- **Security:** workspace_id is generated with `crypto.randomUUID()` (cryptographically random). No user input flows into the SQL statements; parameterized `db.run("... VALUES (?, ?)", [...])` is used for all writes, preventing injection.
- **Side Effects:** After auto-init, `get_kanban_state` proceeds and returns an empty-but-valid kanban state (no plans) instead of an error. This is the correct UX for a brand-new workspace.
- **Dependencies & Conflicts:** No other pending Kanban plans touch `register-tools.js` or `KanbanDatabase.ts`. No conflicts identified.

## Adversarial Synthesis
### Grumpy Critique
*[Grumpy Principal Engineer enters, coffee in hand, already disappointed]*

"Oh wonderful. We're going to let the MCP server — a PROCESS THAT WAS EXPLICITLY DESIGNED AS READ-ONLY — start scribbling to disk. What could possibly go wrong?

First: you're duplicating schema SQL. The canonical schema lives in `KanbanDatabase.ts:43`. The moment someone adds a migration and forgets to update the MCP helper, the two diverge, and you have a 3am incident where plans written by the MCP server are missing columns the extension expects. 'But it's only the config table!' — famous last words. The config table IS the contract. What happens when V6 migrations add something to config? Now the MCP-bootstrapped DB is perpetually one migration behind.

Second: rename-swap atomicity. You're proud of this. `writeFileSync(tmpPath)` then `renameSync(tmpPath, dbPath)`. But `writeFileSync` is NOT crash-safe. If the process dies mid-write, you have a partial `.tmp` file sitting around. On the NEXT run, `fs.existsSync(dbPath)` is true (the original is still there), so you load the old DB — fine. But the orphaned `.tmp` file stays forever. This is a nit, but it's the kind of nit that fills up people's `.switchboard/` directories.

Third: what about workspaces that have `.switchboard/` but no `kanban.db` file AND no `workspace_identity.json` AND no plans? The auto-init creates a fresh UUID. But now, if the extension also tries to init (because someone opens VS Code after), it'll call `_getOrCreateWorkspaceId()`, find the UUID already in the DB (because MCP wrote it), and use it. Great — that case is handled. But what if the extension initializes FIRST and writes UUID-A, then the MCP server opens the DB at the EXACT same millisecond before the extension's `_persist()` has flushed? The MCP server reads an empty file, generates UUID-B, writes it. Now you have UUID-B in the DB, the extension has UUID-A in memory, and `this._workspaceId` is cached — so the extension keeps filtering by UUID-A for the rest of the session while the DB has UUID-B. Plans created by the extension are invisible to the MCP server. Congratulations, you've created a split-brain scenario.

Fourth: `crypto.randomUUID()` — fine for Node 14.17+, but you didn't add a fallback for environments where someone is running an older Node. The MCP server might be bundled separately with a pinned Node version. This should at least have a graceful fallback to `crypto.randomBytes(16).toString('hex')` or the SHA-256-of-workspace-path approach from `PlanFileImporter`.

Fifth: the `init_workspace` tool description will be LLM-visible. If it's vague, Claude will call it every single time it starts a session 'just to be safe', hammering the filesystem unnecessarily. Write the description so it's clearly a bootstrap-only tool."

### Balanced Response
*[Lead Developer, slightly tired but measured]*

Grumpy raises four legitimate points. Here's how the implementation below addresses them:

1. **Schema duplication risk**: The helper uses ONLY `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)` — the single table needed for identity. It deliberately does NOT duplicate the full `SCHEMA_SQL`. The extension's `_initialize()` always runs the full schema on startup anyway, so the MCP-bootstrapped DB will be completed by the extension the moment it opens. This is explicitly documented in a comment in the helper.

2. **Orphaned `.tmp` files**: The rename-swap is the right pattern, and the `.tmp` file risk is acknowledged. We add a cleanup at the top of the helper: if a `.tmp` exists, delete it before starting. This handles crash-orphaned files.

3. **Split-brain UUID race**: The timing window is extremely narrow (sub-millisecond on local disk). It is fundamentally not solvable at the sql.js layer without OS-level file locking, which sql.js doesn't support. We document this as a known limitation and mitigate by checking the config table first (so if any UUID already exists, we re-use it). The extension's in-memory cache (`this._workspaceId`) is refreshed on next `ensureReady()` call, which runs on every plan sync. In practice, the extension initializes the DB synchronously during startup — the MCP tool is only invoked after the agent context is active, by which time the extension has already run. The true "no-extension-ever" scenario (pure MCP without VS Code) is the one this fix targets, and there the extension is never competing.

4. **`crypto.randomUUID()` fallback**: Added. If `randomUUID` is not available, falls back to `crypto.randomBytes(16).toString('hex')` as the UUID string.

5. **`init_workspace` tool description**: Written to explicitly state it is only needed for first-time setup in repos without an existing `.switchboard/kanban.db`, so LLMs don't call it on every session.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks.

---

### 1. Helper Function in MCP Server

#### MODIFY `src/mcp-server/register-tools.js`

- **Context:** The MCP server is a standalone Node.js process with no access to the TypeScript `KanbanDatabase` class or `TaskViewerProvider._getOrCreateWorkspaceId()`. It already reads the DB using raw sql.js calls (line 2322). We need to add write capability for the bootstrap case. The helper is added as a module-level function before `registerTools()`.
- **Logic:**
  1. Resolve `.switchboard/` dir and `kanban.db` path from `workspaceRoot`.
  2. Delete any orphaned `.tmp` file left by a previous crashed write.
  3. `mkdir -p` the `.switchboard/` directory.
  4. Open existing DB bytes via sql.js, or create a new empty in-memory DB.
  5. Run `CREATE TABLE IF NOT EXISTS config (...)` — minimal schema, idempotent.
  6. Read `workspace_id` from config table. If found, return it immediately (no write needed).
  7. If not found, check legacy `workspace_identity.json` for a pre-existing ID.
  8. If still not found, generate a new UUID via `crypto.randomUUID()` (Node ≥ 14.17) with fallback to `crypto.randomBytes(16).toString('hex')`.
  9. Write workspace_id into config using parameterized `db.run(...)`.
  10. Export DB bytes, write to `.tmp`, rename to final path (atomic swap).
  11. Close the sql.js DB handle.
  12. Return the resolved workspace_id string.
- **Implementation:**

```javascript
/**
 * Ensures this workspace has a valid identity row in kanban.db.
 * If the DB file or config table don't exist, creates them with a minimal
 * schema (config table only — the VS Code extension applies the full schema
 * when it runs). Safe to call multiple times; all writes are idempotent.
 *
 * Priority for workspace_id:
 *   1. Existing value in config table (no write needed)
 *   2. Value from legacy .switchboard/workspace_identity.json
 *   3. Newly generated UUID
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root.
 * @returns {Promise<string>} The resolved workspace_id.
 */
async function ensureWorkspaceIdentityInMcp(workspaceRoot) {
    const sbDir = path.join(workspaceRoot, '.switchboard');
    const dbPath = path.join(sbDir, 'kanban.db');
    const tmpPath = dbPath + '.mcp_init.tmp';

    // Clean up any orphaned temp file from a prior crashed write
    try { fs.unlinkSync(tmpPath); } catch (_) { /* expected if absent */ }

    await fs.promises.mkdir(sbDir, { recursive: true });

    const SQL = await getSqlJs(workspaceRoot);
    let db = null;
    try {
        if (fs.existsSync(dbPath)) {
            const existing = fs.readFileSync(dbPath);
            db = new SQL.Database(new Uint8Array(existing));
        } else {
            db = new SQL.Database();
        }

        // Minimal schema — only the config table is needed for workspace identity.
        // The extension's KanbanDatabase._initialize() applies the full schema
        // (plans, migration_meta, indices) the first time VS Code opens this workspace.
        db.exec(`CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);

        // Step 1: check if workspace_id already exists (fast path — no write)
        let workspaceId = null;
        const readStmt = db.prepare("SELECT value FROM config WHERE key = 'workspace_id'");
        try {
            if (readStmt.step()) {
                const val = readStmt.getAsObject().value;
                if (typeof val === 'string' && val.length > 0) {
                    workspaceId = val;
                }
            }
        } finally {
            readStmt.free();
        }

        if (workspaceId) {
            return workspaceId; // Already initialized — skip all writes
        }

        // Step 2: migrate from legacy workspace_identity.json if present
        const legacyPath = path.join(sbDir, 'workspace_identity.json');
        try {
            if (fs.existsSync(legacyPath)) {
                const raw = fs.readFileSync(legacyPath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (typeof parsed?.workspaceId === 'string' && parsed.workspaceId.length > 0) {
                    workspaceId = parsed.workspaceId;
                }
            }
        } catch (_) { /* ignore parse errors — we'll generate a new ID below */ }

        // Step 3: generate a new UUID
        if (!workspaceId) {
            if (typeof crypto.randomUUID === 'function') {
                workspaceId = crypto.randomUUID();
            } else {
                // Fallback for Node < 14.17
                workspaceId = crypto.randomBytes(16).toString('hex');
            }
        }

        // Persist to config table using parameterized statement (no injection risk)
        db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [
            'workspace_id',
            workspaceId,
        ]);

        // Atomic write: export → .tmp → rename over final path
        const exported = db.export();
        fs.writeFileSync(tmpPath, Buffer.from(exported));
        fs.renameSync(tmpPath, dbPath);

        return workspaceId;
    } finally {
        if (db && typeof db.close === 'function') db.close();
    }
}
```

**Placement:** Insert this function immediately before the `registerTools` export function (around line 800, after `findMostRecentActiveRunSheet`).

---

### 2. Fix `get_kanban_state` — Replace Hard Failure with Auto-Init

#### MODIFY `src/mcp-server/register-tools.js` (lines 2312–2339)

- **Context:** Currently, when `workspaceId` is null after reading the DB, the tool returns an immediate error. After this change, it calls `ensureWorkspaceIdentityInMcp()` to bootstrap the workspace, then returns an empty-but-valid kanban state.
- **Logic:**
  1. Keep the existing DB read (lines 2319–2336) unchanged — this is the fast path for initialized workspaces.
  2. If `workspaceId` is still null after the read, call `ensureWorkspaceIdentityInMcp()` and use its return value.
  3. After auto-init, `workspaceId` is guaranteed non-null; proceed normally. Since the DB was just created, there are no plans — `readKanbanStateFromDb` will return an empty column set, which `buildKanbanStateResponse` renders correctly.
- **Implementation — replace the block at lines 2337–2339:**

```javascript
            if (!workspaceId) {
                // Workspace not yet initialized — auto-bootstrap it so this tool
                // succeeds instead of failing. The returned state will be empty
                // (no plans) which is correct for a brand-new workspace.
                try {
                    workspaceId = await ensureWorkspaceIdentityInMcp(workspaceRoot);
                } catch (initErr) {
                    // Init failed (disk permissions, etc.) — surface a clear error
                    return {
                        isError: true,
                        content: [{
                            type: "text",
                            text: `Error: Switchboard workspace could not be initialized. ${initErr?.message || String(initErr)}\n\nTry calling the init_workspace tool, then retry.`,
                        }],
                    };
                }
            }
```

**Full replacement block in context** (replace lines 2337–2339 of `register-tools.js`):

```diff
-            if (!workspaceId) {
-                return { isError: true, content: [{ type: "text", text: "Error: Not a switchboard workspace — no workspace identity in DB." }] };
-            }
+            if (!workspaceId) {
+                // Workspace not yet initialized — auto-bootstrap it so this tool
+                // succeeds instead of failing. The returned state will be empty
+                // (no plans) which is correct for a brand-new workspace.
+                try {
+                    workspaceId = await ensureWorkspaceIdentityInMcp(workspaceRoot);
+                } catch (initErr) {
+                    // Init failed (disk permissions, etc.) — surface a clear error
+                    return {
+                        isError: true,
+                        content: [{
+                            type: "text",
+                            text: `Error: Switchboard workspace could not be initialized. ${initErr?.message || String(initErr)}\n\nTry calling the init_workspace tool, then retry.`,
+                        }],
+                    };
+                }
+            }
```

---

### 3. Add `init_workspace` MCP Tool

#### MODIFY `src/mcp-server/register-tools.js`

- **Context:** Provides an explicit, agent-callable tool to bootstrap a new workspace. This is useful when an agent wants to deliberately initialize Switchboard before taking any other action, rather than relying on `get_kanban_state`'s auto-init as a side-effect.
- **Logic:**
  1. Call `ensureWorkspaceIdentityInMcp(workspaceRoot)`.
  2. Return the resolved workspace_id and a human-readable summary.
  3. If it throws, return `isError: true` with the reason.
- **Placement:** Insert immediately after the `get_kanban_state` tool block (after line 2359).
- **Implementation:**

```javascript
    // Tool: init_workspace
    server.tool(
        "init_workspace",
        {
            // No parameters required — workspace root is resolved from process env
        },
        async () => {
            // This tool is only needed when the workspace has never been opened
            // by the Switchboard VS Code extension (i.e., no kanban.db exists or
            // the config table has no workspace_id). Do NOT call it on every
            // session — it is a one-time bootstrap operation.
            const workspaceRoot = getWorkspaceRoot();
            try {
                const workspaceId = await ensureWorkspaceIdentityInMcp(workspaceRoot);
                const sbDir = path.join(workspaceRoot, '.switchboard');
                const dbPath = path.join(sbDir, 'kanban.db');
                return {
                    content: [{
                        type: "text",
                        text: [
                            `✅ Switchboard workspace initialised.`,
                            ``,
                            `Workspace ID : ${workspaceId}`,
                            `Database     : ${dbPath}`,
                            ``,
                            `You can now use get_kanban_state, move_kanban_card, and other Switchboard tools normally.`,
                            `If you have existing plan files in .switchboard/plans/, open this workspace in VS Code to sync them into the board.`,
                        ].join('\n'),
                    }],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: `❌ Failed to initialise Switchboard workspace: ${err?.message || String(err)}`,
                    }],
                };
            }
        }
    );
```

---

## Verification Plan

### Automated Tests
- No existing automated test suite for `register-tools.js` (MCP server is tested manually). Add the following manual verification steps:

### Manual Verification Steps
1. **Fresh workspace (no DB):** Create an empty directory, set it as `WORKSPACE_ROOT` in the MCP server environment, call `get_kanban_state` via MCP client. Expected: returns empty kanban state (no error). Check that `.switchboard/kanban.db` now exists and contains a `workspace_id` in the config table.
2. **Fresh workspace via `init_workspace`:** Same setup, but call `init_workspace` first. Expected: returns success message with the UUID and DB path.
3. **Initialized workspace (existing DB with workspace_id):** Call `get_kanban_state` on the main Switchboard dev repo. Expected: behaves exactly as before — existing plans are returned, no writes occur (verify by checking DB mtime before and after).
4. **Legacy migration:** Create a workspace with only `.switchboard/workspace_identity.json` (no DB). Call `get_kanban_state`. Expected: the UUID from the JSON file is used as the workspace_id (not a new UUID), and it is persisted to the new `kanban.db`.
5. **Idempotency:** Call `init_workspace` twice on the same workspace. Expected: same workspace_id returned both times; DB mtime only changes on the first call (second call exits early at the "fast path — no write" branch).
6. **Concurrent stress (optional):** Simulate concurrent init by calling `init_workspace` 5× in parallel via the MCP client. Expected: all return the same workspace_id; DB is not corrupted.

---

## Cross-Plan Conflict Scan
No other plans in the Kanban board touch `register-tools.js` or `KanbanDatabase.ts`. No conflicts identified.

---

## Post-Implementation Review (2026-04-01)

### Reviewer Pass

**Implementation fidelity:** All three plan items (helper function, `get_kanban_state` auto-init, `init_workspace` tool) are implemented verbatim from the plan spec.

### Issues Found
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | **MAJOR** | `init_workspace` tool registered without a `description` string — LLMs see a bare tool name with no guidance on when to call it, contradicting plan's own mitigation for the "LLM hammering" risk | **Fixed** — added description string as 2nd arg to `server.tool()` |
| 2 | NIT | Orphaned `.tmp` cleanup silently swallows non-ENOENT errors | Deferred — subsequent `writeFileSync` surfaces the real error |
| 3 | NIT | Prepared statement cleanup relies on `db.close()` | Deferred — sql.js handles it |

### Files Changed During Review
- `src/mcp-server/register-tools.js` — line 2477: added tool description string to `init_workspace` registration

### Validation Results
- `node -c src/mcp-server/register-tools.js` — **PASS** (no syntax errors)

### Remaining Risks
- Split-brain UUID race (documented in plan as known limitation — mitigation is sufficient for the target scenario)
- No automated tests for the MCP server bootstrap path (pre-existing gap, not introduced by this change)

### Verdict: **Ready**
