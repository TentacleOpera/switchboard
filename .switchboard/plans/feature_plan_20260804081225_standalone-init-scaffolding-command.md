# Standalone `init` Command — Bootstrap Switchboard Scaffolding Into a Repo From the CLI

## Goal

### Problem
The standalone CLI (`npx switchboard`) has no way to initialise Switchboard scaffolding inside a repository. Running `npx switchboard` from a fresh repo creates a bare `.switchboard/` directory (one `mkdirSync` in `cli.ts:157-159`) but does **not** scaffold the full protocol layout that the VS Code extension creates on activation:

- `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/`
- `.agents/` (workflows, skills, lib)
- `AGENTS.md` (protocol file)
- `CLAUDE.md` (Claude Code managed block) + `.claude/skills/` mirror
- `worktrees/`
- `kanban.db` (initialised, not zero-byte)
- workspace identity (`ensureWorkspaceIdentity`)

A standalone user who wants to adopt Switchboard in a repo — without installing the VS Code extension — has no CLI path to get the scaffolding in place. They must either install the extension just to scaffold once, or hand-create the directory tree and copy bundled files manually. The `secrets` subcommand exists (`cli.ts:161-203`) but there is no `init` / `scaffold` subcommand.

### Background
The scaffolding logic already exists and is largely host-agnostic:

- `ControlPlaneMigrationService.bootstrapControlPlaneLayout(parentDir, extensionPath)` (`ControlPlaneMigrationService.ts:533-535` → `_bootstrapControlPlaneLayout` at `:667-747`) creates the directory tree, copies bundled `.agents/` from the extension bundle, seeds `AGENTS.md` / `CLAUDE.md`, and generates the `.claude/` mirror. It takes an optional `extensionPath` — when omitted it still creates all directories but skips the bundled-file copy.
- `scaffoldProtocolLayers` (`extension.ts:3772-3803`) wraps `ensureAgentsProtocol` + `ensureClaudeProtocol` + `generateClaudeMirror` — extension-only helpers that read `vscode.workspace.getConfiguration`.
- The standalone bootstrap already resolves the bundle/repo root via `resolveRepoRoot()` (`bootstrap.ts:109-112`, two levels up from `__dirname`), and passes it as `extensionPath` / `extensionUri.fsPath` to providers (`bootstrap.ts:569-570`). The bundled `.agents/` and `AGENTS.md` ship inside the standalone bundle (webpack packages them), so `extensionPath` is available in standalone mode.
- `KanbanDatabase.forWorkspace(root).createIfMissing()` (`MultiRepoScaffoldingService.ts:265-273`) initialises the DB file.
- `ensureWorkspaceIdentity(root)` (`WorkspaceIdentityService`) writes the workspace-id file.

### Root Cause
The standalone CLI was built with a `secrets` subcommand and a server-start path, but never received an `init` subcommand. The scaffolding services (`ControlPlaneMigrationService`, `KanbanDatabase`, `WorkspaceIdentityService`) are already callable from Node without VS Code — the standalone bootstrap itself calls them — but the CLI entry point (`cli.ts`) does not wire them into a user-facing command. The one `mkdirSync` for `.switchboard/` is the only scaffolding the CLI performs, and it is insufficient.

## Metadata
**Complexity:** 4
**Tags:** cli, feature, infrastructure
**Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine:**
- Adding a new `init` subcommand to `cli.ts` (mirrors the existing `secrets` subcommand pattern at `cli.ts:161-203`).
- Calling `ControlPlaneMigrationService.bootstrapControlPlaneLayout(workspaceRoot, repoRoot)` — already a static method, already called from standalone bootstrap's provider wiring.
- Calling `KanbanDatabase.forWorkspace(root).createIfMissing()` + `ensureWorkspaceIdentity(root)` — already called in `MultiRepoScaffoldingService._doScaffold` and `bootstrap.ts`.
- Console output for success/failure.

**Complex/Risky:**
- `bootstrapControlPlaneLayout` internally calls `_getProtocolTargets` (`ControlPlaneMigrationService.ts:752-763`) which reads `vscode.workspace.getConfiguration('switchboard')`. In standalone, `vscode` is the shim (`vscodeShim.ts`) whose `workspace.getConfiguration` reads from the standalone config provider keyed off `__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT`. The `init` command must call `__setStandaloneWorkspaceRoot(workspaceRoot)` **before** invoking `bootstrapControlPlaneLayout`, otherwise the config read resolves against the wrong root (or the default cwd) and `protocol.target` may not be honoured. This is the same ordering constraint `bootstrap.ts:281` already respects.
- `bootstrapControlPlaneLayout` calls `isAllowedSwitchboardLocation(parentDir, parentDir)` (`switchboardLocationGuard.ts`). In standalone, `anyOtherFolderOwnsControlPlane` reads `vscode.workspace.workspaceFolders` — the shim returns `[]`, so the guard reduces to "not home dir / not filesystem root", which is correct for a single-repo init. No risk.
- The `--target` flag (agents/claude/both) must override `protocol.target` config for the init run, since a CLI user may not have a config file yet. This requires either setting the config before calling bootstrap, or passing the target through. The cleanest path: set the standalone config value before calling bootstrap (the config provider writes to `.switchboard/config.json`).

## Edge-Case & Dependency Audit

1. **Re-init over existing scaffolding** — `bootstrapControlPlaneLayout` is idempotent: directories use `mkdir recursive`, `AGENTS.md`/`CLAUDE.md` copies are file-absence-gated (`:707`, `:724`), `.agents/` copy uses `overwrite: false, overwriteIfDiffers: true` (`:697`). `kanban.db` `createIfMissing` is a no-op if the DB already exists. Re-running `init` must be safe and not clobber user edits. ✓ Already handled.

2. **`kanban.db` already exists and is non-empty** — `createIfMissing` must not wipe data. Verify it returns `true` without truncating when the file already exists and is valid. The `MultiRepoScaffoldingService` path (`:266-273`) treats `created === false` as a hard failure, but for `init` a pre-existing valid DB should be a success-with-warning, not an error. The init command should distinguish "created" from "already exists and valid".

3. **`--target` flag with no config file** — If the user passes `--target claude` but no `.switchboard/config.json` exists, the config provider needs to honour the flag. Approach: write `switchboard.protocol.target` to the standalone config before calling `bootstrapControlPlaneLayout`. Alternatively, refactor `_getProtocolTargets` to accept an explicit override — but that changes a shared method signature. Prefer the config-write approach (matches how standalone config already works).

4. **Bundle path resolution** — `resolveRepoRoot()` (`bootstrap.ts:109-112`) resolves `path.resolve(__dirname, '..', '..')`. In the webpacked standalone bundle, `__dirname` is `dist/standalone/`, so repo root is `dist/`. The bundled `.agents/` and `AGENTS.md` must be at `dist/.agents/` and `dist/AGENTS.md`. Verify the webpack config copies these (check `webpack.config.js` copy patterns). If they are not copied, `bootstrapControlPlaneLayout` silently skips the file copy (`extensionPath` truthy but `fs.existsSync(bundledAgentDir)` false → `:693` guard skips). The init command should warn if bundled files are missing.

5. **Non-repo directory** — User runs `npx switchboard init` in a plain directory (no `.git`). `bootstrapControlPlaneLayout` does not require git. `isAllowedSwitchboardLocation` blocks home dir and filesystem root only. This should work (Switchboard can manage a non-git folder). No special handling needed, but the success message should note "no git repository detected" as an FYI.

6. **`--workspace` flag interaction** — The existing `--workspace <path>` flag (`cli.ts:64`) sets the workspace root for server start. The `init` subcommand should reuse it: `npx switchboard init --workspace /path/to/repo`. If omitted, default to `process.cwd()` (same as server start at `cli.ts:150`).

7. **Permission errors** — `mkdir recursive` / file copies may fail on read-only filesystems or permission-denied. Wrap in try/catch and print a clear error with the path. Do not leave a partial scaffold silently — `bootstrapControlPlaneLayout` creates directories first then copies files; a mid-copy failure leaves directories but missing files, which is the same partial state the extension can leave. Acceptable (re-running `init` completes it).

## Proposed Changes

### `src/standalone/cli.ts` — Add `init` subcommand

Add an `init` subcommand handler before the server-start path (after the `secrets` block, before `findRunningInstance` at `:206`). Parse `--target <agents|claude|both>` (default `both`) and reuse `--workspace`.

```typescript
// After the secrets block (line ~203), before findRunningInstance:

if (process.argv[2] === 'init') {
    const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
    const { ControlPlaneMigrationService } = require('../services/ControlPlaneMigrationService');
    const { KanbanDatabase } = require('../services/KanbanDatabase');
    const { StandaloneHostPathConfigProvider } = require('./hostServices');
    const { ensureWorkspaceIdentity } = require('../services/WorkspaceIdentityService');

    const initWorkspace = path.resolve(args.workspace || process.cwd());
    if (!fs.existsSync(initWorkspace)) {
        console.error(`[switchboard] Target directory does not exist: ${initWorkspace}`);
        process.exit(1);
    }

    // Parse --target flag (default 'both')
    let target: string = 'both';
    for (let i = 3; i < process.argv.length; i++) {
        if (process.argv[i] === '--target' && process.argv[i + 1]) {
            target = process.argv[++i];
        }
    }
    if (!['agents', 'claude', 'both'].includes(target)) {
        console.error(`[switchboard] --target must be 'agents', 'claude', or 'both' (got '${target}')`);
        process.exit(1);
    }

    // Install the workspace root on the shim BEFORE any service that reads
    // vscode.workspace.getConfiguration (bootstrapControlPlaneLayout → _getProtocolTargets).
    __setStandaloneWorkspaceRoot(initWorkspace);

    // Set protocol.target in the standalone config so _getProtocolTargets honours --target.
    const configProvider = new StandaloneHostPathConfigProvider(initWorkspace);
    KanbanDatabase.setPathConfigProvider(configProvider);
    configProvider.setConfigString('protocol.target', target);

    const repoRoot = path.resolve(__dirname, '..', '..'); // bundled .agents/ + AGENTS.md

    console.log(`[switchboard] Initialising Switchboard scaffolding in ${initWorkspace} (target: ${target})…`);

    try {
        await ControlPlaneMigrationService.bootstrapControlPlaneLayout(initWorkspace, repoRoot);

        // Initialise kanban.db (create if missing; no-op if already valid)
        const db = KanbanDatabase.forWorkspace(initWorkspace);
        const dbCreated = await db.createIfMissing();
        if (!dbCreated && !fs.existsSync(db.dbPath)) {
            console.error(`[switchboard] Failed to create kanban database at ${db.dbPath}.`);
            process.exit(1);
        }

        await ensureWorkspaceIdentity(initWorkspace);

        // Warn if bundled .agents/ was not found (silent skip in bootstrapControlPlaneLayout)
        if (!fs.existsSync(path.join(repoRoot, '.agents'))) {
            console.warn(`[switchboard] Warning: bundled .agents/ not found at ${repoRoot}. Directory structure created but protocol files were not copied.`);
        }

        console.log(`[switchboard] Scaffolding complete.`);
        console.log(`[switchboard]   .switchboard/  (plans, inbox, archive, kanban.db)`);
        console.log(`[switchboard]   .agents/       (workflows, skills)`);
        if (target === 'agents' || target === 'both') {
            console.log(`[switchboard]   AGENTS.md      (protocol file)`);
        }
        if (target === 'claude' || target === 'both') {
            console.log(`[switchboard]   CLAUDE.md      (Claude Code managed block)`);
            console.log(`[switchboard]   .claude/skills (mirror)`);
        }
        console.log(`[switchboard]   worktrees/`);
        if (!fs.existsSync(path.join(initWorkspace, '.git'))) {
            console.log(`[switchboard] Note: no git repository detected in ${initWorkspace}.`);
        }
        process.exit(0);
    } catch (err) {
        console.error(`[switchboard] Init failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
```

### `src/standalone/cli.ts` — Update `usage()` help text

Add the `init` command to the usage string (`cli.ts:8-30`):

```
Usage: npx switchboard [options]
       npx switchboard init [--target <agents|claude|both>] [--workspace <path>]
       npx switchboard secrets set <clickup|linear|notion|stitch|apiToken|key> <value>
       npx switchboard secrets list
       npx switchboard secrets delete <clickup|linear|notion|stitch|apiToken|key>

Options:
  --workspace <path>   Workspace root to serve or init (default: cwd)
  --port <number>      Preferred port; 0 for ephemeral (default: 0)
  --hostname <name>    Hostname for the board URL (default: 127.0.0.1)
  --no-open            Do not open a browser
  --target <name>      Protocol target for 'init': agents, claude, or both (default: both)
  --help               Show this help
```

### `src/standalone/hostServices.ts` — Verify `setConfigString` exists on `StandaloneHostPathConfigProvider`

The init command calls `configProvider.setConfigString('protocol.target', target)`. Verify this method exists and writes to `.switchboard/config.json`. If it only has `getConfigString` (read-only), add a `setConfigString` method that writes to the config file. Check the existing method surface before implementing — the multi-repo scaffold path does not write config, so this may be a new method.

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/standalone/hostServices.ts" />

### `webpack.config.js` — Verify bundled `.agents/` + `AGENTS.md` are copied into the standalone bundle output

The init command resolves bundled files via `path.resolve(__dirname, '..', '..')`. Verify the webpack config copies `.agents/` and `AGENTS.md` into the output directory so they are present at runtime. If they are not copied, add a copy-webpack-plugin entry (or verify the existing one covers them).

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/webpack.config.js" />

## Verification Plan

1. **Unit test** — Add `src/test/standalone-init-command.test.js`:
   - Create a temp directory, invoke the init logic (extracted or via spawning `node dist/standalone/cli.js init --workspace <tmp>`), assert `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/`, `.agents/`, `AGENTS.md`, `worktrees/` exist.
   - Assert `kanban.db` is non-zero and `createIfMissing` returns true on first run.
   - Assert `ensureWorkspaceIdentity` wrote a workspace-id file.
   - Assert re-running init is idempotent (no errors, no clobber of existing `AGENTS.md`).

2. **`--target` flag test** — Run `init --target agents`, assert `CLAUDE.md` is NOT created and `AGENTS.md` IS created. Run `init --target claude`, assert the inverse.

3. **Manual smoke test** — In a fresh temp repo:
   ```
   mkdir /tmp/sb-init-test && cd /tmp/sb-init-test && git init
   node /path/to/switchboard/dist/standalone/cli.js init
   ```
   Verify the full tree is created. Then run `npx switchboard` (server start) in the same dir and confirm the board UI loads with the scaffolded workspace.

4. **Bundled-files-present check** — Verify `dist/.agents/` and `dist/AGENTS.md` exist after `npm run compile`. If missing, the init command's warning path fires — confirm the warning prints and the directory-only scaffold still works.

5. **Existing repo non-clobber** — Run `init` in a repo that already has a custom `AGENTS.md`. Assert the file is not overwritten (file-absence gate at `ControlPlaneMigrationService.ts:707`).
