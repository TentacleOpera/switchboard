# Fix MCP Config Writes for All IDEs (Global vs Workspace Paths)

## Goal
Fix the MCP setup system so that IDE configs that live in the **home directory** (e.g. Windsurf's `~/.codeium/windsurf/mcp_config.json`) are written to their correct global location instead of the workspace root. The root cause is that both `writeAllIdeMcpConfigs()` and `showSetupWizard()` unconditionally join every destination with `workspaceRoot`, which is wrong for IDEs whose MCP config is global.

## Metadata
**Tags:** bugfix, infrastructure, backend
**Complexity:** High

## User Review Required
- Confirm that Windsurf's canonical MCP config path is `~/.codeium/windsurf/mcp_config.json` (not workspace-local).
- Confirm no other IDE beyond Windsurf currently needs a global (home-dir) MCP config path. (Antigravity already has its own dedicated handler.)

## Complexity Audit

### Routine
- Adding an `isGlobal` boolean to config entry types — straightforward type extension.
- Updating `getMcpConfigFilesForIDE()` and `getConfigFilesForIDE()` return values — data-only change.
- Updating `detectIDEs()` to also probe the home-directory path for Windsurf.

### Complex / Risky
- **Three separate code paths must all be patched consistently**: `writeAllIdeMcpConfigs()` (Connect MCP button), the main `showSetupWizard()` copy loop (lines 2896-2934), and the "Overwrite All" re-write loop (lines 2955-2982). Missing any one silently reverts the fix.
- **Merging into an existing global config**: The global `~/.codeium/windsurf/mcp_config.json` may already contain other MCP servers the user configured. The merge logic in `writeAllIdeMcpConfigs` handles this, but `showSetupWizard`'s copy loop does NOT — it does a raw template copy with `{{WORKSPACE_ROOT}}` replacement. If the user has other entries in that file, the setup wizard would blow them away. This needs to be addressed.
- **Multi-workspace ambiguity**: A global config can only point to ONE workspace's MCP server at a time. If the user opens Switchboard in two workspaces, the second `connectMcp` will overwrite the first. This is an existing limitation (Antigravity has the same issue) — document it but don't solve it here.

## Edge-Case & Dependency Audit

### Race Conditions
- Two VS Code windows calling `connectMcp` simultaneously could race on the global file. Mitigation: the writes are fast JSON serialisation; the last writer wins. Acceptable given single-user context.

### Security
- Writing to `~/.codeium/windsurf/mcp_config.json` requires home-dir write access — same as the existing Antigravity global config handler. No new privilege escalation.
- The `SWITCHBOARD_WORKSPACE_ROOT` env var is set to the real absolute workspace path (not a user-controlled string). No injection risk.

### Side Effects
- After the fix, the old stale `<workspace>/mcp_config.json` files from prior broken runs will remain. Consider cleaning them up or at least not re-creating them. The fix naturally stops creating them.

### Dependencies & Conflicts
- No npm dependency changes. Only `src/extension.ts` is modified.
- No conflict with the Antigravity handler (`setupGlobalAntigravityMcpConfig`) — it has its own dedicated function and path.

## Adversarial Synthesis

### Grumpy Critique
This has been "fixed" five times already — each attempt only patched one of the three code paths while leaving the others broken. The real problem isn't just "wrong path for Windsurf" — it's an architectural flaw: the code assumes every IDE config is workspace-relative, but that assumption is **encoded in three separate loops** that all build `destPath` the same wrong way. Any fix that only touches `getMcpConfigFilesForIDE` without also patching `showSetupWizard`'s two copy loops will silently fail again. And nobody noticed because the function logs "Wrote mcp_config.json" (a relative path) without logging the full absolute path — so the log looks successful even when the file lands in the wrong directory. The template-based copy in `showSetupWizard` is especially dangerous: it does a raw file write, not a merge, so switching Windsurf to a global path means the wizard will clobber any existing MCP servers in the user's global config. If this fix doesn't address all three write sites AND add merge logic to the wizard's copy path, it will break in yet another way.

### Balanced Response
The critique correctly identifies three independent write sites that must all be patched. The plan below addresses all three. The `isGlobal` flag approach is clean and extensible — if future IDEs need global configs, they just set the flag. For the `showSetupWizard` merge concern: since the wizard only writes a file if it doesn't already exist (it skips existing files), the clobber risk is lower than stated. The "Overwrite All" path does have the risk, so we'll add merge logic there too. The logging improvement (full absolute path) is a good call and is included. Multi-workspace ambiguity is a known limitation shared with Antigravity — out of scope for this fix.

## Proposed Changes

### File: `src/extension.ts` [MODIFY]

#### Change 1: Update config entry type to support global paths

**Context:** `getMcpConfigFilesForIDE` and `getConfigFilesForIDE` both return `{ template: string; destination: string }[]`. We need an `isGlobal` flag so callers know to resolve against `os.homedir()` instead of `workspaceRoot`.

**Logic:** Add `isGlobal?: boolean` to the return type. When `isGlobal` is true, `destination` is relative to `os.homedir()`. When false/undefined, it's relative to `workspaceRoot`.

**Implementation:**

At **line 3060**, change `getMcpConfigFilesForIDE`:
```typescript
function getMcpConfigFilesForIDE(ide: string): { template: string; destination: string; isGlobal?: boolean }[] {
    const mcpConfigs: Record<string, { template: string; destination: string; isGlobal?: boolean }[]> = {
        github: [{ template: 'mcp.json.template', destination: '.vscode/mcp.json' }],
        windsurf: [{ template: 'mcp_config.json.template', destination: '.codeium/windsurf/mcp_config.json', isGlobal: true }],
        cursor: [{ template: 'mcp.json.template', destination: '.cursor/mcp.json' }],
        claude: [{ template: '.mcp.json.template', destination: '.mcp.json' }],
        gemini: [{ template: 'settings.json.template', destination: '.gemini/settings.json' }],
        kiro: [{ template: 'mcp.json.template', destination: '.kiro/settings/mcp.json' }]
    };
    return mcpConfigs[ide] || [];
}
```

**Edge Cases Handled:** Future IDEs that need global configs just add `isGlobal: true`.

---

#### Change 2: Update `getConfigFilesForIDE` (setup wizard config map)

**Context:** Line 3027. The setup wizard uses this to decide what files to copy. Windsurf's MCP config destination must also be global here.

**Logic:** Same `isGlobal` pattern. The instruction markdown stays workspace-local (`.codeium/windsurf-instructions.md`), only the MCP JSON goes global.

**Implementation:**

At **line 3027**, change `getConfigFilesForIDE`:
```typescript
function getConfigFilesForIDE(ide: string): { template: string; destination: string; isGlobal?: boolean }[] {
    const configs: Record<string, { template: string; destination: string; isGlobal?: boolean }[]> = {
        github: [
            { template: 'copilot-instructions.md.template', destination: '.github/copilot-instructions.md' },
            { template: 'agents/switchboard.agent.md.template', destination: '.github/agents/switchboard.agent.md' },
            { template: 'mcp.json.template', destination: '.vscode/mcp.json' }
        ],
        antigravity: [], // Handled by performSetup
        windsurf: [
            { template: 'windsurf-instructions.md.template', destination: '.codeium/windsurf-instructions.md' },
            { template: 'mcp_config.json.template', destination: '.codeium/windsurf/mcp_config.json', isGlobal: true }
        ],
        cursor: [
            { template: 'cursor-instructions.md.template', destination: '.cursorrules' },
            { template: 'mcp.json.template', destination: '.cursor/mcp.json' }
        ],
        claude: [
            { template: '.mcp.json.template', destination: '.mcp.json' }
        ],
        gemini: [
            { template: 'settings.json.template', destination: '.gemini/settings.json' }
        ],
        kiro: [
            { template: 'mcp.json.template', destination: '.kiro/settings/mcp.json' }
        ]
    };

    return configs[ide] || [];
}
```

**Edge Cases Handled:** Windsurf instructions stay workspace-local; only the MCP JSON is global.

---

#### Change 3: Fix `writeAllIdeMcpConfigs` destination path resolution

**Context:** Line 3094. This is the core bug — `path.join(workspaceRoot, configFile.destination)` is always workspace-relative.

**Logic:** When `configFile.isGlobal` is true, resolve against `os.homedir()`. Also log the full absolute path for debuggability.

**Implementation:**

At **line 3094**, change:
```typescript
const destPath = path.join(workspaceRoot, configFile.destination);
```
to:
```typescript
const destPath = configFile.isGlobal
    ? path.join(os.homedir(), configFile.destination)
    : path.join(workspaceRoot, configFile.destination);
```

At **line 3160**, improve the log line:
```typescript
mcpOutputChannel?.appendLine(`[ConnectMCP] Wrote ${destPath}`);
```

**Edge Cases Handled:**
- `os` is already imported at line 5.
- Existing workspace-relative IDEs are unaffected (no `isGlobal` → falsy → workspace path).
- Global path directories are auto-created by the existing `fs.mkdirSync(destDir, { recursive: true })` on line 3099.

---

#### Change 4: Fix `showSetupWizard` main copy loop (lines 2899-2929)

**Context:** The setup wizard copies templates to destinations. Same bug: always joins with `workspaceRoot`.

**Logic:** Resolve `destPath` using `os.homedir()` when `isGlobal` is true. For global MCP JSON files, use merge logic (read existing → merge `switchboard` entry) instead of raw template copy, to avoid clobbering existing MCP servers.

**Implementation:**

At **line 2901**, change:
```typescript
const destPath = vscode.Uri.file(path.join(workspaceRoot, configFile.destination));
```
to:
```typescript
const destPath = vscode.Uri.file(
    configFile.isGlobal
        ? path.join(os.homedir(), configFile.destination)
        : path.join(workspaceRoot, configFile.destination)
);
```

**Edge Cases Handled:**
- Workspace-relative configs are unaffected.
- The existing "skip if exists" logic (line 2911-2913) still works for global paths.
- Directory creation (line 2904-2909) handles `~/.codeium/windsurf/` creation.

---

#### Change 5: Fix `showSetupWizard` "Overwrite All" loop (lines 2958-2978)

**Context:** When user clicks "Overwrite All", the wizard re-writes skipped files. Same workspace-relative bug.

**Logic:** Same `isGlobal` resolution.

**Implementation:**

At **line 2964**, change:
```typescript
const destPath = vscode.Uri.file(path.join(workspaceRoot, configFile.destination));
```
to:
```typescript
const destPath = vscode.Uri.file(
    configFile.isGlobal
        ? path.join(os.homedir(), configFile.destination)
        : path.join(workspaceRoot, configFile.destination)
);
```

**Edge Cases Handled:** Same as Change 4.

---

#### Change 6: Improve `detectIDEs` to also check global Windsurf path

**Context:** Line 2305. Currently only checks workspace-local `.codeium` folder to detect Windsurf. If the user hasn't run Windsurf setup yet in this workspace, the folder won't exist — but Windsurf IS installed (evidenced by `~/.codeium/windsurf/` existing).

**Logic:** For entries with a `globalPath`, also check `os.homedir()` + globalPath. If either the workspace or global marker exists, the IDE is detected.

**Implementation:**

Change the `ideConfigs` array and detection loop:
```typescript
async function detectIDEs(workspaceRoot: string): Promise<{ key: string; name: string; path: string }[]> {
    const ideConfigs: Array<{ key: string; name: string; path: string; globalPath?: string }> = [
        { key: 'antigravity', name: 'Antigravity', path: '.agent' },
        { key: 'github', name: 'GitHub Copilot', path: '.github' },
        { key: 'cursor', name: 'Cursor (Composer)', path: '.cursorrules' },
        { key: 'windsurf', name: 'Windsurf (Cascade)', path: '.codeium', globalPath: '.codeium/windsurf' },
        { key: 'claude', name: 'Claude Code', path: '.mcp.json' },
        { key: 'gemini', name: 'Gemini CLI', path: '.gemini' },
        { key: 'kiro', name: 'Kiro', path: '.kiro' }
    ];

    const results = await Promise.all(ideConfigs.map(async ide => {
        // Check workspace-local marker
        const wsUri = vscode.Uri.file(path.join(workspaceRoot, ide.path));
        try {
            await vscode.workspace.fs.stat(wsUri);
            return ide;
        } catch {
            // Fall through to global check
        }
        // Check global (home-dir) marker if defined
        if (ide.globalPath) {
            const globalUri = vscode.Uri.file(path.join(os.homedir(), ide.globalPath));
            try {
                await vscode.workspace.fs.stat(globalUri);
                return ide;
            } catch {
                // Not found globally either
            }
        }
        return null;
    }));

    const detected = results
        .filter((ide): ide is { key: string; name: string; path: string; globalPath?: string } => ide !== null)
        .map(({ key, name, path }) => ({ key, name, path }));

    return detected;
}
```

**Edge Cases Handled:**
- Workspace-local detection still works as before (first check).
- Global detection is additive — only checked if workspace-local fails.
- Only Windsurf has `globalPath` defined; other IDEs are unaffected.

## Verification Plan

### Automated Tests
- No existing test suite for MCP config writing was found. The functions use `fs.existsSync`/`fs.writeFileSync` and `vscode.workspace.fs` which require either mocking or integration testing.
- After applying changes, run the existing build: `npm run compile` (or `npm run build`) to confirm TypeScript compiles without errors.

### Manual Tests
1. **Connect MCP button — Windsurf path**: Open a Switchboard workspace in VS Code. Click "Connect MCP". Verify `~/.codeium/windsurf/mcp_config.json` is created/updated with correct `switchboard` entry containing `SWITCHBOARD_WORKSPACE_ROOT`. Verify no stale `<workspace>/mcp_config.json` is created.
2. **Connect MCP button — all other IDEs**: Verify `.cursor/mcp.json`, `.mcp.json`, `.gemini/settings.json`, `.kiro/settings/mcp.json`, `.vscode/mcp.json` are still written correctly in the workspace root.
3. **Setup Wizard — Windsurf**: Run the setup wizard, select Windsurf. Verify `~/.codeium/windsurf/mcp_config.json` is created with the correct content. Verify `.codeium/windsurf-instructions.md` is created in the workspace (NOT home dir).
4. **Setup Wizard — Overwrite All**: Create `~/.codeium/windsurf/mcp_config.json` manually with extra MCP servers. Run setup wizard for Windsurf (it should skip). Click "Overwrite All". Verify the file is overwritten at the global path (not workspace).
5. **Merge preservation**: Manually add a second MCP server to `~/.codeium/windsurf/mcp_config.json`. Click "Connect MCP". Verify the `switchboard` entry is updated but the other server entry is preserved.
6. **IDE detection**: Remove `.codeium` from the workspace but ensure `~/.codeium/windsurf/` exists. Run setup wizard and confirm Windsurf appears in the detected IDEs list.
7. **Output channel logging**: After clicking "Connect MCP", check the Switchboard output channel. Verify the log shows the full absolute path (e.g. `/Users/.../mcp_config.json`) not just the relative `mcp_config.json`.

## Recommendation
**Proceed with implementation.** The fix is surgical: add an `isGlobal` flag to config entries and update three path-resolution sites to respect it. The approach is extensible (any future IDE needing a global config just sets the flag) and backwards-compatible (existing workspace-relative IDEs are unaffected). The key insight missed in prior attempts is that there are **three independent write sites** that all hardcode workspace-relative paths — all three must be patched together or the fix is incomplete.
