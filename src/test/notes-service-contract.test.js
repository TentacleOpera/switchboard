'use strict';

/**
 * Contract: the Notes store + verb rail.
 *
 * Mirrors the plans/verb rail — a `NotesService` (pure fs/path/uuid, no vscode)
 * wired into `LocalApiServer` via the `notesVerb` option and reached over
 * `POST /notes/verb/<name>`. This pins the HTTP envelope (200 / 502 / 503), the
 * write→read round-trip on a real `.switchboard/notes/` file, list ordering +
 * kind filtering, search, the meetings `upcoming` window, digest composition,
 * immediate (no-confirmation) delete, and absent-store tolerance.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.stack || err}`);
    }
}

function post(port, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request(
            { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
            res => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* non-JSON body */ }
                    resolve({ status: res.statusCode, body: json, raw: data });
                });
            }
        );
        req.on('error', reject);
        req.end(payload);
    });
}

function mkTempWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'notes-contract-'));
}

async function withServer(workspaceRoot, run) {
    const { LocalApiServer } = require(path.join(REPO_ROOT, 'out', 'services', 'LocalApiServer.js'));
    const { NotesService } = require(path.join(REPO_ROOT, 'out', 'services', 'NotesService.js'));
    const notes = new NotesService(workspaceRoot);
    const server = new LocalApiServer({
        port: 0,
        workspaceRoot,
        // Empty token keeps _checkAuth's loopback trust — the proven in-repo pattern.
        getAuthToken: async () => '',
        notesVerb: async (verb, payload, wsRoot) =>
            notes.handleServiceVerb(verb, { ...payload, workspaceRoot: payload?.workspaceRoot || wsRoot }),
    });
    await server.start();
    try {
        await run(server.getPort());
    } finally {
        await server.stop();
    }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

(async function main() {
    console.log('\n── Notes service contract ──');

    // 1. Routing reachability — every verb answers 200 with in-body success.
    await test('each verb is reachable on /notes/verb/<verb> and returns 200 + success:true', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                // Seed one note so read/append/delete have a target.
                const created = await post(port, '/notes/verb/write', { kind: 'plan', title: 'Seed note', body: 'hello' });
                assert.strictEqual(created.status, 200);
                const id = created.body.note.id;

                const cases = [
                    ['list', {}],
                    ['read', { id }],
                    ['search', { query: 'seed' }],
                    ['append', { id, text: 'more' }],
                    ['upcoming', {}],
                    ['digest', {}],
                    ['delete', { id }],
                ];
                for (const [verb, payload] of cases) {
                    const res = await post(port, `/notes/verb/${verb}`, payload);
                    assert.strictEqual(res.status, 200, `${verb} should return 200 (got ${res.status}: ${res.raw})`);
                    assert.strictEqual(res.body && res.body.success, true, `${verb} must carry success:true in-body`);
                }
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 2. write → read round-trip lands a real file with **Field:** metadata.
    await test('write → read round-trip: ids, ISO timestamps, and a real metadata file', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                const w = await post(port, '/notes/verb/write', {
                    kind: 'meeting', title: 'Weekly Sync', body: '- agenda', tags: 'platform, sync', when: '2099-01-01T15:00:00.000Z'
                });
                assert.strictEqual(w.status, 200);
                const note = w.body.note;
                assert.ok(note.id, 'write must return an id');
                assert.ok(note.file && note.file.startsWith('.switchboard/notes/meetings/'), `file should live under meetings/: ${note.file}`);
                assert.ok(note.file.endsWith(`-${note.id}.md`), 'filename must encode the id');
                assert.ok(ISO.test(note.created) && ISO.test(note.updated), 'created/updated must be ISO strings');
                assert.strictEqual(note.kind, 'meeting');

                const absPath = path.join(ws, note.file);
                assert.ok(fs.existsSync(absPath), 'the note file must exist on disk');
                const raw = fs.readFileSync(absPath, 'utf8');
                assert.ok(/^# Weekly Sync$/m.test(raw), 'H1 title line');
                assert.ok(new RegExp(`\\*\\*Note ID:\\*\\* ${note.id}`).test(raw), '**Note ID:** metadata line');
                assert.ok(/\*\*Kind:\*\* meeting/.test(raw), '**Kind:** line');
                assert.ok(/\*\*When:\*\* 2099-01-01T15:00:00\.000Z/.test(raw), '**When:** line');

                const r = await post(port, '/notes/verb/read', { id: note.id });
                assert.strictEqual(r.status, 200);
                assert.strictEqual(r.body.note.title, 'Weekly Sync');
                assert.deepStrictEqual(r.body.note.tags, ['platform', 'sync']);
                assert.ok(r.body.note.content.includes('- agenda'), 'read must include full content');
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 3. write-with-id replaces; append appends and bumps Updated, not Created.
    await test('write-with-id replaces; append appends a paragraph and bumps Updated only', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                const first = (await post(port, '/notes/verb/write', { kind: 'plan', title: 'Draft', body: 'v1' })).body.note;
                await new Promise(r => setTimeout(r, 5));

                // Full-replace by id.
                const replaced = (await post(port, '/notes/verb/write', { id: first.id, kind: 'plan', title: 'Draft', body: 'v2' })).body.note;
                assert.strictEqual(replaced.id, first.id, 'id is stable on replace');
                assert.strictEqual(replaced.created, first.created, 'Created is preserved on replace');
                const readAfterReplace = (await post(port, '/notes/verb/read', { id: first.id })).body.note;
                assert.ok(readAfterReplace.content.includes('v2') && !readAfterReplace.content.includes('v1'), 'body was fully replaced');

                await new Promise(r => setTimeout(r, 5));
                const appended = (await post(port, '/notes/verb/append', { id: first.id, text: 'appended line' })).body.note;
                assert.strictEqual(appended.created, first.created, 'append must not touch Created');
                assert.ok(appended.updated > replaced.updated, 'append must bump Updated');
                const readAfterAppend = (await post(port, '/notes/verb/read', { id: first.id })).body.note;
                assert.ok(readAfterAppend.content.includes('v2') && readAfterAppend.content.includes('appended line'), 'append keeps prior body and adds text');
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 4. list ordering (newest-Updated first) + kind filter.
    await test('list orders newest-Updated first and filters by kind', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                const a = (await post(port, '/notes/verb/write', { kind: 'plan', title: 'Plan A' })).body.note;
                await new Promise(r => setTimeout(r, 5));
                const b = (await post(port, '/notes/verb/write', { kind: 'meeting', title: 'Meeting B', when: '2099-02-02T10:00:00Z' })).body.note;
                await new Promise(r => setTimeout(r, 5));
                const c = (await post(port, '/notes/verb/write', { kind: 'plan', title: 'Plan C' })).body.note;

                const all = (await post(port, '/notes/verb/list', {})).body.notes;
                assert.deepStrictEqual(all.map(n => n.id), [c.id, b.id, a.id], 'newest-Updated first');

                const plansOnly = (await post(port, '/notes/verb/list', { kind: 'plan' })).body.notes;
                assert.deepStrictEqual(plansOnly.map(n => n.id).sort(), [a.id, c.id].sort(), 'kind:plan filters to the plans subdir');
                assert.ok(plansOnly.every(n => n.kind === 'plan'), 'no meeting leaks into the plan filter');

                const capped = (await post(port, '/notes/verb/list', { limit: 1 })).body.notes;
                assert.strictEqual(capped.length, 1, 'limit caps the result');
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 5. search: substring over title/tags/body; miss returns [].
    await test('search matches title/tags/body substrings; a miss returns []', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                await post(port, '/notes/verb/write', { kind: 'plan', title: 'Kafka migration', body: 'move topics', tags: 'infra' });
                await post(port, '/notes/verb/write', { kind: 'plan', title: 'Unrelated', body: 'nothing here' });

                const byTitle = (await post(port, '/notes/verb/search', { query: 'kafka' })).body.notes;
                assert.strictEqual(byTitle.length, 1, 'title substring hit');
                const byBody = (await post(port, '/notes/verb/search', { query: 'topics' })).body.notes;
                assert.strictEqual(byBody.length, 1, 'body substring hit');
                const byTag = (await post(port, '/notes/verb/search', { query: 'infra' })).body.notes;
                assert.strictEqual(byTag.length, 1, 'tag substring hit');
                const miss = (await post(port, '/notes/verb/search', { query: 'zzzznope' })).body.notes;
                assert.deepStrictEqual(miss, [], 'a miss returns []');
                // search returns metadata only, no content field.
                assert.ok(byTitle[0].content === undefined, 'search results carry no content');
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 6. upcoming: in-window meeting appears, out-of-window doesn't, soonest first.
    await test('upcoming lists in-window meetings soonest-first and excludes out-of-window', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();     // +1h
                const later = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(); // +20h
                const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();      // -1h
                const farOut = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(); // +5d

                await post(port, '/notes/verb/write', { kind: 'meeting', title: 'Later', when: later });
                await post(port, '/notes/verb/write', { kind: 'meeting', title: 'Soon', when: soon });
                await post(port, '/notes/verb/write', { kind: 'meeting', title: 'Past', when: past });
                await post(port, '/notes/verb/write', { kind: 'meeting', title: 'FarOut', when: farOut });

                const up = (await post(port, '/notes/verb/upcoming', { withinMinutes: 1440 })).body.meetings;
                assert.deepStrictEqual(up.map(m => m.title), ['Soon', 'Later'], 'in-window, soonest-first; past + far-out excluded');
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 7. digest: non-empty naming the meeting when seeded; '' for an empty store.
    await test('digest names an upcoming meeting when seeded; empty store yields ""', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                const empty = await post(port, '/notes/verb/digest', {});
                assert.strictEqual(empty.status, 200);
                assert.strictEqual(empty.body.digest, '', 'empty store → empty digest');
                assert.strictEqual(empty.body.upcomingCount, 0);
                assert.strictEqual(empty.body.recentCount, 0);

                const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
                await post(port, '/notes/verb/write', { kind: 'meeting', title: 'Board Review', when: soon });
                await post(port, '/notes/verb/write', { kind: 'plan', title: 'Ship it' });

                const d = await post(port, '/notes/verb/digest', {});
                assert.ok(d.body.digest.length > 0, 'seeded store → non-empty digest');
                assert.ok(d.body.digest.includes('Board Review'), 'digest names the upcoming meeting');
                assert.strictEqual(d.body.upcomingCount, 1);
                assert.ok(d.body.recentCount >= 1);
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 8. delete removes immediately (no confirmation path); read then 502s not-found.
    await test('delete unlinks the file immediately; subsequent read fails not-found', async () => {
        const ws = mkTempWorkspace();
        try {
            await withServer(ws, async (port) => {
                const note = (await post(port, '/notes/verb/write', { kind: 'plan', title: 'Ephemeral' })).body.note;
                const absPath = path.join(ws, note.file);
                assert.ok(fs.existsSync(absPath), 'file exists before delete');

                const del = await post(port, '/notes/verb/delete', { id: note.id });
                assert.strictEqual(del.status, 200, 'delete returns 200 immediately (no confirmation gate)');
                assert.strictEqual(del.body.deleted, true);
                assert.strictEqual(del.body.id, note.id);
                assert.ok(!fs.existsSync(absPath), 'file is gone right after delete — nothing to confirm');

                const readGone = await post(port, '/notes/verb/read', { id: note.id });
                assert.strictEqual(readGone.status, 502, 'read of a deleted note is a handled failure (502)');
                assert.strictEqual(readGone.body.success, false);
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // 9. absent-store tolerance — list/digest return empty, not errors.
    await test('an absent .switchboard/notes/ store yields empty list/digest, not errors', async () => {
        const ws = mkTempWorkspace(); // fresh — no .switchboard/notes/ written
        try {
            await withServer(ws, async (port) => {
                assert.ok(!fs.existsSync(path.join(ws, '.switchboard', 'notes')), 'precondition: store dir absent');
                const list = await post(port, '/notes/verb/list', {});
                assert.strictEqual(list.status, 200);
                assert.deepStrictEqual(list.body.notes, [], 'absent store → empty list');
                const digest = await post(port, '/notes/verb/digest', {});
                assert.strictEqual(digest.status, 200);
                assert.strictEqual(digest.body.digest, '', 'absent store → empty digest');
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // SECURITY: a crafted `id` must not escape the notes store (fake-plan injection).
    await test('write with a traversal id is rejected and no file escapes the notes store', async () => {
        const ws = mkTempWorkspace();
        // A sibling .switchboard/plans/ where the plan watcher would ingest an escaped file.
        fs.mkdirSync(path.join(ws, '.switchboard', 'plans'), { recursive: true });
        try {
            await withServer(ws, async (port) => {
                const crafted = [
                    '../../../plans/pwned',
                    '..%2f..%2fplans%2fx',
                    '/etc/passwd',
                    'a/b',
                    'a.b',
                    '..',
                ];
                for (const id of crafted) {
                    const res = await post(port, '/notes/verb/write', { kind: 'plan', title: 'evil', id, body: 'x' });
                    assert.strictEqual(res.body && res.body.success, false, `crafted id ${JSON.stringify(id)} must be rejected in-body`);
                }
                // Nothing landed in the sibling plans dir, and the notes store holds no escaped file.
                assert.deepStrictEqual(fs.readdirSync(path.join(ws, '.switchboard', 'plans')), [], 'no file escaped into .switchboard/plans/');
                const plansNotes = path.join(ws, '.switchboard', 'notes', 'plans');
                const landed = fs.existsSync(plansNotes) ? fs.readdirSync(plansNotes) : [];
                assert.ok(landed.every(f => !f.includes('pwned') && !f.includes('passwd')), `no crafted file in the notes store: ${landed}`);
                // The legit path still works — the guard rejects only the crafted ids.
                const ok = await post(port, '/notes/verb/write', { kind: 'plan', title: 'safe' });
                assert.strictEqual(ok.body.success, true, 'a normal write still succeeds');
            });
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    // Tick digest injection is additive and best-effort. _enqueueOrchestrationWake
    // is too vscode/autoban-coupled to drive live without heavy mocking, so — as
    // the pty-route contract does for host wiring — pin the load-bearing shape at
    // the source: an empty/absent store (buildDigest → '') must leave the wake
    // prompt byte-identical to today's, and a failure must never throw out.
    await test('the wake path injects the notes digest additively and best-effort', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(
            /notesDigest = await this\._notesService\.buildDigest\(\{\s*workspaceRoot: root\s*\}\)/.test(src),
            'the wake path must build the digest from the owned _notesService, rooted at the resolved workspace root.'
        );
        // Best-effort: the buildDigest call is wrapped so any error yields '' rather than throwing.
        assert.ok(
            /try\s*\{[\s\S]{0,120}buildDigest[\s\S]{0,160}catch\s*\(err\)\s*\{[\s\S]{0,120}notes digest failed/.test(src),
            'buildDigest must be wrapped in try/catch that logs and falls back — a wake must never fail on the digest.'
        );
        // Additive: an empty digest contributes an empty block, so the prompt is unchanged.
        assert.ok(
            /const digestBlock = notesDigest\s*\?\s*`NOTES DIGEST[\s\S]{0,80}`\s*:\s*''/.test(src),
            "an empty digest must yield an empty digestBlock so the wake prompt stays byte-identical to today's."
        );
        assert.ok(
            /const wakePrompt = `\$\{recoveryPreamble\}\$\{digestBlock\}You are the Switchboard orchestrator\./.test(src),
            'the digestBlock must be spliced between the recoveryPreamble and the existing orchestrator prompt — nothing else changes.'
        );
    });

    // Capability-gating honesty: the route 503s when no host wires notesVerb.
    await test('/notes/verb/ returns 503 when the host does not wire notesVerb', async () => {
        const { LocalApiServer } = require(path.join(REPO_ROOT, 'out', 'services', 'LocalApiServer.js'));
        const server = new LocalApiServer({ port: 0, workspaceRoot: REPO_ROOT, getAuthToken: async () => '' });
        await server.start();
        try {
            const res = await post(server.getPort(), '/notes/verb/list', {});
            assert.strictEqual(res.status, 503, `expected 503 with no notesVerb wired, got ${res.status}`);
        } finally {
            await server.stop();
        }
    });

    if (failures > 0) {
        console.error(`\n${failures} contract check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll Notes service contract checks passed.\n');
})();
