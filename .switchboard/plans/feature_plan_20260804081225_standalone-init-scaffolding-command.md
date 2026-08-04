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
- The standalone bootstrap already resolves the package root via `resolveRepoRoot()` (`bootstrap.ts:110-113`, two levels up from `__dirname` — with `node.__dirname: false` in `webpack.config.js:158-160`, `__dirname` is `dist/standalone/` at runtime, so two levels up is the **package root**, the parent of `dist/`; `bootstrap.ts:509` proves this by resolving `path.join(repoRoot, 'dist', 'webview')`), and passes it as `extensionPath` / `extensionUri.fsPath` to providers (`bootstrap.ts:569-570`). The bundled `.agents/` and `AGENTS.md` live at the package root (repo root in dev), so `extensionPath` is available in standalone mode.
- `KanbanDatabase.forWorkspace(root).createIfMissing()` (`MultiRepoScaffoldingService.ts:265-273`) initialises the DB file.
- `ensureWorkspaceIdentity(root)` (`WorkspaceIdentityService`) writes the workspace-id file.

### Root Cause
The standalone CLI was built with a `secrets` subcommand and a server-start path, but never received an `init` subcommand. The scaffolding services (`ControlPlaneMigrationService`, `KanbanDatabase`, `WorkspaceIdentityService`) are already callable from Node without VS Code — the standalone bootstrap itself calls them — but the CLI entry point (`cli.ts`) does not wire them into a user-facing command. The one `mkdirSync` for `.switchboard/` is the only scaffolding the CLI performs, and it is insufficient.

## Metadata
**Complexity:** 4
**Tags:** cli, feature, infrastructure
**Project:** Browser Switchboard

## User Review Required

- **`--target` persists.** Writing `--target <agents|claude|both>` to `.switchboard/config.json` makes the choice sticky for the workspace — subsequent server starts and extension activations in that repo will honour it. This is deliberate (the user declared their protocol target), but confirm you want flag-persists-config semantics rather than a one-shot override.
- **No new config-provider API.** The improve pass confirmed the existing `updateConfigWorkspace` write path covers `--target`; no `setConfigString` will be added.

## Complexity Audit (Routine vs Complex/Risky)

### Routine
- Adding a new `init` subcommand to `cli.ts` (mirrors the existing `secrets` subcommand pattern at `cli.ts:161-203`).
- Calling `ControlPlaneMigrationService.bootstrapControlPlaneLayout(workspaceRoot, repoRoot)` — already a static method, already called from standalone bootstrap's provider wiring.
- Calling `KanbanDatabase.forWorkspace(root).createIfMissing()` + `ensureWorkspaceIdentity(root)` — already called in `MultiRepoScaffoldingService._doScaffold` and `bootstrap.ts`.
- Console output for success/failure.

### Complex / Risky
- `bootstrapControlPlaneLayout` internally calls `_getProtocolTargets` (`ControlPlaneMigrationService.ts:752-763`) which reads `vscode.workspace.getConfiguration('switchboard')`. In standalone, `vscode` is the shim (`vscodeShim.ts:192-194`) whose `workspace.getConfiguration` reads `.switchboard/config.json` via `StandaloneHostPathConfigProvider._rawValue`, keyed off `__SWITCHBOARD_STANDALONE_WORKSPACE_ROOT` (falling back to `process.cwd()` if unset). The `init` command must call `__setStandaloneWorkspaceRoot(workspaceRoot)` **before** invoking `bootstrapControlPlaneLayout`, otherwise the config read resolves against the wrong root and `protocol.target` may not be honoured. This is the same ordering constraint `bootstrap.ts:282` already respects.
- `bootstrapControlPlaneLayout` calls `isAllowedSwitchboardLocation(parentDir, parentDir)` (`switchboardLocationGuard.ts`). In standalone, `anyOtherFolderOwnsControlPlane` reads `vscode.workspace.workspaceFolders` — the shim returns `[]` (`vscodeShim.ts:189`), so the guard reduces to "not home dir / not filesystem root", which is correct for a single-repo init. No risk.
- The `--target` flag (agents/claude/both) must override `protocol.target` config for the init run, since a CLI user may not have a config file yet. The cleanest path: write it via the existing `StandaloneHostPathConfigProvider.updateConfigWorkspace('protocol.target', target)` before calling bootstrap (writes `switchboard.protocol.target` to `.switchboard/config.json` — exactly the key the shim reads). No new provider method is needed.

## Edge-Case & Dependency Audit

1. **Re-init over existing scaffolding** — `bootstrapControlPlaneLayout` is idempotent: directories use `mkdir recursive`, `AGENTS.md`/`CLAUDE.md` copies are file-absence-gated (`:707`, `:724`), `.agents/` copy uses `overwrite: false, overwriteIfDiffers: true` (`:697`). `kanban.db` `createIfMissing` is a no-op if the DB already exists. Re-running `init` must be safe and not clobber user edits. ✓ Already handled.

2. **`kanban.db` already exists and is non-empty** — `createIfMissing` must not wipe data. Confirmed by its contract (`KanbanDatabase.ts:1807-1809`): it returns `true` if the DB now exists, **created or already present**, `false` only on error — no truncation. The `MultiRepoScaffoldingService` path (`:266-273`) treats `created === false` as a hard failure; for `init` a pre-existing valid DB should be a success-with-note, not an error. The init command should distinguish "created" from "already exists and valid" (check `fs.existsSync(db.dbPath)` before calling).

3. **`--target` flag with no config file** — If the user passes `--target claude` but no `.switchboard/config.json` exists, the flag must still be honoured.

> **Superseded:** Approach: write `switchboard.protocol.target` via a new `configProvider.setConfigString('protocol.target', target)` method (to be added to `StandaloneHostPathConfigProvider` if absent); alternative considered was refactoring `_getProtocolTargets` to accept an explicit override.
> **Reason:** `setConfigString` does not exist on `StandaloneHostPathConfigProvider` (verified — the class has getters only, `hostServices.ts:76-106`), but it does not need to: `updateConfigWorkspace('protocol.target', target)` (`hostServices.ts:114-119`) already writes `switchboard.protocol.target` to `.switchboard/config.json` and saves — byte-for-byte the key the shim's `getConfiguration('switchboard').get('protocol.target')` resolves through `_rawValue`'s prefixed lookup (`hostServices.ts:70-71`). Note `vscode.workspace.getConfiguration(...).update(...)` is NOT an alternative — the shim's `update()` is a deliberate no-op (`vscodeShim.ts:178`).
> **Replaced with:** Call the existing `await configProvider.updateConfigWorkspace('protocol.target', target)` in the init handler before `bootstrapControlPlaneLayout`. No provider changes. Side effect (intentional): the flag persists as workspace config — see User Review Required.

4. **Bundle path resolution** — `resolveRepoRoot()` (`bootstrap.ts:110-113`) resolves `path.resolve(__dirname, '..', '..')`.

> **Superseded:** "In the webpacked standalone bundle, `__dirname` is `dist/standalone/`, so repo root is `dist/`. The bundled `.agents/` and `AGENTS.md` must be at `dist/.agents/` and `dist/AGENTS.md`. Verify the webpack config copies these (check `webpack.config.js` copy patterns)."
> **Reason:** The path arithmetic is wrong: two levels up from `dist/standalone/` is the **package root** (parent of `dist/`), not `dist/` — `bootstrap.ts:509` proves it by resolving webview assets as `path.join(repoRoot, 'dist', 'webview')`. And `standaloneConfig` (`webpack.config.js:128-171`) has **no CopyPlugin at all** (BannerPlugin only) — there is no webpack copy step to verify. `.agents/` and `AGENTS.md` are found because they live at the package root, which in dev is the repo checkout root.
> **Replaced with:** The init command resolves `repoRoot = path.resolve(__dirname, '..', '..')` (package root) and relies on `.agents/` + `AGENTS.md` existing there. The runtime guard is the plan's existsSync warning (below), which is load-bearing: `bootstrapControlPlaneLayout` silently skips the copy when `<repoRoot>/.agents` is absent (`:693`). Packaging note for B4 (npx distribution): the npm tarball MUST include `.agents/` and `AGENTS.md` at the package root — package.json currently has no `files` field and npm publishing is an explicit non-goal today (`scripts/package-targets.sh:59-64`); when B4 lands, express inclusions via `.npmignore`, not `files`.

5. **Non-repo directory** — User runs `npx switchboard init` in a plain directory (no `.git`). `bootstrapControlPlaneLayout` does not require git. `isAllowedSwitchboardLocation` blocks home dir and filesystem root only. This should work (Switchboard can manage a non-git folder). No special handling needed, but the success message should note "no git repository detected" as an FYI.

6. **`--workspace` flag interaction** — The existing `--workspace <path>` flag (`cli.ts:64`) sets the workspace root for server start. The `init` subcommand should reuse it: `npx switchboard init --workspace /path/to/repo`. If omitted, default to `process.cwd()` (same as server start at `cli.ts:150`).

7. **Permission errors** — `mkdir recursive` / file copies may fail on read-only filesystems or permission-denied. Wrap in try/catch and print a clear error with the path. Do not leave a partial scaffold silently — `bootstrapControlPlaneLayout` creates directories first then copies files; a mid-copy failure leaves directories but missing files, which is the same partial state the extension can leave. Acceptable (re-running `init` completes it).

8. **Early generic guards in `cli.ts` already run** — `main()` resolves `workspaceRoot` (`:150`), exits if it doesn't exist (`:151-154`), and creates a bare `.switchboard/` (`:156-159`) **before** subcommand dispatch. The init handler must reuse `workspaceRoot` and must NOT duplicate the existence check or the mkdir; the bare `.switchboard/` mkdir is harmless (init fills it out).

## Dependencies

- None (no prior session plans required). Sibling plan `feature_plan_20260804081226_standalone-multi-repo-scaffold-and-control-plane-cli.md` lands after this one and reuses the subcommand + config-write idioms established here, but neither blocks the other.

## Adversarial Synthesis

Key risks: bundled-file copy silently skipped if `<packageRoot>/.agents` is absent (init would report success with an empty protocol layer); `--target` ignored if `__setStandaloneWorkspaceRoot` runs after bootstrap or if the write goes through the shim's no-op `update()`. Mitigations: load-bearing existsSync warning after bootstrap; existing `updateConfigWorkspace` write path before bootstrap; ordering copied from `bootstrap.ts:282`. The config-write persists `--target` as workspace config — intentional, flagged for user review.

## Proposed Changes

### `src/standalone/cli.ts` — Add `init` subcommand

Add an `init` subcommand handler before the server-start path (after the `secrets` block, before `findRunningInstance` at `:206`). Parse `--target <agents|claude|both>` (default `both`) and reuse the already-resolved `workspaceRoot` (`:150`) / `--workspace` flag (`:64`).

```typescript
// After the secrets block (line ~203), before findRunningInstance.
// NOTE: workspaceRoot is already resolved and existence-checked at :150-154;
// .switchboard/ is already mkdir'd at :156-159. Do not duplicate either.

if (process.argv[2] === 'init') {
    const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
    const { ControlPlaneMigrationService } = require('../services/ControlPlaneMigrationService');
    const { KanbanDatabase } = require('../services/KanbanDatabase');
    const { StandaloneHostPathConfigProvider } = require('./hostServices');
    const { ensureWorkspaceIdentity } = require('../services/WorkspaceIdentityService');

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
    __setStandaloneWorkspaceRoot(workspaceRoot);

    // Persist protocol.target via the EXISTING provider write path so
    // _getProtocolTargets honours --target (shim reads switchboard.protocol.target
    // from .switchboard/config.json). Do NOT use vscode...getConfiguration().update()
    // — the shim's update() is a deliberate no-op (vscodeShim.ts:178).
    const configProvider = new StandaloneHostPathConfigProvider(workspaceRoot);
    KanbanDatabase.setPathConfigProvider(configProvider);
    await configProvider.updateConfigWorkspace('protocol.target', target);

    const repoRoot = path.resolve(__dirname, '..', '..'); // package root; bundled .agents/ + AGENTS.md live here

    console.log(`[switchboard] Initialising Switchboard scaffolding in ${workspaceRoot} (target: ${target})…`);

    try {
        await ControlPlaneMigrationService.bootstrapControlPlaneLayout(workspaceRoot, repoRoot);

        // Initialise kanban.db (createIfMissing returns true if created OR already present)
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const dbExisted = fs.existsSync(db.dbPath);
        const dbCreated = await db.createIfMissing();
        if (!dbCreated) {
            console.error(`[switchboard] Failed to create kanban database at ${db.dbPath}.`);
            process.exit(1);
        }
        if (dbExisted) {
            console.log(`[switchboard] Existing kanban.db kept (${db.dbPath}).`);
        }

        await ensureWorkspaceIdentity(workspaceRoot);

        // Load-bearing warning: bootstrapControlPlaneLayout SILENTLY skips the
        // bundled-file copy when <repoRoot>/.agents is absent (:693).
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
        if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
            console.log(`[switchboard] Note: no git repository detected in ${workspaceRoot}.`);
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

### `src/standalone/hostServices.ts` — NO CHANGE

> **Superseded:** "The init command calls `configProvider.setConfigString('protocol.target', target)`. Verify this method exists and writes to `.switchboard/config.json`. If it only has `getConfigString` (read-only), add a `setConfigString` method…"
> **Reason:** Verified: `setConfigString` does not exist, but the write capability already does — `updateConfigWorkspace(key, value)` (`hostServices.ts:114-119`) writes `switchboard.<key>` to `.switchboard/config.json` and saves. Adding a second write method would fork the provider's write surface for zero gain.
> **Replaced with:** No edit to `hostServices.ts`. The init handler calls the existing `updateConfigWorkspace('protocol.target', target)` (see snippet above).

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/standalone/hostServices.ts" />

### `webpack.config.js` — NO CHANGE (B4 packaging note only)

> **Superseded:** "Verify the webpack config copies `.agents/` and `AGENTS.md` into the output directory so they are present at runtime. If they are not copied, add a copy-webpack-plugin entry."
> **Reason:** `standaloneConfig` (`webpack.config.js:128-171`) has no CopyPlugin — BannerPlugin only. Runtime resolution targets the **package root** (two levels up from `dist/standalone/`), where `.agents/` and `AGENTS.md` already live in the repo checkout. There is no webpack copy step to fix.
> **Replaced with:** No webpack edit. The load-bearing guard is the runtime existsSync warning in the init snippet. The real gap is B4 npx packaging: the published tarball must carry `.agents/` + `AGENTS.md` at the package root (no `files` field exists; npm publishing is a stated non-goal today per `scripts/package-targets.sh:59-64` — express via `.npmignore` when B4 lands).

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/webpack.config.js" />

## Verification Plan

Manual smoke verification only — no project compilation step and no automated tests are run as part of this plan's verification (session directive). All checks run against the already-built `dist/standalone/cli.js` bundle.

1. **Fresh-repo smoke test** — In a fresh temp repo:
   ```
   mkdir /tmp/sb-init-test && cd /tmp/sb-init-test && git init
   node /path/to/switchboard/dist/standalone/cli.js init
   ```
   Verify the full tree exists: `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/`, `.switchboard/kanban.db` (non-zero bytes), `.switchboard/workspace-id`, `.agents/` (non-empty), `AGENTS.md`, `CLAUDE.md`, `.claude/skills/`, `worktrees/`. Then run `node .../cli.js` (server start) in the same dir and confirm the board UI loads with the scaffolded workspace.

2. **`--target` flag check** — In two more temp dirs: run `init --target agents`, assert `AGENTS.md` exists and `CLAUDE.md` / `.claude/` do NOT. Run `init --target claude`, assert the inverse. Assert `.switchboard/config.json` in each contains `switchboard.protocol.target` with the passed value.

3. **Idempotency / non-clobber check** — Hand-edit `AGENTS.md` in the first temp repo (add a marker line), re-run `init`. Assert: exit 0, the marker line survives (file-absence gate at `ControlPlaneMigrationService.ts:707`), and the output prints the "Existing kanban.db kept" note.

4. **Bundled-files-missing warning check** — Temporarily rename the package-root `.agents/` dir, run `init` in a fresh temp dir, assert the "bundled .agents/ not found" warning prints and the directory-only scaffold still succeeds. Restore `.agents/` afterwards.

5. **Non-git directory check** — Run `init` in a plain directory with no `.git`. Assert success and the "no git repository detected" FYI line prints.

6. **Bad `--target` check** — Run `init --target bogus`. Assert exit 1 with the usage error, and assert no scaffolding was created beyond the bare `.switchboard/` from the generic pre-dispatch mkdir.
