# Remove All MCP Server References

## Goal
Completely remove the Switchboard MCP server and all related code, configuration, documentation, and test references from the codebase. The MCP server is no longer used — workflows execute via IDE chat commands, and API operations use skill-based LocalApiServer invocations.

## Metadata
- **Tags:** [infrastructure, documentation, workflow]
- **Complexity:** 7

## User Review Required
- Confirm that no external agents or workflows depend on the MCP server
- Confirm that the `handleMcpMove` dispatch path in KanbanProvider is not used by any external integrations
- Confirm that removing MCP config files (.vscode/mcp.json, .cursor/mcp.json, etc.) is acceptable — these are currently committed to the repo
- Confirm that the `hasSwitchboardProtocolFiles`, `hasSwitchboardConfigs`, and `setupProtocolFilesSilent` functions should be modified (not deleted) since they check for `.agent/workflows` which is NOT MCP-specific

## Complexity Audit

### Routine
- Delete MCP configuration files (.vscode/mcp.json, .cursor/mcp.json, .mcp.json, .kiro/settings/mcp.json, .gemini/settings.json)
- Remove MCP status indicator from implementation.html
- Remove MCP buttons from setup.html
- Delete entire src/mcp-server/ directory
- Delete MCP-specific test files
- Remove MCP comments from DiagramRenderer.ts
- Remove 'mcp' from allowed tags in planMetadataUtils.ts
- Remove MCP-related ignore patterns from .gitignore
- Remove MCP keyword from package.json

### Complex / Risky
- **extension.ts**: Very large file (~4700 lines) with 25+ MCP-related functions, 5 command registrations, global variables, health check logic, IPC handling, lifecycle management, and deactivate() cleanup. Must carefully remove all MCP code without breaking non-MCP extension functionality. Key risk: orphaned references to deleted functions will crash at runtime.
- **KanbanProvider.ts**: The `handleMcpMove` method and 4 related MCP target resolution functions (plus the `McpMoveTargetResolution` type) are used for VS Code UI-driven card movement. Must verify this is only called from the MCP command (which is being removed) and not from other dispatch paths.
- **TaskViewerProvider.ts**: Has 4 private MCP state fields, 3 webview message handlers, initial state message fields, and an `mcp-agent` pattern in ORPHAN_PATTERNS. All must be removed consistently or the webview will send messages into the void.
- **ControlPlaneMigrationService.ts**: MCP directory copying logic is part of the migration service. Need to remove this without breaking other migration functionality.
- **Shared functions**: `hasSwitchboardProtocolFiles()`, `hasSwitchboardConfigs()`, and `setupProtocolFilesSilent()` check for `.agent/workflows` and `.switchboard` directories — these are NOT MCP-specific. Must modify to remove MCP-specific checks (e.g., `hasWorkspaceMcpRuntime` call inside `hasSwitchboardConfigs`) rather than deleting entirely.
- **webpack.config.js**: The entire `mcpServerConfig` object (lines 83-132) and its inclusion in `module.exports` must be precisely removed. Removing this changes the build output.
- **Documentation updates**: 10+ documentation files with 80+ MCP references. Need to update README, TECHNICAL_DOC, SECURITY-AUDIT, and other docs to reflect the new architecture without leaving stale references.

## Edge-Case & Dependency Audit

- **Race Conditions**: None. This is a removal operation, not a runtime change.
- **Security**: No new attack surface. Removing MCP server reduces attack surface (removes IPC channel, child process, environment variable propagation of signing keys).
- **Side Effects**: 
  - External agents configured to use Switchboard MCP server will lose access
  - Any custom integrations using `handleMcpMove` will break
  - The `replace-mcp-with-skills.md` plan references MCP tools — that plan should be updated or closed after this removal
- **Dependencies & Conflicts**: 
  - LocalApiServer remains for skill-based API operations (unaffected)
  - Kanban database operations remain (unaffected)
  - Extension core functionality remains (unaffected)
  - `.agent/workflows/` and `.switchboard/plans/` infrastructure remains (unaffected — not MCP-specific)

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) extension.ts has 25+ MCP functions and multiple event listeners not listed in the original plan — missing any will cause runtime crashes on activate/deactivate. (2) Shared functions like `hasSwitchboardConfigs` must be modified not deleted, since they serve non-MCP purposes. (3) webpack.config.js removal changes the build output and must be tested. Mitigations: Use systematic grep for all `mcp`/`MCP` references before and after; treat shared functions as modifications; verify extension startup after changes.

## Overview
Remove the entire Switchboard MCP server infrastructure, including:
- Source code (src/mcp-server/)
- Extension lifecycle management (spawn, health checks, IPC, deactivate cleanup)
- UI components (status lights, setup buttons, webview message handlers)
- Configuration files (no templates exist — removed from plan)
- Test files
- Documentation references
- MCP-specific dispatch paths in services
- Build configuration (webpack)
- Package metadata (keywords, commands, config properties, scripts)

## Removal Steps

### 1. Remove MCP Server Source Code
- Delete entire `src/mcp-server/` directory (contains: mcp-server.js, register-mcp.js, register-tools.js, state-manager.js, workflows.js, Icon/)
- Delete `dist/mcp-server/` directory if it exists (build output)
- Delete `.switchboard/MCP/` directory from workspace if it exists (runtime copy)
- Delete `.switchboard/.mcp_server.pid` file if it exists
- Delete `.switchboard/.mcp_version.json` file if it exists

### 2. Remove MCP Configuration Files
All of these currently exist in the repo:
- Delete `.vscode/mcp.json`
- Delete `.cursor/mcp.json`
- Delete `.mcp.json`
- Delete `.kiro/settings/mcp.json`
- Delete `.gemini/settings.json`

### 3. Remove MCP UI Components from implementation.html
- Remove MCP status indicator div (lines 1894-1899): `<div class="status-indicator" id="mcp-status-footer">...</div>`
- Remove MCP status DOM element references (lines 1924-1925): `const mcpDot = ...` and `const mcpText = ...`
- Remove MCP recheck button event listener (lines 2058-2060): `document.getElementById('mcp-recheck-btn')?.addEventListener(...)`
- Remove MCP status message handler (lines 2508-2510): `case 'mcpStatus': ... updateMcpStatus(message); ...`
- Remove `updateMcpStatus` function (lines 5535-5554): entire function body
- Remove MCP comment at line 5101: reference to "no MCP call at prompt time"

### 4. Remove MCP UI Components from setup.html
- Remove CONNECT MCP button (line 472): `<button id="btn-connect-mcp"...>CONNECT MCP</button>`
- Remove COPY MCP CONFIG button (line 474): `<button id="btn-copy-mcp-config"...>COPY MCP CONFIG</button>`
- Remove CONNECT MCP button event listener (line 2668)
- Remove COPY MCP CONFIG button event listener (line 2669)

### 5. Remove MCP from extension.ts - Global Variables
- Remove `let mcpServerProcess: ChildProcess | null = null;` (line 39)
- Remove `let mcpOutputChannel: vscode.OutputChannel | null = null;` (line 40)
- Remove `let mcpHealthCheckInterval: ReturnType<typeof setInterval> | null = null;` (line 41)
- Remove `const MCP_PID_FILENAME = '.switchboard/.mcp_server.pid';` (line 45)
- Remove `const MCP_HEALTH_CHECK_INTERVAL_MS = 300_000;` (line 2198)

### 6. Remove MCP from extension.ts - Helper Functions
Remove all MCP-related helper functions (entire function bodies):
- `getWorkspaceMcpDirectory` (lines 55-57)
- `getWorkspaceSourceMcpDirectory` (lines 59-61)
- `getMcpVersionFilePath` (lines 67-69)
- `getLastCopiedMcpVersion` (lines 85-96)
- `setLastCopiedMcpVersion` (lines 98-106)
- `shouldRefreshMcpWorkspaceFiles` (lines 193-214)
- `getGlobalAntigravityMcpConfigPath` (lines 216-218)
- `resolveNodeRuntime` (lines 226-240) — used exclusively by MCP server spawning
- `normalizeEnvPath` (lines 242-244) — used exclusively by MCP config generation
- `buildSwitchboardMcpEnv` (lines 246-284)
- `setupGlobalAntigravityMcpConfig` (lines 286-405)
- `resolveBundledMcpSourceDirectory` (lines 439-455)
- `logMcpRuntimeLockWarning` (lines 462-470)
- `ensureWorkspaceMcpServerFiles` (lines 491-561)
- `attachMcpListeners` (lines 728-958) — entire IPC handler for MCP server messages
- `persistMcpPid` (lines 1002-1013)
- `killOrphanMcpServer` (lines 1015-1047)
- `spawnBundledMcpServer` (lines 964-1000)
- `restartBundledMcpServer` (lines 1049-1068)
- `restartLocalMcpServer` (lines 1076-1144)
- `syncSettingsToMcp` (lines 1149-1167)
- `resolveWorkspaceRootForMcp` (lines 3174-3206)
- `handleMcpSetup` (lines 3211-3337) — 126-line MCP setup orchestration
- `hasWorkspaceMcpRuntime` (lines 3370-3373)
- `getMcpConfigFilesForIDE` (lines 4260-4270)
- `writeAllIdeMcpConfigs` (lines 4278-4380) — 102-line IDE config writer
- `refreshMcpStatus` (lines 2119-2124)
- `checkMcpConnection` (lines 4548-4647) — 100-line health check function
- Remove `McpStatus` interface (lines 4534-4539)

### 7. Modify Shared Functions in extension.ts (DO NOT DELETE)
These functions check for `.agent/workflows` and `.switchboard` directories which are NOT MCP-specific:
- `hasSwitchboardProtocolFiles` (lines 3351-3368): Modify to remove any MCP-specific checks, keep `.agent/workflows` check
- `hasSwitchboardConfigs` (lines 3378-3384): Remove the `hasWorkspaceMcpRuntime` call inside this function, keep protocol files check
- `setupProtocolFilesSilent` (lines 3432-3438): Remove any MCP-specific setup, keep core workflow dependencies

### 8. Remove MCP from extension.ts - Command Registrations
- Remove `switchboard.connectMcp` command registration (lines 2558-2592)
- Remove `switchboard.copyMcpConfig` command registration (lines 2594-2629)
- Remove `switchboard.recheckMcp` command registration (lines 2468-2478)
- Remove `switchboard.mcpMoveKanbanCard` command registration (lines 1790-1793)
- Remove `switchboard.setupMcp` command registration (lines 2632-2637) — legacy command

### 9. Remove MCP from extension.ts - Health Check & Event Listeners
- Remove MCP health check interval setup (lines 2194-2202)
- Remove MCP health check interval cleanup in deactivate (lines 4650-4654)
- Remove window focus listener that calls `refreshMcpStatus` (lines 2204-2217)
- Remove config change listener that calls `syncSettingsToMcp` (lines 2435-2437)
- Remove all calls to `refreshMcpStatus` (lines 2195, 2200, 2206, 2443, 2476)

### 10. Remove MCP from extension.ts - Status Messaging
- Remove all calls to `taskViewerProvider.sendMcpConnectionStatus` (lines 1088, 1141, 2123, 2470-2475)
- Remove all calls to `provider.sendMcpConnectionStatus` (lines 3320, 3330-3335)

### 11. Remove MCP from extension.ts - Server Lifecycle in activate()
- Remove call to `killOrphanMcpServer` (line 1285)
- Remove call to `spawnBundledMcpServer` (lines 2188-2190)
- Remove call to `restartBundledMcpServer` (lines 1552-1559 in `refreshControlPlaneRuntimeDisposable`)
- Remove call to `ensureWorkspaceMcpServerFiles` (line 3748)
- Remove calls to `setupGlobalAntigravityMcpConfig` (lines 2571, 4201)
- Remove calls to `syncSettingsToMcp` (lines 999, 1134, 2436)
- Remove MCP runtime self-heal check (lines 2389-2393)

### 12. Remove MCP from extension.ts - Deactivate Cleanup
- Remove MCP server process kill logic in deactivate (lines 4667-4702): kills process tree, cleans PID file
- Remove MCP output channel disposal (lines 4708-4711)

### 13. Remove MCP from extension.ts - IPC Message Handling
- Remove MCP process message sending (lines 1162, 3102-3103, 3891)
- Remove terminal batch registration IPC send to MCP (lines 3102-3106)

### 14. Remove MCP from KanbanProvider.ts
- Remove `McpMoveTargetResolution` type (line 67)
- Remove `_normalizeMcpTarget` method (lines 3769-3782)
- Remove `_registerMcpTargetAlias` method (lines 3784-3795)
- Remove `_buildMcpTargetAliases` method (lines 3797-3836)
- Remove `_resolveMcpMoveTarget` method (lines 3960-3985)
- Remove `handleMcpMove` method (lines 3987-4052)
- Remove all internal calls to these methods
- Remove MCP-related comment at line 2639

### 15. Remove MCP from TaskViewerProvider.ts
- Remove private fields (lines 287-290): `_mcpServerRunning`, `_mcpIdeConfigured`, `_mcpToolReachable`, `_mcpDiagnostic`
- Remove `sendMcpConnectionStatus` method (lines 15383-15396)
- Remove webview message handler `case 'connectMcp':` (line 7712)
- Remove webview message handler `case 'recheckMcpConnection':` (line 7715)
- Remove webview message handler `case 'copyMcpConfig':` (line 7718)
- Remove MCP fields from initial state message (lines 4339-4343): `mcpServerRunning`, `mcpIdeConfigured`, `mcpToolReachable`, `mcpDiagnostic`, `connected`
- Remove `mcp-agent` pattern from ORPHAN_PATTERNS regex (line 13764)
- Remove MCP-related comment at line 12417

### 16. Remove MCP from ControlPlaneMigrationService.ts
- Remove `_resolveBundledMcpDirectory` method (lines 714-720)
- Remove MCP directory copying logic (lines 696-703)
- Remove call to `_resolveBundledMcpDirectory` (line 696)

### 17. Remove MCP from DiagramRenderer.ts
- Remove MCP-related comment at line 22: "Upload is handled by the MCP tool handler, not this renderer."
- Remove MCP-related comment at line 40: "Prepare base64-encoded data for upload by the MCP tool handler"
- Update any code that references MCP tool handler to describe the skill-based upload path instead

### 18. Remove MCP Test Files
- Delete `src/test/send-message-guards.test.js`
- Delete `src/test/workflow-controls.test.js`
- Delete `src/test/build-switchboard-mcp-env.test.js`
- Delete `src/test/workflow-contract-consistency.test.js`
- Delete `src/test/state-root-fragmentation-regression.test.js` (if it only tests MCP)
- Delete `src/test/kanban-mcp-state.test.js`
- Delete `src/test/state-manager.test.js` (if it only tests MCP state manager)
- Delete `src/test/kanban-smart-router-regression.test.js` (contains MCP routing tests)
- Delete `src/test/send-team-message.test.js` (contains MCP team messaging tests)

### 19. Update Documentation
- **README.md**: Remove MCP references at lines 29, 328, 332. Update architecture description to remove "Bundled MCP Server" component.
- **docs/TECHNICAL_DOC.md**: Remove/rewrite MCP sections at lines 12, 18, 61, 78, 80, 102, 104, 121, 122, 144, 168, 175, 177, 469, 471, 489, 604, 606, 619, 621, 664, 708, 718, 722, 724, 731. Key sections to remove entirely: "Extension <-> MCP IPC contract" (§4), "MCP server runtime internals" (§5), "Future Work: Uncovered MCP Tools Migration" (§24). Key sections to rewrite: API tool descriptions to reference skills only.
- **docs/marketing.md**: Remove MCP references at lines 16, 43. Rewrite PM sync description to reference skills instead of MCP.
- **docs/terminal_creation_capability.md**: Remove/rewrite all 12 MCP references. This entire document describes MCP-based terminal creation — consider archiving or rewriting to describe skill-based approach.
- **docs/SECURITY-AUDIT.md**: Remove/rewrite MCP references at lines 10, 26, 36-41, 56, 139, 154-158, 162, 188, 235, 243. Key: remove MCP-specific security findings, update threat model.
- **AGENTS.md**: Remove MCP tool documentation from Available MCP Tools section (lines 73-74, 87). Update tool preference guidance to remove MCP references.
- **.cursorrules**: Remove MCP tool documentation (lines 4, 8-9, 12-14, 27). Rewrite setup instructions.
- **.switchboard/CLIENT_CONFIG.md**: Remove/rewrite MCP config documentation (lines 9, 12-14, 17-20, 44-49, 75-77, 91). Remove "Stdio Transport" and "SSE Transport" sections. Keep "Manual File Protocol" section.
- **.switchboard/SWITCHBOARD_PROTOCOL.md**: Remove/rewrite MCP references (lines 9-12, 15, 107, 114). Remove "MCP — Primary" transport section.
- **src/webview/switchboard/README.md**: Remove MCP reference at line 7.

### 20. Update planMetadataUtils.ts
- Remove 'mcp' from allowed tags list (line 9)

### 21. Clean up package.json
- Remove `"mcp"` from keywords array (line 10)
- Remove `switchboard.connectMcp` command declaration (lines 55-56)
- Remove `switchboard.copyMcpConfig` command declaration (lines 59-60)
- Remove `switchboard.recheckMcp` command declaration (lines 63-64)
- Remove MCP workspace mode configuration description (lines 335-336)
- Remove `mcpServers` configuration property (lines 338-342)
- Remove `test:regression:token-env` script (line 516)
- Update plan watcher description to remove "by MCP tools" reference (line 461)

### 22. Update webpack.config.js
- Remove entire `mcpServerConfig` object (lines 83-132): 50-line MCP server build configuration including entry point, output, externals, module rules, CopyPlugin patterns
- Change `module.exports` from `[extensionConfig, mcpServerConfig]` to just `extensionConfig` (line 134)

### 23. Update .gitignore
- Remove `mcp_config.json` ignore pattern and its comment (lines 67-68)

### 24. Verification
- Search codebase for remaining 'mcp' and 'MCP' references in `src/`, `docs/`, and config files (excluding `.switchboard/plans/` which may contain historical references) to ensure complete removal
- Verify extension activates without errors (no references to deleted functions)
- Verify kanban functionality works (card movement, column display)
- Verify LocalApiServer still works for skill-based operations
- Verify webview loads without console errors (no orphaned MCP message handlers)
- Verify webpack build succeeds with only `extensionConfig`

## Verification Checklist
- [ ] src/mcp-server/ directory deleted
- [ ] dist/mcp-server/ directory deleted (if existed)
- [ ] .switchboard/MCP/ directory deleted (if existed)
- [ ] MCP configuration files deleted (5 files)
- [ ] implementation.html MCP status indicator and handlers removed
- [ ] setup.html MCP buttons and listeners removed
- [ ] extension.ts global variables removed (5 items)
- [ ] extension.ts helper functions removed (28 functions + 1 interface)
- [ ] extension.ts shared functions modified (3 functions — NOT deleted)
- [ ] extension.ts command registrations removed (5 commands)
- [ ] extension.ts health check & event listeners removed
- [ ] extension.ts status messaging removed
- [ ] extension.ts activate() lifecycle calls removed
- [ ] extension.ts deactivate() cleanup removed
- [ ] extension.ts IPC message handling removed
- [ ] KanbanProvider.ts MCP methods and type removed (6 items)
- [ ] TaskViewerProvider.ts MCP fields, method, handlers, and patterns removed (10 items)
- [ ] ControlPlaneMigrationService.ts MCP logic removed
- [ ] DiagramRenderer.ts MCP comments removed/updated
- [ ] MCP test files deleted (9 files)
- [ ] Documentation updated (10 files)
- [ ] planMetadataUtils.ts tags updated
- [ ] package.json cleaned (7 items)
- [ ] webpack.config.js MCP config removed
- [ ] .gitignore MCP pattern removed
- [ ] No remaining MCP references in src/ or docs/ (excluding plan files)
- [ ] Extension starts successfully
- [ ] Kanban functionality works
- [ ] LocalApiServer works for skills
- [ ] Webview loads without console errors

## Recommendation
**Send to Coder** — Large-scale removal across multiple files with moderate risk of breaking core extension functionality if not carefully tested. The pattern is repetitive (deletion, not new logic) which reduces risk, but the scope of extension.ts changes (25+ functions, 5 commands, lifecycle hooks) requires systematic verification after each major component removal.
