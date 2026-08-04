# Standalone Multi-Repo Scaffold + Control Plane CLI Commands

## Goal

### Problem
The standalone CLI (`npx switchboard`) exposes no commands for multi-repo scaffolding or control plane setup. These capabilities exist only behind the VS Code extension's Setup panel UI (`SetupPanelProvider` → `MultiRepoScaffoldingService.scaffold` / `ControlPlaneMigrationService`). A standalone user who wants to create a control-plane parent workspace and clone multiple repos into sibling folders — the "Fresh Setup" flow — has no CLI path.

Worse, even when the standalone server is running and the browser Setup panel is used to trigger multi-repo scaffold, the scaffold **silently cancels** the first time it encounters an existing sub-repo `kanban.db`. The root cause is a headless dialog no-op:

`MultiRepoScaffoldingService._reviewSubRepoDb` (`MultiRepoScaffoldingService.ts:371-414`) calls `vscode.window.showWarningMessage(...)` to ask the user whether to delete or keep an existing sub-repo DB. In standalone mode, `vscode` is the shim (`vscodeShim.ts:134`) whose `showWarningMessage` is a no-op returning `undefined`. The `undefined` return falls through every `if` branch (`:390` delete, `:407` keep) and hits the final `return { cancelled: true }` (`:413`) — cancelling the entire scaffold with the error `"Scaffold cancelled while reviewing sub-repo database cleanup."` The same no-op hits `_offerReopenWorkspace` (`:416-429`) — `showInformationMessage` returns `undefined`, so the reopen prompt is silently skipped (non-fatal but the user gets no feedback).

### Background
- `MultiRepoScaffoldingService.scaffold(options, extensionPath)` (`MultiRepoScaffoldingService.ts:166-196`) is a static method that clones repos, bootstraps the control-plane layout, creates the DB, and generates a `.code-workspace` file. It is called from `SetupPanelProvider` (`SetupPanelProvider.ts:495-518`) which is wired in the standalone bootstrap (`bootstrap.ts:591-592`).
- `ControlPlaneMigrationService` provides: `detectCandidateParent`, `previewMigration`, `executeMigration`, `bootstrapControlPlaneLayout`, `generateCodeWorkspace`, and a "fresh control plane" path. These are all static methods callable from Node.
- The standalone bootstrap already passes `repoRoot` (the bundle root) as `extensionPath` (`bootstrap.ts:569-570`), so `MultiRepoScaffoldingService.scaffold` can copy bundled `.agents/` / `AGENTS.md` in standalone.
- The `vscode.window` shim no-ops (`vscodeShim.ts:133-134`) are the only hard blocker. The `git clone` (`safeClone` at `:107-124`), `execFileSync`, and all filesystem operations work fine in Node.

### Root Cause
Two gaps:
1. **No CLI subcommand** — `cli.ts` has `secrets` and server-start but no `scaffold` / `control-plane` subcommand. The scaffolding services are callable from Node but not wired to a CLI entry point.
2. **Dialog no-op silent cancel** — `MultiRepoScaffoldingService._reviewSubRepoDb` treats the `vscode.window.showWarningMessage` `undefined` return as "cancel" (`:413`). In headless mode this is wrong — there is no user to ask. The service needs a headless-aware decision strategy (default to the recommended action: delete the sub-repo DB, or keep with a warning) rather than cancelling.

## Metadata
**Complexity:** 6
**Tags:** cli, feature, infrastructure, refactor
**Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine:**
- Adding `scaffold` and `control-plane` subcommands to `cli.ts` (mirrors the `secrets` / `init` pattern).
- Calling `MultiRepoScaffoldingService.scaffold(options, repoRoot)` from the CLI — it is a static async method returning a `ScaffoldResult`.
- Calling `ControlPlaneMigrationService.detectCandidateParent` / `previewMigration` / `executeMigration` from the CLI.
- Console output formatting for scaffold results (per-repo status table).

**Complex/Risky:**
- **Fixing the `_reviewSubRepoDb` dialog no-op.** The method uses `vscode.window.showWarningMessage` which is a no-op in standalone. The fix must not break the extension path (where the dialog is real and the user's choice matters). Approach: add an optional `headlessDefaults` parameter to `scaffold()` / `_reviewSubRepoDb` that, when set, skips the dialog and applies the default action (delete sub-repo DB = the recommended action). The standalone CLI and the standalone bootstrap's SetupPanelProvider wiring both pass `headlessDefaults: { subRepoDbAction: 'delete' }`. The extension path passes nothing (undefined) and gets the real dialog. This is a backward-compatible optional parameter.
- **`_offerReopenWorkspace` dialog no-op.** `showInformationMessage` returns `undefined` in standalone → no reopen. This is non-fatal (the workspace file is still generated and the path is printed). For the CLI, "reopen in VS Code" is meaningless anyway — the CLI should just print the workspace file path. For the browser-UI path in standalone, the reopen prompt is a no-op (acceptable — the user can open the file manually). Fix: make `_offerReopenWorkspace` a no-op when `vscode.window.showInformationMessage` returns `undefined` (it already is — the `if (selection === reopenAction)` just doesn't fire). No code change needed here; just ensure the workspace file path is in the `ScaffoldResult` (it already is at `:366`).
- **PAT handling on the CLI.** The multi-repo scaffold requires a PAT (`MultiRepoScaffoldingService._normalizeOptions` at `:213-215` throws if missing). On the CLI, the PAT must be passed via a flag (`--pat`) or an env var (`SWITCHBOARD_PAT`). The PAT must NOT be echoed or logged. `safeClone` already scrubs the PAT from error messages (`stripSensitiveText` at `:76-101`). The CLI must not print the PAT in any output. Use `--pat` flag (typed as password) with env-var fallback; never echo it.
- **`ControlPlaneMigrationService._getProtocolTargets` config read.** Same as the init plan — `__setStandaloneWorkspaceRoot` must be called before any `ControlPlaneMigrationService` method that reads `vscode.workspace.getConfiguration`. The `executeMigration` path calls `bootstrapControlPlaneLayout` which calls `_getProtocolTargets`.

## Edge-Case & Dependency Audit

1. **Existing sub-repo `kanban.db` in headless mode** — The current code cancels the scaffold. The fix: when `headlessDefaults` is set, default to deleting the sub-repo DB (the recommended action, `DELETE_SUB_REPO_DB_ACTION`). This matches the control-plane model where the parent DB is authoritative. The outcome should still be recorded in `RepoOutcome.cleanupAction = 'deleted'` and a warning pushed. If the delete fails (permission error), record the error in `outcome.error` and continue (same as the current keep-path error handling).

2. **`--pat` security** — The PAT is passed via `--pat <token>` or `SWITCHBOARD_PAT` env var. It must never appear in:
   - Console output (the scaffold result prints repo URLs, not the PAT — `ScaffoldResult` does not include the PAT).
   - Error messages (`sanitizeErrorText` at `:103-105` scrubs it).
   - Process arguments visible to other users (`ps aux`). On macOS/Linux, `--pat <token>` is visible in the process list. Prefer `SWITCHBOARD_PAT` env var as the default, with `--pat` as a convenience that prints a warning recommending the env var. Alternatively, support `--pat-stdin` (read from stdin) for maximum safety. Start with env var + `--pat` flag + a warning.

3. **All repos fail to clone** — `MultiRepoScaffoldingService._doScaffold` returns `{ success: false, error: 'No repositories were available...' }` (`:342-349`). The CLI must print this error and exit non-zero. The control-plane layout and DB are already created at this point (parent dir scaffolded at `:261-275`) — this is acceptable (the parent is a valid empty control plane; the user can re-run scaffold or add repos manually).

4. **Partial clone failure** — Some repos clone, some fail. `ScaffoldResult.repos` has per-repo `status: 'failed'` with `error`. The CLI must print a per-repo status table and exit non-zero if any repo failed. The `.code-workspace` file is generated with only the successful repos (`:351-355`), and a warning is added (`:357-359`).

5. **Control plane `executeMigration` from CLI** — The migration flow (`previewMigration` → `executeMigration`) moves sub-repo DBs into the parent. In headless mode, `executeMigration` may also call `vscode.window` dialogs. Audit `ControlPlaneMigrationService.executeMigration` (`:328` area) for any `vscode.window` calls. If found, apply the same `headlessDefaults` pattern. (Initial scan: `executeMigration` calls `bootstrapControlPlaneLayout` which does not use `vscode.window` — it uses `vscode.workspace.getConfiguration` only. The migration preview/execute themselves appear to be pure filesystem operations. Verify during implementation.)

6. **`detectCandidateParent` from CLI** — This scans a parent dir for child repos. It is a read-only static method. Safe to call from CLI. Print the discovered repos and warnings as a table.

7. **Workspace file path on macOS** — `generateCodeWorkspace` writes a `.code-workspace` file. The CLI should print the absolute path so the user can open it with `code <path>`.

8. **Interaction with running server** — `findRunningInstance` (`cli.ts:110-117`) checks for an existing server before start. The `scaffold` / `control-plane` subcommands should NOT check for a running server — they are one-shot operations, not server starts. They should run and exit regardless of whether a server is running. Place them before the `findRunningInstance` check (same position as `init` and `secrets`).

## Proposed Changes

### `src/services/MultiRepoScaffoldingService.ts` — Add `headlessDefaults` to fix silent cancel

Add an optional `headlessDefaults` field to `ScaffoldOptions` and thread it through to `_reviewSubRepoDb`:

```typescript
// ScaffoldOptions (line 10-15):
export interface ScaffoldOptions {
    parentDir: string;
    workspaceName: string;
    repoUrls: string[];
    pat: string;
    /** When set, skip vscode.window dialogs and apply these defaults (headless mode). */
    headlessDefaults?: {
        subRepoDbAction: 'delete' | 'keep';
    };
}
```

```typescript
// _reviewSubRepoDb (line 371-414) — add headlessDefaults short-circuit:
private static async _reviewSubRepoDb(
    targetDir: string,
    outcome: RepoOutcome,
    warnings: string[],
    headlessDefaults?: { subRepoDbAction: 'delete' | 'keep' }
): Promise<{ cancelled: boolean; error?: string }> {
    const dbPath = getSubRepoDbPath(targetDir);
    if (!fs.existsSync(dbPath)) {
        return { cancelled: false };
    }

    outcome.existingSubRepoDb = true;

    // Headless: skip the dialog, apply the default action.
    if (headlessDefaults) {
        if (headlessDefaults.subRepoDbAction === 'delete') {
            try {
                await Promise.all([
                    fs.promises.rm(dbPath, { force: true }),
                    fs.promises.rm(`${dbPath}-wal`, { force: true }),
                    fs.promises.rm(`${dbPath}-shm`, { force: true })
                ]);
                outcome.cleanupAction = 'deleted';
                warnings.push(`Headless: deleted existing sub-repo kanban.db for ${outcome.dir} (control-plane parent is authoritative).`);
                return { cancelled: false };
            } catch (error) {
                return {
                    cancelled: false,
                    error: `Failed to delete the existing sub-repo kanban.db for ${outcome.dir}: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }
        // 'keep'
        outcome.cleanupAction = 'kept';
        warnings.push(`Headless: kept ${outcome.dir}/.switchboard/kanban.db with an explicit warning.`);
        return { cancelled: false };
    }

    // Existing dialog path (extension mode) — unchanged:
    const selection = await vscode.window.showWarningMessage(
        `Switchboard found an existing sub-repo kanban.db in ${outcome.dir}. Delete it so the Control Plane parent stays authoritative, or keep it and proceed with a warning.`,
        { modal: true },
        DELETE_SUB_REPO_DB_ACTION,
        KEEP_SUB_REPO_DB_ACTION,
        CANCEL_SUB_REPO_DB_ACTION
    );
    // ... rest unchanged
}
```

Thread `headlessDefaults` from `scaffold` → `_doScaffold` → `_reviewSubRepoDb` (both call sites at `:286` and `:324`).

### `src/standalone/bootstrap.ts` — Pass `headlessDefaults` when wiring SetupPanelProvider

The standalone SetupPanelProvider calls `MultiRepoScaffoldingService.scaffold` via the `scaffoldMultiRepo` verb (`SetupPanelProvider.ts:495-518`). The SetupPanelProvider does not currently pass `headlessDefaults`. Two options:

**Option A (preferred):** Patch the `scaffoldMultiRepo` case in `SetupPanelProvider.ts` to detect headless mode (check `this._hostSeams` / a `_headless` flag) and inject `headlessDefaults: { subRepoDbAction: 'delete' }`. The standalone bootstrap already injects `_hostSeams` (`bootstrap.ts:592`); the extension does not set this flag. Add a `_headless` boolean to `SetupPanelProvider` set by the standalone bootstrap.

```typescript
// bootstrap.ts, after line 592:
(setupProvider as any)._headless = true;
```

```typescript
// SetupPanelProvider.ts, scaffoldMultiRepo case (line 495-518):
case 'scaffoldMultiRepo': {
    try {
        const result = await MultiRepoScaffoldingService.scaffold(
            {
                parentDir: typeof message.parentDir === 'string' ? message.parentDir : '',
                workspaceName: typeof message.workspaceName === 'string' ? message.workspaceName : '',
                repoUrls: Array.isArray(message.repoUrls) ? message.repoUrls.map((value: unknown) => String(value)) : [],
                pat: typeof message.pat === 'string' ? message.pat : '',
                headlessDefaults: (this as any)._headless ? { subRepoDbAction: 'delete' as const } : undefined,
            },
            this._extensionUri.fsPath
        );
        this.postMessage({ type: 'multiRepoScaffoldResult', result });
    } catch (error) {
        // ... unchanged
    }
    return { success: true };
}
```

### `src/standalone/cli.ts` — Add `scaffold` subcommand

```typescript
if (process.argv[2] === 'scaffold') {
    const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
    const { MultiRepoScaffoldingService } = require('../services/MultiRepoScaffoldingService');
    const { StandaloneHostPathConfigProvider } = require('./hostServices');
    const { KanbanDatabase } = require('../services/KanbanDatabase');

    const scaffoldWorkspace = path.resolve(args.workspace || process.cwd());

    // Parse scaffold-specific flags
    let parentDir = '';
    let workspaceName = '';
    let repoUrls: string[] = [];
    let pat = process.env.SWITCHBOARD_PAT || '';
    let subRepoDbAction: 'delete' | 'keep' = 'delete';
    for (let i = 3; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === '--parent-dir') { parentDir = argv[++i]; }
        else if (a === '--workspace-name') { workspaceName = argv[++i]; }
        else if (a === '--repo') { repoUrls.push(argv[++i]); }
        else if (a === '--pat') {
            pat = argv[++i];
            console.warn('[switchboard] --pat is visible in the process list. Prefer SWITCHBOARD_PAT env var.');
        }
        else if (a === '--keep-sub-repo-db') { subRepoDbAction = 'keep'; }
    }

    if (!parentDir) { console.error('Usage: npx switchboard scaffold --parent-dir <dir> --workspace-name <name> --repo <url> [--repo <url>...]'); process.exit(1); }
    if (!workspaceName) { console.error('--workspace-name is required'); process.exit(1); }
    if (repoUrls.length === 0) { console.error('At least one --repo <url> is required'); process.exit(1); }
    if (!pat) { console.error('PAT is required. Pass --pat <token> or set SWITCHBOARD_PAT env var.'); process.exit(1); }

    __setStandaloneWorkspaceRoot(scaffoldWorkspace);
    KanbanDatabase.setPathConfigProvider(new StandaloneHostPathConfigProvider(scaffoldWorkspace));
    const repoRoot = path.resolve(__dirname, '..', '..');

    console.log(`[switchboard] Scaffolding multi-repo control plane into ${parentDir}…`);
    const result = await MultiRepoScaffoldingService.scaffold(
        { parentDir, workspaceName, repoUrls, pat, headlessDefaults: { subRepoDbAction } },
        repoRoot
    );

    // Print per-repo status table
    for (const repo of result.repos) {
        const tag = repo.status === 'cloned' ? '✓' : repo.status === 'skipped' ? '○' : '✗';
        console.log(`  ${tag} ${repo.dir} — ${repo.status}${repo.error ? ': ' + repo.error : ''}`);
    }
    if (result.warnings?.length) {
        console.log('Warnings:');
        for (const w of result.warnings) { console.log(`  ! ${w}`); }
    }
    if (result.success) {
        console.log(`\n[switchboard] Workspace file: ${result.workspaceFilePath}`);
        console.log(`[switchboard] Open with: code "${result.workspaceFilePath}"`);
        process.exit(0);
    } else {
        console.error(`\n[switchboard] Scaffold failed: ${result.error || 'unknown error'}`);
        process.exit(1);
    }
}
```

### `src/standalone/cli.ts` — Add `control-plane` subcommand (detect + migrate)

```typescript
if (process.argv[2] === 'control-plane') {
    const sub = process.argv[3];
    const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
    const { ControlPlaneMigrationService } = require('../services/ControlPlaneMigrationService');
    const { StandaloneHostPathConfigProvider } = require('./hostServices');
    const { KanbanDatabase } = require('../services/KanbanDatabase');

    const cpWorkspace = path.resolve(args.workspace || process.cwd());
    __setStandaloneWorkspaceRoot(cpWorkspace);
    KanbanDatabase.setPathConfigProvider(new StandaloneHostPathConfigProvider(cpWorkspace));
    const repoRoot = path.resolve(__dirname, '..', '..');

    if (sub === 'detect') {
        const candidate = await ControlPlaneMigrationService.detectCandidateParent(cpWorkspace);
        console.log(JSON.stringify(candidate, null, 2));
        process.exit(0);
    } else if (sub === 'preview') {
        const parentDir = process.argv[4];
        if (!parentDir) { console.error('Usage: npx switchboard control-plane preview <parent-dir>'); process.exit(1); }
        const preview = await ControlPlaneMigrationService.previewMigration(parentDir);
        console.log(JSON.stringify(preview, null, 2));
        process.exit(0);
    } else if (sub === 'migrate') {
        const parentDir = process.argv[4];
        if (!parentDir) { console.error('Usage: npx switchboard control-plane migrate <parent-dir>'); process.exit(1); }
        const result = await ControlPlaneMigrationService.executeMigration(parentDir, { extensionPath: repoRoot });
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
    } else {
        console.error('Usage: npx switchboard control-plane <detect|preview|migrate> [parent-dir]');
        process.exit(1);
    }
}
```

### `src/standalone/cli.ts` — Update `usage()` help text

Add the new subcommands to the usage string.

### `src/services/SetupPanelProvider.ts` — Add `_headless` flag

Add a public `_headless: boolean = false` field. The standalone bootstrap sets it to `true` (`bootstrap.ts`). The `scaffoldMultiRepo` case reads it to decide whether to pass `headlessDefaults`.

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts" />

## Verification Plan

1. **Headless dialog fix test** — Add `src/test/multi-repo-scaffold-headless-defaults.test.js`:
   - Create a temp parent dir, a temp sub-repo with a `.switchboard/kanban.db`.
   - Call `MultiRepoScaffoldingService.scaffold({ ..., headlessDefaults: { subRepoDbAction: 'delete' } }, repoRoot)`.
   - Assert the sub-repo DB is deleted, `cleanupAction === 'deleted'`, scaffold succeeds, and a warning is in `result.warnings`.
   - Assert `headlessDefaults: { subRepoDbAction: 'keep' }` keeps the DB and adds a warning.
   - Assert `headlessDefaults: undefined` (extension mode) still calls `vscode.window.showWarningMessage` (mock it and assert it was called).

2. **CLI scaffold smoke test** — Spawn `node dist/standalone/cli.js scaffold --parent-dir <tmp> --workspace-name test-ws --repo https://github.com/octocat/Hello-World.git --pat <token>` with `SWITCHBOARD_PAT`. Assert:
   - The repo is cloned into `<tmp>/Hello-World/`.
   - The parent has `.switchboard/kanban.db`, `.agents/`, `AGENTS.md`.
   - A `test-ws.code-workspace` file is generated and its path is printed.
   - Exit code 0.

3. **CLI scaffold with existing sub-repo DB** — Pre-create `<tmp>/Hello-World/.switchboard/kanban.db`. Run scaffold. Assert (with the headless fix) the DB is deleted and scaffold succeeds (exit 0), not cancelled.

4. **CLI control-plane detect/preview/migrate** — Set up a parent dir with two child repos each having `.switchboard/kanban.db`. Run `control-plane detect` → assert JSON output with discovered repos. Run `control-plane preview <parent>` → assert preview JSON. Run `control-plane migrate <parent>` → assert child DBs are consolidated into the parent and exit 0.

5. **PAT not leaked** — Run scaffold with a bad PAT that causes a clone failure. Assert the error message does NOT contain the PAT string (verify `sanitizeErrorText` scrubs it). Assert the console output never prints the PAT.

6. **Browser-UI scaffold in standalone** — Start the standalone server, open the Setup panel in the browser, trigger multi-repo scaffold with an existing sub-repo DB. Assert it no longer silently cancels — it deletes the DB and succeeds (the `_headless` flag path).
