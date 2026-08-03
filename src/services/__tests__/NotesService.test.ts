import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesService, NoteMeta } from '../NotesService';

/**
 * Pure-ish unit coverage for NotesService: parse/serialize round-trips, slug/id
 * generation, and buildDigest window math. Round-trip tests need no fs; the fs
 * tests run against a throwaway temp workspace (no server, no vscode).
 */
suite('NotesService', () => {
    let ws: string;
    let notes: NotesService;

    setup(() => {
        ws = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-unit-'));
        notes = new NotesService(ws);
    });

    teardown(() => {
        try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    suite('serializeNote / parseNoteMetadata round-trip', () => {
        test('preserves title, id, kind, timestamps, tags, when, and body', () => {
            const meta: NoteMeta = {
                id: '6b1e0000-0000-0000-0000-000000000000',
                kind: 'meeting',
                title: 'Weekly Sync with Platform',
                file: '',
                created: '2026-08-03T09:12:00.000Z',
                updated: '2026-08-03T09:40:12.000Z',
                tags: ['platform', 'sync'],
                when: '2026-08-05T15:00:00.000Z'
            };
            const body = '- Agenda item 1\n- Action: follow up';
            const serialized = notes.serializeNote(meta, body);

            // Metadata is embedded **Field:** lines, not YAML.
            assert.ok(/^# Weekly Sync with Platform$/m.test(serialized));
            assert.ok(serialized.includes('**Note ID:** 6b1e0000-0000-0000-0000-000000000000'));
            assert.ok(serialized.includes('**Kind:** meeting'));
            assert.ok(serialized.includes('**Tags:** platform, sync'));
            assert.ok(serialized.includes('**When:** 2026-08-05T15:00:00.000Z'));
            assert.ok(!/^---$/m.test(serialized), 'must not emit a YAML front-matter fence');

            // Subdir supplies the authoritative kind on parse.
            const parsed = notes.parseNoteMetadata(serialized, 'meetings');
            assert.strictEqual(parsed.title, meta.title);
            assert.strictEqual(parsed.id, meta.id);
            assert.strictEqual(parsed.kind, 'meeting');
            assert.strictEqual(parsed.created, meta.created);
            assert.strictEqual(parsed.updated, meta.updated);
            assert.deepStrictEqual(parsed.tags, ['platform', 'sync']);
            assert.strictEqual(parsed.when, meta.when);
            assert.strictEqual(parsed.body, body);
        });

        test('omits Tags/When lines when absent and parses empty tags to []', () => {
            const meta: NoteMeta = {
                id: 'id-1', kind: 'plan', title: 'Bare', file: '',
                created: '2026-08-03T00:00:00.000Z', updated: '2026-08-03T00:00:00.000Z', tags: []
            };
            const serialized = notes.serializeNote(meta, '');
            assert.ok(!/\*\*Tags:\*\*/.test(serialized), 'no Tags line when empty');
            assert.ok(!/\*\*When:\*\*/.test(serialized), 'no When line when absent');
            const parsed = notes.parseNoteMetadata(serialized, 'plans');
            assert.deepStrictEqual(parsed.tags, []);
            assert.strictEqual(parsed.when, undefined);
            assert.strictEqual(parsed.body, '');
        });

        test('subdir wins over a mismatched **Kind:** line', () => {
            const meta: NoteMeta = {
                id: 'id-2', kind: 'meeting', title: 'X', file: '',
                created: '2026-08-03T00:00:00.000Z', updated: '2026-08-03T00:00:00.000Z', tags: []
            };
            const serialized = notes.serializeNote(meta, 'body');
            const parsed = notes.parseNoteMetadata(serialized, 'plans'); // file physically in plans/
            assert.strictEqual(parsed.kind, 'plan', 'subdir is authoritative');
        });
    });

    suite('slug / id generation (via write)', () => {
        test('write assigns a uuid, encodes it in the filename, and slugs the title', async () => {
            const note = await notes.write({ kind: 'plan', title: 'Hello, World! (v2)', body: 'x' });
            assert.match(note.id, /^[0-9a-f-]{36}$/, 'a uuidv4 id');
            assert.ok(note.file.endsWith(`-${note.id}.md`), 'id recoverable from filename');
            const base = path.basename(note.file);
            assert.ok(base.startsWith('hello-world-v2-'), `slug lowercases + hyphenates: ${base}`);
        });

        test('write honors a supplied id and preserves Created on replace', async () => {
            const first = await notes.write({ kind: 'plan', title: 'Keep', body: '1' });
            await new Promise(r => setTimeout(r, 5));
            const replaced = await notes.write({ id: first.id, kind: 'plan', title: 'Keep', body: '2' });
            assert.strictEqual(replaced.id, first.id);
            assert.strictEqual(replaced.created, first.created, 'Created preserved');
            assert.ok(replaced.updated >= first.updated, 'Updated refreshed');
            const all = await notes.list({});
            assert.strictEqual(all.length, 1, 'replace does not create a second file');
        });

        test('rejects a traversal id and writes nothing outside the notes store', async () => {
            fs.mkdirSync(path.join(ws, '.switchboard', 'plans'), { recursive: true });
            for (const id of ['../../../plans/x', 'a/b', 'a.b', '..', '/etc/passwd']) {
                await assert.rejects(
                    () => notes.write({ kind: 'plan', title: 'evil', id, body: 'x' }),
                    /path traversal|Invalid note id/,
                    `id ${JSON.stringify(id)} must be rejected`
                );
            }
            assert.deepStrictEqual(fs.readdirSync(path.join(ws, '.switchboard', 'plans')), [], 'nothing escaped into plans/');
        });

        test('a very long title is capped at 60 slug chars', async () => {
            const longTitle = 'a'.repeat(200);
            const note = await notes.write({ kind: 'plan', title: longTitle });
            const slug = path.basename(note.file).replace(`-${note.id}.md`, '');
            assert.ok(slug.length <= 60, `slug capped at 60 (got ${slug.length})`);
        });
    });

    suite('buildDigest window math', () => {
        test('empty store returns an empty string', async () => {
            assert.strictEqual(await notes.buildDigest({}), '');
        });

        test('a meeting inside the window appears; one outside does not', async () => {
            const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();          // +1h
            const farOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // +3d
            await notes.write({ kind: 'meeting', title: 'Soon Meeting', when: soon });
            await notes.write({ kind: 'meeting', title: 'Far Meeting', when: farOut });

            const digest = await notes.buildDigest({ lookaheadMinutes: 1440 }); // 24h
            // The upcoming-meetings section is window-bounded; the recent-notes
            // section is not (a far-out meeting is still a recently-changed note).
            const upcomingSection = digest.split('Recently changed notes:')[0];
            assert.ok(upcomingSection.includes('Soon Meeting'), 'in-window meeting is named under upcoming');
            assert.ok(!upcomingSection.includes('Far Meeting'), 'out-of-window meeting is excluded from upcoming');
            assert.ok(/1 upcoming meeting\(s\)/.test(digest), 'counts line reflects the window');
        });

        test('digest is bounded: caps stale plan-notes, clamps titles, clamps total length', async () => {
            // Seed many stale plan-notes (Updated well in the past) + one giant title.
            const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            for (let i = 0; i < 25; i++) {
                const note = await notes.write({ kind: 'plan', title: `Stale plan ${i} ${'x'.repeat(300)}` });
                // Backdate Updated so it counts as stale (write stamps "now").
                const abs = path.join(ws, note.file);
                const raw = fs.readFileSync(abs, 'utf8').replace(/\*\*Updated:\*\* .*/, `**Updated:** ${oldIso}`);
                fs.writeFileSync(abs, raw, 'utf8');
            }
            const digest = await notes.buildDigest({});
            // Stale section lists at most STALE_DIGEST_MAX (10) and says so.
            const bulletCount = (digest.match(/^• /gm) || []).length;
            assert.ok(digest.includes('showing 10 of'), `stale section must be capped and annotated: ${digest.slice(0, 200)}`);
            // No single line carries a 300-char title (clamped to ~120).
            assert.ok(!/x{200}/.test(digest), 'titles must be clamped, not emitted raw');
            // Total output is bounded.
            assert.ok(digest.length <= 4000 + 20, `digest must be clamped to ~4000 chars (was ${digest.length})`);
            assert.ok(bulletCount > 0, 'sanity: the digest has bullet lines');
        });

        test('upcoming() excludes past meetings and sorts soonest-first', async () => {
            const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const inHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            const inTwo = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
            await notes.write({ kind: 'meeting', title: 'Two', when: inTwo });
            await notes.write({ kind: 'meeting', title: 'One', when: inHour });
            await notes.write({ kind: 'meeting', title: 'Past', when: past });

            const up = await notes.upcoming({ withinMinutes: 1440 });
            assert.deepStrictEqual(up.map(m => m.title), ['One', 'Two']);
        });
    });
});
