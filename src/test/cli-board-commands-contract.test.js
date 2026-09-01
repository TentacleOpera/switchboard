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
const BOARD_SUBCOMMANDS = ['plans', 'ready', 'dispatch', 'done', 'next', 'clear', 'fleet', 'verb', 'help', 'about', 'version', 'setup'];

// ── Banner art ───────────────────────────────────────────────────────────────
//
// Plan: .switchboard/plans/cli-banner-saucer-redrawn-to-align-and-render-everywhere.md
//
// The banner is no longer hand-typed: it is a build-time render of
// icons/switchboard-ufo-static.svg. The drift check alone cannot catch a
// rasteriser that is deterministic but WRONG (it would be happily in sync with
// its own bad output), so the pixel assertions below name coordinates derived
// from the SVG. If the SVG changes, these are updated deliberately.
//
//   grid origin = the art's bounding box, x=72 y=42, at 4 SVG units per cell
//   column = (svgX - 72) / 4     pixel row = round((svgY - 42) / 4)
//
// The round-half-up snap is exact for every shape except the two y=88 cyan
// ports (88 -> pixel row 12), which is the generator's one documented
// judgement call.
const ESC = '\u001b';
const SGR = /\u001b\[[0-9;]*m/g;

/** SVG coordinate -> expected raster colour. Derived from <g class="ufo">, not from the generator. */
const PIXEL_INVARIANTS = [
    // The six cyan ports (rect x=..,y=..,w=12,h=8, fill #00e5ff, full opacity).
    { svg: 'port x=96 y=82', row: 10, col: 6, colour: '#00e5ff' },
    { svg: 'port x=120 y=86', row: 11, col: 12, colour: '#00e5ff' },
    { svg: 'port x=144 y=88', row: 12, col: 18, colour: '#00e5ff' },
    { svg: 'port x=168 y=88', row: 12, col: 24, colour: '#00e5ff' },
    { svg: 'port x=192 y=86', row: 11, col: 30, colour: '#00e5ff' },
    { svg: 'port x=216 y=82', row: 10, col: 36, colour: '#00e5ff' },
    // Hull bands.
    { svg: 'hull rect x=72 y=78 w=176 h=12', row: 9, col: 0, colour: '#1d2323' },
    { svg: 'hull rect x=88 y=90 w=144 h=8', row: 12, col: 4, colour: '#0b0f0f' },
    { svg: 'dome highlight rect x=132 y=50 w=56 h=4', row: 2, col: 20, colour: '#a0a6a6' },
    { svg: 'dome rim rect x=136 y=46 w=48 h=4', row: 1, col: 20, colour: '#5e6666' },
    // The cockpit's opacity=".55" cyan composited over #0b0f0f — proves alpha is
    // composed, not dropped and not painted opaque.
    { svg: 'cockpit rect x=152 y=58 w=24 h=4 opacity=.55', row: 4, col: 20, colour: '#058593' },
];

/** Pull a JSON-literal export out of the generated module — the real value, not a docblock claim. */
function readGeneratedLiteral(source, name, multiline) {
    if (multiline) {
        const m = source.match(new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\n\\];`));
        assert.ok(m, `src/generated/bannerArt.ts must export ${name}.`);
        return JSON.parse(`[${m[1].trim().replace(/,$/, '')}]`);
    }
    const m = source.match(new RegExp(`export const ${name}(?:: (?:string|readonly string\\[\\]))? = (".*"|\\[.*\\]|\\d+);`));
    assert.ok(m, `src/generated/bannerArt.ts must export ${name}.`);
    return JSON.parse(m[1]);
}

/** Lift a function out of the TS source and make it callable — no build step, real behaviour. */
function liftFunction(cli, signature, replacement) {
    const start = cli.indexOf(signature);
    assert.ok(start > 0, `cli.ts must define ${signature}`);
    const end = cli.indexOf('\n}', start);
    assert.ok(end > start, `could not find the end of ${signature}`);
    return cli.slice(start, end + 2).replace(signature, replacement);
}

function assertBannerArt(cli) {
    const { spawnSync } = require('child_process');

    // ── Sync guard: the checked-in module matches the SVG. ───────────────────
    const drift = spawnSync(process.execPath, ['scripts/generate-banner-art.js'], {
        cwd: process.cwd(), encoding: 'utf8',
    });
    assert.strictEqual(
        drift.status, 0,
        'src/generated/bannerArt.ts is out of sync with icons/switchboard-ufo-static.svg — '
        + `run \`npm run banner:generate\`. Generator said: ${(drift.stderr || '').trim()}`
    );

    const art = readSource('src', 'generated', 'bannerArt.ts');
    const palette = readGeneratedLiteral(art, 'BANNER_PALETTE');
    const pixelRows = readGeneratedLiteral(art, 'BANNER_PIXEL_ROWS', true);
    const columns = readGeneratedLiteral(art, 'BANNER_ART_COLUMNS');
    const rows = readGeneratedLiteral(art, 'BANNER_ART_ROWS');

    // ── Rasteriser correctness. ─────────────────────────────────────────────
    // <g class="ufo"> spans x=72..248 (176 units -> 44 columns) and y=42..106
    // (64 units -> 16 pixel rows -> 8 terminal rows of half-blocks).
    assert.strictEqual(columns, 44, 'BANNER_ART_COLUMNS must be 44 (the 176-unit hull at 4 units/cell).');
    assert.strictEqual(rows, 8, 'BANNER_ART_ROWS must be 8 (16 pixel rows paired into half-blocks).');
    assert.strictEqual(pixelRows.length, 16, 'BANNER_PIXEL_ROWS must carry 16 pixel rows.');
    for (const row of pixelRows) {
        assert.strictEqual(row.length, 44, 'every BANNER_PIXEL_ROWS row must be 44 cells wide.');
    }
    for (const inv of PIXEL_INVARIANTS) {
        const ch = pixelRows[inv.row][inv.col];
        const actual = ch === '.' ? '(empty)' : palette[parseInt(ch, 36)];
        assert.strictEqual(
            actual, inv.colour,
            `raster cell (row ${inv.row}, col ${inv.col}) should be ${inv.colour} from SVG ${inv.svg}, got ${actual} — `
            + 'the rasteriser is in sync with itself but wrong.'
        );
    }
    // Every full-opacity #00e5ff cell in the raster, derived from the SVG rects.
    // Pinning the WHOLE map (not just a sample) is what catches a rasteriser
    // that is shifted, mirrored, or vertically mis-snapped: a one-cell drift
    // anywhere moves a span. NOTE the art is not mirror-symmetric — the SVG's
    // own outer ports sit at x=96 and x=216 against a hull centred on x=160, so
    // the left port lands one cell further in than the right. That asymmetry is
    // the source art's, and reproducing it faithfully is the point.
    const CYAN_SPANS = {
        10: [[6, 8], [36, 38]],             // rects x=96 / x=216, y=82 h=8 -> rows 10-11
        11: [[6, 8], [12, 14], [30, 32], [36, 38]],  // + rects x=120 / x=192, y=86 h=8 -> rows 11-12
        12: [[12, 14], [18, 20], [24, 26], [30, 32]], // + rects x=144 / x=168, y=88 h=8 -> rows 12-13 (the snapped pair)
        13: [[18, 20], [24, 26]],
        14: [[21, 22]],                     // tractor emitter rect x=156 y=98 w=8 h=8 -> rows 14-15
        15: [[21, 22]],
    };
    const cyanIndex = palette.indexOf('#00e5ff');
    assert.ok(cyanIndex >= 0, 'BANNER_PALETTE must contain the product cyan #00e5ff.');
    const cyanChar = cyanIndex.toString(36);
    pixelRows.forEach((row, index) => {
        const spans = [];
        let start = null;
        for (let c = 0; c <= row.length; c += 1) {
            if (row[c] === cyanChar) { if (start === null) { start = c; } }
            else if (start !== null) { spans.push([start, c - 1]); start = null; }
        }
        assert.deepStrictEqual(
            spans, CYAN_SPANS[index] || [],
            `pixel row ${index} has the wrong #00e5ff columns — the rasteriser is in sync with itself but wrong.`
        );
    });

    // ── Portability: every tier is 8 rows and <= 80 columns. ────────────────
    const tiers = {
        BANNER_ART_TRUECOLOR: readGeneratedLiteral(art, 'BANNER_ART_TRUECOLOR'),
        BANNER_ART_256: readGeneratedLiteral(art, 'BANNER_ART_256'),
        BANNER_ART_ASCII: readGeneratedLiteral(art, 'BANNER_ART_ASCII'),
    };
    for (const [name, text] of Object.entries(tiers)) {
        const lines = text.split('\n');
        assert.strictEqual(lines.length, 8, `${name} must be 8 rows tall.`);
        const widest = Math.max(...lines.map(l => [...l.replace(SGR, '')].length));
        assert.ok(widest <= 80, `${name} is ${widest} columns wide; the banner must fit an 80-column terminal.`);
    }
    assert.ok(!tiers.BANNER_ART_ASCII.includes(ESC), 'BANNER_ART_ASCII must contain no escape sequences.');
    const highCodePoint = [...tiers.BANNER_ART_ASCII].find(c => c.codePointAt(0) > 0x7e);
    assert.strictEqual(
        highCodePoint, undefined,
        `BANNER_ART_ASCII must be pure ASCII (found U+${(highCodePoint || ' ').codePointAt(0).toString(16)}) — `
        + 'it is the fallback for terminals that render U+2580/U+2584 as ambiguous-width.'
    );

    // ── The hand-drawn saucer is gone from cli.ts. ──────────────────────────
    const bannerBody = liftFunction(cli, 'function banner(version: string): string {', 'function banner(version) {');
    assert.ok(
        !bannerBody.includes('●'),
        'banner() still contains U+25CF (●) — that glyph is East-Asian-Ambiguous width and is what broke '
        + 'the old art\'s alignment. The art now comes from src/generated/bannerArt.ts.'
    );
    for (const constant of ['BANNER_ART_TRUECOLOR', 'BANNER_ART_256', 'BANNER_ART_ASCII']) {
        assert.ok(
            new RegExp(`import \\{[^}]*${constant}`).test(cli) || cli.includes(constant),
            `cli.ts must import ${constant} from the generated module.`
        );
    }

    // ── Tier behaviour, executed rather than pattern-matched. ───────────────
    const detect = liftFunction(
        cli,
        "function detectBannerTier(): 'truecolor' | 'x256' | 'ascii' {",
        'function detectBannerTier() {'
    );
    const render = new Function(
        'process', 'BANNER_ART_TRUECOLOR', 'BANNER_ART_256', 'BANNER_ART_ASCII',
        `${detect}\n${bannerBody}\nreturn { tier: detectBannerTier(), text: banner('9.9.9') };`
    );
    const invoke = (env, isTTY) => render(
        { env, stdout: { isTTY }, platform: 'linux', arch: 'x64' },
        tiers.BANNER_ART_TRUECOLOR, tiers.BANNER_ART_256, tiers.BANNER_ART_ASCII
    );

    // Negative half of the paired invariant: nothing escapes into a pipe.
    const piped = invoke({ COLORTERM: 'truecolor' }, undefined);
    assert.strictEqual(piped.tier, 'ascii', 'a non-TTY stdout must select the ascii tier even under COLORTERM=truecolor.');
    assert.ok(!piped.text.includes(ESC), 'banner() must emit no escape byte when stdout is not a TTY.');

    const noColor = invoke({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true);
    assert.strictEqual(noColor.tier, 'ascii', 'NO_COLOR must select the ascii tier.');
    assert.ok(!noColor.text.includes(ESC), 'banner() must emit no escape byte under NO_COLOR.');

    // Positive half: colour IS emitted where the terminal supports it.
    const truecolor = invoke({ COLORTERM: 'truecolor' }, true);
    assert.strictEqual(truecolor.tier, 'truecolor', 'COLORTERM=truecolor on a TTY must select the truecolor tier.');
    assert.ok(
        truecolor.text.includes(`${ESC}[38;2;`),
        'the truecolor tier must emit 24-bit SGR sequences — otherwise the gate is "no ESC ever", not "no ESC when piped".'
    );

    // U+2580/U+2584 are East-Asian-Ambiguous, so a CJK locale must get the ASCII
    // tier — otherwise the art renders double-width and wraps, which is the same
    // class of defect as the U+25CF (●) it replaced.
    for (const locale of ['ja_JP.UTF-8', 'ko_KR.UTF-8', 'zh_CN.UTF-8', 'zh_TW.utf8']) {
        const cjk = invoke({ LANG: locale, COLORTERM: 'truecolor' }, true);
        assert.strictEqual(cjk.tier, 'ascii', `LANG=${locale} must degrade to the ascii tier (ambiguous-width terminals).`);
        assert.ok(!cjk.text.includes(ESC), `banner() must emit no escape byte under LANG=${locale}.`);
    }
    for (const variable of ['LC_ALL', 'LC_CTYPE']) {
        assert.strictEqual(
            invoke({ [variable]: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' }, true).tier, 'ascii',
            `${variable} must outrank LANG when deciding ambiguous width.`
        );
    }
    // ...and a Western locale must NOT be degraded — otherwise the check is "always ascii".
    assert.strictEqual(
        invoke({ LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' }, true).tier, 'truecolor',
        'a non-CJK locale must keep the half-block render.'
    );

    const x256 = invoke({ TERM: 'xterm-256color' }, true);
    assert.strictEqual(x256.tier, 'x256', 'a TTY without COLORTERM must fall back to the 256-colour tier.');
    assert.ok(x256.text.includes(`${ESC}[38;5;`), 'the 256-colour tier must emit indexed SGR sequences.');
    assert.ok(!x256.text.includes(`${ESC}[38;2;`), 'the 256-colour tier must not emit 24-bit SGR sequences.');

    // ── The wizard's replace target survives, on its own line, in every tier. ─
    for (const rendered of [piped, noColor, truecolor, x256]) {
        assert.ok(
            rendered.text.split('\n').includes('Agent Fleet Command'),
            'every banner tier must carry "Agent Fleet Command" as its own whole line — the setup wizard '
            + 'does banner(v).replace(\'Agent Fleet Command\', \'Workspace & Scaffolding Wizard\'), which '
            + 'silently no-ops if the literal moves or gains neighbours.'
        );
        assert.ok(rendered.text.includes('SWITCHBOARD v9.9.9'), 'every banner tier must carry the version line.');
        assert.ok(
            rendered.text.includes('https://github.com/TentacleOpera/switchboard'),
            'every banner tier must carry the project URL.'
        );
    }
    // A long semver must not wrap an 80-column terminal.
    const longest = invoke({ NO_COLOR: '1' }, true).text
        .replace('9.9.9', '1.7.13-rc.1+build.20260901')
        .split('\n')
        .reduce((max, line) => Math.max(max, [...line.replace(SGR, '')].length), 0);
    assert.ok(longest <= 80, `the banner reaches ${longest} columns with a long version string; it must stay within 80.`);

    // The wizard call site still targets the literal.
    assert.ok(
        cli.includes("banner(version).replace('Agent Fleet Command', 'Workspace & Scaffolding Wizard')"),
        'the setup wizard must still swap the tagline via banner(version).replace(...).'
    );
}

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
    // The backstop now routes through the shared emitOfflineGuidance helper
    // (which itself calls exitFlushed(1)) — the literal exitFlushed(1) lives in
    // the helper, not at the call site, so the regex accepts either form.
    const console_ = cli.slice(cli.indexOf('async function cmdBoardConsole('), cli.indexOf('async function main()'));
    assert.match(
        console_,
        /const port = await findRunningInstance\(workspaceRoot\);\s*if \(port === null\) \{[\s\S]{0,400}?(exitFlushed\(1\);|emitOfflineGuidance\()/,
        'cmdBoardConsole must keep its findRunningInstance + exit-1 backstop (directly or via emitOfflineGuidance).'
    );

    // Every branch that starts something re-spawns this file with a real
    // subcommand. `setup` is the one that MUST NOT be called in-process:
    // cmdSetup does not execute the wizard's choice, it rewrites process.argv
    // and returns, expecting main() to fall through to the init / scaffold /
    // control-plane handlers. Those handlers sit ABOVE the bare-routing point,
    // and a bare argv has no 'setup' token to rewrite — so an in-process call
    // makes every wizard choice a no-op that then falls through to the serve
    // path and silently starts a board instead.
    //
    // The adaptive menu has two render branches keyed on findRunningInstance:
    //   • Offline — 5-option triage (local, tailnet, setup, help, status).
    //     [1]/[2] re-spawn [__filename, serveSub] in the foreground; the
    //     operator explicitly chose to start a board, so the child runs the
    //     full serve path inheriting the TTY (NOT --detach — a detached spawn
    //     would orphan the operator from the board they just asked to start).
    //     [3]/[4]/[5] re-spawn setup / help / status.
    //   • Online — 4-option menu (board console, setup, help, diagnostics).
    //     [1] calls cmdBoardConsole in-process (no spawn — matches the previous
    //     CLI Mode handoff); [2]/[3]/[4] re-spawn setup / help / status.
    // The spawn argument is an expression, not always a literal: the menu
    // consolidates its three writing branches onto two ternary-assigned
    // variables (`serveSub` for the offline serve choice, `sub` for
    // setup/help/status on both branches). Counting spawn *call sites*
    // therefore measures the code's shape, not the contract — what matters is
    // that every one of the five subcommands is reachable from the front door.
    // Resolve each spawn argument through its `const <id> = ...` assignment
    // inside cmdMainMenu and assert on the resulting set.
    const respawns = [...menu.matchAll(/spawn\(process\.execPath, \[__filename, ([^\]]*)\]/g)].map(m => m[1].trim());
    assert.ok(
        respawns.length >= 3,
        'cmdMainMenu must re-spawn itself for its writing branches (the offline serve choice, and '
        + `setup/help/status on both branches); found ${respawns.length} spawn site(s).`
    );
    const reachableSubs = new Set();
    for (const arg of respawns) {
        const literals = [...arg.matchAll(/'([^']+)'/g)].map(m => m[1]);
        if (literals.length) { literals.forEach(s => reachableSubs.add(s)); continue; }
        assert.ok(
            /^[A-Za-z_$][\w$]*$/.test(arg),
            `cmdMainMenu spawn argument "${arg}" is neither a string literal nor a plain identifier — `
            + 'this check cannot resolve which subcommand it reaches.'
        );
        const assigns = [...menu.matchAll(new RegExp(`(?:const|let)\\s+${arg}\\s*=\\s*([^;]+);`, 'g'))];
        assert.ok(
            assigns.length > 0,
            `cmdMainMenu spawns [__filename, ${arg}] but never assigns ${arg} — cannot verify which `
            + 'subcommand it reaches.'
        );
        for (const a of assigns) {
            for (const m of a[1].matchAll(/'([^']+)'/g)) { reachableSubs.add(m[1]); }
        }
    }
    assert.ok(
        !reachableSubs.has('--detach') && !/\[__filename, [^\]]*'--detach'/.test(menu),
        "Offline [1] must re-spawn [__filename, 'local'] in the foreground (stdio: 'inherit') — NOT "
        + "'--detach'. The operator explicitly chose to start a board; a detached spawn orphans them "
        + 'from the board they just asked to start, and the single-track auto-start path is gone.'
    );
    for (const sub of ['local', 'tailnet', 'setup', 'help', 'status']) {
        assert.ok(
            reachableSubs.has(sub),
            `cmdMainMenu must be able to re-spawn [__filename, '${sub}'] — the front door offers it as a `
            + `top-level option. Resolved reachable subcommands: ${[...reachableSubs].join(', ') || '(none)'}.`
        );
    }
    assert.ok(
        respawns.some(a => a === 'serveSub'),
        'Offline [1]/[2] must re-spawn [__filename, serveSub] — the whole serve path lives inline in '
        + "main(), there is no cmdLocal/cmdTailnet to call."
    );
    assert.match(
        menu,
        /serveSub = answer === '1' \? 'local' : 'tailnet'/,
        "Offline branch must map its two choices onto the 'local' and 'tailnet' subcommands."
    );
    // Both ternary mappings are pinned separately. Asserting only the resolved
    // union would let either branch be deleted silently: the surviving branch's
    // `const sub` alone contributes setup/help/status.
    assert.match(
        menu,
        /sub = answer === '3' \? 'setup' : answer === '4' \? 'help' : 'status'/,
        "Offline [3]/[4]/[5] must map onto the 'setup', 'help' and 'status' subcommands."
    );
    assert.match(
        menu,
        /sub = answer === '2' \? 'setup' : answer === '3' \? 'help' : 'status'/,
        "Online [2]/[3]/[4] must map onto the 'setup', 'help' and 'status' subcommands — the online "
        + 'branch shifts down by one because [1] is Open Board Console, not a serve option.'
    );
    // The single-track "Start local server now? [Y/n]" prompt is gone — the
    // adaptive menu offers an explicit [1] Start Local Board instead.
    assert.ok(
        !/Start local (board )?server now\?/.test(menu),
        'cmdMainMenu must NOT contain the single-track "Start local server now?" prompt — the adaptive '
        + 'menu replaces it with an explicit [1] Start Local Board option.'
    );
    // The offline branch renders all five triage labels.
    for (const label of [
        'Start Local Board',
        'Start Remote Tailnet Board',
        'Setup & Scaffolding Wizard',
        'Help & Command Documentation',
        'Server Status & Diagnostics',
    ]) {
        assert.ok(
            menu.includes(label),
            `cmdMainMenu offline branch must render the "${label}" triage option.`
        );
    }
    // The online branch must survive too — a regex that only checks the offline
    // 5-option labels would pass if the online branch were accidentally deleted.
    assert.ok(
        menu.includes('Open Board Console'),
        'cmdMainMenu online branch must render the "Open Board Console" entry — the local-development '
        + 'scenario (a running server) is served by handing off to cmdBoardConsole.'
    );
    // Every spawn in cmdMainMenu that inherits stdin is preceded by
    // prompter.close() — the child may render firstRunDatabaseMenu on the same
    // TTY, and two readline interfaces reading one tty split the operator's
    // keystrokes between them.
    for (const m of menu.matchAll(/spawn\(process\.execPath, \[__filename, [^\]]*\], \{ stdio: 'inherit' \}\);/g)) {
        const spawnAt = m.index;
        // Walk backwards from the spawn to the preceding prompter.ask(...) and
        // assert a prompter.close() sits between them (closer to the spawn).
        const askAt = menu.lastIndexOf('prompter.ask(', spawnAt);
        const closeAt = menu.lastIndexOf('prompter.close();', spawnAt);
        assert.ok(
            closeAt > askAt,
            `cmdMainMenu must close its prompter BEFORE the stdio:'inherit' spawn at offset ${spawnAt} `
            + '— two readline interfaces on one tty split the keystrokes.'
        );
    }
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

    // ── 11. Shared offline guidance — every board command emits the same
    //        multi-scenario message from one helper, not a terse one-liner. ──
    // Plan: .switchboard/plans/context-aware-offline-front-door-and-triage-in-cli.md
    assert.match(
        cli,
        /function emitOfflineGuidance\(jsonFlag: boolean\): never \{/,
        'cli.ts must define a shared emitOfflineGuidance(jsonFlag) helper.'
    );
    assert.match(
        cli,
        /hints: OFFLINE_HINTS,/,
        'emitOfflineGuidance --json payload must include a hints array (additive — existing '
        + 'success/error consumers are unaffected).'
    );
    const guidanceHints = cli.match(/const OFFLINE_HINTS = \[([\s\S]*?)\];/);
    assert.ok(guidanceHints, 'OFFLINE_HINTS array must be defined.');
    assert.ok(
        /'switchboard local'/.test(guidanceHints[1]) && /'switchboard tailnet'/.test(guidanceHints[1])
            && /'switchboard setup'/.test(guidanceHints[1]) && /'switchboard help'/.test(guidanceHints[1]),
        'OFFLINE_HINTS must carry all four recovery suggestions (local, tailnet, setup, help).'
    );
    for (const cmd of ['cmdPlans', 'cmdReady', 'cmdDispatch', 'cmdClear', 'cmdFleet', 'cmdBoardConsole']) {
        const fnStart = cli.indexOf(`async function ${cmd}(`);
        assert.ok(fnStart > 0, `cli.ts must define ${cmd}.`);
        const fnEnd = cli.indexOf('async function ', fnStart + 1);
        const body = cli.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
        assert.ok(
            body.includes('emitOfflineGuidance('),
            `${cmd} must call the shared emitOfflineGuidance helper when findRunningInstance returns null.`
        );
    }
    // ── Every dispatched subcommand is also an ALLOWED subcommand. ───────────
    // main() answers `process.argv[2] === 'X'` far below the KNOWN_SUBCOMMANDS
    // gate, so a handler added without a matching allowlist entry is dead: the
    // gate prints "Unknown subcommand 'X'" and exits 1 before the handler is
    // reached. `done` and `next` shipped exactly that way — registered in
    // `usage()` and in the help body, dispatched in main(), and unreachable.
    // Nothing else can see it: it compiles, it lints, and every other gate is
    // static text that reads the help output rather than the gate.
    const known = new Set(
        Array.from(knownMatch[1].matchAll(/'([^']+)'/g)).map(m => m[1])
    );
    const dispatched = new Set(
        Array.from(cli.matchAll(/process\.argv\[2\] === '([^']+)'/g)).map(m => m[1])
    );
    // 'start' is the retired-alias redirect, handled inside the gate itself.
    dispatched.delete('start');
    const unreachable = [...dispatched].filter(cmd => !known.has(cmd));
    assert.deepStrictEqual(
        unreachable, [],
        `main() dispatches subcommand(s) missing from KNOWN_SUBCOMMANDS: ${unreachable.join(', ')} — `
        + 'the gate rejects them before the handler runs.'
    );
    for (const cmd of ['done', 'next']) {
        assert.ok(known.has(cmd), `KNOWN_SUBCOMMANDS must contain '${cmd}'.`);
        assert.ok(dispatched.has(cmd), `main() must dispatch '${cmd}'.`);
    }

    // The CLI banner tagline is "Agent Fleet Command" (renamed from
    // "Autonomous Agent Fleet Console").
    assert.ok(
        /Agent Fleet Command/.test(cli) && !/Autonomous Agent Fleet Console/.test(cli),
        'cli.ts banner tagline must be "Agent Fleet Command", not "Autonomous Agent Fleet Console".'
    );

    assertBannerArt(cli);

    console.log('cli board commands contract test passed');
}

try {
    run();
} catch (error) {
    console.error('cli board commands contract test failed:', error);
    process.exit(1);
}
