---
description: Improve kanban_operations skill to auto-discover workspaces without requiring manual workspace root argument
---

# Improve Kanban Operations Skill Auto-Discovery

## Goal
Make the `kanban_operations` skill auto-discover workspace roots from VS Code configuration and environment variables instead of requiring a manual workspace root argument, so running `node .agent/skills/kanban_operations/get-state.js` just works.

## Metadata
**Tags:** infrastructure, workflow, devops, testing
**Complexity:** 5

## User Review Required
- [ ] Confirm whether the skill should aggregate results across all discovered workspaces or default to the first/primary workspace.
- [ ] Confirm whether the skill should output results per-workspace or merge all plans into a single view.

## Complexity Audit

### Routine
- **Read environment variables:** Check `SWITCHBOARD_WORKSPACE_ROOT` and `SWITCHBOARD_STATE_ROOT` env vars first — these are already the primary discovery mechanism used by `register-tools.js` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/mcp-server/register-tools.js:274-284`).
- **Read VS Code settings.json:** Parse `.vscode/settings.json` for `switchboard.workspaceDatabaseMappings` — actual schema is `{ enabled: boolean, mappings: [{ id, name, dbPath, workspaceFolders: string[] }] }` (NOT a flat array with `parentFolder` keys as previously drafted).
- **Fallback to current directory:** If no env vars or mappings are found, use `process.cwd()` as the default root.
- **Aggregate results:** Iterate over discovered roots, call `KanbanDatabase.forWorkspace()` for each, and collect plan data.
- **Update get-state.js entry point:** Modify `@/Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/kanban_operations/get-state.js:3` to use auto-discovery.
- **Update move-card.js entry point:** Modify `@/Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/kanban_operations/move-card.js` to also use auto-discovery for workspace root resolution.
- **Handle missing databases gracefully:** Wrap `KanbanDatabase.forWorkspace()` and `ensureReady()` in try/catch; log warning to stderr and skip that workspace if DB is missing.

### Complex / Risky
- **Settings.json schema mismatch:** The original proposed code assumed `workspaceDatabaseMappings` was a flat array with `parentFolder` keys — the actual schema (`@/Users/patrickvuleta/Documents/GitHub/switchboard/.vscode/settings.json:40-52`) is `{ enabled: boolean, mappings: [{ id, name, dbPath, workspaceFolders }] }`. Must parse correctly or discovery silently fails.
- **Multi-workspace output format:** Aggregating results across workspaces changes the JSON structure; callers of the skill may expect a single-workspace result. Decision: **Option A** — keyed by workspace root, wrapped in `{ workspaces: { [root]: result } }`. This preserves workspace attribution and avoids session ID collisions across workspaces.
- **CLI vs extension context:** The skill is a Node script run from CLI, not inside the VS Code extension host, so `vscode.workspace.workspaceFolders` is not available. Must read workspace configuration from files and env vars only.
- **KanbanDatabase import path:** The skill imports from `../../../out/services/KanbanDatabase` which requires a prior compile step. If `out/` doesn't exist, the script crashes with `MODULE_NOT_FOUND`. No fallback is available — this is a pre-existing constraint, not introduced by this plan.

## Edge-Case & Dependency Audit

**Race Conditions:**
- None expected for read-only skill execution.

**Security:**
- Ensure resolved workspace roots are within the repository or allowed paths to avoid reading arbitrary directories.
- Do not expose sensitive database contents in console output beyond plan metadata.

**Side Effects:**
- Skill output will now include results from multiple workspaces if configured, potentially larger JSON payloads.
- Default behavior changes from single-workspace to multi-workspace unless a primary workspace heuristic is added.
- `move-card.js` behavior changes: currently requires explicit workspace root; after change, will auto-discover but still accept override.

**Dependencies & Conflicts:**
- Active Kanban board query returned no cards in CREATED or PLAN REVIEWED columns that conflict with this plan.
- No related plans currently target the kanban_operations skill.
- The `workspaceDatabaseMappings` setting currently has `enabled: false` — discovery must handle this gracefully (skip mappings when disabled, fall through to env vars / cwd).

## Dependencies
- None

## Adversarial Synthesis
Key risks: The settings.json parsing must match the actual `{ enabled, mappings }` schema or auto-discovery silently degrades to cwd fallback; `move-card.js` must be updated alongside `get-state.js` to avoid half-fixed behavior; multi-workspace output format (Option A) changes caller expectations. Mitigations: Parse the real schema correctly, update both entry points, maintain backward compatibility via explicit argument override, and clearly document the new output format.

## Problem

The `kanban_operations` skill requires passing a workspace root path as the first argument:
```bash
node .agent/skills/kanban_operations/get-state.js /path/to/workspace
```

This is cumbersome because:
- Users must know the exact workspace root path
- In multi-root workspaces, users must guess which root to use
- The skill should "just work" without manual configuration

## Proposed Changes

### Execution Breakdown by Complexity

#### Low Complexity Steps

1. **Add workspace root discovery helper**
   - **File:** `.agent/skills/kanban_operations/lib/workspaceDiscovery.js` (new file)
   - **Implementation:** Implement `discoverWorkspaceRoots()` with a 3-tier discovery chain:
     1. **Tier 1 — Environment variables:** Check `process.env.SWITCHBOARD_WORKSPACE_ROOT`. If set, use it as the primary root. Also check `SWITCHBOARD_STATE_ROOT` for the state directory path.
     2. **Tier 2 — VS Code settings.json:** Read `.vscode/settings.json` (relative to `process.cwd()`). Parse `switchboard.workspaceDatabaseMappings`. **Critical:** The actual schema is `{ enabled: boolean, mappings: [{ id: string, name: string, dbPath: string, workspaceFolders: string[] }] }`. Only extract roots when `enabled === true`. For each mapping, add all `workspaceFolders` entries as absolute paths.
     3. **Tier 3 — cwd fallback:** If no env vars and no enabled mappings, use `process.cwd()`.
   - De-duplicate all resolved paths using a `Set`.

2. **Update get-state.js to use auto-discovery**
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/kanban_operations/get-state.js:3`
   - **Implementation:** Replace `const workspaceRoot = process.argv[2] || '.';` with:
     - Call `discoverWorkspaceRoots()` to get all roots
     - If `process.argv[2]` is provided, use it as an override (backward compatibility)
     - Otherwise, iterate over all discovered roots
   - Add `const path = require('path');` import at top.

3. **Update move-card.js to use auto-discovery**
   - **File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/kanban_operations/move-card.js`
   - **Implementation:** Same pattern as get-state.js — import `discoverWorkspaceRoots`, use explicit argument override or auto-discovered root. For move-card, only a single workspace root is needed (the one containing the target plan), so use the first discovered root or the explicit override.

4. **Aggregate results across workspaces (get-state.js only)**
   - **File:** `.agent/skills/kanban_operations/get-state.js`
   - **Implementation:** Build an output object keyed by workspace root, containing the columns for each workspace. Use **Option A** format: `{ timestamp, workspaces: { [root]: { workspaceId, timestamp, columns } } }`.

5. **Handle missing databases gracefully**
   - **File:** `.agent/skills/kanban_operations/get-state.js`
   - **Implementation:** Wrap `KanbanDatabase.forWorkspace()` and `ensureReady()` in try/catch; log a warning to stderr and skip that workspace if the DB is missing or fails to initialize. Do not include error workspaces in the output JSON — only log to stderr.

6. **Add tests for discovery logic**
   - **File:** `.agent/skills/kanban_operations/__tests__/workspaceDiscovery.test.js` (new file)
   - **Implementation:** Test discovery with:
     - No configuration (falls back to cwd)
     - `SWITCHBOARD_WORKSPACE_ROOT` env var set
     - `workspaceDatabaseMappings` present with `enabled: true`
     - `workspaceDatabaseMappings` present with `enabled: false` (should skip mappings)
     - Multi-root workspace folder parsing

#### High Complexity Steps

1. **Preserve backward compatibility**
   - **File:** `.agent/skills/kanban_operations/get-state.js`
   - **Implementation:** If `process.argv[2]` is provided, use it as a single-workspace override and output the **original single-workspace JSON structure** (`{ workspaceId, timestamp, columns }`). If no argument, output the new multi-workspace structure (`{ timestamp, workspaces: { ... } }`). This ensures existing callers (e.g., workflow scripts that pipe the output) continue to work unchanged.

2. **Output format decision — Option A (resolved)**
   - **Decision:** Use Option A: `{ workspaceId, timestamp, columns }` per workspace, wrapped in `{ timestamp, workspaces: { [root]: result } }`.
   - **Rationale:** Option B (merge all plans into single columns) would lose workspace attribution and risk session ID collisions across workspaces. Option A is the only safe choice for multi-repo setups.

3. **Handle VS Code workspace folder reading in CLI context**
   - **File:** `.agent/skills/kanban_operations/lib/workspaceDiscovery.js`
   - **Implementation:** Since `vscode` API is not available in CLI, read workspace configuration from:
     - `process.env.SWITCHBOARD_WORKSPACE_ROOT` (primary — same mechanism used by MCP server)
     - `.vscode/settings.json` → `switchboard.workspaceDatabaseMappings.mappings[].workspaceFolders` (secondary)
     - `process.cwd()` (tertiary fallback)
   - **Risk:** Heuristic-based discovery may miss workspaces in non-standard layouts. Mitigated by env var being the primary path (MCP server always sets it).

### Proposed Code Changes

#### New File: `.agent/skills/kanban_operations/lib/workspaceDiscovery.js`

```javascript
const path = require('path');
const fs = require('fs');

/**
 * Auto-discover workspace roots using a 3-tier strategy:
 * 1. SWITCHBOARD_WORKSPACE_ROOT env var (primary — same as MCP server)
 * 2. .vscode/settings.json → switchboard.workspaceDatabaseMappings (secondary)
 * 3. process.cwd() (tertiary fallback)
 */
function discoverWorkspaceRoots() {
    const roots = new Set();

    // Tier 1: Environment variables (primary)
    const envRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT;
    if (envRoot && envRoot.trim()) {
        roots.add(path.resolve(envRoot.trim()));
    }

    // Tier 2: VS Code settings.json (secondary)
    const settingsPath = path.join(process.cwd(), '.vscode', 'settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const dbMappings = settings['switchboard.workspaceDatabaseMappings'];
            // Actual schema: { enabled: boolean, mappings: [{ id, name, dbPath, workspaceFolders }] }
            if (dbMappings && typeof dbMappings === 'object' && dbMappings.enabled === true) {
                const mappings = dbMappings.mappings;
                if (Array.isArray(mappings)) {
                    for (const mapping of mappings) {
                        if (Array.isArray(mapping.workspaceFolders)) {
                            for (const folder of mapping.workspaceFolders) {
                                if (typeof folder === 'string' && folder.trim()) {
                                    roots.add(path.resolve(folder));
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[workspaceDiscovery] Failed to parse .vscode/settings.json:', err.message);
        }
    }

    // Tier 3: cwd fallback
    if (roots.size === 0) {
        roots.add(process.cwd());
    }

    return Array.from(roots);
}

module.exports = { discoverWorkspaceRoots };
```

#### Modified File: `.agent/skills/kanban_operations/get-state.js`

```javascript
const path = require('path');
const { KanbanDatabase, VALID_KANBAN_COLUMNS } = require('../../../out/services/KanbanDatabase');
const { discoverWorkspaceRoots } = require('./lib/workspaceDiscovery');

// Backward compatibility: if argument provided, use single workspace mode
const explicitRoot = process.argv[2];
const workspaceRoots = explicitRoot ? [path.resolve(explicitRoot)] : discoverWorkspaceRoots();

const results = {};

Promise.all(workspaceRoots.map(async (workspaceRoot) => {
    try {
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.ensureReady();
        const workspaceId = await db.getWorkspaceId() || workspaceRoot;
        const columns = {};
        const columnNames = Array.from(VALID_KANBAN_COLUMNS);

        for (const col of columnNames) {
            columns[col] = await db.getPlansByColumn(workspaceId, col);
        }

        results[workspaceRoot] = {
            workspaceId,
            timestamp: new Date().toISOString(),
            columns
        };

        if (typeof db.close === 'function') db.close();
    } catch (err) {
        console.error(`[get-state] Failed for workspace ${workspaceRoot}:`, err.message);
        // Do not include error entries in output — only log to stderr
    }
})).then(() => {
    // Single-workspace mode: output the old format for backward compatibility
    if (explicitRoot) {
        const singleResult = results[Object.keys(results)[0]];
        if (singleResult && !singleResult.error) {
            console.log(JSON.stringify(singleResult, null, 2));
        } else {
            console.error(JSON.stringify(singleResult, null, 2));
            process.exit(1);
        }
    } else {
        // Multi-workspace mode: output all results (Option A format)
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            workspaces: results
        }, null, 2));
    }
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
```

#### Modified File: `.agent/skills/kanban_operations/move-card.js`

- Import `discoverWorkspaceRoots` from `./lib/workspaceDiscovery`
- Replace hardcoded `process.argv[2]` workspace root with auto-discovery
- Keep `process.argv[2]` as override for backward compatibility
- Use first discovered root as the target workspace (move-card operates on a single workspace)

## Verification Plan

### Automated Tests
- [ ] `workspaceDiscovery.test.js`: Test discovery with no config, with env var, with `workspaceDatabaseMappings` enabled, with `workspaceDatabaseMappings` disabled, with multi-root folders.
- [ ] Integration test: Run `node .agent/skills/kanban_operations/get-state.js` in a workspace with no arguments, verify it outputs results for the current directory.
- [ ] Integration test: Run with an explicit argument, verify backward-compatible single-workspace output.
- [ ] Integration test: Run `node .agent/skills/kanban_operations/move-card.js` with no workspace argument, verify it auto-discovers the root.

### Manual Verification
- [ ] Run `node .agent/skills/kanban_operations/get-state.js` in the switchboard repo, verify it outputs results without arguments.
- [ ] Run with an explicit workspace path, verify it uses that path and outputs the old format.
- [ ] Run in a multi-root workspace with `workspaceDatabaseMappings.enabled: true`, verify it discovers all mapped folders and aggregates results.
- [ ] Run with `SWITCHBOARD_WORKSPACE_ROOT` env var set, verify it uses that path.
- [ ] Run `move-card.js` without arguments, verify it auto-discovers and operates on the correct workspace.

## Recommendation

**Send to Coder** — Complexity 5. The changes are localized to the skill scripts, involve straightforward file-based configuration reading, and maintain backward compatibility. The settings.json schema fix and move-card.js coverage add moderate scope but no architectural risk.

---

## Reviewer Pass

### Stage 1: Grumpy Review
*   **[MAJOR] Missing Env Var Coverage:** You completely forgot to include `SWITCHBOARD_STATE_ROOT` in the environment variable checks for Tier 1! If a user hasn't set `WORKSPACE_ROOT` but *has* set `STATE_ROOT`, your discovery drops straight to Tier 2. Unacceptable gap in the discovery chain. I had to step in and fix this.
*   **[NIT] UX Hostility Maintained:** `move-card.js` still forces the user to pass an empty string `""` as the fourth argument just to supply the workspace root as the fifth. It's ugly, but it was documented as a legacy backward-compatibility requirement, so I'll let it slide.

### Stage 2: Balanced Synthesis
*   **Keep:** The 3-tier discovery strategy is robust, parsing `.vscode/settings.json` exactly according to the weird `switchboard.workspaceDatabaseMappings` schema.
*   **Keep:** Backward compatibility via explicit arguments works cleanly and `get-state.js` formats Option A gracefully.
*   **Fix Now:** Added `SWITCHBOARD_STATE_ROOT` to the environment variable tier in `workspaceDiscovery.js`.

### Action Taken
*   **Code Fixes Applied:** Updated `.agent/skills/kanban_operations/lib/workspaceDiscovery.js` to parse and resolve `SWITCHBOARD_STATE_ROOT` if it exists.
*   **Verification:** Executed `get-state.js` and `move-card.js` to confirm correct state resolution and database mutation without manual arguments.
*   **Compilation:** `npm run compile` passed successfully.
