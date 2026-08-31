'use strict';

/**
 * Contract: the CLI's board commands stay a THIRD DOOR onto the server, and
 * they read the fields the server actually persists.
 *
 * Plan: .switchboard/plans/board-commands-in-the-switchboard-cli.md
 *
 * Every check here is static, because the plan's own "Automated Tests" section
 * is otherwise entirely manual — a board, a live terminal and a TTY are needed
 * for the end-to-end assertions, so none of them can gate CI. These are the
 * invariants that CAN be discriminated without a running board, and they are
 * exactly the ones that were broken on the first pass:
 *
 *   - the plan rows the CLI reads carry `topic`, never `title`
 *     (KanbanDatabase._readRows is the writer; there is no `title` key in it)
 *   - `--all` is a flag, so it can never be read from a positional list
 *   - the ptyListTerminals projection carries `friendlyName` / `status`
 *   - the terminal verb rail answers 502, never 404, for a verb it does not own
 *   - the board commands never open kanban.db or shell move-card.js
 *   - every board verb is reachable AND excluded from subcommandTargetsCwd
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

/** The board subcommands this plan added, plus the pre-existing read-only three. */
const BOARD_SUBCOMMANDS = ['plans', 'ready', 'dispatch', 'clear', 'fleet', 'verb', 'help', 'about', 'version', 'setup'];

function run() {
    const cli = readSource('src', 'standalone', 'cli.ts');
    const db = readSource('src', 'services', 'KanbanDatabase.ts');
    const api = readSource('src', 'services', 'LocalApiServer.ts');
    const bootstrap = readSource('src', 'standalone', 'bootstrap.ts');

    // ── 1. The plan-row title field is `topic`. ───────────────────────────────
    // The persisted literal is the evidence, not a type or a docblock.
    assert.match(
        db,
        /rows\.push\(\{[\s\S]{0,400}?topic: String\(row\.topic \|\| ""\),/,
        'KanbanDatabase._readRows must still set `topic` on every plan row — the CLI listing reads it.'
    );
    assert.ok(
        !/rows\.push\(\{[\s\S]{0,3000}?\btitle:/.test(db),
        'KanbanDatabase._readRows grew a `title` key; revisit planTitle() in cli.ts before trusting it.'
    );
    assert.match(
        cli,
        /function planTitle\(p: any\): string \{\s*return String\(p\?\.topic \|\|/,
        'cli.ts must resolve a card title through planTitle(), reading `topic` FIRST.'
    );
    // No board listing may read `.title` without going through planTitle().
    for (const line of cli.split('\n')) {
        if (line.includes('p?.title') && !line.includes('p?.topic')) {
            assert.fail(`cli.ts reads a non-existent \`title\` field outside planTitle(): ${line.trim()}`);
        }
    }

    // ── 2. The ready set is the protocol's two lanes. ─────────────────────────
    const readyMatch = cli.match(/const READY_COLUMNS = \[([^\]]*)\]/);
    assert.ok(readyMatch, 'cli.ts must declare READY_COLUMNS.');
    const readyColumns = readyMatch[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepStrictEqual(
        readyColumns.slice().sort(),
        ['CREATED', 'PLAN REVIEWED'],
        'READY_COLUMNS must be the Mission Control protocol\'s two dispatchable lanes '
        + '(CREATED = planning, PLAN REVIEWED = coding). STAGING is named there as NOT ready.'
    );
    const protocol = readSource('.agents', 'protocols', 'switchboard-mission-control', 'SKILL.md');
    for (const col of readyColumns) {
        assert.ok(
            protocol.includes(`\`${col}\``),
            `The protocol's "What Is Ready To Go" must still name ${col}; the CLI and the protocol answer one question.`
        );
    }

    // ── 3. Every read carries workspaceRoot. ─────────────────────────────────
    assert.match(
        cli,
        /const params: Record<string, string> = \{ \.\.\.\(query \|\| \{\}\), workspaceRoot \};/,
        'apiGet must always send workspaceRoot — _resolveDbFromQuery otherwise falls back to the HOST\'s '
        + 'selected root, so the CLI would list one board and dispatch against another.'
    );
    assert.match(
        api,
        /const wsRoot = url\.searchParams\.get\('workspaceRoot'\) \|\| undefined;/,
        'LocalApiServer._resolveDbFromQuery must still read the workspaceRoot query param.'
    );

    // ── 4. `--all` is read as a flag, never from the positional list. ─────────
    assert.match(
        cli,
        /const clearAll = argv\.includes\('--all'\);/,
        '`switchboard clear --all` must detect --all as a flag; a positional filter strips it and the '
        + 'fan-out branch becomes unreachable.'
    );

    // ── 5. Fleet reads the fields ptyListTerminals actually projects. ─────────
    assert.match(
        bootstrap,
        /case 'ptyListTerminals':[\s\S]{0,600}?friendlyName: t\.friendlyName,/,
        'bootstrap\'s ptyListTerminals projection must still emit friendlyName.'
    );
    assert.match(
        bootstrap,
        /case 'ptyListTerminals':[\s\S]{0,600}?status: t\.status,/,
        'bootstrap\'s ptyListTerminals projection must still emit status.'
    );
    assert.match(
        cli,
        /const name = String\(t\?\.friendlyName \|\|/,
        'cmdFleet must read friendlyName first — there is no `name` key on a ptyListTerminals row.'
    );
    assert.match(
        cli,
        /const status = String\(t\?\.status \|\|/,
        'cmdFleet must read `status` — there is no `alive`/`active` key on a ptyListTerminals row.'
    );

    // ── 6. The verb runner falls back on the refusal the rail really sends. ───
    assert.match(
        bootstrap,
        /PTY verb '\$\{verb\}' not implemented in standalone mode/,
        'standalone\'s terminal-verb default arm must still refuse with "not implemented".'
    );
    assert.match(
        readSource('src', 'standalone', 'ptyHost.ts'),
        /Unknown terminal verb '\$\{verb\}'/,
        'ptyHost\'s default arm must still refuse with "Unknown terminal verb".'
    );
    assert.match(
        cli,
        /const VERB_NOT_HERE = \/not implemented\|unknown \(terminal \|pty \)\?verb\|missing verb\/i;/,
        'cmdVerb must fall back to /kanban/verb on the rail\'s real refusal text — the terminal rail '
        + 'answers 502, never 404, so a 404-only fallback never fires.'
    );

    // ── 7. Third door, not third implementation. ─────────────────────────────
    assert.match(cli, /'\/kanban\/dispatch'/, 'dispatch must go through POST /kanban/dispatch.');
    const codeLines = cli.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    assert.ok(
        !codeLines.some(l => l.includes('move-card')),
        'The CLI must never shell out to move-card.js — dispatch is one implementation, reached over HTTP.'
    );
    const boardCommandRegion = cli.slice(
        cli.indexOf('// ── Board command implementations'),
        cli.indexOf('async function main()')
    );
    assert.ok(boardCommandRegion.length > 1000, 'Could not locate the board-command region in cli.ts.');
    assert.ok(
        !/kanban\.db|KanbanDatabase/.test(boardCommandRegion),
        'The board commands must not open kanban.db — they are HTTP clients.'
    );

    // ── 8. Reachability + the no-.switchboard/ guarantee. ────────────────────
    const knownMatch = cli.match(/const KNOWN_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(knownMatch, 'cli.ts must declare KNOWN_SUBCOMMANDS.');
    for (const verb of BOARD_SUBCOMMANDS) {
        assert.ok(
            knownMatch[1].includes(`'${verb}'`),
            `'${verb}' must be in KNOWN_SUBCOMMANDS or it is rejected as an unknown subcommand.`
        );
    }
    const targetsCwd = cli.slice(
        cli.indexOf('const subcommandTargetsCwd'),
        cli.indexOf('const switchboardDir')
    );
    for (const verb of BOARD_SUBCOMMANDS) {
        assert.ok(
            targetsCwd.includes(`subcommand !== '${verb}'`),
            `'${verb}' must be excluded from subcommandTargetsCwd — a read-only command must never `
            + 'create a .switchboard/ in a directory that has none.'
        );
    }
    assert.match(
        targetsCwd,
        /const subcommandTargetsCwd = !!firstArg/,
        'The bare `switchboard` console (no firstArg) must also be excluded from the mkdir path.'
    );

    // ── 9. The exit-code table covers the full dispatch status space. ────────
    const table = cli.slice(cli.indexOf('function dispatchExitCode'), cli.indexOf('const READY_COLUMNS'));
    for (const [status, code] of [[200, 0], [401, 4], [409, 3], [502, 3], [400, 5], [404, 5], [503, 6]]) {
        assert.ok(
            new RegExp(`case ${status}: return ${code};`).test(table),
            `dispatchExitCode must map HTTP ${status} → exit ${code}.`
        );
    }
    assert.match(table, /default: return 1;/, 'dispatchExitCode must map 500/unknown → exit 1.');
    // Every status performKanbanDispatch can produce must be in the table.
    const produced = new Set(
        [...api.slice(api.indexOf('public async performKanbanDispatch'), api.indexOf('public async performKanbanDispatch') + 9000)
            .matchAll(/fail\((\d{3}),/g)].map(m => m[1])
    );
    for (const status of produced) {
        assert.ok(
            new RegExp(`case ${status}:`).test(table),
            `performKanbanDispatch can return ${status} but dispatchExitCode does not map it.`
        );
    }

    // ── 10. The bare front door is a MENU, and every writing branch of it
    //        re-spawns rather than calling an in-process handler. ───────────
    // Plan: .switchboard/plans/fix-bare-switchboard-cli-front-door-menu-when-server-is-not-running.md
    const menuStart = cli.indexOf('async function cmdMainMenu(');
    assert.ok(menuStart > 0, 'cli.ts must define cmdMainMenu — the bare `switchboard` front door.');
    const menu = cli.slice(menuStart, cli.indexOf('async function cmdBoardConsole('));
    assert.ok(menu.length > 500, 'Could not locate the cmdMainMenu body in cli.ts.');

    assert.match(
        cli,
        /if \(!firstArg\) \{\s*await cmdMainMenu\(workspaceRoot\);/,
        'Bare `switchboard` must route to cmdMainMenu — routing it straight to cmdBoardConsole '
        + 'reinstates the exit-1 dead end when no server is running.'
    );
    assert.ok(
        !menu.includes('No running Switchboard instance for this workspace.'),
        'cmdMainMenu must never emit the old no-server error — the menu renders regardless of server status.'
    );
    assert.match(
        menu,
        /if \(!process\.stdin\.isTTY\)[\s\S]{0,600}?exitFlushed\(0\)/,
        'cmdMainMenu must exit 0 on a non-TTY — a piped or cron bare invocation must not block on a prompt.'
    );
    // The board console keeps its own no-server backstop for the probe→select race.
    const console_ = cli.slice(cli.indexOf('async function cmdBoardConsole('), cli.indexOf('async function main()'));
    assert.match(
        console_,
        /const port = await findRunningInstance\(workspaceRoot\);\s*if \(port === null\) \{[\s\S]{0,400}?exitFlushed\(1\);/,
        'cmdBoardConsole must keep its findRunningInstance + exitFlushed(1) backstop.'
    );

    // Every branch that starts something re-spawns this file with a real
    // subcommand. `setup` is the one that MUST NOT be called in-process:
    // cmdSetup does not execute the wizard's choice, it rewrites process.argv
    // and returns, expecting main() to fall through to the init / scaffold /
    // control-plane handlers. Those handlers sit ABOVE the bare-routing point,
    // and a bare argv has no 'setup' token to rewrite — so an in-process call
    // makes every wizard choice a no-op that then falls through to the serve
    // path and silently starts a board instead.
    const respawns = [...menu.matchAll(/spawn\(process\.execPath, \[__filename, ([^\]]*)\]/g)].map(m => m[1]);
    assert.ok(
        respawns.length >= 3,
        `cmdMainMenu must re-spawn itself for GUI serve, CLI auto-start and Setup; found ${respawns.length}.`
    );
    assert.ok(
        respawns.some(a => /^serveSub$/.test(a.trim())),
        'GUI mode must re-spawn [__filename, serveSub] — the whole serve path lives inline in main(), '
        + 'there is no cmdLocal/cmdTailnet to call.'
    );
    assert.match(
        menu,
        /serveSub = sub === '1' \? 'local' : 'tailnet'/,
        "GUI mode must map its two choices onto the 'local' and 'tailnet' subcommands."
    );
    assert.ok(
        respawns.some(a => a.includes("'local'") && a.includes("'--detach'")),
        "CLI mode's offline auto-start must re-spawn [__filename, 'local', '--detach'] — a foreground "
        + 'spawn would turn the menu process into the server and the board console would never appear.'
    );
    assert.ok(
        respawns.some(a => a.trim() === "'setup'"),
        "Setup must re-spawn [__filename, 'setup'] rather than calling cmdSetup() in-process."
    );
    // The auto-start child inherits stdin (stdio: 'inherit') and may render
    // firstRunDatabaseMenu on the same TTY, so the menu's own readline must be
    // closed before the spawn — two interfaces on one tty split the keystrokes.
    const autoStart = menu.slice(menu.indexOf('Server is offline.'), menu.indexOf("'--detach'"));
    assert.match(
        autoStart,
        /prompter\.close\(\);/,
        'cmdMainMenu must close its prompter BEFORE spawning the auto-start child that inherits stdin.'
    );
    assert.ok(
        !/\bawait cmdSetup\(/.test(menu),
        'cmdMainMenu must NOT call cmdSetup() in-process: cmdSetup returns after an argv rewrite that '
        + 'only main()\'s earlier init/scaffold/control-plane handlers can consume, and they are already '
        + 'behind us. Re-spawn [__filename, \'setup\'] instead.'
    );
    // The structural fact the check above rests on: the handlers cmdSetup hands
    // off to are declared BEFORE the bare-command routing point. If a refactor
    // ever moves them below it, this fails loudly instead of quietly making the
    // in-process call legal again.
    const bareRouting = cli.indexOf('if (!firstArg) {\n        await cmdMainMenu(');
    assert.ok(bareRouting > 0, 'Could not locate the bare-command routing block in main().');
    for (const handler of ['init', 'scaffold', 'control-plane']) {
        const at = cli.indexOf(`if (process.argv[2] === '${handler}')`);
        assert.ok(at > 0, `main() must dispatch the '${handler}' handler.`);
        assert.ok(
            at < bareRouting,
            `The '${handler}' handler must stay above the bare-command routing point — cmdSetup's `
            + 'argv-rewrite handoff depends on it, and the front door re-spawns precisely because it does.'
        );
    }

    console.log('cli board commands contract test passed');
}

try {
    run();
} catch (error) {
    console.error('cli board commands contract test failed:', error);
    process.exit(1);
}
