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

## User Review Required

- **Headless default = DELETE sub-repo DB.** When an existing sub-repo `kanban.db` is found in headless mode, the default action is to delete it (the control-plane parent is authoritative), recorded in `RepoOutcome.cleanupAction` plus a warning. The CLI exposes `--keep-sub-repo-db` to opt out. Confirm delete-by-default is acceptable for the browser-UI standalone path, where there is no dialog to ask.
- **`control-plane migrate` never cleans up source `.switchboard/` dirs unless told.** Source cleanup is opt-in via `--cleanup <repo>` / `--cleanup-all` (maps to `MigrationOptions.cleanupConfirmed`). Default is leave-in-place (safe).
- **Integration sync gap (accepted).** Headless `migrate` skips `switchboard.syncImportedPlans` (shim no-op) — imported plans will not sync to ClickUp/Linear until the workspace is next opened in the extension. The CLI prints a warning saying so.

## Complexity Audit (Routine vs Complex/Risky)

### Routine
- Adding `scaffold` and `control-plane` subcommands to `cli.ts` (mirrors the `secrets` / `init` pattern).
- Calling `MultiRepoScaffoldingService.scaffold(options, repoRoot)` from the CLI — it is a static async method returning a `ScaffoldResult`.
- Calling `ControlPlaneMigrationService.detectCandidateParent` / `previewMigration` / `executeMigration` from the CLI.
- Console output formatting for scaffold results (per-repo status table).

### Complex / Risky
- **Fixing the `_reviewSubRepoDb` dialog no-op.** The method uses `vscode.window.showWarningMessage` which is a no-op in standalone. The fix must not break the extension path (where the dialog is real and the user's choice matters). Approach: add an optional `headlessDefaults` parameter to `scaffold()` / `_reviewSubRepoDb` that, when set, skips the dialog and applies the default action (delete sub-repo DB = the recommended action). The standalone CLI and the standalone bootstrap's SetupPanelProvider wiring both pass `headlessDefaults: { subRepoDbAction: 'delete' }`. The extension path passes nothing (undefined) and gets the real dialog. This is a backward-compatible optional parameter.
- **`_offerReopenWorkspace` dialog no-op.** `showInformationMessage` returns `undefined` in standalone → no reopen. This is non-fatal (the workspace file is still generated and the path is printed). For the CLI, "reopen in VS Code" is meaningless anyway — the CLI should just print the workspace file path. For the browser-UI path in standalone, the reopen prompt is a no-op (acceptable — the user can open the file manually). Fix: make `_offerReopenWorkspace` a no-op when `vscode.window.showInformationMessage` returns `undefined` (it already is — the `if (selection === reopenAction)` just doesn't fire). No code change needed here; just ensure the workspace file path is in the `ScaffoldResult` (it already is at `:365`).
- **PAT handling on the CLI.** The multi-repo scaffold requires a PAT (`MultiRepoScaffoldingService._normalizeOptions` at `:212-215` throws if missing). On the CLI, the PAT must be passed via a flag (`--pat`) or an env var (`SWITCHBOARD_PAT`). The PAT must NOT be echoed or logged. `safeClone` already scrubs the PAT from error messages (`stripSensitiveText` at `:76-101`). The CLI must not print the PAT in any output. Use `--pat` flag (typed as password) with env-var fallback; never echo it.
- **`ControlPlaneMigrationService._getProtocolTargets` config read.** Same as the init plan — `__setStandaloneWorkspaceRoot` must be called before any `ControlPlaneMigrationService` method that reads `vscode.workspace.getConfiguration`. The `executeMigration` path calls `bootstrapControlPlaneLayout` (`:208`) which calls `_getProtocolTargets`.

## Edge-Case & Dependency Audit

1. **Existing sub-repo `kanban.db` in headless mode** — The current code cancels the scaffold. The fix: when `headlessDefaults` is set, default to deleting the sub-repo DB (the recommended action, `DELETE_SUB_REPO_DB_ACTION`). This matches the control-plane model where the parent DB is authoritative. The outcome should still be recorded in `RepoOutcome.cleanupAction = 'deleted'` and a warning pushed. If the delete fails (permission error), record the error in `outcome.error` and continue (same as the current keep-path error handling).

2. **`--pat` security** — The PAT is passed via `--pat <token>` or `SWITCHBOARD_PAT` env var. It must never appear in:
   - Console output (the scaffold result prints repo URLs, not the PAT — `ScaffoldResult` does not include the PAT).
   - Error messages (`sanitizeErrorText` at `:103-105` scrubs it).
   - Process arguments visible to other users (`ps aux`). On macOS/Linux, `--pat <token>` is visible in the process list. Prefer `SWITCHBOARD_PAT` env var as the default, with `--pat` as a convenience that prints a warning recommending the env var. Alternatively, support `--pat-stdin` (read from stdin) for maximum safety. Start with env var + `--pat` flag + a warning.

3. **All repos fail to clone** — `MultiRepoScaffoldingService._doScaffold` returns `{ success: false, error: 'No repositories were available...' }` (`:342-349`). The CLI must print this error and exit non-zero. The control-plane layout and DB are already created at this point (parent dir scaffolded at `:261-275`) — this is acceptable (the parent is a valid empty control plane; the user can re-run scaffold or add repos manually).

4. **Partial clone failure** — Some repos clone, some fail. `ScaffoldResult.repos` has per-repo `status: 'failed'` with `error`. The CLI must print a per-repo status table and exit non-zero if any repo failed. The `.code-workspace` file is generated with only the successful repos (`:351-355`), and a warning is added (`:357-359`).

5. **Control plane `executeMigration` from CLI** — Verified during improve pass (not deferred to implementation): `executeMigration` (`:187-313`) contains **no `vscode.window` dialogs**, but it is NOT pure filesystem either:

> **Superseded:** "Audit `ControlPlaneMigrationService.executeMigration` (`:328` area) for any `vscode.window` calls… The migration preview/execute themselves appear to be pure filesystem operations. Verify during implementation."
> **Reason:** Verified now. There are zero `vscode.window` calls in the whole service, but `executeMigration` makes two `vscode.commands.executeCommand` calls that are no-ops under the shim (`vscodeShim.ts:229`): `switchboard.syncImportedPlans` (`:278`) — imported plans silently skip ClickUp/Linear integration sync headless — and `vscode.openFolder` (`:291-295`) — harmless (CLI prints `workspaceFilePath` from the result instead).
> **Replaced with:** No `headlessDefaults` needed for `executeMigration`. The CLI migrate handler prints a warning that integration sync of imported plans is deferred to the next extension open of the workspace, and prints the workspace file path itself.

6. **`detectCandidateParent` from CLI** — This scans a parent dir for child repos. It is a read-only static method (`:106-121`). Safe to call from CLI. Print the discovered repos and warnings as a table.

7. **Workspace file path on macOS** — `generateCodeWorkspace` writes a `.code-workspace` file. The CLI should print the absolute path so the user can open it with `code <path>`.

8. **Interaction with running server** — `findRunningInstance` (`cli.ts:110-117`) checks for an existing server before start. The `scaffold` / `control-plane` subcommands should NOT check for a running server — they are one-shot operations, not server starts. They should run and exit regardless of whether a server is running. Place them before the `findRunningInstance` check (same position as `init` and `secrets`).

9. **Source cleanup is gated on `cleanupConfirmed` — the CLI must opt in explicitly** — `executeMigration` only archives a source repo's `.switchboard/` when its name appears in `MigrationOptions.cleanupConfirmed` (`:246-249`); otherwise `cleanupAction` is `'left in place'`. The CLI `migrate` handler must expose `--cleanup <repoName>` (repeatable) and `--cleanup-all` (populate from the preview's source list) and pass them through. Default: leave in place — destructive cleanup is never the implicit default.

10. **Snippet-level corrections from the improve pass** — (a) Flag parsing in the scaffold handler must use `process.argv[++i]` — `argv` is not in scope in `main()` (it is `parseArgs`'s parameter name). (b) Partial clone failure: `result.success` is `true` even when individual repos have `status: 'failed'` — the CLI must exit non-zero when `result.repos.some(r => r.status === 'failed')`, per edge case 4; checking `result.success` alone would report a half-failed scaffold as success.

## Dependencies

- Sibling plan `feature_plan_20260804081225_standalone-init-scaffolding-command.md` (same feature) should land FIRST: it establishes the CLI subcommand block placement, the `__setStandaloneWorkspaceRoot` → config-write ordering idiom, and the `usage()` help text layout that this plan's subcommands extend. Shared file `src/standalone/cli.ts` is edited by both — merging this plan's changes onto the init plan's `usage()` text avoids a help-text conflict.

## Adversarial Synthesis

Key risks: headless delete default destroying a wanted sub-repo DB (mitigated by recorded `cleanupAction`, warnings, and `--keep-sub-repo-db`); a half-failed scaffold reporting success (mitigated by exit-non-zero on any failed repo); CLI `migrate` silently skipping integration sync and source cleanup (mitigated by printed warnings and explicit `--cleanup` flags). The `headlessDefaults` parameter keeps the shipped extension's dialog path byte-identical (PRD contract #2). PAT safety relies on existing `stripSensitiveText`/`sanitizeErrorText` scrubbing plus never echoing the flag value.

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

The standalone SetupPanelProvider calls `MultiRepoScaffoldingService.scaffold` via the `scaffoldMultiRepo` verb (`SetupPanelProvider.ts:512-524`). The SetupPanelProvider does not currently pass `headlessDefaults`. Two options:

**Option A (preferred):** Patch the `scaffoldMultiRepo` case in `SetupPanelProvider.ts` to detect headless mode (check a `_headless` flag) and inject `headlessDefaults: { subRepoDbAction: 'delete' }`. The standalone bootstrap already injects `_hostSeams` post-construction (`bootstrap.ts:592`); the extension does not set this flag. Add a `_headless` boolean to `SetupPanelProvider` set by the standalone bootstrap.

```typescript
// bootstrap.ts, immediately after the existing injections at :592-593:
(setupProvider as any)._headless = true;
```

```typescript
// SetupPanelProvider.ts, scaffoldMultiRepo case (:512-524):
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

Placed after the `init` block (sibling plan), before `findRunningInstance` (`cli.ts:206`). Reuses the already-resolved `workspaceRoot` (`cli.ts:150`) for the shim/config-provider root. **Flag parsing must use `process.argv` — `argv` is not in scope in `main()`.**

```typescript
if (process.argv[2] === 'scaffold') {
    const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
    const { MultiRepoScaffoldingService } = require('../services/MultiRepoScaffoldingService');
    const { StandaloneHostPathConfigProvider } = require('./hostServices');
    const { KanbanDatabase } = require('../services/KanbanDatabase');

    // Parse scaffold-specific flags (process.argv — NOT argv, which is out of scope here)
    let parentDir = '';
    let workspaceName = '';
    let repoUrls: string[] = [];
    let pat = process.env.SWITCHBOARD_PAT || '';
    let subRepoDbAction: 'delete' | 'keep' = 'delete';
    for (let i = 3; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === '--parent-dir') { parentDir = process.argv[++i]; }
        else if (a === '--workspace-name') { workspaceName = process.argv[++i]; }
        else if (a === '--repo') { repoUrls.push(process.argv[++i]); }
        else if (a === '--pat') {
            pat = process.argv[++i];
            console.warn('[switchboard] --pat is visible in the process list. Prefer SWITCHBOARD_PAT env var.');
        }
        else if (a === '--keep-sub-repo-db') { subRepoDbAction = 'keep'; }
    }

    if (!parentDir) { console.error('Usage: npx switchboard scaffold --parent-dir <dir> --workspace-name <name> --repo <url> [--repo <url>...]'); process.exit(1); }
    if (!workspaceName) { console.error('--workspace-name is required'); process.exit(1); }
    if (repoUrls.length === 0) { console.error('At least one --repo <url> is required'); process.exit(1); }
    if (!pat) { console.error('PAT is required. Pass --pat <token> or set SWITCHBOARD_PAT env var.'); process.exit(1); }

    __setStandaloneWorkspaceRoot(workspaceRoot);
    KanbanDatabase.setPathConfigProvider(new StandaloneHostPathConfigProvider(workspaceRoot));
    const repoRoot = path.resolve(__dirname, '..', '..'); // package root (bundled .agents/ + AGENTS.md)

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
    // Partial failure: success=true can still carry failed repos (edge case 4) —
    // a half-failed scaffold must NOT exit 0.
    const anyFailed = result.repos.some(r => r.status === 'failed');
    if (result.success) {
        console.log(`\n[switchboard] Workspace file: ${result.workspaceFilePath}`);
        console.log(`[switchboard] Open with: code "${result.workspaceFilePath}"`);
        process.exit(anyFailed ? 1 : 0);
    } else {
        console.error(`\n[switchboard] Scaffold failed: ${result.error || 'unknown error'}`);
        process.exit(1);
    }
}
```

### `src/standalone/cli.ts` — Add `control-plane` subcommand (detect + migrate)

`migrate` exposes opt-in source cleanup (`--cleanup <repo>` repeatable, `--cleanup-all`) mapped to `MigrationOptions.cleanupConfirmed` (`:246-249`), and warns about the headless integration-sync gap (`:278` shim no-op).

```typescript
if (process.argv[2] === 'control-plane') {
    const sub = process.argv[3];
    const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
    const { ControlPlaneMigrationService } = require('../services/ControlPlaneMigrationService');
    const { StandaloneHostPathConfigProvider } = require('./hostServices');
    const { KanbanDatabase } = require('../services/KanbanDatabase');

    __setStandaloneWorkspaceRoot(workspaceRoot);
    KanbanDatabase.setPathConfigProvider(new StandaloneHostPathConfigProvider(workspaceRoot));
    const repoRoot = path.resolve(__dirname, '..', '..');

    if (sub === 'detect') {
        const candidate = await ControlPlaneMigrationService.detectCandidateParent(workspaceRoot);
        console.log(JSON.stringify(candidate, null, 2));
        process.exit(0);
    } else if (sub === 'preview') {
        const parentDir = process.argv[4];
        if (!parentDir) { console.error('Usage: npx switchboard control-plane preview <parent-dir>'); process.exit(1); }
        const preview = await ControlPlaneMigrationService.previewMigration(parentDir);
        console.log(JSON.stringify(preview, null, 2));
        process.exit(0);
    } else if (sub === 'migrate') {
        // Parse: npx switchboard control-plane migrate <parent-dir> [--cleanup <repo>...] [--cleanup-all]
        const positional: string[] = [];
        const cleanupRepos: string[] = [];
        let cleanupAll = false;
        for (let i = 4; i < process.argv.length; i++) {
            const a = process.argv[i];
            if (a === '--cleanup') { cleanupRepos.push(process.argv[++i]); }
            else if (a === '--cleanup-all') { cleanupAll = true; }
            else { positional.push(a); }
        }
        const parentDir = positional[0];
        if (!parentDir) { console.error('Usage: npx switchboard control-plane migrate <parent-dir> [--cleanup <repo>...] [--cleanup-all]'); process.exit(1); }

        let cleanupConfirmed = cleanupRepos;
        if (cleanupAll) {
            const preview = await ControlPlaneMigrationService.previewMigration(parentDir);
            cleanupConfirmed = [...new Set([...cleanupRepos, ...preview.sources.map(s => s.repoName)])];
        }

        const result = await ControlPlaneMigrationService.executeMigration(parentDir, {
            extensionPath: repoRoot,
            cleanupConfirmed
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.success) {
            // Headless gap: executeMigration's switchboard.syncImportedPlans call (:278)
            // is a shim no-op — imported plans sync to ClickUp/Linear on next extension open.
            console.warn('[switchboard] Note: integration sync of imported plans is deferred — open this workspace in the VS Code extension to sync ClickUp/Linear.');
            if (result.workspaceFilePath) {
                console.log(`[switchboard] Workspace file: ${result.workspaceFilePath}`);
            }
        }
        process.exit(result.success ? 0 : 1);
    } else {
        console.error('Usage: npx switchboard control-plane <detect|preview|migrate> [parent-dir] [--cleanup <repo>...] [--cleanup-all]');
        process.exit(1);
    }
}
```

### `src/standalone/cli.ts` — Update `usage()` help text

Extend the usage string the sibling `init` plan establishes (`cli.ts:8-30`) — do NOT rewrite it wholesale; append the new lines so the two plans merge cleanly:

```
       npx switchboard scaffold --parent-dir <dir> --workspace-name <name> --repo <url> [--repo <url>...] [--pat <token>] [--keep-sub-repo-db]
       npx switchboard control-plane detect
       npx switchboard control-plane preview <parent-dir>
       npx switchboard control-plane migrate <parent-dir> [--cleanup <repo>...] [--cleanup-all]

Options (scaffold / control-plane):
  --pat <token>        PAT for cloning (visible in process list — prefer SWITCHBOARD_PAT env var)
  --keep-sub-repo-db   Keep an existing sub-repo kanban.db instead of deleting it (headless default: delete)
  --cleanup <repo>     migrate: archive the named source repo's .switchboard/ after merging (repeatable)
  --cleanup-all        migrate: archive ALL source repos' .switchboard/ after merging
```

### `src/services/SetupPanelProvider.ts` — Add `_headless` flag

Add a public `_headless: boolean = false` field. The standalone bootstrap sets it to `true` (`bootstrap.ts`). The `scaffoldMultiRepo` case reads it to decide whether to pass `headlessDefaults`.

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts" />

## Verification Plan

Manual smoke verification only — no project compilation step and no automated tests are run as part of this plan's verification (session directive). All checks run against the already-built `dist/standalone/cli.js` bundle.

1. **Headless dialog fix — direct service check** — In a Node REPL/script against the built bundle: create a temp parent dir and a temp sub-repo with a pre-made `.switchboard/kanban.db`, call `MultiRepoScaffoldingService.scaffold({ ..., headlessDefaults: { subRepoDbAction: 'delete' } }, repoRoot)`. Assert the sub-repo DB is gone, the outcome's `cleanupAction === 'deleted'`, scaffold succeeds, and a warning is present. Repeat with `'keep'` — DB survives, warning present. (Extension-mode dialog path is unchanged by construction: `headlessDefaults` absent ⇒ identical code path.)

2. **CLI scaffold smoke test** — Run:
   ```
   SWITCHBOARD_PAT=<token> node dist/standalone/cli.js scaffold --parent-dir /tmp/sb-cp-test --workspace-name test-ws --repo https://github.com/octocat/Hello-World.git
   ```
   Assert: the repo is cloned into `/tmp/sb-cp-test/Hello-World/`; the parent has `.switchboard/kanban.db`, `.agents/`, `AGENTS.md`; a `test-ws.code-workspace` file is generated and its absolute path printed; exit code 0. Assert the PAT string appears nowhere in the output.

3. **CLI scaffold with existing sub-repo DB** — Pre-create `/tmp/sb-cp-test2/Hello-World/.switchboard/kanban.db` (e.g. by cloning manually first), then run the scaffold command against `/tmp/sb-cp-test2`. Assert (with the headless fix) the DB is deleted, a warning is printed, and the scaffold succeeds (exit 0) — NOT cancelled with "Scaffold cancelled while reviewing sub-repo database cleanup."

4. **CLI scaffold partial failure** — Run scaffold with one valid repo URL and one bogus URL (`--repo https://github.com/octocat/does-not-exist-999.git`). Assert: the per-repo table shows `✓` and `✗` rows, the workspace file is generated for the successful repo only, and the exit code is **non-zero** (edge case 4).

5. **CLI control-plane detect/preview/migrate** — Set up a parent dir with two child repos each having `.switchboard/kanban.db` (seed each via `switchboard init` in the child, or by hand). Run `control-plane detect` → assert JSON output. Run `control-plane preview <parent>` → assert preview JSON lists both sources. Run `control-plane migrate <parent>` → assert child DB rows are merged into the parent DB, `cleanupAction` is `left in place` for both (no `--cleanup` passed), the integration-sync deferred warning prints, and exit 0. Re-run `control-plane migrate <parent> --cleanup-all` on a fresh copy → assert `cleanupAction` reflects archival.

6. **PAT not leaked** — Run scaffold with a deliberately bad PAT causing a clone failure. Assert the printed error does NOT contain the PAT string (the existing `stripSensitiveText`/`sanitizeErrorText` scrubbing at `MultiRepoScaffoldingService.ts:76-105`).

7. **Browser-UI scaffold in standalone** — Start the standalone server, open the Setup panel in the browser, trigger multi-repo scaffold with an existing sub-repo DB. Assert it no longer silently cancels — it deletes the DB and succeeds (the `_headless` flag path), and the `multiRepoScaffoldResult` message shows `cleanupAction: 'deleted'`.

## Review Findings

Files changed: `src/standalone/cli.ts`, `src/services/ControlPlaneMigrationService.ts`, `src/test/multi-repo-scaffolding.test.js`, `src/test/control-plane-repo-scope.test.js`. Fixed: (1) CRITICAL — `control-plane migrate` failed on **every** fresh parent because `executeMigration` used `ensureReady()`, which opens an existing DB but never creates one, aborting before any repo was touched (now `createIfMissing()` + `flushPersist()`, matching the sibling scaffold path); (2) MAJOR — `detect/preview/migrate` emitted unparseable stdout, since `_loadSqlJs` (`console.log`) and the V17/V18/V27/V29 migration notices (`console.debug`/`console.info`, both stdout in Node) prefixed the payload, so `| jq` failed — log/info/debug now route to stderr and the JSON is written directly; (3) MAJOR — `scaffold`/`control-plane` installed the shim + `KanbanDatabase` path provider against the **cwd** rather than the target dir, letting a stray `protocol.target`/`kanban.dbPath` in the launch directory govern or relocate the control plane; (4) MAJOR — the pre-dispatch `mkdir` littered `.switchboard/` into any launch directory including `$HOME`, bypassing `isAllowedSwitchboardLocation`. Validation: `compile-tests`/`compile`/five PRD gates green, eslint 0 errors; the headless fix verified directly against a no-op-dialog mock (silent cancel reproduces without `headlessDefaults`, `delete` removes the DB with `cleanupAction: 'deleted'`, `keep` preserves it, PAT never present in any result); all three `control-plane` subcommands exit 0 with pure valid JSON, `migrate` copies plan files and leaves sources in place by default while `--cleanup-all` archives to `.switchboard.migrated.bak`; `multi-repo-scaffolding.test.js` went red→green (its `break;`-anchored source regex was stale after the verb-return migration). Remaining risks: the end-to-end CLI `scaffold` clone path is unverified (needs network + a real PAT, so `--pat` scrubbing was only checked via the service-level result), and `control-plane-migration.test.js`/`control-plane-repo-scope.test.js` are still red at later **pre-existing** assertions (`importPlanFiles` discovery and `getCompletedPlansFilteredByProject`) unrelated to this feature.
