'use strict';

/**
 * Contract: every discoverable skill declares its preconditions and what to do
 * when they are unmet.
 *
 * This is the durability gate for skills-declare-preconditions-and-degrade.
 * The plan's Verification Plan named six automated checks and shipped none, and
 * the cost was immediate: the entire `query-kanban` endpoints-primary rewrite,
 * plus the `kanban_operations` and `worktree-cleanup` preconditions sections,
 * were silently reverted in the working tree by a concurrent stale-tree write.
 * Every TypeScript gate stayed green while the markdown half of the delivery was
 * gone, and `MIRROR_MANIFEST` went on advertising an endpoints-primary skill
 * whose body was 100% SQL — worse than the pre-plan state, which was at least
 * honestly wrong.
 *
 * Nothing here compiles or imports the extension: these are static assertions
 * over the `.agents/` sources and the generated `.claude/` mirror, which is the
 * layer an agent actually reads. Pairs with `mirror:check` (source→mirror drift)
 * and `test:contract:claude-protocol-block` (the resident block).
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/skill-preconditions-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_SKILLS = path.join(REPO_ROOT, '.agents', 'skills');
const MIRROR_SKILLS = path.join(REPO_ROOT, '.claude', 'skills');

// The four discoverable skills. `mirrorName` differs where the manifest renames
// the directory (kanban_operations → kanban-operations).
const SKILLS = [
    { dir: 'manage-features', mirrorName: 'manage-features' },
    { dir: 'query-kanban', mirrorName: 'query-kanban' },
    { dir: 'kanban_operations', mirrorName: 'kanban-operations' },
    { dir: 'worktree-cleanup', mirrorName: 'worktree-cleanup' },
];

const read = (p) => fs.readFileSync(p, 'utf8');
const sourceBody = (s) => read(path.join(AGENTS_SKILLS, s.dir, 'SKILL.md'));
const mirrorBody = (s) => read(path.join(MIRROR_SKILLS, s.mirrorName, 'SKILL.md'));

function mirrorDescription(s) {
    const m = mirrorBody(s).match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${s.mirrorName}/SKILL.md has no frontmatter block`);
    const d = m[1].match(/^description:\s*(.+)$/m);
    assert.ok(d, `${s.mirrorName}/SKILL.md frontmatter has no description`);
    return d[1].trim();
}

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

test('every discoverable skill states its preconditions', () => {
    for (const s of SKILLS) {
        const body = sourceBody(s);
        assert.ok(/^##+\s+(Preconditions|Prerequisites)\b/mi.test(body),
            `${s.dir}/SKILL.md has no "## Preconditions" (or "## Prerequisites") heading — an agent cannot tell what the skill needs before running it`);
    }
});

test('every discoverable skill says what to do when its preconditions are unmet', () => {
    // The what-if-absent clause is the load-bearing half: a precondition that
    // only states a requirement converts a confusing failure into a confusing
    // failure. Each skill must name the absent case AND an action.
    for (const s of SKILLS) {
        const body = sourceBody(s);
        assert.ok(/when absent|if absent|not reachable|is not running|unavailable|falls? back|fall back/i.test(body),
            `${s.dir}/SKILL.md states preconditions but never says what to do when they are unmet`);
    }
});

test('absent-capability instructions do not encourage improvisation', () => {
    // "Say so" must not become "work around it". Hand-rolled SQL is the specific
    // failure query-kanban exists to prevent (labels differ from stored ids, so a
    // wrong guess returns zero rows and reports an empty column).
    for (const s of SKILLS) {
        const body = sourceBody(s);
        for (const phrase of ['query the DB another way', 'query the database another way', 'find another way', 'work around']) {
            assert.ok(!body.toLowerCase().includes(phrase),
                `${s.dir}/SKILL.md suggests improvising around an absent capability ("${phrase}")`);
        }
    }
});

test('query-kanban is endpoints-primary, not SQL-primary', () => {
    // The exact regression that was reverted. The skill is `no-user`, so a
    // model-driven team agent picks it up unprompted; if it teaches SQL first,
    // that agent reads kanban.db directly and bypasses every API-layer guard.
    const body = sourceBody({ dir: 'query-kanban' });
    assert.ok(/primary method is the LocalApiServer/i.test(body),
        'query-kanban must name the LocalApiServer read endpoints as its primary method');
    assert.ok(/direct SQL is a fallback/i.test(body),
        'query-kanban must demote direct SQL to an explicitly-labelled fallback');
    for (const endpoint of ['/kanban/board', '/kanban/columns', '/kanban/plan', '/kanban/features']) {
        assert.ok(body.includes(endpoint),
            `query-kanban must document the ${endpoint} read endpoint`);
    }
    // Ordering: the endpoints section must precede the SQL fallback section.
    const endpointsAt = body.search(/^##+\s+Primary method/mi);
    const sqlAt = body.search(/^##+\s+Fallback/mi);
    assert.ok(endpointsAt > -1 && sqlAt > -1 && endpointsAt < sqlAt,
        'query-kanban must present the endpoint method BEFORE the SQL fallback — an agent reads top-down');
});

test('query-kanban tells a DB-less session to report, not to invent', () => {
    const body = sourceBody({ dir: 'query-kanban' });
    assert.ok(/not reachable from this session/i.test(body),
        'query-kanban must tell a DB-less session to report the board as unreachable');
    assert.ok(/not a fault|expected in a cloud/i.test(body),
        'the absent-capability clause must name the likely reason (cloud / tracker-only session), so the agent reports a configuration fact rather than declaring the system broken');
    assert.ok(/do \*\*not\*\* hand-write SQL|do not hand-write SQL/i.test(body),
        'query-kanban must forbid hand-written SQL on the no-API path');
});

test('skill descriptions name their environmental dependency', () => {
    // The description is what an agent sees BEFORE deciding to load the skill,
    // so an unqualified promise ("direct SQL access to kanban.db") is what sends
    // a DB-less session down a dead path. Asserted against the emitted mirror
    // frontmatter, not the manifest field — the frontmatter is what ships.
    const qk = mirrorDescription({ dir: 'query-kanban', mirrorName: 'query-kanban' });
    assert.ok(/LocalApiServer|endpoint/i.test(qk),
        `query-kanban's description must lead with the endpoint method, got: "${qk}"`);
    assert.ok(/kanban\.db|local database|extension running/i.test(qk),
        `query-kanban's description must name the local-database / extension requirement, got: "${qk}"`);
    assert.ok(/unavailable|cloud|tracker-only/i.test(qk),
        `query-kanban's description must say where it is unavailable, got: "${qk}"`);

    for (const s of SKILLS.filter((x) => x.dir !== 'manage-features')) {
        const d = mirrorDescription(s);
        assert.ok(/LocalApiServer|extension running|kanban\.db/i.test(d),
            `${s.mirrorName}'s description names no environmental dependency, got: "${d}"`);
    }
});

test('the LocalApiServer probe is referenced, not reinvented', () => {
    // manage-features is the canonical probe. Other skills must point at it or
    // at the same /health check — never a different liveness path that can drift.
    //
    // The port-source half of this check used to demand
    // `.switchboard/api-server-port.txt` by name. That was correct while each
    // skill resolved the port itself; it is now the opposite of the contract.
    // The CLI owns port discovery, the /health probe, token attachment and the
    // offline message, and a skill that still names the port file is
    // reimplementing findRunningInstance() in markdown — the drift this whole
    // feature exists to end. The invariant is unchanged ("say how you reach the
    // board, do not invent a liveness path"); only the answer moved.
    // Plan: .switchboard/plans/migrate-agent-protocols-from-curl-to-the-cli.md
    for (const s of SKILLS.filter((x) => x.dir !== 'manage-features')) {
        const body = sourceBody(s);
        assert.ok(/manage-features/.test(body) || /\/health/.test(body),
            `${s.dir}/SKILL.md invents its own reachability check — reuse the manage-features probe or the /health endpoint`);
        assert.ok(/switchboard api\b/.test(body),
            `${s.dir}/SKILL.md must reach the board through \`switchboard api\` — the CLI is the one transport that carries the auth token`);
        assert.ok(!/api-server-port\.txt/.test(body),
            `${s.dir}/SKILL.md still names .switchboard/api-server-port.txt — hand-rolled port discovery was retired with sb_api_call.sh`);
    }
});

test('skills reference no protocol path that does not exist', () => {
    // A pointer into .agents/protocols/ is only as good as the directory it
    // names. The switchboard-orchestration → switchboard-mission-control-http
    // rename broke exactly this link once already. Retired protocols were moved
    // to control_plane rows (bodies in bundledProtocols.ts) — a skill may still
    // reference the old path, but the protocol must resolve either on disk (the
    // two committed survivors) or in the bundle.
    const bundledSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/services/bundledProtocols.ts'), 'utf8');
    const bundledNames = new Set();
    for (const m of bundledSrc.matchAll(/"([A-Za-z0-9_\-]+)":\s*\{/g)) {
        bundledNames.add(m[1]);
    }
    const pattern = /\.agents\/protocols\/([A-Za-z0-9_\-]+)\/SKILL\.md/g;
    for (const s of SKILLS) {
        const body = sourceBody(s);
        let m;
        while ((m = pattern.exec(body)) !== null) {
            const target = path.join(REPO_ROOT, '.agents', 'protocols', m[1], 'SKILL.md');
            const onDisk = fs.existsSync(target);
            const inBundle = bundledNames.has(m[1]);
            assert.ok(onDisk || inBundle,
                `${s.dir}/SKILL.md points at .agents/protocols/${m[1]}/SKILL.md, which does not exist on disk or in the bundle`);
        }
    }
});

if (failed > 0) {
    console.error(`\n❌ ${failed} test(s) failed, ${passed} passed.`);
    process.exit(1);
}
console.log(`\n✅ All ${passed} test(s) passed.`);
