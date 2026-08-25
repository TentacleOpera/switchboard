'use strict';

/**
 * Behavioural + contract guard for ptyPromptDelivery.ts paste framing.
 *
 * The shipped bug (feature_plan_20260813103000) chunked the FRAMED string
 * `\x1b[200~${text}\x1b[201~`, which splits the 6-byte close marker `\x1b[201~`
 * across a 256-byte boundary. The close marker STARTS at index 6+text.length
 * (the 6-byte open marker `\x1b[200~` precedes the payload), so the split
 * condition is (6 + text.length) % 256 ∈ [251,255] — i.e. text.length % 256 ∈
 * [245,249]. The two halves arrive 30 ms apart; a per-read paste parser never
 * sees a close and the terminal stays in paste mode — every later byte (\r,
 * Ctrl-U, the next prompt) is absorbed as literal text. The bug returned
 * success:true every time, so a fixed-length smoke send passes against the
 * broken code. This test parameterises over the failing lengths and asserts the
 * markers are whole.
 *
 * SUBMISSION: two \r, not one. The port from _sendRobustTextBackground took its
 * framing verbatim but NOT its submit count. terminalUtils.ts:258 sends one
 * Enter; sendPromptToPty sends a second, unconditional confirm Enter
 * CONFIRM_ENTER_DELAY_MS later — restored as a follow-up to
 * feature_plan_20260812093000 (see its completion summary) on operator evidence
 * that unlisted CLIs (devin) show pasted text land in the input field unsent.
 * "Unconditional" is the load-bearing word: no regex, no allowlist, no role
 * check — the CLI_AGENT_REGEX gate that used to gate it is deleted and must
 * stay deleted. If the second CR ever goes away, this file's CONFIRM_CR_COUNT is
 * the single knob to turn.
 *
 * SPLIT CR: no write may carry printable text AND the CR that submits it.
 * Measured 2026-08-23 on devin 3000.4.25 vs 3000.5.20: the new build inserts a
 * literal newline instead of submitting whenever the CR arrives in the same READ
 * as text, which broke every slash command (the clear/model buttons) and made
 * clearBeforePrompt deliver `/clear\n<prompt>` with the context never reset. Two
 * writes with no delay between them coalesce into one read, so the settle between
 * them is part of the contract — hence the timing assertion below, which is the
 * only thing standing between the fix and someone "optimising" the await away.
 * That also answers the old question about terminalUtils.ts's clipboard branch:
 * its Enter is already isolated (`sendText('', true)`), so one suffices there.
 *
 * No compilation step required — Node's native type stripping loads the .ts
 * source directly. The `import type` in ptyPromptDelivery.ts is erased, so
 * ptyFleetService.ts (and its node-pty dependency) are never loaded.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('./bootstrap/tsResolveHook').installTsResolveHook();

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_FILE = path.join(REPO_ROOT, 'src', 'standalone', 'ptyPromptDelivery.ts');

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

/**
 * How many \r sendPromptToPty emits after the close marker: the submit Enter
 * plus one unconditional confirm Enter. See the header comment. This is the
 * ONLY intended divergence from the reference implementation.
 */
const CONFIRM_CR_COUNT = 2;

/**
 * Independently replicate _sendRobustTextBackground's write sequence
 * (terminalUtils.ts:241-258) to produce the reference byte sequence for a
 * given payload. sendPromptToPty must emit byte-identical writes up to and
 * including the close marker; it then diverges by exactly the extra confirm
 * \r that expectedWrites() appends.
 */
function referenceWrites(text) {
    const CHUNK_SIZE = 256;
    const writes = [];
    writes.push('\x1b[200~');
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        writes.push(text.substring(i, i + CHUNK_SIZE));
    }
    writes.push('\x1b[201~');
    writes.push('\r');
    return writes;
}

/**
 * The reference sequence plus sendPromptToPty's extra confirm CRs. Built from
 * referenceWrites so the framing half stays diffable against terminalUtils.ts
 * by eye — the whole point of the port — while the submit half records the one
 * deliberate difference in a single place.
 */
function expectedWrites(text) {
    return [...referenceWrites(text), ...Array(CONFIRM_CR_COUNT - 1).fill('\r')];
}

/** A stub handle that records every write call. */
function stubHandle(name = 'Feature Implementation-coder-1', role = 'coder') {
    const writes = [];
    const times = [];
    return {
        name,
        role,
        writes,
        times,
        handle: {
            name,
            role,
            write(chunk) { writes.push(chunk); times.push(Date.now()); },
        },
    };
}

(async function main() {
    console.log('\n── PTY prompt delivery framing ──');

    const mod = await import(path.join('file://', SOURCE_FILE));
    const { sendPromptToPty } = mod;

    // --- behavioural: the failing lengths --------------------------------
    // The close marker starts at index 6+text.length in the OLD framed string
    // (the 6-byte open marker precedes the payload), so it splits when
    // (6 + text.length) % 256 ∈ [251,255] — i.e. text.length % 256 ∈ [245,249].
    // Every residue in [245,249] strands, so the whole band is listed at the
    // smallest multiple as well as at higher ones — 245 is the first failing
    // length in the product, not a safe control.
    const FAILING_LENGTHS = [245, 246, 247, 248, 249, 501, 757, 1013, 1269];
    // 250 is the first residue clear of the band; 507/763/1019/1275 (% 256 = 251)
    // are the lengths the plan originally named as failing and which do NOT split.
    const SAFE_LENGTHS = [10, 250, 256, 257, 507, 763, 1019, 1275, 1536, 2048];

    for (const len of [...FAILING_LENGTHS, ...SAFE_LENGTHS]) {
        await test(`markers are whole writes and ${CONFIRM_CR_COUNT} \\r follow — len ${len} (mod ${len % 256})`, async () => {
            const text = 'x'.repeat(len);
            const { handle, writes } = stubHandle();
            await sendPromptToPty(handle, text, { clearBeforePrompt: false });

            // \x1b[200~ must be a single, whole write (first write).
            assert.strictEqual(
                writes[0], '\x1b[200~',
                `open marker must arrive as a single whole write (got ${JSON.stringify(writes[0])})`
            );

            // \x1b[201~ must be a single, whole write, sitting immediately before
            // the trailing CRs. Indexing from the END rather than a fixed -2 keeps
            // this honest if CONFIRM_CR_COUNT ever changes.
            const closeIdx = writes.length - 1 - CONFIRM_CR_COUNT;
            assert.strictEqual(
                writes[closeIdx], '\x1b[201~',
                `close marker must arrive as a single whole write (got ${JSON.stringify(writes[closeIdx])})`
            );

            // Exactly CONFIRM_CR_COUNT \r, and they are the trailing writes —
            // nothing may be interleaved between the close marker and the submit.
            const crCount = writes.filter(w => w === '\r').length;
            assert.strictEqual(crCount, CONFIRM_CR_COUNT, `exactly ${CONFIRM_CR_COUNT} \\r per delivery (got ${crCount})`);
            assert.deepStrictEqual(
                writes.slice(closeIdx + 1), Array(CONFIRM_CR_COUNT).fill('\r'),
                'every write after the close marker must be a bare \\r'
            );

            // No write may contain a partial marker fragment.
            for (let i = 0; i < writes.length; i++) {
                const w = writes[i];
                if (w === '\x1b[200~' || w === '\x1b[201~' || w === '\r') { continue; }
                assert.ok(
                    !w.includes('\x1b[200~') && !w.includes('\x1b[201~'),
                    `payload chunk ${i} must not contain a paste marker fragment: ${JSON.stringify(w)}`
                );
            }
        });
    }

    // --- behavioural: byte-sequence parity with _sendRobustTextBackground ---
    for (const len of [...FAILING_LENGTHS, ...SAFE_LENGTHS]) {
        await test(`emitted sequence matches reference + confirm CR — len ${len}`, async () => {
            const text = 'A'.repeat(len);
            const { handle, writes } = stubHandle();
            await sendPromptToPty(handle, text, { clearBeforePrompt: false });
            assert.deepStrictEqual(
                writes, expectedWrites(text),
                `write sequence differs from _sendRobustTextBackground's (plus the confirm CR) for len ${len}`
            );
            // The framing half must be byte-identical to the reference with no
            // allowance at all — that is the ported contract.
            const ref = referenceWrites(text);
            assert.deepStrictEqual(
                writes.slice(0, ref.length - 1), ref.slice(0, ref.length - 1),
                `framing writes (open marker → payload → close marker) must be byte-identical to _sendRobustTextBackground's for len ${len}`
            );
        });
    }

    // --- behavioural: clearBeforePrompt does not corrupt the framing -------
    await test('clearBeforePrompt: true prepends /clear but markers stay whole', async () => {
        const text = 'x'.repeat(507); // a failing length
        const { handle, writes } = stubHandle();
        await sendPromptToPty(handle, text, { clearBeforePrompt: true, clearBeforePromptDelayMs: 0 });

        assert.strictEqual(writes[0], '\x15', 'first write must reset the CLI input line (Ctrl+U)');
        assert.strictEqual(writes[1], '/clear', 'second write must be the bare /clear command — no CR appended');
        assert.strictEqual(writes[2], '\r', "the clear's submitting CR must be its own write");

        // After the clear, the paste framing must still be whole.
        const pasteStart = writes.indexOf('\x1b[200~');
        assert.ok(pasteStart !== -1, 'open marker must be present after the clear');
        assert.strictEqual(writes[pasteStart], '\x1b[200~');
        assert.ok(!writes.slice(pasteStart).includes('\x15'), 'no Ctrl+U after the open marker');

        const closeIdx = writes.length - 1 - CONFIRM_CR_COUNT;
        assert.strictEqual(writes[closeIdx], '\x1b[201~', 'close marker must be whole');
        assert.strictEqual(writes[writes.length - 1], '\r', 'final write must be \\r');

        // The clear's CR is now a bare write of its own, so it adds exactly one to
        // the bare-'\r' count on top of the submit + confirm CRs.
        const submitCrCount = writes.filter(w => w === '\r').length;
        assert.strictEqual(
            submitCrCount, CONFIRM_CR_COUNT + 1,
            `exactly ${CONFIRM_CR_COUNT + 1} bare \\r (submit + confirm, plus the clear's own split CR)`
        );
    });

    // --- behavioural: text and its submitting CR never share a write --------
    await test('no write carries printable text AND a trailing CR', async () => {
        const { handle, writes } = stubHandle();
        await sendPromptToPty(handle, 'y'.repeat(300), { clearBeforePrompt: true, clearBeforePromptDelayMs: 0 });
        for (const w of writes) {
            if (w === '\r') { continue; }
            assert.ok(
                !w.endsWith('\r'),
                `a CR must never ride along with printable text — devin 3000.5.20 inserts it as a newline instead of submitting: ${JSON.stringify(w)}`
            );
        }
    });

    await test('writeSlashCommandLocked emits exactly [Ctrl+U, command, CR]', async () => {
        const { writeSlashCommandLocked } = mod;
        const { handle, writes } = stubHandle();
        await writeSlashCommandLocked(handle, '/model');
        assert.deepStrictEqual(
            writes, ['\x15', '/model', '\r'],
            'the command and its submitting CR must be separate writes, with Ctrl+U first'
        );
    });

    await test('a real delay separates the command from its CR', async () => {
        const { writeSlashCommandLocked } = mod;
        const { handle, writes, times } = stubHandle();
        await writeSlashCommandLocked(handle, '/clear');
        const cmdIdx = writes.indexOf('/clear');
        const crIdx = writes.indexOf('\r');
        assert.ok(cmdIdx !== -1 && crIdx === cmdIdx + 1, 'the CR must be the write right after the command');
        const gap = times[crIdx] - times[cmdIdx];
        // Separate write() calls are NOT enough: with no delay the pty coalesces
        // them into one read and the CR is absorbed as a literal newline, exactly
        // as if it had been concatenated. Measured 0ms fails, 40ms submits.
        assert.ok(
            gap >= 25,
            `the command and its CR must be separated by an awaited settle, not just two write() calls (gap was ${gap}ms)`
        );
    });

    // --- behavioural: no identity check — coder and shell get the same path -
    await test('coder and shell roles receive identical framing (no identity gate)', async () => {
        const text = 'x'.repeat(507);
        const coder = stubHandle('Feature Implementation-coder-1', 'coder');
        const shell = stubHandle('my-shell', 'shell');
        await sendPromptToPty(coder.handle, text, { clearBeforePrompt: false });
        await sendPromptToPty(shell.handle, text, { clearBeforePrompt: false });
        assert.deepStrictEqual(
            coder.writes, shell.writes,
            'coder and shell roles must produce identical write sequences'
        );
    });

    // --- contract: source-text assertions (no compilation needed) ---------
    const src = fs.readFileSync(SOURCE_FILE, 'utf8');
    // Strip comments before asserting on identifiers. The file DELIBERATELY
    // discusses CLI_AGENT_REGEX in prose — that history is why the gate stays
    // deleted, and a guard that fails on its own documentation teaches the next
    // reader to delete the documentation.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    await test('no CLI_AGENT_REGEX in code (comments may discuss it)', () => {
        assert.ok(
            !/CLI_AGENT_REGEX/.test(code),
            'CLI_AGENT_REGEX must stay deleted from the code — it tested handle.name/handle.role, which carry no CLI identity for role-named seats, so it could never match a fleet terminal. The confirm CR is now unconditional instead of gated.'
        );
    });

    await test('no identity gate of any kind on the delivery path', () => {
        assert.ok(
            !/handle\.(name|role)\s*\)?\s*\.(test|match)|\.test\(\s*handle\.(name|role)/.test(code),
            'the delivery path must not branch on handle.name or handle.role — the confirm CR is unconditional by design.'
        );
    });

    await test('source contains no framed template concatenation', () => {
        assert.ok(
            !/`\\x1b\[200~\$\{/.test(code) && !/`\x1b\[200~\$\{/.test(code),
            'no `\\x1b[200~${...}` template concatenation may remain — chunking the framed string splits the close marker.'
        );
    });

    await test(`sendPromptToPty contains exactly ${CONFIRM_CR_COUNT} handle.write('\\r')`, () => {
        // Scoped to sendPromptToPty's body. writeSlashCommandLocked now has a bare
        // CR write of its own (the split submit), and counting file-wide would
        // conflate the two paths — a future change to either would fail as the
        // other's regression.
        const from = code.indexOf('export async function sendPromptToPty');
        const to = code.indexOf('export async function clearPty');
        assert.ok(from !== -1 && to > from, 'could not locate sendPromptToPty..clearPty in the source');
        const body = code.slice(from, to);
        const matches = body.match(/handle\.write\('\\r'\)/g) || [];
        assert.strictEqual(
            matches.length, CONFIRM_CR_COUNT,
            `exactly ${CONFIRM_CR_COUNT} handle.write('\\r') in sendPromptToPty — the submit Enter plus the unconditional confirm Enter; found ${matches.length}.`
        );
    });

    await test("writeSlashCommandLocked submits with a bare handle.write('\\r')", () => {
        const from = code.indexOf('export async function writeSlashCommandLocked');
        const to = code.indexOf('export interface PromptDeliveryOptions');
        assert.ok(from !== -1 && to > from, 'could not locate writeSlashCommandLocked in the source');
        const body = code.slice(from, to);
        const matches = body.match(/handle\.write\('\\r'\)/g) || [];
        assert.strictEqual(
            matches.length, 1,
            `the slash-command submit must be exactly one bare CR write; found ${matches.length}.`
        );
        assert.ok(
            !/handle\.write\([^)]*\+ '\\r'\)/.test(body),
            "the CR must never be concatenated onto the command — devin 3000.5.20 inserts a CR arriving in the same read as printable text as a literal newline instead of submitting."
        );
    });

    await test('source contains standalone marker writes', () => {
        assert.ok(
            /handle\.write\('\\x1b\[200~'\)/.test(src),
            "open marker must be its own handle.write('\\x1b[200~') call"
        );
        assert.ok(
            /handle\.write\('\\x1b\[201~'\)/.test(src),
            "close marker must be its own handle.write('\\x1b[201~') call"
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll PTY prompt delivery framing checks passed.\n');
})();
