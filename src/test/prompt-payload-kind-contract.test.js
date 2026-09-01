/**
 * Contract: the ptySendPrompt payload-kind rail and POST /terminals/clear.
 *
 * Two mechanisms land here, and neither had a gate that could discriminate on
 * its correctness:
 *
 *  1. **Payload kind.** `ptySendPrompt` re-keys append suppression from "who
 *     sent it" (`machineOrigin`) to "what is this payload" (`kind`), and flips
 *     the DEFAULT for a send that carries no `dispatch` object from dispatch to
 *     message. That default flip is a behaviour change on a rail every seat
 *     shares: a caller that relied on the appends and does not declare
 *     `kind: 'dispatch'` silently loses its standing orders AND its seat
 *     directive block (GIT POLICY, subagent policy) — the exact regression the
 *     HTTP-boundary strip exists to prevent, with no error and no failing test.
 *     Section 3 is the ratchet for that: every send site must SAY what it is
 *     sending. Five sites were found undeclared on the first pass (the browser
 *     cockpit's drop, its team-queue drain, its standing-orders resend, the
 *     extension's `sendToTerminal`, and the external-team-lead recipe).
 *
 *  2. **POST /terminals/clear.** The canonical scope-aware clear. Its
 *     invariants are server-enforced precisely so a caller cannot forget them,
 *     which means the server is the only place they can be checked.
 *
 * Source-level where the logic is inlined per host (there is no extracted
 * helper to call), behavioural where a pure function exists.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const TVP = read('src/services/TaskViewerProvider.ts');
const BOOT = read('src/standalone/bootstrap.ts');
const LAS = read('src/services/LocalApiServer.ts');
const SCHEMAS = read('src/services/verbSchemas.ts');

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

console.log('\nprompt-payload-kind-contract\n');

// ── 1. BEHAVIOURAL: bare slash commands are rejected as prompt data ─────

let validateVerbPayload;
try {
    ({ validateVerbPayload } = require(path.join(REPO_ROOT, 'out', 'services', 'verbSchemas.js')));
} catch { /* out/ not built — section skipped, source checks below still run */ }

if (typeof validateVerbPayload === 'function') {
    test('BEHAVIOUR: a bare /clear as prompt data is rejected, naming the endpoint', () => {
        const res = validateVerbPayload('taskViewer', 'ptySendPrompt', { name: 'a', data: '/clear' });
        assert.strictEqual(res.ok, false, '/clear must be rejected as prompt data');
        assert.ok(
            /POST \/terminals\/clear/.test(res.error),
            `the rejection must name POST /terminals/clear, got: ${res.error}`
        );
    });

    test('BEHAVIOUR: surrounding whitespace does not smuggle a bare slash command through', () => {
        const res = validateVerbPayload('taskViewer', 'ptySendPrompt', { name: 'a', data: '  /clear\n' });
        assert.strictEqual(res.ok, false, 'a padded /clear is still a bare slash command');
    });

    test('BEHAVIOUR: prose that merely QUOTES a slash command still sends', () => {
        for (const data of [
            'Explain what /clear does.',
            '/clear the backlog before you start, then report',
            'Run /clear\nthen continue',
        ]) {
            const res = validateVerbPayload('taskViewer', 'ptySendPrompt', { name: 'a', data });
            assert.strictEqual(res.ok, true, `prose must still send, rejected: ${JSON.stringify(data)}`);
        }
    });

    test('BEHAVIOUR: the rejection is not /clear-specific — any bare slash command is prompt-hostile', () => {
        for (const cmd of ['/compact', '/model', '/status']) {
            const res = validateVerbPayload('taskViewer', 'ptySendPrompt', { name: 'a', data: cmd });
            assert.strictEqual(res.ok, false, `${cmd} must be rejected as prompt data`);
        }
    });
} else {
    console.log('  ⏭  behavioural section skipped (out/ not built)');
}

// ── 2. SOURCE: both hosts agree on what a message is ───────────────────

// The two hosts inline this decision rather than sharing a helper, so the only
// way to stop them drifting is to pin the same four clauses in both.
for (const [label, src] of [['TaskViewerProvider.ts', TVP], ['bootstrap.ts', BOOT]]) {
    test(`SOURCE: ${label} derives isMessage from kind, the machineOrigin alias, and the dispatch evidence`, () => {
        const m = /const isMessage =[\s\S]{0,400}?;/.exec(src);
        assert.ok(m, `${label} must compute an isMessage flag`);
        const block = m[0];
        assert.ok(/kind === 'message'/.test(block), `${label}: kind:'message' must mark a message`);
        assert.ok(/machineOrigin === true/.test(block), `${label}: machineOrigin must remain an accepted alias`);
        assert.ok(/kind !== 'dispatch'/.test(block), `${label}: an explicit dispatch kind must beat the default`);
        assert.ok(/extractDispatchIdentity/.test(block),
            `${label}: the parse backstop must still recognise a dispatch-shaped prompt sent without a dispatch object`);
    });

    test(`SOURCE: ${label} rejects the reserved orders-refresh kind and any unknown kind`, () => {
        assert.ok(
            /kind === 'orders-refresh'[\s\S]{0,200}?reserved/.test(src),
            `${label} must reject kind:'orders-refresh' as reserved for the after-clear path`
        );
        assert.ok(
            /must be "dispatch" or "message"/.test(src),
            `${label} must reject an unknown kind rather than silently treating it as one of the two`
        );
    });

    test(`SOURCE: ${label} does NOT strip kind at the HTTP boundary`, () => {
        // Stripping `kind` would make a message-kind payload unsendable over
        // HTTP, which is the entire point of the field. `addonsComposed` and
        // `seatBlock` stay stripped — those opt a seat out of its own block.
        assert.ok(
            !/delete payload\.kind\b/.test(src),
            `${label} must not delete payload.kind — an HTTP caller is the only party that knows what it is sending`
        );
        assert.ok(
            /delete payload\.(addonsComposed|seatBlock)/.test(src),
            `${label} must still strip the host-only append opt-outs`
        );
    });
}

test('SOURCE: machineOrigin and kind:"message" reach the same suppression, not two code paths', () => {
    // The alias must be honoured EXACTLY (byte-identical delivered text) for as
    // long as the coder's step-3 standing-order text instructs it verbatim.
    // One shared isMessage flag is what makes that true by construction.
    const m = /const isMessage =[\s\S]{0,400}?;/.exec(TVP);
    assert.ok(m && /machineOrigin === true/.test(m[0]),
        'the alias must fold into isMessage rather than getting its own branch');
    assert.ok(
        /applySO\s*=[^;]*!isMessage/.test(TVP) && /applySeatBlock\s*=[^;]*!isMessage/.test(TVP),
        'both appends must gate on the single isMessage flag'
    );
});

// ── 3. RATCHET: every send site declares what kind it is sending ───────

/**
 * The gate that would have caught the five missed callers. A `ptySendPrompt`
 * send that carries no `kind`, no `dispatch` object and no `machineOrigin` is
 * an UNDECLARED payload: it takes the message default silently, and if it
 * wanted the appends it loses them with no error. Declaring is one field.
 *
 * Only SEND sites are scanned — a window is a send when it carries a `data`
 * field. Verb-name mentions, docs and response handling are skipped.
 */
const SEND_SITES = [
    ['src/services/TaskViewerProvider.ts', TVP],
    ['src/services/LocalApiServer.ts', LAS],
    ['src/webview/terminals.js', read('src/webview/terminals.js')],
];

test('RATCHET: every ptySendPrompt send site declares its payload kind', () => {
    const undeclared = [];
    for (const [rel, src] of SEND_SITES) {
        const re = /ptySendPrompt['"]?\s*,?\s*\{|ptySendPrompt['"][\s\S]{0,300}?body:\s*JSON\.stringify\(/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            // Bound the window at the NEXT send site rather than a fixed byte
            // count: two payload literals here carry ~1kB of comment before
            // their `kind`, and a short window reported them as undeclared
            // while the field sat just past its edge.
            const nextAt = src.indexOf('ptySendPrompt', m.index + 20);
            const end = nextAt === -1 ? m.index + 3000 : Math.min(nextAt, m.index + 3000);
            const window = src.slice(m.index, end);
            // Not a send: no payload body.
            if (!/\bdata\s*:/.test(window) && !/["']data["']\s*:/.test(window)) { continue; }
            const declares =
                /\bkind\s*:/.test(window) ||
                /["']kind["']\s*:/.test(window) ||
                /\bmachineOrigin\s*:/.test(window) ||
                /\bdispatch\s*:/.test(window);
            if (!declares) {
                const line = src.slice(0, m.index).split('\n').length;
                undeclared.push(`${rel}:${line}`);
            }
        }
    }
    assert.deepStrictEqual(
        undeclared, [],
        'these ptySendPrompt sends declare no kind, no dispatch object and no machineOrigin, so they ' +
        'silently take the message default and lose the standing-orders and seat-directive appends:\n  ' +
        undeclared.join('\n  ')
    );
});

test('RATCHET: the agent-facing dispatch recipes declare kind:"dispatch"', () => {
    // A recipe an agent copies verbatim is a send site like any other. An
    // external lead dispatching work from a recipe with no kind hands its
    // worker a prompt with no GIT POLICY and no subagent policy.
    for (const rel of [
        '.agents/skills/external-team-lead/SKILL.md',
        '.agents/protocols/external-team-lead/SKILL.md',
    ]) {
        const doc = read(rel);
        const recipe = /Send prompt to a worker terminal[\s\S]{0,1200}?```bash([\s\S]{0,600}?)```/.exec(doc);
        assert.ok(recipe, `${rel} must carry a worker dispatch recipe`);
        assert.ok(
            /"kind":\s*"dispatch"/.test(recipe[0]),
            `${rel}: the worker dispatch recipe must set "kind": "dispatch" or the worker loses its seat directive block`
        );
    }
});

test('SOURCE: kind and machineOrigin are declared fields on the ptySendPrompt schema', () => {
    const from = SCHEMAS.indexOf('ptySendPrompt: {');
    assert.ok(from > 0, 'ptySendPrompt schema must exist');
    const block = SCHEMAS.slice(from, SCHEMAS.indexOf('sendToTerminal: {', from));
    assert.ok(/kind:\s*\{\s*type:\s*'string'\s*\}/.test(block), 'kind must be a declared string field');
    assert.ok(/machineOrigin:\s*\{\s*type:\s*'boolean'\s*\}/.test(block), 'machineOrigin must stay declared');
});

// ── 4. POST /terminals/clear — the server-enforced invariants ──────────

test('SOURCE: the clear route is registered as a first-class POST endpoint', () => {
    assert.ok(
        /pathname === '\/terminals\/clear' && req\.method === 'POST'/.test(LAS),
        'POST /terminals/clear must be a real route, not a verb-tunnel call'
    );
});

test('SOURCE: from is REQUIRED and the caller is never cleared', () => {
    const h = /_handleTerminalsClear[\s\S]*?\n    }\n/.exec(LAS);
    assert.ok(h, '_handleTerminalsClear must exist');
    const body = h[0];
    assert.ok(/missing required field 'from'/.test(body),
        "an optional `from` reopens the invariant the endpoint exists to close");
    assert.ok(/reason: 'caller'/.test(body),
        'the caller must be reported as skipped, not silently dropped');
    assert.ok(/reason: 'head'/.test(body),
        'a head must be skipped on a team scope — clearing a lead is never what "clear the team" means');
});

test('SOURCE: exactly one scope, and no scope that clears everything', () => {
    const h = /_handleTerminalsClear[\s\S]*?\n    }\n/.exec(LAS)[0];
    assert.ok(/scopeCount !== 1/.test(h), 'exactly one of name/team/seats must be required');
    assert.ok(!/ptyClearAllTerminals/.test(h),
        'an endpoint that cannot express "everything" is a better guarantee than a warning against it');
});

test('SOURCE: the clear routes through clearTerminalContext, not the lesser ptyClearTerminal', () => {
    const h = /_handleTerminalsClear[\s\S]*?\n    }\n/.exec(LAS)[0];
    assert.ok(/_options\.clearTerminalContext/.test(h),
        'the endpoint must perform the canonical clear (config honoured, orders redelivered, log boundary rolled)');
    assert.ok(!/'ptyClearTerminal'/.test(h),
        'the endpoint must not fall back to the lesser clear');
});

test('SOURCE: busy-seat deferral reuses the roster barrier helper, not a second policy', () => {
    const h = /_handleTerminalsClear[\s\S]*?\n    }\n/.exec(LAS)[0];
    assert.ok(/computeRosterClearTargets/.test(h),
        'the team scope must reuse the shared pure helper so both clear paths agree on what "mid-turn" means');
    assert.ok(/recordDeferredClears/.test(h),
        'a deferred seat must be RECORDED, or it is skipped permanently rather than cleared when it goes quiet');
});

// ── 5. Standalone parity: the seams, not the verbs ─────────────────────

test('PARITY: both composition roots wire clearTerminalContext and recordDeferredClears', () => {
    // The endpoint is inert in whichever host does not wire the seam, and it
    // fails the same silent way the seam it depends on did. `Promise<void>`
    // seams are where "never wired" and "working" look identical.
    for (const [label, src] of [['TaskViewerProvider.ts', TVP], ['bootstrap.ts', BOOT]]) {
        assert.ok(/clearTerminalContext:\s*(async\s*)?\(/.test(src),
            `${label} must wire clearTerminalContext into LocalApiServerOptions`);
        assert.ok(/recordDeferredClears:\s*\(/.test(src),
            `${label} must wire recordDeferredClears, or a deferred seat is never re-cleared`);
    }
});

test('PARITY: the log session boundary rolls exactly once per clear', () => {
    // Every caller of the clearTerminalContext seam fires
    // onTerminalContextCleared right after it, and that callback is the log
    // roll. A root that ALSO rolls inside its own clearTerminalContext rolls
    // twice, stranding an empty log file behind every clear.
    const impl = /clearTerminalContext:\s*async\s*\([\s\S]*?\n        \},\n/.exec(BOOT);
    assert.ok(impl, "bootstrap.ts must wire a clearTerminalContext implementation");
    // Comments are stripped first: this file's own explanation of WHERE the
    // roll lives names the method, and a gate that cannot tell a comment from a
    // call is a gate that punishes documenting the invariant.
    const implCode = impl[0].replace(/\/\/[^\n]*/g, '');
    assert.ok(
        !/onSessionBoundary/.test(implCode),
        'bootstrap.ts must not roll the log session inside clearTerminalContext — its callers already fire ' +
        'onTerminalContextCleared, and the extension host does not roll internally either'
    );
    assert.ok(
        /onTerminalContextCleared:[\s\S]{0,200}?onSessionBoundary/.test(BOOT),
        'the roll must still happen, via the onTerminalContextCleared callback'
    );
});

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
if (failures > 0) process.exit(1);
