import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { startHeadlessSwitchboard } from './bootstrap';
import { DEFAULT_DISPLAY_HOSTNAME, isLoopbackHostname } from '../utils/loopbackHostname';

function usage(): string {
    return `Usage: npx switchboard [options]
       npx switchboard init [--target <agents|claude|both>] [--workspace <path>]
       npx switchboard scaffold --parent-dir <dir> --workspace-name <name> --repo <url> [--repo <url>...] [--pat <token>] [--keep-sub-repo-db]
       npx switchboard control-plane <detect|preview|migrate> [parent-dir] [--cleanup <repo>...] [--cleanup-all]
       npx switchboard secrets set <clickup|linear|notion|stitch|apiToken|key> <value>
       npx switchboard secrets list
       npx switchboard secrets delete <clickup|linear|notion|stitch|apiToken|key>

Aliases for secrets commands:
  clickup   -> switchboard.clickup.apiToken
  linear    -> switchboard.linear.apiToken
  notion    -> switchboard.notion.apiToken
  stitch    -> switchboard.stitch.apiKey
  apiToken  -> switchboard.apiToken

Options:
  --workspace <path>   Workspace root to serve or init (default: cwd)
  --port <number>      Preferred port; 0 for ephemeral (default: 0)
  --hostname <name>    Hostname for the board URL (default: switchboard.localhost,
                       falling back to 127.0.0.1 if that name is unreachable).
                       Must be a loopback name: localhost, 127.0.0.1, or anything
                       under the reserved .localhost TLD, e.g. switchboard.localhost
  --no-open            Do not open a browser
  --target <name>      Protocol target for 'init': agents, claude, or both (default: both)
  --pat <token>        PAT for cloning (visible in process list — prefer SWITCHBOARD_PAT env var)
  --keep-sub-repo-db   Keep an existing sub-repo kanban.db instead of deleting it (headless default: delete)
  --cleanup <repo>     migrate: archive the named source repo's .switchboard/ after merging (repeatable)
  --cleanup-all        migrate: archive ALL source repos' .switchboard/ after merging
  --help               Show this help
`;
}

const SECRET_ALIASES: Record<string, string> = {
    clickup: 'switchboard.clickup.apiToken',
    linear: 'switchboard.linear.apiToken',
    notion: 'switchboard.notion.apiToken',
    stitch: 'switchboard.stitch.apiKey',
    apiToken: 'switchboard.apiToken',
};

/**
 * Resolve a CLI secret argument to the key a service actually reads, or exit.
 *
 * The bug this command exists to fix was writing a token under a key nothing
 * reads, so a bare unrecognised word must be a hard error rather than a
 * pass-through. Fully-qualified keys (anything dotted) still pass through as the
 * escape hatch for keys the alias table has not caught up with.
 */
function resolveSecretKey(inputKey: string): string {
    const aliased = SECRET_ALIASES[inputKey];
    if (aliased) { return aliased; }
    if (inputKey.includes('.')) { return inputKey; }
    console.error(`Unknown secret name '${inputKey}'. Use one of:`);
    for (const [alias, resolved] of Object.entries(SECRET_ALIASES)) {
        console.error(`  ${alias.padEnd(9)} -> ${resolved}`);
    }
    console.error('...or pass a fully-qualified key such as switchboard.clickup.apiToken.');
    process.exit(1);
}

function parseArgs(argv: string[]): { workspace?: string; port?: number; hostname?: string; noOpen: boolean; help: boolean } {
    const args = { noOpen: false, help: false } as any;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--workspace') { args.workspace = argv[++i]; }
        else if (a === '--port') { args.port = parseInt(argv[++i], 10); }
        else if (a === '--hostname') { args.hostname = argv[++i]; }
        else if (a === '--no-open') { args.noOpen = true; }
        else if (a === '--help' || a === '-h') { args.help = true; }
    }
    return args;
}

/**
 * Reject a `--hostname` the server would 403 on, at parse time.
 *
 * The failure this prevents is silent and expensive: a non-loopback name would
 * print an inviting URL, open a browser, and then hit the DNS-rebinding guard —
 * burning the one-time token on a request that can never succeed.
 */
function resolveHostname(input: string | undefined): string | undefined {
    if (input === undefined) { return undefined; }
    const candidate = input.trim().toLowerCase();
    if (!isLoopbackHostname(candidate)) {
        console.error(`[switchboard] --hostname '${input}' is not a loopback name.`);
        console.error('Switchboard binds 127.0.0.1 only, so the hostname must resolve there:');
        console.error('  127.0.0.1, localhost, or any name under the reserved .localhost TLD');
        console.error('  e.g. --hostname switchboard.localhost');
        process.exit(1);
    }
    return candidate;
}

/**
 * Expand a leading `~` the way the scaffolding services do.
 *
 * `--parent-dir`/`<parent-dir>` reach the services through
 * `MultiRepoScaffoldingService._normalizeOptions` (expandHome + path.resolve), so the
 * CLI must resolve them the same way before installing the shim workspace root —
 * otherwise the root points at a literal `./~/...` that holds no config.
 */
function expandHomePath(input: string): string {
    if (input === '~') { return os.homedir(); }
    if (input.startsWith('~/') || input.startsWith('~\\')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}

/**
 * Exit only once stdout has drained.
 *
 * `process.exit()` discards queued async writes, and when stdout is a pipe (rather
 * than a TTY) Node buffers asynchronously — so `control-plane preview <dir> | jq`
 * could lose the JSON that is the entire product of the command. A hard exit is still
 * required: the DB services leave handles behind, so returning normally is not
 * guaranteed to end the process.
 */
function exitFlushed(code: number): never {
    if (process.stdout.writableLength === 0) {
        process.exit(code);
    }
    process.stdout.write('', () => process.exit(code));
    // Belt-and-braces: if the drain callback never fires, do not hang forever.
    setTimeout(() => process.exit(code), 2000).unref();
    return undefined as never;
}

async function probeHealth(port: number, hostname = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
    return new Promise(resolve => {
        const req = http.get(`http://${hostname}:${port}/health`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json.status === 'ok' && json.port === port);
                } catch { resolve(false); }
            });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { } resolve(false); });
    });
}

async function findRunningInstance(workspaceRoot: string): Promise<number | null> {
    const portFile = path.join(workspaceRoot, '.switchboard', 'api-server-port.txt');
    if (!fs.existsSync(portFile)) return null;
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    if (isNaN(port)) return null;
    if (await probeHealth(port)) return port;
    return null;
}

async function openBrowser(url: string): Promise<void> {
    const platform = process.platform;
    let cmd: string;
    const args: string[] = [];
    if (platform === 'darwin') { cmd = 'open'; args.push(url); }
    else if (platform === 'win32') { cmd = 'cmd'; args.push('/c', 'start', '', url); }
    else { cmd = 'xdg-open'; args.push(url); }
    try {
        const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        p.unref();
    } catch (err) {
        console.error(`[switchboard] Failed to open browser: ${err}`);
    }
}

async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await probeHealth(port, '127.0.0.1', 1000)) return;
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Health check timed out on port ${port}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        process.exit(0);
    }

    const workspaceRoot = path.resolve(args.workspace || process.cwd());
    if (!fs.existsSync(workspaceRoot)) {
        console.error(`[switchboard] Workspace does not exist: ${workspaceRoot}`);
        process.exit(1);
    }

    // `scaffold` and `control-plane` operate on a directory named by their own
    // arguments and never touch the cwd. Creating .switchboard/ here would leave a
    // stray control-plane marker in whatever directory the command was launched from
    // — including $HOME, which `isAllowedSwitchboardLocation` exists to keep out.
    // Every other path (server start, secrets, init) does use workspaceRoot.
    const subcommand = process.argv[2];
    const subcommandTargetsCwd = subcommand !== 'scaffold' && subcommand !== 'control-plane';
    const switchboardDir = path.join(workspaceRoot, '.switchboard');
    if (subcommandTargetsCwd && !fs.existsSync(switchboardDir)) {
        fs.mkdirSync(switchboardDir, { recursive: true });
    }

    if (process.argv[2] === 'secrets') {
        const sub = process.argv[3];
        const { createStandaloneHostSecrets } = require('./hostServices');
        const secrets = createStandaloneHostSecrets(workspaceRoot);

        if (sub === 'set') {
            const rawKey = process.argv[4];
            const secretValue = process.argv[5];
            if (!rawKey || !secretValue) {
                console.error('Usage: npx switchboard secrets set <clickup|linear|notion|stitch|apiToken|key> <value>');
                process.exit(1);
            }
            const secretKey = resolveSecretKey(rawKey);
            await secrets.store(secretKey, secretValue);
            console.log(`[switchboard] Secret '${secretKey}' saved securely to standalone store.`);
            process.exit(0);
        } else if (sub === 'list') {
            const keys = await secrets.keys();
            if (keys.length === 0) {
                console.log('[switchboard] No secrets stored in standalone store.');
            } else {
                console.log('[switchboard] Stored secrets (keys only):');
                for (const k of keys) {
                    console.log(`  - ${k}`);
                }
            }
            process.exit(0);
        } else if (sub === 'delete' || sub === 'rm') {
            const rawKey = process.argv[4];
            if (!rawKey) {
                console.error('Usage: npx switchboard secrets delete <clickup|linear|notion|stitch|apiToken|key>');
                process.exit(1);
            }
            const secretKey = resolveSecretKey(rawKey);
            await secrets.delete(secretKey);
            console.log(`[switchboard] Secret '${secretKey}' deleted from standalone store.`);
            process.exit(0);
        } else {
            console.error(`Unknown secrets subcommand '${sub}'.`);
            console.error(usage());
            process.exit(1);
        }
    }


    if (process.argv[2] === 'init') {
        const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
        const { ControlPlaneMigrationService } = require('../services/ControlPlaneMigrationService');
        const { KanbanDatabase } = require('../services/KanbanDatabase');
        const { StandaloneHostPathConfigProvider } = require('./hostServices');
        const { ensureWorkspaceIdentity } = require('../services/WorkspaceIdentityService');

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

        __setStandaloneWorkspaceRoot(workspaceRoot);

        const configProvider = new StandaloneHostPathConfigProvider(workspaceRoot);
        KanbanDatabase.setPathConfigProvider(configProvider);
        await configProvider.updateConfigWorkspace('protocol.target', target);

        const repoRoot = path.resolve(__dirname, '..', '..');

        console.log(`[switchboard] Initialising Switchboard scaffolding in ${workspaceRoot} (target: ${target})…`);

        try {
            await ControlPlaneMigrationService.bootstrapControlPlaneLayout(workspaceRoot, repoRoot);

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

            if (!fs.existsSync(path.join(repoRoot, '.agents'))) {
                console.warn(`[switchboard] Warning: bundled .agents/ not found at ${repoRoot}. Directory structure created but protocol files were not copied.`);
            }

            console.log('[switchboard] Scaffolding complete.');
            console.log('[switchboard]   .switchboard/  (plans, inbox, archive, kanban.db)');
            console.log('[switchboard]   .agents/       (workflows, skills)');
            if (target === 'agents' || target === 'both') {
                console.log('[switchboard]   AGENTS.md      (protocol file)');
            }
            if (target === 'claude' || target === 'both') {
                console.log('[switchboard]   CLAUDE.md      (Claude Code managed block)');
                console.log('[switchboard]   .claude/skills (mirror)');
            }
            console.log('[switchboard]   worktrees/');
            if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
                console.log(`[switchboard] Note: no git repository detected in ${workspaceRoot}.`);
            }
            process.exit(0);
        } catch (err) {
            console.error(`[switchboard] Init failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    }

    if (process.argv[2] === 'scaffold') {
        const { __setStandaloneWorkspaceRoot } = require('./vscodeShim');
        const { MultiRepoScaffoldingService } = require('../services/MultiRepoScaffoldingService');
        const { StandaloneHostPathConfigProvider } = require('./hostServices');
        const { KanbanDatabase } = require('../services/KanbanDatabase');

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
        const repoRoot = path.resolve(__dirname, '..', '..');

        console.log(`[switchboard] Scaffolding multi-repo control plane into ${parentDir}…`);
        const result = await MultiRepoScaffoldingService.scaffold(
            { parentDir, workspaceName, repoUrls, pat, headlessDefaults: { subRepoDbAction } },
            repoRoot
        );

        for (const repo of result.repos) {
            const tag = repo.status === 'cloned' ? '✓' : repo.status === 'skipped' ? '○' : '✗';
            console.log(`  ${tag} ${repo.dir} — ${repo.status}${repo.error ? ': ' + repo.error : ''}`);
        }
        if (result.warnings?.length) {
            console.log('Warnings:');
            for (const w of result.warnings) { console.log(`  ! ${w}`); }
        }
        // The service is lazily `require`d above, so `result` is untyped here — annotate
        // the callback param rather than widening noImplicitAny.
        const anyFailed = result.repos.some((r: { status: string }) => r.status === 'failed');
        if (result.success) {
            console.log(`\n[switchboard] Workspace file: ${result.workspaceFilePath}`);
            console.log(`[switchboard] Open with: code "${result.workspaceFilePath}"`);
            process.exit(anyFailed ? 1 : 0);
        } else {
            console.error(`\n[switchboard] Scaffold failed: ${result.error || 'unknown error'}`);
            process.exit(1);
        }
    }

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
                cleanupConfirmed = [...new Set([...cleanupRepos, ...preview.sources.map((s: { repoName: string }) => s.repoName)])];
            }

            const result = await ControlPlaneMigrationService.executeMigration(parentDir, {
                extensionPath: repoRoot,
                cleanupConfirmed
            });
            console.log(JSON.stringify(result, null, 2));
            if (result.success) {
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

    const existing = await findRunningInstance(workspaceRoot);
    if (existing !== null) {
        console.error(`[switchboard] Another Switchboard instance is already running on port ${existing} for ${workspaceRoot}.`);
        console.error(`[switchboard] Reusing is not supported (single writer). Use that instance or shut it down.`);
        process.exit(1);
    }

    const hostname = resolveHostname(args.hostname);

    const instance = await startHeadlessSwitchboard({
        workspaceRoot,
        port: args.port,
        hostname,
        verbose: true,
    });

    await waitForHealth(instance.port);

    const displayHost = new URL(instance.url).hostname;
    const boardUrl = `${instance.url}/?token=${instance.oneTimeToken}`;

    console.log(`\nSwitchboard is running at ${instance.url}`);
    console.log(`Board URL (one-time token): ${boardUrl}`);
    if (displayHost !== '127.0.0.1') {
        // The token is consumed server-side, so a name the browser fails to
        // resolve never reaches the server and never spends it — this fallback
        // stays valid. Printed up front because the failure mode (a browser that
        // does not map *.localhost to loopback) looks like Switchboard is down.
        console.log(`If your browser cannot resolve ${displayHost}, use http://127.0.0.1:${instance.port}/?token=${instance.oneTimeToken} instead.`);
    }
    console.log('Press Ctrl+C to stop.\n');

    if (!args.noOpen) {
        await openBrowser(boardUrl);
    }

    const shutdown = async () => {
        console.log('\n[switchboard] Shutting down...');
        try { await instance.stop(); } catch { /* ignore */ }
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process alive until interrupted
    await new Promise(() => { /* never resolves */ });
}

main().catch(err => {
    console.error('[switchboard] Fatal error:', err);
    process.exit(1);
});
