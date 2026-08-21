'use strict';

/**
 * Contract: the standing-orders marker literal is byte-identical across the
 * TypeScript writer (src/services/standingOrders.ts) and the webview client
 * mirror (src/webview/terminals.js), and the scope-aware selection and
 * rendering logic is mechanically pinned between the two.
 *
 * The marker is the cross-boundary de-duplication token: when a prompt is
 * processed by both the client and the host, the block-strip regex removes
 * a pre-existing block before appending a fresh one, so only one block
 * appears. A one-sided rename or logic divergence breaks de-duplication and
 * delivers two blocks in one prompt, or drops the target's own orders. This
 * test enforces parity mechanically so the next change cannot silently diverge.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-marker-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const STANDING_ORDERS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'standingOrders.ts'), 'utf8'
);
const TERMINALS_JS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8'
);
const AGENT_PROMPT_BUILDER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'agentPromptBuilder.ts'), 'utf8'
);
const KANBAN_HTML_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'webview', 'kanban.html'), 'utf8'
);
const TEAM_WIRING_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'teamWiring.ts'), 'utf8'
);

/**
 * Read a chain of single-quoted string literals joined by `+`, starting at
 * `i`, and return the concatenated value with `\n` and `\'` unescaped.
 * Returns null when `src[i]` does not begin a string literal.
 *
 * Every copy of this prose is authored as `'…' + '…' + '…'` (single-quoted
 * concatenation is the house style for prompt text — it must never be
 * evaluated), so byte-comparing the copies means joining the segments first.
 */
function readQuotedChain(src, i) {
    if (src[i] !== "'") { return null; }
    let value = '';
    for (;;) {
        if (src[i] !== "'") { break; }
        let j = i + 1;
        let seg = '';
        while (j < src.length && src[j] !== "'") {
            if (src[j] === '\\') { seg += src[j] + src[j + 1]; j += 2; continue; }
            seg += src[j]; j++;
        }
        value += seg;
        i = j + 1;
        while (i < src.length && /\s/.test(src[i])) { i++; }
        if (src[i] === '+') { i++; while (i < src.length && /\s/.test(src[i])) { i++; } continue; }
        break;
    }
    return value.replace(/\\n/g, '\n').replace(/\\'/g, "'");
}

let passed = 0;
let failed = 0;
const testPromises = [];

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            // Async test — defer pass/fail to promise settlement.
            testPromises.push(
                result.then(() => { console.log(`  ✅ ${name}`); passed++; })
                      .catch((e) => { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; })
            );
        } else {
            console.log(`  ✅ ${name}`); passed++;
        }
    } catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/** Extract the single-quoted string value from a `const STANDING_ORDERS_MARKER = '...';` line. */
function extractMarker(src, fileLabel) {
    const m = src.match(/STANDING_ORDERS_MARKER\s*=\s*'([^']*)'/);
    assert.ok(m, `STANDING_ORDERS_MARKER literal not found in ${fileLabel}`);
    return m[1];
}

// 1. Byte-identity across both declaration sites

test('standingOrders.ts and terminals.js declare the same marker literal', () => {
    const tsMarker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    const jsMarker = extractMarker(TERMINALS_JS_SRC, 'src/webview/terminals.js');
    assert.strictEqual(
        tsMarker, jsMarker,
        `Marker mismatch: standingOrders.ts has '${tsMarker}' but terminals.js has '${jsMarker}'. ` +
        'A one-sided rename breaks cross-boundary de-duplication and delivers two standing-order blocks.'
    );
});

// 2. The marker is not the retired product-named string

test('marker does not contain the retired "SWITCHBOARD" prefix', () => {
    const marker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    assert.ok(
        !marker.includes('SWITCHBOARD'),
        `Marker still contains 'SWITCHBOARD': '${marker}'. The block header names the thing, not the product.`
    );
});

// 3. The marker is wrapped in the === delimiters

test('marker is wrapped in === delimiters', () => {
    const marker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    assert.ok(
        marker.startsWith('=== ') && marker.endsWith(' ==='),
        `Marker must be wrapped in '=== ... ===' delimiters, got: '${marker}'`
    );
});

// 4. validateInstruction rejects a string containing the marker

test('validateInstruction rejects an instruction containing the marker', () => {
    const marker = extractMarker(STANDING_ORDERS_SRC, 'src/services/standingOrders.ts');
    // Source-level assertion: the validateInstruction function dereferences the
    // constant, so this is a structural check that the guard exists.
    assert.ok(
        STANDING_ORDERS_SRC.includes('text.includes(STANDING_ORDERS_MARKER)'),
        'validateInstruction must guard against the marker via text.includes(STANDING_ORDERS_MARKER)'
    );
    // Sanity: the marker we extracted is a non-empty string.
    assert.ok(marker.length > 0, 'Marker must not be empty');
});

// 5. Mirror parity — the client mirror (terminals.js) and the server
//    (standingOrders.ts) must implement the same scope-aware selection and
//    rendering logic. There is no runtime test enforcing that the filter or
//    the template match, which is precisely how they could silently diverge.
//    These source-level assertions pin the scope vocabulary, the team-membership
//    resolution, the block-strip regex, and the per-scope rendering framing
//    across both files.

test('both files declare the same block-strip regex for de-duplication, anchored to a complete block', () => {
    for (const [src, label] of [[STANDING_ORDERS_SRC, 'standingOrders.ts'], [TERMINALS_JS_SRC, 'terminals.js']]) {
        assert.ok(
            /STANDING_ORDERS_BLOCK_RE/.test(src),
            `${label} must declare STANDING_ORDERS_BLOCK_RE for block stripping`
        );
        // The regex must be anchored to a COMPLETE block — require the trailing
        // "These apply..." line — so a mid-text marker quote is not silently
        // truncated from that point to end-of-string.
        assert.ok(
            /STANDING_ORDERS_BLOCK_RE/.test(src) && /These apply to everything/.test(src),
            `${label} block-strip regex must be anchored to the trailing 'These apply...' line`
        );
    }
});

test('both files implement scope-aware selection (global / team / pair)', () => {
    for (const scope of ['global', 'team', 'pair']) {
        assert.ok(
            new RegExp(`scope.*${scope}|${scope}.*scope`).test(STANDING_ORDERS_SRC),
            `standingOrders.ts must reference the '${scope}' scope in its selection logic`
        );
        assert.ok(
            new RegExp(`scope.*${scope}|${scope}.*scope`).test(TERMINALS_JS_SRC),
            `terminals.js must reference the '${scope}' scope in its selection logic (mirror parity)`
        );
    }
});

test('both files resolve team membership through group members and teamId', () => {
    assert.ok(
        /teamId/.test(STANDING_ORDERS_SRC) && /members/.test(STANDING_ORDERS_SRC),
        'standingOrders.ts must resolve team scope via teamId and group members'
    );
    assert.ok(
        /teamId/.test(TERMINALS_JS_SRC) && /members/.test(TERMINALS_JS_SRC),
        'terminals.js must resolve team scope via teamId and group members (mirror parity)'
    );
});

test('both files exclude the head from team-scoped orders via o.parent check', () => {
    // The head exclusion check: when o.parent === targetName, the team order
    // must not render for the head. This is how the head is excluded from the
    // member prompt despite being in the group's members array.
    for (const [src, label] of [[STANDING_ORDERS_SRC, 'standingOrders.ts'], [TERMINALS_JS_SRC, 'terminals.js']]) {
        // Find the team-scope branch and verify it contains a parent-based
        // exclusion check. The check must appear inside the team branch
        // (after the teamId/membership resolution), not at the top level.
        const teamBranchIdx = src.indexOf("scope === 'team'");
        assert.ok(teamBranchIdx >= 0, `${label} must have a team-scope branch`);
        const afterTeamBranch = src.slice(teamBranchIdx);
        assert.ok(
            /o\.parent.*targetName.*o\.parent|targetName.*===.*o\.parent/.test(afterTeamBranch),
            `${label} must exclude the head from team-scoped orders via an o.parent === targetName check in the team branch (mirror parity)`
        );
    }
});

test('both files apply team-pair migration before selection', () => {
    // The migration recognises pre-rewrite per-member pair rows and folds
    // them into team-scoped orders. Both the host (migrateTeamPairOrders in
    // teamWiring.ts, called at the read sites) and the client mirror
    // (migrateTeamPairOrdersClient in terminals.js, called inside
    // applyStandingOrdersClient) must implement this. Without parity, the
    // Shift-drop path renders old pair rows while the host renders the
    // folded team prompt — divergent delivery to the same terminal.
    assert.ok(
        /migrateTeamPairOrders/.test(STANDING_ORDERS_SRC) || /migrateTeamPairOrders/.test(fs.readFileSync(
            path.join(__dirname, '..', 'services', 'teamWiring.ts'), 'utf8'
        )),
        'host must call migrateTeamPairOrders at the standing-orders read sites'
    );
    assert.ok(
        /migrateTeamPairOrdersClient/.test(TERMINALS_JS_SRC),
        'terminals.js must implement migrateTeamPairOrdersClient and call it inside applyStandingOrdersClient (mirror parity)'
    );
    // The migration must match the PRE-rewrite callback text, not the
    // post-rewrite constant — the rows on disk carry the old wording.
    const teamWiringSrc = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'teamWiring.ts'), 'utf8'
    );
    assert.ok(
        /PRE_REWRITE_CALLBACK_INSTRUCTION/.test(teamWiringSrc),
        'teamWiring.ts must declare PRE_REWRITE_CALLBACK_INSTRUCTION for the migration recogniser'
    );
    assert.ok(
        /PRE_REWRITE_CALLBACK_INSTRUCTION/.test(TERMINALS_JS_SRC),
        'terminals.js must declare PRE_REWRITE_CALLBACK_INSTRUCTION for the client migration recogniser (mirror parity)'
    );
    // The migration must NOT be applied at the GET /terminals/standing-orders
    // fetch level — makeStandingOrder mints fresh uuids per call, so ids
    // would churn on every request and the Link-up editor delete-by-id would
    // break. Verify the client applies it inside applyStandingOrdersClient,
    // not at the fetch level.
    const fetchIdx = TERMINALS_JS_SRC.indexOf('fetchStandingOrders');
    const fetchEnd = TERMINALS_JS_SRC.indexOf('standingOrdersAvailable', fetchIdx);
    const fetchBlock = fetchIdx >= 0 ? TERMINALS_JS_SRC.slice(fetchIdx, fetchEnd) : '';
    assert.ok(
        !/migrateTeamPairOrdersClient/.test(fetchBlock),
        'terminals.js must NOT call migrateTeamPairOrdersClient inside fetchStandingOrders — it would churn ids and break delete-by-id'
    );
});

test('GIT_SAFETY_DIRECTIVE in agentPromptBuilder.ts is byte-identical to GIT_SAFETY_DIRECTIVE_CLIENT in terminals.js', () => {
    // The team prompt's safety section is the one guardrail team coders get.
    // The host imports GIT_SAFETY_DIRECTIVE from agentPromptBuilder.ts (one
    // source of truth); the webview cannot import TypeScript modules, so
    // terminals.js carries a hand-copied mirror (GIT_SAFETY_DIRECTIVE_CLIENT).
    // A drift in the copy is invisible without this test — the plan names
    // this exact failure mode under "Safeguard text must have one source of
    // truth" and it is verification step 10.
    //
    // The host constant is a backtick template literal; the client mirror is
    // a single-quoted string. Extract the string content from both and
    // assert byte equality — same shape as the marker and block-regex parity
    // tests above, and the same shape link-presets-mirror-contract.test.js
    // uses for the callback constant.

    // Extract from agentPromptBuilder.ts: `export const GIT_SAFETY_DIRECTIVE = `...`;`
    // The host constant is a backtick template literal with escaped backticks
    // inside (\`<path>\`). Greedy-match from the opening backtick to the
    // closing `` `; ``, then unescape \` to `.
    const hostMatch = AGENT_PROMPT_BUILDER_SRC.match(
        /export\s+const\s+GIT_SAFETY_DIRECTIVE\s*=\s*`(.*)`;/
    );
    assert.ok(hostMatch, 'GIT_SAFETY_DIRECTIVE not found in agentPromptBuilder.ts');
    const hostValue = hostMatch[1].replace(/\\`/g, '`');

    // Extract from terminals.js: `var GIT_SAFETY_DIRECTIVE_CLIENT = '...';`
    // The client mirror is a single-quoted string — backticks are literal
    // inside single quotes, so no unescaping is needed.
    const clientMatch = TERMINALS_JS_SRC.match(
        /GIT_SAFETY_DIRECTIVE_CLIENT\s*=\s*\n?\s*'([^']*)'/
    );
    assert.ok(clientMatch, 'GIT_SAFETY_DIRECTIVE_CLIENT not found in terminals.js');
    const clientValue = clientMatch[1];

    assert.strictEqual(
        hostValue, clientValue,
        `GIT_SAFETY_DIRECTIVE drift detected.\n` +
        `agentPromptBuilder.ts: "${hostValue}"\n` +
        `terminals.js:         "${clientValue}"\n` +
        `This is the one guardrail team coders get — a drift here is invisible without this test.`
    );
});

test('kanban.html shipped team prompts carry byte-identical safety + callback text', () => {
    // The THIRD and FOURTH copies of this prose. The test above pins
    // terminals.js to agentPromptBuilder.ts; kanban.html's SHIPPED_TEAM_TYPES
    // hand-copies BOTH the git-safety directive and the callback instruction
    // into each shipped team's `prompt`, and nothing pinned them. Those
    // prompts are what an operator actually adopts when they click USE, so a
    // drift here silently ships a team whose coders carry stale or absent
    // safety text — the exact failure the owning plan names under "Safeguard
    // text must have one source of truth" (verification step 10).
    const hostMatch = AGENT_PROMPT_BUILDER_SRC.match(
        /export\s+const\s+GIT_SAFETY_DIRECTIVE\s*=\s*`(.*)`;/
    );
    assert.ok(hostMatch, 'GIT_SAFETY_DIRECTIVE not found in agentPromptBuilder.ts');
    const gitSafety = hostMatch[1].replace(/\\`/g, '`');

    const cbAnchor = /AGENT_GROUP_CALLBACK_INSTRUCTION\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(cbAnchor, 'AGENT_GROUP_CALLBACK_INSTRUCTION not found in teamWiring.ts');
    const callback = readQuotedChain(TEAM_WIRING_SRC, cbAnchor.index + cbAnchor[0].length);
    assert.ok(callback, 'could not read AGENT_GROUP_CALLBACK_INSTRUCTION as a quoted chain');

    const start = KANBAN_HTML_SRC.indexOf('const SHIPPED_TEAM_TYPES');
    assert.ok(start >= 0, 'SHIPPED_TEAM_TYPES not found in kanban.html');
    const end = KANBAN_HTML_SRC.indexOf('const MEMBER_RELATIONSHIP_PRESETS', start);
    assert.ok(end > start, 'could not bound the SHIPPED_TEAM_TYPES array');
    const block = KANBAN_HTML_SRC.slice(start, end);

    const prompts = [];
    const re = /prompt:\s*/g;
    let m;
    while ((m = re.exec(block)) !== null) {
        const value = readQuotedChain(block, m.index + m[0].length);
        if (value !== null) { prompts.push(value); }
    }
    assert.strictEqual(
        prompts.length, 5,
        `Expected 5 shipped team prompts, found ${prompts.length}. The gallery ships exactly ` +
        'five team types (Batch planners, Coding, Review, Multi-agent planning, Planning with analyst) and each must carry a prompt.'
    );
    for (const p of prompts) {
        assert.ok(
            p.startsWith(callback),
            'A shipped team prompt does not open with AGENT_GROUP_CALLBACK_INSTRUCTION verbatim.\n' +
            `teamWiring.ts: "${callback}"\n` +
            `kanban.html:   "${p.slice(0, callback.length)}"\n` +
            'Without it, a team member is never told how to report back to its head.'
        );
        assert.ok(
            p.endsWith(gitSafety),
            'A shipped team prompt does not end with GIT_SAFETY_DIRECTIVE verbatim.\n' +
            `agentPromptBuilder.ts: "${gitSafety}"\n` +
            `kanban.html:           "${p.slice(-gitSafety.length)}"\n` +
            'This is the only guardrail a team coder gets — a drift here is invisible without this test.'
        );
    }

    // ── headPrompt contract ──────────────────────────────────────────
    // The /prompt:\s*/g regex above is case-sensitive and does NOT match
    // `headPrompt:` (capital P), so the 5-prompt count is unaffected. Pin
    // the field: exactly TWO headPrompts exist (Coding and Review),
    // and both must carry their respective dispatch/delegation literals.
    const headPromptMatches = [];
    const hpRe = /headPrompt:\s*/g;
    let hpM;
    while ((hpM = hpRe.exec(block)) !== null) {
        const value = readQuotedChain(block, hpM.index + hpM[0].length);
        if (value !== null) { headPromptMatches.push(value); }
    }
    assert.strictEqual(
        headPromptMatches.length, 4,
        `Expected exactly 4 shipped headPrompts (Coding, Review, Multi-agent planning, Planning with analyst), found ${headPromptMatches.length}.`
    );
    const codingHeadPrompt = headPromptMatches.find(hp => hp.includes('/kanban/dispatch'));
    assert.ok(codingHeadPrompt, 'Coding headPrompt not found among shipped headPrompts');
    const headPrompt = codingHeadPrompt;
    assert.ok(headPrompt.includes('/kanban/dispatch'),
        'Coding headPrompt must reference POST /kanban/dispatch — the endpoint that advances the card AND dispatches the reviewer');
    assert.ok(headPrompt.includes('CODE REVIEWED'),
        'Coding headPrompt must name CODE REVIEWED as the target column');
    assert.ok(headPrompt.includes('"from":"{head}"'),
        'Coding headPrompt must carry "from":"{head}" — the {head} token is substituted by wireSpawnedTeam with the head terminal name');
    assert.ok(headPrompt.includes('Do NOT use /kanban/move'),
        'Coding headPrompt must warn against /kanban/move — that endpoint moves the card and dispatches nobody, leaving the reviewer idle');
    assert.ok(!headPrompt.includes('GET /kanban/feature'),
        'Coding headPrompt must NOT reference GET /kanban/feature — that is a POST create endpoint. '
        + 'Use GET /kanban/plan?planId= to check subtask status.');
    assert.ok(headPrompt.includes('workspaceRoot'),
        'Coding headPrompt must include workspaceRoot in the /kanban/dispatch body — '
        + 'without it, fleet/worktree heads get "Plan not found".');
    assert.ok(!headPrompt.includes('give that coder the next subtask'),
        'Coding headPrompt must NOT say "give that coder the next subtask" — '
        + 'stacking subtasks on the same coder causes context-wall losses.');
    assert.ok(!headPrompt.includes('Post a status report to .switchboard/orchestrator/reports/'),
        'Coding headPrompt must NOT hardcode the orchestrator report instruction — '
        + 'it is now gated by the orchestratorActive flag in ensureDispatchProtocolDirectives.');
    // The shipped Coding reviewer member must declare
    // relationship: 'reports-to-head' (member-receives → no pair-scoped
    // bypass order on the lead). A future edit that reinstates
    // relationship: 'reviewer' would silently re-install the lead-bypasses-
    // the-board defect this plan exists to fix.
    assert.ok(
        block.includes("{ role: 'reviewer', count: 1, scope: 'shared', relationship: 'reports-to-head' }"),
        'Coding reviewer member must declare relationship: \'reports-to-head\' — '
        + 'relationship: \'reviewer\' installs a pair-scoped order on the lead that '
        + 'bypasses the board, which is the defect this team definition exists to avoid.'
    );
    assert.ok(
        !block.includes("relationship: 'reviewer'"),
        'No shipped team member may declare relationship: \'reviewer\' — it installs a '
        + 'pair-scoped bypass order on the head. The Coding reviewer must use '
        + 'relationship: \'reports-to-head\' instead.'
    );

    // ── Review team headPrompt contract ──────────────────────────────
    const reviewHeadPrompt = headPromptMatches.find(hp => hp.includes('You are the reviewer on a review team'));
    assert.ok(reviewHeadPrompt, 'Review team headPrompt not found among shipped headPrompts');
    const reviewHeadAnchor = /NEW_REVIEW_TEAM_HEAD_PROMPT\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(reviewHeadAnchor, 'NEW_REVIEW_TEAM_HEAD_PROMPT not found in teamWiring.ts');
    const tsReviewHeadPrompt = readQuotedChain(TEAM_WIRING_SRC, reviewHeadAnchor.index + reviewHeadAnchor[0].length);
    assert.ok(tsReviewHeadPrompt, 'could not read NEW_REVIEW_TEAM_HEAD_PROMPT as a quoted chain');
    assert.strictEqual(
        reviewHeadPrompt, tsReviewHeadPrompt,
        'Review headPrompt drift detected between kanban.html and teamWiring.ts.'
    );
    assert.ok(reviewHeadPrompt.includes('{coder}'), 'Review headPrompt must carry {coder} substitution placeholder');
    assert.ok(reviewHeadPrompt.includes('approximately 100 lines directly'), 'Review headPrompt must carry the self-fix threshold');
    assert.ok(reviewHeadPrompt.includes('let the coder choose the fix'), 'Review headPrompt must preserve judgment-call autonomy');
    assert.ok(reviewHeadPrompt.includes('POST /terminals/verb/ptySendPrompt'), 'Review headPrompt must reference ptySendPrompt');

    // ── queue/next standing order ────────────────────────────────────
    // The Coding headPrompt must tell the lead to pull the next card via
    // POST /kanban/queue/next after the reviewer passes, and the sentence
    // must be byte-identical between teamWiring.ts (NEW_CODING_HEAD_PROMPT,
    // the host source of truth) and kanban.html's shipped headPrompt. The
    // rewriter at teamWiring.ts:1239-1241 rewrites stale team-head rows by
    // indexOf match, so the two literals MUST move together — a drift here
    // ships a lead that never asks for the next card (the whole point of
    // the lead-paced-pipeline feature).
    const headPromptAnchor = /NEW_CODING_HEAD_PROMPT\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(headPromptAnchor, 'NEW_CODING_HEAD_PROMPT not found in teamWiring.ts');
    const tsHeadPrompt = readQuotedChain(TEAM_WIRING_SRC, headPromptAnchor.index + headPromptAnchor[0].length);
    assert.ok(tsHeadPrompt, 'could not read NEW_CODING_HEAD_PROMPT as a quoted chain');
    assert.strictEqual(
        headPrompt, tsHeadPrompt,
        'Coding headPrompt drift detected between kanban.html and teamWiring.ts.\n'
        + `teamWiring.ts: "${tsHeadPrompt}"\n`
        + `kanban.html:   "${headPrompt}"\n`
        + 'The two literals must be byte-identical — the teamWiring.ts rewriter '
        + 'matches stale rows by indexOf, so a drift ships a lead carrying stale text.'
    );
    const queueNextSentence = 'When the reviewer reports the feature passed, POST /kanban/queue/next with '
        + '{"from":"{head}"} against the port in .switchboard/api-server-port.txt; if it returns '
        + 'a dispatched card, work it; if it returns dispatched: null, report that the queue is '
        + 'empty and stop.';
    assert.ok(
        tsHeadPrompt.includes(queueNextSentence),
        'NEW_CODING_HEAD_PROMPT must carry the POST /kanban/queue/next standing order — '
        + 'without it a lead never asks for the next card after a review pass.'
    );
    assert.ok(
        headPrompt.includes(queueNextSentence),
        'kanban.html Coding headPrompt must carry the POST /kanban/queue/next standing order '
        + 'byte-identically to teamWiring.ts — a gallery-adopted team must pace its own pipeline.'
    );

    // ── unattended escalation clause ─────────────────────────────────
    // The ladder's terminal rung must carry BOTH forms: attended (stop and
    // report) and unattended (record the blocked card, take the next queue
    // item). Without the unattended half, a head driving overnight ends its
    // turn on the first twice-failed subtask and the queue stalls with cards
    // behind it — the failure `.agents/protocols/terminal-coder-dispatch/SKILL.md`
    // §5.6 exists to remove. Standing orders survive a /clear, which is what
    // makes this instruction durable across a head's context resets.
    const unattendedEscalationSentence = 'stop and report to the human instead of dispatching again '
        + '(or unattended: record the blocked card to .switchboard/orchestrator/reports/ '
        + 'and proceed to the next queue item).';
    assert.ok(
        tsHeadPrompt.includes(unattendedEscalationSentence),
        'NEW_CODING_HEAD_PROMPT must carry the unattended form of the escalation terminal rung — '
        + 'without it an unattended head stalls the queue on the first twice-failed subtask.'
    );
    assert.ok(
        headPrompt.includes(unattendedEscalationSentence),
        'kanban.html Coding headPrompt must carry the unattended escalation clause byte-identically '
        + 'to teamWiring.ts — a gallery-adopted team must not stall overnight.'
    );

    // ── role-boundary guardrails ─────────────────────────────────────
    assert.ok(
        tsHeadPrompt.includes('PLAN FILES ARE THE SOURCE OF TRUTH'),
        'NEW_CODING_HEAD_PROMPT must carry the plan-immutability directive'
    );
    assert.ok(
        tsHeadPrompt.includes('If your team has a reviewer seat'),
        'NEW_CODING_HEAD_PROMPT must make CODE REVIEWED dispatch conditional on reviewer seat'
    );
    assert.ok(
        tsHeadPrompt.includes('If your team has NO reviewer seat'),
        'NEW_CODING_HEAD_PROMPT must specify behavior when team has no reviewer seat'
    );

    // ── the frozen migration snapshots must stay frozen ──────────────
    // CURRENT_BUGGY_CODING_HEAD_PROMPT is not a delivered prompt: it is a
    // byte-exact snapshot of what the first migration already wrote to disk on
    // installs in the field, matched by `===` in isUntouchedCurrentCodingTeam.
    // Any new wording swept into it (this exact regression happened once with
    // the unattended clause) makes the recogniser match ZERO installs and the
    // second migration silently never fires.
    const buggyAnchor = /CURRENT_BUGGY_CODING_HEAD_PROMPT\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(buggyAnchor, 'CURRENT_BUGGY_CODING_HEAD_PROMPT not found in teamWiring.ts');
    const buggySnapshot = readQuotedChain(TEAM_WIRING_SRC, buggyAnchor.index + buggyAnchor[0].length);
    assert.ok(buggySnapshot, 'could not read CURRENT_BUGGY_CODING_HEAD_PROMPT as a quoted chain');
    assert.ok(
        !buggySnapshot.includes('unattended'),
        'CURRENT_BUGGY_CODING_HEAD_PROMPT is a frozen on-disk snapshot — new prompt wording '
        + '(here: the unattended escalation clause) must go in NEW_CODING_HEAD_PROMPT only. '
        + 'Editing the snapshot makes isUntouchedCurrentCodingTeam match no install at all.'
    );
    assert.notStrictEqual(
        buggySnapshot, tsHeadPrompt,
        'CURRENT_BUGGY_CODING_HEAD_PROMPT must differ from NEW_CODING_HEAD_PROMPT — if they are '
        + 'equal the migration rewrites installs to the text they already have, forever.'
    );

    const preRoleBoundaryAnchor = /PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(preRoleBoundaryAnchor, 'PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT not found in teamWiring.ts');
    const preRoleBoundarySnapshot = readQuotedChain(TEAM_WIRING_SRC, preRoleBoundaryAnchor.index + preRoleBoundaryAnchor[0].length);
    assert.ok(preRoleBoundarySnapshot, 'could not read PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT as a quoted chain');
    assert.ok(
        !preRoleBoundarySnapshot.includes('PLAN FILES ARE THE SOURCE OF TRUTH'),
        'PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT is a frozen snapshot of pre-guardrail text — new prompt wording must go in NEW_CODING_HEAD_PROMPT only'
    );
    assert.notStrictEqual(
        preRoleBoundarySnapshot, tsHeadPrompt,
        'PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT must differ from NEW_CODING_HEAD_PROMPT'
    );

    // ── commit instruction assertions ───────────────────────────────
    // The durable commit instruction (TEAM_HEAD_COMMIT_INSTRUCTION) is
    // appended to both NEW_CODING_HEAD_PROMPT and NEW_REVIEW_TEAM_HEAD_PROMPT.
    // The frozen pre-commit-instruction snapshots must NOT contain it.
    const commitInstructionText = 'create a single commit with a descriptive message';
    assert.ok(
        tsHeadPrompt.includes(commitInstructionText),
        'NEW_CODING_HEAD_PROMPT must include the durable commit instruction text'
    );
    assert.ok(
        tsReviewHeadPrompt.includes(commitInstructionText),
        'NEW_REVIEW_TEAM_HEAD_PROMPT must include the durable commit instruction text'
    );

    const preCommitCodingAnchor = /PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(preCommitCodingAnchor, 'PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT not found in teamWiring.ts');
    const preCommitCodingSnapshot = readQuotedChain(TEAM_WIRING_SRC, preCommitCodingAnchor.index + preCommitCodingAnchor[0].length);
    assert.ok(preCommitCodingSnapshot, 'could not read PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT as a quoted chain');
    assert.ok(
        !preCommitCodingSnapshot.includes(commitInstructionText),
        'PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT is a frozen snapshot — the commit instruction must NOT be in it'
    );
    assert.notStrictEqual(
        preCommitCodingSnapshot, tsHeadPrompt,
        'PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT must differ from NEW_CODING_HEAD_PROMPT'
    );

    const preCommitReviewAnchor = /PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT\s*=\s*/.exec(TEAM_WIRING_SRC);
    assert.ok(preCommitReviewAnchor, 'PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT not found in teamWiring.ts');
    const preCommitReviewSnapshot = readQuotedChain(TEAM_WIRING_SRC, preCommitReviewAnchor.index + preCommitReviewAnchor[0].length);
    assert.ok(preCommitReviewSnapshot, 'could not read PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT as a quoted chain');
    assert.ok(
        !preCommitReviewSnapshot.includes(commitInstructionText),
        'PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT is a frozen snapshot — the commit instruction must NOT be in it'
    );
    assert.notStrictEqual(
        preCommitReviewSnapshot, tsReviewHeadPrompt,
        'PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT must differ from NEW_REVIEW_TEAM_HEAD_PROMPT'
    );
});

test('GIT_SAFETY_DIRECTIVE_WORKTREE_MODE excludes the staging-scope clause (isolated trees need no path-staging rule)', () => {
    const hostMatch = AGENT_PROMPT_BUILDER_SRC.match(
        /export\s+const\s+GIT_SAFETY_DIRECTIVE_WORKTREE_MODE\s*=\s*`(.*)`;/
    );
    assert.ok(hostMatch, 'GIT_SAFETY_DIRECTIVE_WORKTREE_MODE not found in agentPromptBuilder.ts');
    const worktreeDirective = hostMatch[1];
    assert.ok(
        !worktreeDirective.includes('git add -A'),
        'GIT_SAFETY_DIRECTIVE_WORKTREE_MODE must NOT contain "git add -A" — worktree agents own their isolated tree and do not need shared-tree staging restrictions'
    );
});

test('both files render pair with "Regarding" framing and global/team without it', () => {
    assert.ok(
        STANDING_ORDERS_SRC.includes('Regarding terminal'),
        'standingOrders.ts must render pair scope with "Regarding terminal" framing'
    );
    assert.ok(
        TERMINALS_JS_SRC.includes('Regarding terminal'),
        'terminals.js must render pair scope with "Regarding terminal" framing (mirror parity)'
    );
    // The "Regarding" framing must be conditional on pair scope, not unconditional —
    // a global/team order rendering "Regarding terminal undefined" is the bug
    // this refactor exists to remove. Verify the scope check appears before the
    // Regarding rendering in both files.
    // Scan CODE ONLY. Both files document the per-scope framing in prose ABOVE
    // the renderer — standingOrders.ts's renderOrder JSDoc names `- Regarding
    // terminal "X":` and the "Regarding terminal undefined" bug it removes —
    // so a raw source scan finds the doc mention before the `scope === 'pair'`
    // code that gates it and fails on correct source. `stripComments` is a
    // hoisted function declaration, so it is callable here.
    for (const [raw, label] of [[STANDING_ORDERS_SRC, 'standingOrders.ts'], [TERMINALS_JS_SRC, 'terminals.js']]) {
        const src = stripComments(raw);
        const pairIdx = src.indexOf("scope === 'pair'");
        const regardingIdx = src.indexOf('Regarding terminal');
        assert.ok(pairIdx >= 0, `${label} must check scope === 'pair'`);
        assert.ok(regardingIdx >= 0, `${label} must contain 'Regarding terminal' rendering`);
        assert.ok(pairIdx < regardingIdx,
            `${label}: the scope === 'pair' check must appear before the "Regarding" rendering (gating)`);
    }
});

test('both files carry a team-head scope branch with matching selection logic and scopeRank', () => {
    // Source-text parity: both the TypeScript resolver (standingOrders.ts) and
    // the webview client mirror (terminals.js) must contain a team-head branch
    // that gates on teamId + group membership + parent === targetName, and both
    // scopeRank literals must list all four scopes with team-head and team at
    // the same rank. applyStandingOrdersClient is inside a panel IIFE and
    // cannot be executed in a test harness, so source-text parity is the guard.
    for (const [raw, label] of [[STANDING_ORDERS_SRC, 'standingOrders.ts'], [TERMINALS_JS_SRC, 'terminals.js']]) {
        const src = stripComments(raw);
        assert.ok(src.includes("'team-head'"),
            `${label} must contain a 'team-head' scope branch`);
        assert.ok(src.includes('team-head'),
            `${label} must reference team-head in scopeRank`);
        // Both must gate the team-head SELECTION branch on o.teamId, group
        // membership, and parent === targetName. Anchor on the BRANCH
        // (`scope === 'team-head'`), not on the bare literal: in
        // standingOrders.ts the first occurrence of `'team-head'` is the
        // StandingOrderScope union at the top of the file, and a window
        // measured from there covers the type declarations instead of the
        // selection logic — the assertion then fails on correct source.
        //
        // Scan EVERY branch and require that ONE of them satisfies the gate,
        // rather than measuring from the first. `team-head` is a scope any
        // read-side converter may also switch on (terminals.js's
        // migrateCodingTeamOrdersClient does, and it is declared above the
        // selection branch), so a first-occurrence anchor fails on correct
        // source the moment a second, legitimate branch is added upstream —
        // the same trap this comment already documents one level up.
        const branches = [];
        for (let i = src.indexOf("scope === 'team-head'"); i >= 0;
            i = src.indexOf("scope === 'team-head'", i + 1)) {
            branches.push(src.slice(i, i + 400));
        }
        assert.ok(branches.length > 0, `${label}: team-head branch not found`);
        const gated = branches.filter(b =>
            b.includes('teamId') && b.includes('parent') && b.includes('members'));
        assert.ok(gated.length > 0,
            `${label}: no team-head branch gates on o.teamId + o.parent === targetName + group membership `
            + `(found ${branches.length} team-head branch(es), none of them the selection branch)`);
    }
    // scopeRank must list every scope, in both files, with the same ORDER and the
    // same team/team-head tie. The literal rank numbers are deliberately NOT
    // pinned: adding `role` at 1 pushed team-head/team from 1 to 2, and the next
    // inserted scope will renumber again. Pinning the digits makes a correct
    // insertion fail this gate (it did, for `role`) while pinning the ordering
    // catches the drift that actually matters — a mirror that renders the block in
    // a different order than the host, or loses a scope entirely.
    const parseScopeRank = (raw, label) => {
        const m = stripComments(raw).match(/scopeRank[^=]*=\s*\{([^}]*)\}/);
        assert.ok(m, `${label}: no scopeRank literal found`);
        const ranks = {};
        for (const part of m[1].split(',')) {
            const kv = part.match(/'?([a-zA-Z-]+)'?\s*:\s*(\d+)/);
            if (kv) { ranks[kv[1]] = Number(kv[2]); }
        }
        return ranks;
    };
    for (const [raw, label] of [[STANDING_ORDERS_SRC, 'standingOrders.ts'], [TERMINALS_JS_SRC, 'terminals.js']]) {
        const r = parseScopeRank(raw, label);
        for (const scope of ['global', 'role', 'team-head', 'team', 'pair']) {
            assert.strictEqual(typeof r[scope], 'number',
                `${label} scopeRank must list '${scope}' (found: ${JSON.stringify(r)})`);
        }
        assert.strictEqual(r['team-head'], r.team,
            `${label} scopeRank must give team-head and team the SAME rank`);
        assert.ok(r.global < r.role, `${label} scopeRank must rank global before role`);
        assert.ok(r.role < r.team, `${label} scopeRank must rank role before team/team-head`);
        assert.ok(r.team < r.pair, `${label} scopeRank must rank team/team-head before pair`);
    }
});

test('neither file declares the retired cap constants (MAX_BLOCK_CHARS / MAX_INSTRUCTION_CHARS / MAX_ORDERS)', () => {
    for (const cap of ['MAX_BLOCK_CHARS', 'MAX_INSTRUCTION_CHARS', 'MAX_ORDERS']) {
        assert.ok(
            !new RegExp(`\\b${cap}\\b`).test(STANDING_ORDERS_SRC),
            `standingOrders.ts must not declare ${cap} — caps were removed`
        );
        // MAX_ORDERS was never in terminals.js; MAX_BLOCK_CHARS/MAX_INSTRUCTION_CHARS were
        assert.ok(
            !new RegExp(`\\b${cap}\\b`).test(TERMINALS_JS_SRC),
            `terminals.js must not declare ${cap} — caps were removed (mirror parity)`
        );
    }
});

// 6. Delivery-site coverage — the enumerable guarantee that replaces
//    "remember to hook all the sites". Three delivery chokepoints exist:
//    the PTY host (_ptyHostVerb), the standalone host (deliverPrompt), and
//    the VS Code terminal path (sendRobustText). A new bare call site or a
//    missing opt-out gate is how this feature silently half-ships.

/** Blank out `//` and block comments so prose mentions do not count as code. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const BOOTSTRAP_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8'
);
const TASKVIEWER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8'
);
const TERMINAL_UTILS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'terminalUtils.ts'), 'utf8'
);

test('bootstrap.ts calls sendPromptToPty ONLY inside the deliverPrompt wrapper', () => {
    const code = stripComments(BOOTSTRAP_SRC);
    const calls = [...code.matchAll(/sendPromptToPty\s*\(/g)].map(m => m.index);
    assert.strictEqual(
        calls.length, 1,
        `Expected exactly 1 sendPromptToPty(...) call in bootstrap.ts, found ${calls.length}. ` +
        'Every standalone delivery must route through deliverPrompt, or that path silently ' +
        'drops the standing-orders block (the standalone board dispatch is the classic miss).'
    );
    const wrapperStart = code.indexOf('const deliverPrompt');
    assert.ok(wrapperStart >= 0, 'deliverPrompt wrapper not found in bootstrap.ts');
    // The wrapper is the first arrow function after that declaration; the single
    // call must live after it and before the next top-level `const secrets =`.
    const wrapperEnd = code.indexOf('const secrets', wrapperStart);
    assert.ok(wrapperEnd > wrapperStart, 'could not bound the deliverPrompt wrapper');
    assert.ok(
        calls[0] > wrapperStart && calls[0] < wrapperEnd,
        'The sole sendPromptToPty call is outside the deliverPrompt wrapper body.'
    );
});

test('TaskViewerProvider routes every /api/pty/ request through _ptyHostVerb', () => {
    const code = stripComments(TASKVIEWER_SRC);
    const hookStart = code.indexOf('private async _ptyHostVerb(');
    assert.ok(hookStart >= 0, '_ptyHostVerb not found in TaskViewerProvider.ts');
    // End of the method = the next member declaration at class-body indentation.
    const after = code.slice(hookStart + 1);
    const relEnd = after.search(/\n {4}(?:private|public|protected)\s/);
    const hookEnd = relEnd === -1 ? code.length : hookStart + 1 + relEnd;

    const requests = [...code.matchAll(/\/api\/pty\//g)].map(m => m.index);
    assert.ok(requests.length >= 2, 'expected the two /api/pty/ request builders');
    for (const idx of requests) {
        assert.ok(
            idx > hookStart && idx < hookEnd,
            'An /api/pty/ request is built outside _ptyHostVerb. That bypasses the ' +
            'standing-orders append hook, so the delivery it performs ships bare.'
        );
    }
});

test('the three delivery chokepoints carry a standingOrders opt-out guard', () => {
    // Chokepoint 1: PTY host (_ptyHostVerb in TaskViewerProvider)
    assert.ok(
        /standingOrders !== false/.test(TASKVIEWER_SRC),
        'TaskViewerProvider._ptyHostVerb must gate the append on payload.standingOrders !== false'
    );
    // Chokepoint 2: standalone host (deliverPrompt in bootstrap)
    assert.ok(
        /standingOrders !== false/.test(BOOTSTRAP_SRC),
        'bootstrap.ts ptySendPrompt must pass payload.standingOrders !== false to deliverPrompt'
    );
    // Chokepoint 3: VS Code terminal path (sendRobustText in terminalUtils)
    assert.ok(
        /applyStandingOrders/.test(TERMINAL_UTILS_SRC),
        'terminalUtils.ts must import and call applyStandingOrders in the sendRobustText delivery path'
    );
    assert.ok(
        /standingOrders.*!==.*false/.test(TERMINAL_UTILS_SRC),
        'terminalUtils.ts sendRobustText must gate the standing-orders append on standingOrders !== false'
    );
});

// 7. Resolver behaviour — the module is transpiled and executed, so these are
//    real assertions about output, not source scans.

const tsc = require('typescript');
const resolverModule = { exports: {} };
new Function('exports', 'module', 'require', tsc.transpileModule(STANDING_ORDERS_SRC, {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020 }
}).outputText)(resolverModule.exports, resolverModule, require);

const { applyStandingOrders, renderStandaloneOrdersBlock, validateInstruction, STANDING_ORDERS_MARKER } = resolverModule.exports;

const order = (parent, child, instruction) => ({ id: `${parent}->${child}`, parent, child, instruction, createdAt: 0 });
const globalOrder = (instruction) => ({ id: 'global-' + instruction.slice(0, 8), parent: '', instruction, createdAt: 0, scope: 'global' });
const teamOrder = (teamId, instruction) => ({ id: 'team-' + teamId, parent: '', instruction, createdAt: 0, scope: 'team', teamId });
const LIVE = new Set(['child-1', 'child-2']);
const GROUPS = [
    { id: 'team_Lead', name: 'Lead', members: ['Lead', 'member-1', 'member-2'] },
];

// ── role scope + standalone block ────────────────────────────────────────────
// Covers the three plans' Verification Plans: role selection (match / mismatch /
// no map), scope ordering against team, and the standalone block used by the
// establish + clear one-shot delivery.

const roleOrder = (role, instruction) => ({ id: 'role-' + role, parent: '', instruction, createdAt: 0, scope: 'role', role });
const ROLE_MAP = new Map([['planner-1', 'planner'], ['coder-1', 'coder']]);

test('selectOrders: a role order reaches terminals whose role matches and no others', () => {
    const hit = applyStandingOrders('task', 'planner-1', [roleOrder('planner', 'PLANNER_RULE')], LIVE, [], ROLE_MAP);
    assert.ok(hit.includes('PLANNER_RULE'), 'matching role must receive the order');
    const miss = applyStandingOrders('task', 'coder-1', [roleOrder('planner', 'PLANNER_RULE')], LIVE, [], ROLE_MAP);
    assert.strictEqual(miss, 'task', 'a different role must not receive the order');
    const unknown = applyStandingOrders('task', 'stranger', [roleOrder('planner', 'PLANNER_RULE')], LIVE, [], ROLE_MAP);
    assert.strictEqual(unknown, 'task', 'a terminal absent from the roleMap must not receive the order');
});

test('selectOrders: role orders are skipped when no roleMap is supplied (headless degradation)', () => {
    assert.strictEqual(
        applyStandingOrders('task', 'planner-1', [roleOrder('planner', 'PLANNER_RULE')], LIVE),
        'task',
        'no roleMap must skip role-scoped orders rather than deliver them to everyone'
    );
});

test('selectOrders: a role order with no role field is dropped, not broadcast', () => {
    const malformed = { id: 'role-malformed', parent: '', instruction: 'BAD', createdAt: 0, scope: 'role' };
    assert.strictEqual(
        applyStandingOrders('task', 'planner-1', [malformed], LIVE, [], ROLE_MAP),
        'task'
    );
});

test('scopeRank: a role order renders before a team order in the same block', () => {
    const groups = [{ id: 'team_X', name: 'X', members: ['coder-1'] }];
    const out = applyStandingOrders(
        'task', 'coder-1',
        [teamOrder('team_X', 'TEAM_RULE'), roleOrder('coder', 'ROLE_RULE')],
        LIVE, groups, ROLE_MAP
    );
    assert.ok(out.includes('ROLE_RULE') && out.includes('TEAM_RULE'), 'both orders must render');
    assert.ok(out.indexOf('ROLE_RULE') < out.indexOf('TEAM_RULE'), 'role must render before team');
});

test('renderOrder: a role order renders as a plain rule with no "Regarding" framing', () => {
    const out = applyStandingOrders('task', 'planner-1', [roleOrder('planner', 'PLANNER_RULE')], LIVE, [], ROLE_MAP);
    assert.ok(out.includes('- PLANNER_RULE'), 'role order must render as a plain rule');
    assert.ok(!out.includes('Regarding terminal'), 'role order must not borrow the pair framing');
});

test('renderStandaloneOrdersBlock: returns the marker-bearing block when orders apply, null when none do', () => {
    const block = renderStandaloneOrdersBlock([roleOrder('planner', 'PLANNER_RULE')], 'planner-1', LIVE, [], ROLE_MAP);
    assert.ok(typeof block === 'string', 'applicable orders must yield a string');
    assert.ok(block.includes(STANDING_ORDERS_MARKER), 'the block must carry the marker');
    assert.ok(block.includes('- PLANNER_RULE'), 'the block must carry the rule');
    assert.strictEqual(
        renderStandaloneOrdersBlock([roleOrder('planner', 'x')], 'coder-1', LIVE, [], ROLE_MAP),
        null,
        'no applicable orders must yield null so the caller sends no prompt'
    );
    assert.strictEqual(renderStandaloneOrdersBlock([], 'planner-1', LIVE, [], ROLE_MAP), null);
});

test('renderStandaloneOrdersBlock: the block it returns is what applyStandingOrders appends', () => {
    const orders = [globalOrder('BE_SAFE'), roleOrder('planner', 'PLANNER_RULE')];
    const block = renderStandaloneOrdersBlock(orders, 'planner-1', LIVE, [], ROLE_MAP);
    const applied = applyStandingOrders('task', 'planner-1', orders, LIVE, [], ROLE_MAP);
    assert.strictEqual(applied, 'task' + block,
        'the one-shot block and the dispatch suffix must be the same bytes — otherwise the '
        + 'strip-and-re-append dedup across the two deliveries stops matching');
});

test('applyStandingOrders: empty prompt is returned unchanged', () => {
    assert.strictEqual(applyStandingOrders('', 'p', [order('p', 'child-1', 'x')], LIVE), '');
});

test('applyStandingOrders: a prompt already carrying a complete block is stripped and re-blocked, not silently dropped', () => {
    // The stale/fresh sentinels must not be substrings of the block's own
    // boilerplate. `old` fails that test — the trailing line is "until tOLD
    // otherwise.", so `!out.includes('old')` can never pass regardless of
    // whether the strip works.
    const already = `task\n\n${STANDING_ORDERS_MARKER}\n- Regarding terminal "child-1": STALE_SENTINEL\nThese apply to everything you do in this terminal until told otherwise.\n`;
    const out = applyStandingOrders(already, 'p', [order('p', 'child-1', 'FRESH_SENTINEL')], LIVE);
    assert.ok(out.includes('FRESH_SENTINEL'), 'the fresh order must appear after strip + re-append');
    assert.ok(!out.includes('STALE_SENTINEL'), 'the stale block content must be stripped');
    assert.strictEqual(
        (out.match(new RegExp(STANDING_ORDERS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
        'exactly one marker block after strip + re-append'
    );
});

test('applyStandingOrders: a prompt that merely quotes the marker mid-text is NOT truncated', () => {
    // The marker appears in the body of the prompt but NOT as a complete
    // appended block (no trailing "These apply..." line). The strip regex
    // must NOT match this — otherwise everything after the quote is lost.
    const quoted = `Here is a note about the marker: ${STANDING_ORDERS_MARKER} — please review.\nMore text after the quote.`;
    const out = applyStandingOrders(quoted, 'p', [order('p', 'child-1', 'x')], LIVE);
    assert.ok(out.includes('More text after the quote.'),
        'text after a mid-text marker quote must survive (strip anchored to complete blocks only)');
    assert.ok(out.includes('Here is a note about the marker:'),
        'text before a mid-text marker quote must survive');
});

test('applyStandingOrders: no order for this parent leaves the prompt bare', () => {
    assert.strictEqual(applyStandingOrders('task', 'other', [order('p', 'child-1', 'x')], LIVE), 'task');
});

test('applyStandingOrders: an order whose child is dead is skipped, not deleted', () => {
    assert.strictEqual(applyStandingOrders('task', 'p', [order('p', 'ghost', 'x')], LIVE), 'task');
});

test('applyStandingOrders: multiple orders render in creation order under one header', () => {
    const out = applyStandingOrders('task', 'p', [
        order('p', 'child-1', 'first'),
        order('p', 'child-2', 'second'),
    ], LIVE);
    assert.strictEqual((out.match(new RegExp(STANDING_ORDERS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
        'exactly one marker block');
    assert.ok(out.indexOf('first') < out.indexOf('second'), 'orders must render in creation order');
    assert.ok(out.startsWith('task'), 'the original prompt must be preserved verbatim at the head');
});

// 8. Scope behaviour — the three scopes compose into one block with distinct
//    selection and rendering rules.

test('applyStandingOrders: a global order applies to every target with no partner terminal', () => {
    const out = applyStandingOrders('task', 'anyone', [globalOrder('be safe')], LIVE);
    assert.ok(out.includes(STANDING_ORDERS_MARKER), 'global order must produce a block');
    assert.ok(out.includes('- be safe'), 'global order must render as a plain rule');
    assert.ok(!out.includes('Regarding'), 'global order must NOT emit "Regarding" framing');
});

test('applyStandingOrders: a global order still renders when unrelated terminals have exited', () => {
    const emptyLive = new Set();
    const out = applyStandingOrders('task', 'solo', [globalOrder('be safe')], emptyLive);
    assert.ok(out.includes('- be safe'), 'global order must not be liveness-gated');
});

test('applyStandingOrders: a team order reaches team members and no one else', () => {
    const memberOut = applyStandingOrders('task', 'member-1', [teamOrder('team_Lead', 'report to head')], LIVE, GROUPS);
    assert.ok(memberOut.includes('- report to head'), 'team order must reach a group member');

    // A team order with no `parent` (the old teamOrder() helper shape) has
    // no head to exclude, so it reaches every member including the head.
    // This is the false-confidence case — the exclusion only fires when
    // `parent` names the head. The next assertion covers the real shape.
    const headOutNoParent = applyStandingOrders('task', 'Lead', [teamOrder('team_Lead', 'report to head')], LIVE, GROUPS);
    assert.ok(headOutNoParent.includes('- report to head'), 'team order with no parent reaches the head (no exclusion target)');

    // A team order whose `parent` is the head must NOT reach the head —
    // the team prompt is for members only. wireSpawnedTeam sets
    // `parent = headName` on the team-scoped order precisely so this
    // exclusion fires.
    const teamOrderWithHeadParent = { id: 'team-lead-parent', parent: 'Lead', child: '', instruction: 'report to head', createdAt: 0, scope: 'team', teamId: 'team_Lead' };
    const headOut = applyStandingOrders('task', 'Lead', [teamOrderWithHeadParent], LIVE, GROUPS);
    assert.strictEqual(headOut, 'task', 'team order must NOT reach the head when parent names the head');

    const outsiderOut = applyStandingOrders('task', 'outsider', [teamOrder('team_Lead', 'report to head')], LIVE, GROUPS);
    assert.strictEqual(outsiderOut, 'task', 'team order must NOT reach a non-member');
});

test('applyStandingOrders: a team order whose teamId matches no registered group renders for nobody', () => {
    const out = applyStandingOrders('task', 'member-1', [teamOrder('nonexistent', 'x')], LIVE, GROUPS);
    assert.strictEqual(out, 'task', 'team order with unknown teamId must render for nobody, not everybody');
});

// 8b. team-head scope behaviour — the mirror image of `team`: this order is
//     FOR the head and nobody else. `parent` holds the head name, `child` is
//     deliberately '' so an older build's pair fall-through drops it.

const teamHeadOrder = (teamId, headName, instruction) => ({
    id: 'team-head-' + teamId, parent: headName, child: '', instruction, createdAt: 0,
    scope: 'team-head', teamId,
});

const TEAM_HEAD_GROUPS = [
    { id: 'team_lead_1', name: 'lead-1', members: ['lead-1', 'lead-1-coder-1', 'Coding-reviewer'] },
];

test('applyStandingOrders: a team-head order reaches the head and nobody else', () => {
    const headOut = applyStandingOrders('task', 'lead-1',
        [teamHeadOrder('team_lead_1', 'lead-1', 'advance to reviewed')], LIVE, TEAM_HEAD_GROUPS);
    assert.ok(headOut.includes('- advance to reviewed'),
        'team-head order must reach the head (parent === targetName && group member)');

    const coderOut = applyStandingOrders('task', 'lead-1-coder-1',
        [teamHeadOrder('team_lead_1', 'lead-1', 'advance to reviewed')], LIVE, TEAM_HEAD_GROUPS);
    assert.strictEqual(coderOut, 'task',
        'team-head order must NOT reach a coder (only the head)');

    const reviewerOut = applyStandingOrders('task', 'Coding-reviewer',
        [teamHeadOrder('team_lead_1', 'lead-1', 'advance to reviewed')], LIVE, TEAM_HEAD_GROUPS);
    assert.strictEqual(reviewerOut, 'task',
        'team-head order must NOT reach the reviewer (only the head)');
});

test('applyStandingOrders: team and team-head are complements, not overlaps', () => {
    // A team order (parent = head) excludes the head; a team-head order
    // (parent = head) includes ONLY the head. Together they cover the whole
    // team with no overlap.
    const teamMemberOrder = { id: 'team-member', parent: 'lead-1', child: '', instruction: 'report to head', createdAt: 0, scope: 'team', teamId: 'team_lead_1' };
    const headOrder = teamHeadOrder('team_lead_1', 'lead-1', 'advance to reviewed');

    // Head gets the head order, not the member order.
    const headOut = applyStandingOrders('task', 'lead-1', [teamMemberOrder, headOrder], LIVE, TEAM_HEAD_GROUPS);
    assert.ok(headOut.includes('- advance to reviewed'), 'head must receive the team-head order');
    assert.ok(!headOut.includes('- report to head'), 'head must NOT receive the team (member) order');

    // Coder gets the member order, not the head order.
    const coderOut = applyStandingOrders('task', 'lead-1-coder-1', [teamMemberOrder, headOrder], LIVE, TEAM_HEAD_GROUPS);
    assert.ok(coderOut.includes('- report to head'), 'coder must receive the team (member) order');
    assert.ok(!coderOut.includes('- advance to reviewed'), 'coder must NOT receive the team-head order');
});

test('applyStandingOrders: a team-head order whose teamId matches no group renders for nobody', () => {
    const out = applyStandingOrders('task', 'lead-1',
        [teamHeadOrder('nonexistent', 'lead-1', 'x')], LIVE, TEAM_HEAD_GROUPS);
    assert.strictEqual(out, 'task',
        'team-head order with unknown teamId must render for nobody, not the head');
});

test('applyStandingOrders: a team-head order renders as a plain rule with no Regarding framing', () => {
    const out = applyStandingOrders('task', 'lead-1',
        [teamHeadOrder('team_lead_1', 'lead-1', 'advance the card')], LIVE, TEAM_HEAD_GROUPS);
    assert.ok(out.includes('- advance the card'),
        'team-head order must render as a plain rule');
    assert.ok(!out.includes('Regarding'),
        'team-head order must NOT emit "Regarding" framing (same as global/team)');
});

// 8c. Old-build safety — a team-head order read by a pre-change build (which
//     has no team-head branch and falls through to the pair rule) must select
//     for nobody. This is the compatibility claim for the ~4,000-install base.

test('old-build safety: a team-head order falls through to pair and selects for nobody', () => {
    // Simulate the PRE-change selectOrders: three branches (global, team, pair).
    // A team-head order has scope 'team-head', which matches none of the three,
    // so it falls through to the pair rule: parent === targetName && child !==
    // undefined && liveNames.has(child). The head order has child: '', so
    // liveNames.has('') is false and the order is dropped.
    function oldSelectOrders(orders, targetName, liveNames, groups) {
        return orders.filter(function (o) {
            var scope = o.scope || 'pair';
            if (scope === 'global') { return true; }
            if (scope === 'team') {
                if (!o.teamId) { return false; }
                var group = groups.find(function (g) { return g && g.id === o.teamId; });
                if (!group || !Array.isArray(group.members)) { return false; }
                if (o.parent && targetName === o.parent) { return false; }
                return group.members.indexOf(targetName) !== -1;
            }
            // pair (default) — the only fall-through in the old build
            return o.parent === targetName && o.child !== undefined && liveNames.has(o.child);
        });
    }
    const liveNames = new Set(['lead-1', 'lead-1-coder-1', 'Coding-reviewer']);
    const groups = TEAM_HEAD_GROUPS;
    const headOrder = teamHeadOrder('team_lead_1', 'lead-1', 'advance to reviewed');
    for (const target of ['lead-1', 'lead-1-coder-1', 'Coding-reviewer', 'outsider']) {
        const selected = oldSelectOrders([headOrder], target, liveNames, groups);
        assert.strictEqual(selected.length, 0,
            `old build must not deliver team-head order to "${target}" — child: '' makes liveNames.has('') false`);
    }
});

test('applyStandingOrders: pair orders keep "Regarding" framing; global and team do not', () => {
    const out = applyStandingOrders('task', 'member-1', [
        globalOrder('global rule'),
        teamOrder('team_Lead', 'team rule'),
        order('member-1', 'child-1', 'pair rule'),
    ], LIVE, GROUPS);
    assert.ok(out.includes('- global rule'), 'global must render as plain rule');
    assert.ok(out.includes('- team rule'), 'team must render as plain rule');
    assert.ok(out.includes('- Regarding terminal "child-1": pair rule'), 'pair must render with Regarding framing');
    // No "Regarding" for global or team
    const lines = out.split('\n');
    const regardingLines = lines.filter(l => l.includes('Regarding'));
    assert.strictEqual(regardingLines.length, 1, 'exactly one "Regarding" line (the pair order only)');
});

test('applyStandingOrders: safeguard-bearing scopes (global, team) render before pair', () => {
    const out = applyStandingOrders('task', 'member-1', [
        order('member-1', 'child-1', 'pair rule'),
        globalOrder('global rule'),
    ], LIVE, GROUPS);
    assert.ok(out.indexOf('global rule') < out.indexOf('pair rule'),
        'global (safeguard-bearing) must render before pair');
});

test('applyStandingOrders: a 10000-char order reaches the prompt uncut', () => {
    const long = 'y'.repeat(10000);
    const out = applyStandingOrders('task', 'p', [order('p', 'child-1', long)], LIVE);
    assert.ok(out.includes(long), 'the full instruction must appear untruncated');
    assert.ok(!out.includes('[standing orders truncated]'), 'no truncation marker must appear');
});

test('validateInstruction: empty and marker-bearing text are rejected; normal text passes', () => {
    assert.ok(validateInstruction(''), 'empty must be rejected');
    assert.ok(validateInstruction('   '), 'whitespace-only must be rejected');
    assert.ok(validateInstruction(undefined), 'non-string must be rejected');
    assert.ok(validateInstruction(`hi ${STANDING_ORDERS_MARKER} there`), 'marker forgery must be rejected');
    assert.strictEqual(validateInstruction('be the researcher for terminal 2'), null);
    // Over-length text is no longer rejected — the cap was removed.
    assert.strictEqual(validateInstruction('z'.repeat(10000)), null, 'long text must pass (cap removed)');
});

// 9. wireSpawnedTeam behaviour — the function is transpiled and executed with
//    an in-memory db stub. Covers Verification Plan step 4: headPrompt
//    supplied, absent/whitespace, idempotent re-run, and children: [].

// Transpile linkPresets.ts (no imports — standalone) for the real preset
// resolvers that wireSpawnedTeam uses to build pair-scoped orders.
const LINK_PRESETS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'linkPresets.ts'), 'utf8'
);
const linkPresetsModule = { exports: {} };
new Function('exports', 'module', 'require', tsc.transpileModule(LINK_PRESETS_SRC, {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020 }
}).outputText)(linkPresetsModule.exports, linkPresetsModule, require);

// Transpile teamWiring.ts with a custom require that resolves its three
// relative imports: standingOrders (already transpiled above as resolverModule),
// linkPresets (just transpiled), and agentPromptBuilder (stub with just
// GIT_SAFETY_DIRECTIVE — the only export teamWiring.ts uses).
// TEAM_WIRING_SRC is already read at the top of this file (the source-text
// assertions use it) — do NOT re-declare it here.
const agentPromptBuilderStub = {
    GIT_SAFETY_DIRECTIVE: 'GIT_SAFETY_DIRECTIVE_STUB'
};
const teamWiringRequire = function (name) {
    if (name === './standingOrders') { return resolverModule.exports; }
    if (name === './linkPresets') { return linkPresetsModule.exports; }
    if (name === './agentPromptBuilder') { return agentPromptBuilderStub; }
    return require(name);
};
const teamWiringModule = { exports: {} };
new Function('exports', 'module', 'require', tsc.transpileModule(TEAM_WIRING_SRC, {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020 }
}).outputText)(teamWiringModule.exports, teamWiringModule, teamWiringRequire);

const { wireSpawnedTeam, TERMINALS_LAYOUT_MODES, SEAT_QUEUE_DONE_ORDER_BODY } = teamWiringModule.exports;

/**
 * The panel's own layout whitelist, read out of terminals.js rather than
 * restated: `LAYOUT_MODES = Object.keys(LAYOUTS)` is what both
 * `loadLayoutSettings` and `reloadTerminalGroups` filter on, so it is the only
 * correct yardstick for "is this stored layout keepable".
 */
const PANEL_LAYOUT_MODES = (() => {
    const start = TERMINALS_JS_SRC.indexOf('const LAYOUTS = {');
    assert.ok(start !== -1, 'terminals.js: `const LAYOUTS = {` not found');
    const end = TERMINALS_JS_SRC.indexOf('\n    };', start);
    assert.ok(end !== -1, 'terminals.js: end of LAYOUTS block not found');
    const modes = [...TERMINALS_JS_SRC.slice(start, end).matchAll(/^\s*'([^']+)':\s*\{\s*slots:/gm)]
        .map(m => m[1]);
    assert.ok(modes.length >= 7, `terminals.js: parsed only ${modes.length} layout modes`);
    return modes;
})();

/**
 * In-memory db stub for wireSpawnedTeam. getConfigJson/setConfigJson operate
 * on a plain object so mutateStandingOrders can read-modify-write the
 * standing-orders key. Also stubs the terminals.groups key for the group
 * registration step.
 */
function makeInMemoryDb() {
    const store = {};
    return {
        getConfigJson: async function (key, fallback) {
            if (key in store) { return JSON.parse(JSON.stringify(store[key])); }
            return fallback;
        },
        setConfigJson: async function (key, value) {
            store[key] = JSON.parse(JSON.stringify(value));
        },
        _store: store,
    };
}

const HEAD_NAME = 'lead-1';
const CODER_CHILDREN = [
    { friendlyName: 'lead-1-coder-1' },
    { friendlyName: 'lead-1-coder-2' },
    { friendlyName: 'lead-1-coder-3' },
];
const CODER_MEMBERS = [
    { role: 'coder', count: 3, scope: 'per-team', relationship: 'reports-to-head' },
    { role: 'reviewer', count: 1, scope: 'shared', relationship: 'reviewer' }
];
const HEAD_PROMPT = 'Advance finished subtasks to CODE REVIEWED. From: {head}.';

test('wireSpawnedTeam: headPrompt supplied => exactly two orders (team + team-head), same teamId, head order has child === "" and {head} substituted', async () => {
    const db = makeInMemoryDb();
    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: CODER_CHILDREN,
        members: CODER_MEMBERS, prompt: 'team prompt {child}',
        headPrompt: HEAD_PROMPT,
    });
    const orders = await db.getConfigJson('terminals.standingOrders', []);
    assert.strictEqual(orders.length, 2,
        `expected exactly 2 orders (team + team-head), got ${orders.length}`);

    const teamOrders = orders.filter(o => o.scope === 'team');
    const headOrders = orders.filter(o => o.scope === 'team-head');
    assert.strictEqual(teamOrders.length, 1, 'exactly one team-scoped order');
    assert.strictEqual(headOrders.length, 1, 'exactly one team-head-scoped order');

    // Same teamId on both.
    const teamId = teamOrders[0].teamId;
    assert.ok(teamId, 'team order must have a teamId');
    assert.strictEqual(headOrders[0].teamId, teamId,
        'team-head order must have the same teamId as the team order');

    // Head order has child === '' (old-build safety).
    assert.strictEqual(headOrders[0].child, '',
        'team-head order must have child === "" for old-build fall-through safety');

    // {head} substituted with the head name in the head order's instruction.
    assert.ok(headOrders[0].instruction.includes(HEAD_NAME),
        `team-head instruction must have {{head}} replaced with "${HEAD_NAME}"`);
    assert.ok(!headOrders[0].instruction.includes('{head}'),
        'team-head instruction must NOT contain the literal {head} token after substitution');

    // parent on the head order is the head name (delivery target).
    assert.strictEqual(headOrders[0].parent, HEAD_NAME,
        'team-head order parent must be the head name');
});

test('wireSpawnedTeam: headPrompt absent, empty, or whitespace => exactly one order (team), no fabricated default', async () => {
    for (const [label, headPrompt] of [['absent', undefined], ['empty', ''], ['whitespace', '   \t\n  ']]) {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: HEAD_NAME, children: CODER_CHILDREN,
            members: CODER_MEMBERS, prompt: 'team prompt {child}',
            headPrompt,
        });
        const orders = await db.getConfigJson('terminals.standingOrders', []);
        assert.strictEqual(orders.length, 1,
            `headPrompt ${label}: expected exactly 1 order (team only), got ${orders.length}`);
        assert.strictEqual(orders[0].scope, 'team',
            `headPrompt ${label}: the single order must be team-scoped`);
        assert.strictEqual(orders.filter(o => o.scope === 'team-head').length, 0,
            `headPrompt ${label}: no team-head order must be fabricated`);
    }
});

test('wireSpawnedTeam: re-run with identical args => still exactly two orders, no duplicate', async () => {
    const db = makeInMemoryDb();
    const args = {
        db, headName: HEAD_NAME, children: CODER_CHILDREN,
        members: CODER_MEMBERS, prompt: 'team prompt {child}',
        headPrompt: HEAD_PROMPT,
    };
    await wireSpawnedTeam(args);
    await wireSpawnedTeam(args);
    const orders = await db.getConfigJson('terminals.standingOrders', []);
    assert.strictEqual(orders.length, 2,
        `idempotent re-run: expected still exactly 2 orders, got ${orders.length} — duplicate detection failed`);
    assert.strictEqual(orders.filter(o => o.scope === 'team').length, 1,
        'idempotent re-run: exactly one team order');
    assert.strictEqual(orders.filter(o => o.scope === 'team-head').length, 1,
        'idempotent re-run: exactly one team-head order');
});

test('wireSpawnedTeam: children: [] => zero orders written and { ok: true } returned', async () => {
    const db = makeInMemoryDb();
    const result = await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: [],
        members: CODER_MEMBERS, prompt: 'team prompt {child}',
        headPrompt: HEAD_PROMPT,
    });
    assert.strictEqual(result.ok, true,
        'children: [] must return { ok: true } — a bare head is not an error');
    const orders = await db.getConfigJson('terminals.standingOrders', []);
    assert.strictEqual(orders.length, 0,
        `children: []: expected zero orders written, got ${orders.length}`);
});

test('wireSpawnedTeam: group roster first-registration append path', async () => {
    const db = makeInMemoryDb();
    const result = await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: CODER_CHILDREN,
        members: CODER_MEMBERS, prompt: 'team prompt {child}',
    });
    assert.strictEqual(result.ok, true);
    const groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.strictEqual(groups.length, 1, 'first registration appends group');
    assert.strictEqual(groups[0].id, result.groupId);
    assert.strictEqual(groups[0].name, HEAD_NAME);
    assert.strictEqual(groups[0].source, 'manual');
    assert.deepStrictEqual(groups[0].members, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-2', 'lead-1-coder-3']);
    assert.deepStrictEqual(groups[0].order, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-2', 'lead-1-coder-3']);
    // A new row must carry a layout the panel's own validator accepts, or both
    // loadLayoutSettings and reloadTerminalGroups silently drop the group.
    assert.ok(
        PANEL_LAYOUT_MODES.includes(groups[0].layout),
        `append path must write a LAYOUT_MODES-valid layout, got ${JSON.stringify(groups[0].layout)}`
    );
});

test('wireSpawnedTeam: second run with different children replaces members and removes stale member (not union)', async () => {
    const db = makeInMemoryDb();
    // 1st run: 3 coders
    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: CODER_CHILDREN,
        members: CODER_MEMBERS, prompt: 'team prompt {child}',
    });
    let groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0].members, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-2', 'lead-1-coder-3']);

    // 2nd run: 2 coders + 1 intern (lead-1-coder-3 removed, lead-1-intern added)
    const newChildren = [
        { friendlyName: 'lead-1-coder-1' },
        { friendlyName: 'lead-1-coder-2' },
        { friendlyName: 'lead-1-intern' },
    ];
    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: newChildren,
        prompt: 'team prompt {child}',
    });
    groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.strictEqual(groups.length, 1, 'still exactly 1 group');
    assert.deepStrictEqual(groups[0].members, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-2', 'lead-1-intern']);
    assert.deepStrictEqual(groups[0].order, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-2', 'lead-1-intern']);
    assert.ok(!groups[0].members.includes('lead-1-coder-3'), 'stale member lead-1-coder-3 must be removed');
});

test('wireSpawnedTeam: unknown keys on stored roster row survive upsert', async () => {
    const db = makeInMemoryDb();
    const groupId = 'team_' + encodeURIComponent(HEAD_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
    // Pre-populate store with custom fields
    await db.setConfigJson('switchboard.prompts.terminals.groups', [
        {
            id: groupId,
            name: HEAD_NAME,
            source: 'manual',
            customFlag: 'preserved-value',
            uiCollapsed: true,
            members: [HEAD_NAME, 'lead-1-coder-old'],
            order: [HEAD_NAME, 'lead-1-coder-old'],
        }
    ]);

    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: CODER_CHILDREN,
    });

    const groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].customFlag, 'preserved-value', 'custom keys must survive');
    assert.strictEqual(groups[0].uiCollapsed, true, 'custom boolean flags must survive');
    assert.deepStrictEqual(groups[0].members, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-2', 'lead-1-coder-3']);
});

test('wireSpawnedTeam: switching back to head pacing removes the persisted field and seat orders', async () => {
    const db = makeInMemoryDb();
    const args = { db, headName: HEAD_NAME, children: CODER_CHILDREN };
    await wireSpawnedTeam({ ...args, pacing: 'seat' });
    let groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    let orders = await db.getConfigJson('terminals.standingOrders', []);
    assert.strictEqual(groups[0].pacing, 'seat');
    assert.strictEqual(orders.filter(o => o.instruction === SEAT_QUEUE_DONE_ORDER_BODY).length, 2);

    await wireSpawnedTeam(args);
    groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    orders = await db.getConfigJson('terminals.standingOrders', []);
    assert.ok(!Object.prototype.hasOwnProperty.call(groups[0], 'pacing'));
    assert.strictEqual(orders.filter(o => o.instruction === SEAT_QUEUE_DONE_ORDER_BODY).length, 0);
});

test('wireSpawnedTeam: null/non-object stored entry with matching id is replaced', async () => {
    const db = makeInMemoryDb();
    const groupId = 'team_' + encodeURIComponent(HEAD_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
    // Pre-populate with null or primitive
    await db.setConfigJson('switchboard.prompts.terminals.groups', [null, { id: 'other-group', members: [] }]);

    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: CODER_CHILDREN,
    });

    const groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.strictEqual(groups.length, 3);
    const teamGroup = groups.find(g => g && g.id === groupId);
    assert.ok(teamGroup, 'group should be registered');
    assert.deepStrictEqual(teamGroup.members, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-2', 'lead-1-coder-3']);
});

test('wireSpawnedTeam: existing layout on stored row is preserved across re-runs', async () => {
    const db = makeInMemoryDb();
    const groupId = 'team_' + encodeURIComponent(HEAD_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
    // Pre-populate store with a custom layout '2x2'
    await db.setConfigJson('switchboard.prompts.terminals.groups', [
        {
            id: groupId,
            name: HEAD_NAME,
            source: 'manual',
            layout: '2x2',
            members: [HEAD_NAME, 'lead-1-coder-old'],
            order: [HEAD_NAME, 'lead-1-coder-old'],
        }
    ]);

    // Spawn 1 child — head + 1 = 2 members, so layoutForTeamSize would pick '2h'.
    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: [{ friendlyName: 'lead-1-coder-1' }],
    });

    const groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].layout, '2x2', 'operator-authored layout must survive');
    assert.deepStrictEqual(groups[0].members, [HEAD_NAME, 'lead-1-coder-1']);
});

test("wireSpawnedTeam: an operator's '2v' survives a re-run — the ladder is not the validator", async () => {
    // '2v' is the discriminating case: it is a valid panel layout with its own
    // button, but it is deliberately ABSENT from TEAM_LAYOUT_LADDER because a
    // stacked pair is never auto-picked. Validating a stored layout against the
    // ladder therefore reverts the one mode only an operator can have authored.
    // A test pinned on '2x2' passes against both the correct and the broken
    // implementation, which is why this one exists alongside it.
    const db = makeInMemoryDb();
    const groupId = 'team_' + encodeURIComponent(HEAD_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
    await db.setConfigJson('switchboard.prompts.terminals.groups', [
        {
            id: groupId,
            name: HEAD_NAME,
            source: 'manual',
            layout: '2v',
            members: [HEAD_NAME, 'lead-1-coder-old'],
            order: [HEAD_NAME, 'lead-1-coder-old'],
        }
    ]);

    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: [{ friendlyName: 'lead-1-coder-1' }],
    });

    const groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.strictEqual(groups[0].layout, '2v', "operator's stacked-pair layout must not revert to '2h'");
    assert.deepStrictEqual(groups[0].members, [HEAD_NAME, 'lead-1-coder-1']);
});

test('wireSpawnedTeam: a stored layout outside the panel whitelist falls back to the computed one', async () => {
    const db = makeInMemoryDb();
    const groupId = 'team_' + encodeURIComponent(HEAD_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
    await db.setConfigJson('switchboard.prompts.terminals.groups', [
        { id: groupId, name: HEAD_NAME, source: 'manual', layout: '9x9', members: [], order: [] }
    ]);

    await wireSpawnedTeam({
        db, headName: HEAD_NAME, children: [{ friendlyName: 'lead-1-coder-1' }],
    });

    const groups = await db.getConfigJson('switchboard.prompts.terminals.groups', []);
    assert.ok(
        PANEL_LAYOUT_MODES.includes(groups[0].layout),
        `merged row must stay loadable, got ${JSON.stringify(groups[0].layout)}`
    );
});

test('TERMINALS_LAYOUT_MODES is byte-identical to LAYOUT_MODES in terminals.js', () => {
    assert.ok(TERMINALS_LAYOUT_MODES instanceof Set, 'teamWiring must export TERMINALS_LAYOUT_MODES as a Set');
    assert.deepStrictEqual(
        [...TERMINALS_LAYOUT_MODES].sort(),
        [...PANEL_LAYOUT_MODES].sort(),
        'the backend layout whitelist must mirror the panel\'s LAYOUTS keys — a mode present in one and '
        + 'not the other either reverts an operator layout or writes a row the panel then drops'
    );
});

// ─────────────────────────────────────────────────────────────────────
// reloadTerminalGroups (webview) — the second half of the roster upsert.
// Executed, not pattern-matched: the backend upsert is invisible unless the
// panel adopts `members`/`order` for an id it already holds.
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract `reloadTerminalGroups` from terminals.js and run it against injected
 * closure state. The panel is one big IIFE, so the function is lifted whole and
 * re-hosted with the four collaborators it closes over.
 */
function makeReloadHarness(initialGroups, backendGroups, scopedTeamId) {
    const start = TERMINALS_JS_SRC.indexOf('    async function reloadTerminalGroups()');
    assert.ok(start !== -1, 'terminals.js: reloadTerminalGroups not found');
    const end = TERMINALS_JS_SRC.indexOf('    async function fetchTerminalList()', start);
    assert.ok(end !== -1, 'terminals.js: end marker (fetchTerminalList) not found');
    const src = TERMINALS_JS_SRC.slice(start, end);

    const calls = { sidebar: 0, tabStrip: 0 };
    const factory = new Function('deps', `
        const LAYOUT_MODES = deps.LAYOUT_MODES;
        const loadSetting = deps.loadSetting;
        const renderSidebarList = deps.renderSidebarList;
        const renderGroupTabStrip = deps.renderGroupTabStrip;
        let terminalGroups = deps.terminalGroups;
        let lastReadGroupIds = [];
        let teamScopeId = deps.teamScopeId;
        ${src}
        return {
            reloadTerminalGroups,
            groups: () => terminalGroups,
            lastReadIds: () => lastReadGroupIds,
        };
    `);
    const api = factory({
        LAYOUT_MODES: PANEL_LAYOUT_MODES,
        loadSetting: async () => JSON.parse(JSON.stringify(backendGroups)),
        renderSidebarList: () => { calls.sidebar++; },
        renderGroupTabStrip: () => { calls.tabStrip++; },
        terminalGroups: initialGroups,
        teamScopeId: scopedTeamId || null,
    });
    return { ...api, calls };
}

const ROSTER_ID = 'team_lead_1';
function localRow(extra) {
    return Object.assign({
        id: ROSTER_ID,
        name: HEAD_NAME,
        source: 'manual',
        layout: '2v',
        members: [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-3'],
        order: [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-3'],
    }, extra || {});
}

test('reloadTerminalGroups: an id already in memory has members and order refreshed', async () => {
    const local = [localRow({ pinnedByOperator: true })];
    const fresh = [{
        id: ROSTER_ID, name: HEAD_NAME, source: 'manual', layout: '2x2',
        members: [HEAD_NAME, 'lead-1-coder-1', 'lead-1-intern'],
        order: [HEAD_NAME, 'lead-1-coder-1', 'lead-1-intern'],
    }];
    const h = makeReloadHarness(local, fresh);
    await h.reloadTerminalGroups();

    assert.strictEqual(h.groups().length, 1, 'refresh must not append a second row for the same id');
    assert.deepStrictEqual(h.groups()[0].members, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-intern']);
    assert.deepStrictEqual(h.groups()[0].order, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-intern']);
    assert.ok(!h.groups()[0].members.includes('lead-1-coder-3'), 'stale member must be dropped, not unioned');
    assert.strictEqual(h.groups()[0].layout, '2v', 'layout is the panel\'s — the backend does not own it');
    assert.strictEqual(h.groups()[0].pinnedByOperator, true, 'unknown local fields must survive');
    assert.strictEqual(h.calls.sidebar, 1, 'a members-only change must redraw the sidebar');
    assert.strictEqual(h.calls.tabStrip, 1, 'a members-only change must redraw the tab strip');
});

test('reloadTerminalGroups: in team scope the redraw skips the strip so the team header survives', () => {
    // The strip and the team header share #group-tab-strip: renderSidebarList
    // renders the strip, then renderTeamHeader APPENDS the context bar into the
    // same element. A bare renderGroupTabStrip() after that re-wipes the
    // element and takes the header — plus any live `team:*` role picker mounted
    // beside it — with it, on every terminalsGroupsChanged push (team spawn,
    // team restart, cross-panel group edit). Fleet mode keeps the redraw.
    const local = [localRow()];
    const fresh = [{
        id: ROSTER_ID, name: HEAD_NAME, source: 'manual', layout: '2x2',
        members: [HEAD_NAME, 'lead-1-coder-1', 'lead-1-intern'],
        order: [HEAD_NAME, 'lead-1-coder-1', 'lead-1-intern'],
    }];
    const h = makeReloadHarness(local, fresh, ROSTER_ID);
    return h.reloadTerminalGroups().then(() => {
        assert.strictEqual(h.calls.sidebar, 1, 'the sidebar redraw still runs in team scope — it rebuilds the strip AND the header');
        assert.strictEqual(h.calls.tabStrip, 0, 'the bare strip redraw must be skipped in team scope');
    });
});

test('reloadTerminalGroups: an unchanged read triggers no redraw', async () => {
    const local = [localRow()];
    const h = makeReloadHarness(local, [localRow()]);
    await h.reloadTerminalGroups();
    assert.strictEqual(h.calls.sidebar, 0, 'an idempotent reload must not redraw');
    assert.strictEqual(h.calls.tabStrip, 0);
});

test('reloadTerminalGroups: a new id is appended and a local-only group is left alone', async () => {
    const local = [{
        id: 'grp_local', name: 'my group', source: 'manual', layout: '1',
        members: ['a'], order: ['a'],
    }];
    const h = makeReloadHarness(local, [localRow()]);
    await h.reloadTerminalGroups();
    assert.strictEqual(h.groups().length, 2, 'backend row added, local row kept');
    assert.ok(h.groups().some(g => g.id === 'grp_local'), 'this loop never removes');
    assert.strictEqual(h.calls.sidebar, 1);
});

test('reloadTerminalGroups: a row with non-array members cannot blank a populated local one', async () => {
    const local = [localRow()];
    const fresh = [{ id: ROSTER_ID, name: HEAD_NAME, source: 'manual', layout: '2x2', members: null, order: undefined }];
    const h = makeReloadHarness(local, fresh);
    await h.reloadTerminalGroups();
    assert.deepStrictEqual(h.groups()[0].members, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-3']);
    assert.deepStrictEqual(h.groups()[0].order, [HEAD_NAME, 'lead-1-coder-1', 'lead-1-coder-3']);
    assert.strictEqual(h.calls.sidebar, 0);
});

test('reloadTerminalGroups: the same id twice in one read yields one row, last wins', async () => {
    const fresh = [
        { id: ROSTER_ID, name: HEAD_NAME, source: 'manual', layout: '2x2', members: ['x'], order: ['x'] },
        { id: ROSTER_ID, name: HEAD_NAME, source: 'manual', layout: '2x2', members: ['y'], order: ['y'] },
    ];
    const h = makeReloadHarness([], fresh);
    await h.reloadTerminalGroups();
    assert.strictEqual(h.groups().length, 1, 'a duplicate id must not produce a duplicate row');
    assert.deepStrictEqual(h.groups()[0].members, ['y'], 'last wins');
});

test('reloadTerminalGroups: a malformed backend row is filtered before it can enter panel state', async () => {
    const fresh = [
        { id: 'bad-layout', name: 'x', source: 'manual', layout: '9x9', members: [], order: [] },
        { id: 'bad-source', name: 'x', source: 'ghost', layout: '1', members: [], order: [] },
        null,
    ];
    const h = makeReloadHarness([], fresh);
    await h.reloadTerminalGroups();
    assert.strictEqual(h.groups().length, 0, 'validation filter must still gate panel state');
});

// Summary

Promise.all(testPromises).then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
});


