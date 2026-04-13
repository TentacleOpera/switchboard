# Fix: sql-wasm.js Missing from MCP Server Bundle

## Status
COMPLETED — shipped in v1.5.5

---

## Problem

Users activating the Switchboard MCP with Claude Code (or any non-Windsurf client) received the following error on every tool call:

```
Error: Switchboard workspace could not be initialized. Unable to locate sql-wasm.js. Checked:
  /Users/.../viaapp/.switchboard/sql-wasm.js,
  /Users/.../viaapp/sql-wasm.js,
  /Users/.../viaapp/dist/sql-wasm.js,
  /Users/.../viaapp/node_modules/sql.js/dist/sql-wasm.js,
  ...

Try calling the init_workspace tool, then retry.
```

The MCP server was running (responding with structured errors, not "command not found"), but the `sql-wasm.js` / `sql-wasm.wasm` WebAssembly assets needed to load the SQLite kanban DB were absent from the deployed directory.

---

## Root Cause

The webpack build has two configs in `webpack.config.js`:

| Config | Output | CopyPlugin? |
|---|---|---|
| `extensionConfig` | `dist/` | ✅ copies `sql-wasm.js` + `sql-wasm.wasm` |
| `mcpServerConfig` | `dist/mcp-server/` | ❌ missing — no CopyPlugin |

When the VS Code extension runs `ensureWorkspaceMcpServerFiles()`, it copies `dist/mcp-server/` → `{workspace}/.switchboard/MCP/`. Because the WASM files were never in `dist/mcp-server/`, they were never copied to the user's workspace.

**Secondary issue**: `resolveSqlJsModulePath()` in `register-tools.js` never tried `path.join(__dirname, 'sql-wasm.js')` (i.e., the same directory as `mcp-server.js`). The first candidate was `path.join(__dirname, '..', 'sql-wasm.js')` — one level up — which also doesn't exist.

**Misleading error hint**: The error message says "Try calling the `init_workspace` tool". That tool creates the kanban DB schema — it does not install or copy WASM assets. The hint is wrong and should be updated separately.

---

## Files Changed

### `webpack.config.js`
Added `CopyPlugin` to `mcpServerConfig` so `sql-wasm.js` and `sql-wasm.wasm` are emitted into `dist/mcp-server/` alongside `mcp-server.js`:

```js
plugins: [
    new CopyPlugin({
        patterns: [
            {
                from: path.resolve(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
                to: 'sql-wasm.js'
            },
            {
                from: path.resolve(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
                to: 'sql-wasm.wasm'
            }
        ]
    })
],
```

### `src/mcp-server/register-tools.js`
Prepended `path.join(__dirname, 'sql-wasm.js')` and `path.join(__dirname, 'sql-wasm.wasm')` as the **first** candidate in both `resolveSqlJsModulePath()` and `resolveSqlWasmPath()`:

```js
// Before:
const candidates = [
    path.join(__dirname, '..', 'sql-wasm.js'),
    ...

// After:
const candidates = [
    path.join(__dirname, 'sql-wasm.js'),       // ← same dir as mcp-server.js (new)
    path.join(__dirname, '..', 'sql-wasm.js'),
    ...
```

### `package.json`
Version bumped: `1.5.4` → `1.5.5`

---

## Verification

Build output confirmed both WASM assets emitted into `dist/mcp-server/`:

```
asset mcp-server.js 694 KiB [emitted]
asset sql-wasm.wasm 644 KiB [emitted] [from: node_modules/sql.js/dist/sql-wasm.wasm] [copied]
asset sql-wasm.js 39.8 KiB [emitted] [from: node_modules/sql.js/dist/sql-wasm.js] [copied]
```

VSIX packaged successfully: `switchboard-1.5.5.vsix` (114 files, 2.85MB)

---

## Workaround (for users on v1.5.4 or earlier)

```bash
npm install sql.js
```

Run in the project root. This drops `sql-wasm.js` at `node_modules/sql.js/dist/sql-wasm.js`, which is already in the server's candidate list.

---

## Remaining Issues (not in scope for this fix)

- The `init_workspace` error hint is misleading — it implies that tool fixes the WASM issue, but it only initialises the DB schema. Should be updated to say something like "This is a setup defect — reinstall the Switchboard extension or run `npm install sql.js` in your project root."

## Direct Reviewer Pass — 2026-04-13

### Findings addressed

- **MAJOR — Misleading remediation remained in shipped MCP error handling.** The bundled/runtime asset fix was correct, but the user-facing recovery text still told users to run `init_workspace` for missing `sql-wasm` assets. That advice was false and would have sent future failures down the wrong path.

### Fixed items

- Updated `src/mcp-server/register-tools.js` so missing `sql-wasm.wasm` failures include the full candidate search list, matching the existing `sql-wasm.js` diagnostic quality.
- Replaced the incorrect `init_workspace` retry hint with contextual remediation that correctly identifies missing `sql.js` runtime assets and points users to reinstall/update the extension or install `sql.js` in the workspace when appropriate.

### Files changed in reviewer pass

- `src/mcp-server/register-tools.js`
- `.switchboard/plans/fix_sql_wasm_missing_from_mcp_bundle.md`

### Validation results

- `npm run compile` — success; `dist/mcp-server/` emitted `mcp-server.js`, `sql-wasm.js`, and `sql-wasm.wasm`.
- `npm run compile-tests` — success.
- `switchboard-1.5.5.vsix` currently contains `extension/dist/mcp-server/sql-wasm.js` and `extension/dist/mcp-server/sql-wasm.wasm`.

### Remaining risks

- Existing user workspaces or extension installs that already contain a stale `.switchboard/MCP` runtime will still need that runtime refreshed; the improved error message now points to the correct remediation, but it cannot repair an already-broken external installation on its own.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-13T22:49:23.416Z
**Format Version:** 1
