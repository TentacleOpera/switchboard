'use strict';

/**
 * Contract: Teams reach state through endpoints, never through host files.
 *
 * Invariants:
 *  1. Every built-in role that receives a prompt or queue order receives the
 *     SWITCHBOARD STATUS (liveness / port) line when apiPort > 0.
 *  2. No active agent-facing instruction in teamWiring.ts, standingOrderFragments.ts,
 *     agentPromptBuilder.ts, or agentGroupInstantiation.ts names .switchboard/api-server-port.txt
 *     or kanban.db, except for the explicit allowlist (legacy recognisers and host-side code).
 *  3. Stale installed orders carrying legacy port-file bodies are rewritten on read
 *     by migrateCodingTeamOrders.
 *  4. Endpoints named in order bodies match real LocalApiServer endpoints.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js --require ./src/test/bootstrap/vscodeStub.js src/test/team-state-endpoint-access-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');

const {
    buildKanbanBatchPrompt,
    SWITCHBOARD_LIVENESS_DIRECTIVE,
} = require('../../out/services/agentPromptBuilder');

const {
    migrateCodingTeamOrders,
    NEW_CODING_HEAD_PROMPT,
    CONTEXT_AWARE_HEAD_COMPLETION_ORDER_BODY,
    CONTEXT_AWARE_COMPLETION_ORDER_BODY,
} = require('../../out/services/teamWiring');

const {
    buildMemberCompletionFragment,
    buildHeadCompletionFragment,
    buildHeadNextFragment,
    GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY,
} = require('../../out/services/standingOrderFragments');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function run() {
    console.log('\nteam-state-endpoint-access-contract\n');

    const BUILTIN_ROLES = [
        'planner',
        'reviewer',
        'tester',
        'lead',
        'coder',
        'intern',
        'analyst',
        'ticket_updater',
        'researcher',
        'chat'
    ];

    const samplePlans = [
        {
            planId: 'plan-test-1',
            absolutePath: path.join(ROOT, '.switchboard', 'plans', 'plan-test-1.md'),
            topic: 'Test Plan Topic',
            isFeature: false,
            isSubtask: false,
        }
    ];

    // ── 1. Port line reaches every role ─────────────────────────────────

    check('SWITCHBOARD STATUS line reaches all 10 built-in roles when apiPort > 0', () => {
        const testPort = 58312;
        for (const role of BUILTIN_ROLES) {
            const prompt = buildKanbanBatchPrompt(role, samplePlans, {
                apiPort: testPort,
                workspaceRoot: ROOT,
            });
            assert.ok(
                prompt.includes(`SWITCHBOARD STATUS: Live (port ${testPort})`),
                `Role '${role}' must include SWITCHBOARD STATUS line with port ${testPort}`
            );
            assert.ok(
                prompt.includes(`http://127.0.0.1:${testPort}`),
                `Role '${role}' must include base URL http://127.0.0.1:${testPort}`
            );
        }
    });

    check('SWITCHBOARD STATUS line is omitted when apiPort is 0 or undefined', () => {
        for (const role of BUILTIN_ROLES) {
            const promptZero = buildKanbanBatchPrompt(role, samplePlans, {
                apiPort: 0,
                workspaceRoot: ROOT,
            });
            assert.ok(
                !promptZero.includes('SWITCHBOARD STATUS: Live'),
                `Role '${role}' must NOT include SWITCHBOARD STATUS when apiPort is 0`
            );

            const promptUndef = buildKanbanBatchPrompt(role, samplePlans, {
                workspaceRoot: ROOT,
            });
            assert.ok(
                !promptUndef.includes('SWITCHBOARD STATUS: Live'),
                `Role '${role}' must NOT include SWITCHBOARD STATUS when apiPort is undefined`
            );
        }
    });

    // ── 2. Active standing orders & fragments reach state via endpoints, never host files ──

    check('active standing order fragments name no host files (api-server-port.txt or kanban.db)', () => {
        const memberCompletion = buildMemberCompletionFragment({ teamId: 'team_test', headName: 'Lead' });
        assert.ok(!memberCompletion.includes('api-server-port.txt'), 'memberCompletion must not name api-server-port.txt');
        assert.ok(!memberCompletion.includes('kanban.db'), 'memberCompletion must not name kanban.db');
        assert.ok(memberCompletion.includes('SWITCHBOARD STATUS'), 'memberCompletion must point at SWITCHBOARD STATUS line');

        const headCompletion = buildHeadCompletionFragment();
        assert.ok(!headCompletion.includes('api-server-port.txt'), 'headCompletion must not name api-server-port.txt');
        assert.ok(!headCompletion.includes('kanban.db'), 'headCompletion must not name kanban.db');
        assert.ok(headCompletion.includes('SWITCHBOARD STATUS'), 'headCompletion must point at SWITCHBOARD STATUS line');

        const headNext = buildHeadNextFragment({ teamId: 'team_test' });
        assert.ok(!headNext.includes('api-server-port.txt'), 'headNext must not name api-server-port.txt');
        assert.ok(!headNext.includes('kanban.db'), 'headNext must not name kanban.db');

        const globalCompletion = GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY;
        assert.ok(!globalCompletion.includes('api-server-port.txt'), 'globalCompletion must not name api-server-port.txt');
        assert.ok(!globalCompletion.includes('kanban.db'), 'globalCompletion must not name kanban.db');
    });

    check('NEW_CODING_HEAD_PROMPT names no host files and reaches API via SWITCHBOARD STATUS line', () => {
        assert.ok(!NEW_CODING_HEAD_PROMPT.includes('api-server-port.txt'), 'NEW_CODING_HEAD_PROMPT must not name api-server-port.txt');
        assert.ok(!NEW_CODING_HEAD_PROMPT.includes('kanban.db'), 'NEW_CODING_HEAD_PROMPT must not name kanban.db');
        assert.ok(NEW_CODING_HEAD_PROMPT.includes('SWITCHBOARD STATUS'), 'NEW_CODING_HEAD_PROMPT must point at SWITCHBOARD STATUS line');
    });

    // ── 3. Grep gate with explicit allowlist for legacy recognisers & host readers ──

    check('grep gate: no active instruction names api-server-port.txt or kanban.db outside allowlist', () => {
        const filesToCheck = [
            'src/services/teamWiring.ts',
            'src/services/standingOrderFragments.ts',
            'src/services/agentGroupInstantiation.ts',
            'src/services/agentPromptBuilder.ts',
        ];

        const ALLOWED_PATTERNS = [
            // teamWiring.ts: legacy recogniser constants for migration matching (multi-line)
            /export const PRE_REWRITE_CALLBACK_INSTRUCTION =[\s\S]*?;\s*$/m,
            /function LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY\([\s\S]*?^}\s*$/m,
            /function LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY_V2\([\s\S]*?^}\s*$/m,
            // agentGroupInstantiation.ts: explicit negative prohibition for external head
            /Do not read `\.switchboard\/api-server-port\.txt`\./,
            // agentPromptBuilder.ts: documentation comments explaining the migration
            /\* `\.switchboard\/api-server-port\.txt` reference, so those instructions name "the API/,
            /root's \.switchboard\/\)\. The directive is mandatory for the agent, but a missing/,
            /\/\/ researcher agent handoff fallback when port file is missing/,
            /\.switchboard\/api-server-port\.txt \(relative to the workspace root\);/,
        ];

        for (const relPath of filesToCheck) {
            const absPath = path.join(ROOT, relPath);
            const content = fs.readFileSync(absPath, 'utf8');

            // Mask out all allowed multi-line constructs before line checking
            let maskedContent = content;
            for (const pattern of ALLOWED_PATTERNS) {
                maskedContent = maskedContent.replace(pattern, match => {
                    // Replace non-newlines with spaces to preserve line numbers exactly
                    return match.replace(/[^\r\n]/g, ' ');
                });
            }

            const lines = maskedContent.split('\n');

            lines.forEach((line, idx) => {
                const lineNum = idx + 1;
                const hasPortFile = line.includes('api-server-port.txt');
                const hasDb = line.includes('kanban.db');

                if (!hasPortFile && !hasDb) return;

                // Check comments
                const isAllowed = line.trim().startsWith('*')
                    || line.trim().startsWith('//')
                    || (line.includes('//') && (line.indexOf('//') < line.indexOf('api-server-port.txt') || line.indexOf('//') < line.indexOf('kanban.db')));

                assert.ok(
                    isAllowed,
                    `Disallowed host file reference in ${relPath}:${lineNum}:\n  ${line.trim()}`
                );
            });
        }
    });

    // ── 4. Installed orders migration rewrites legacy bodies ────────────

    check('migrateCodingTeamOrders rewrites stale port-file order bodies on read', () => {
        const legacyBody = 'When you finish a task, route your completion report based on where the work came from:\n\n'
            + '1. If you have a PLAN_ID from your dispatch, call GET /kanban/plan?planId=<your planId>\n'
            + '   against the port in .switchboard/api-server-port.txt.\n'
            + '   - If the response shows kanbanColumn is "LEAD CODED", "CODER CODED", or "INTERN CODED",\n'
            + '     POST /kanban/queue/done with {"from":"<your terminal name>"}.\n'
            + '     The system will clear your terminal and dispatch the next staged card.\n'
            + '     A response of {"dispatched":null,"reason":"queue empty"} means the run is over — say so and stop.\n'
            + '     If you cannot complete it, POST /kanban/queue/done with\n'
            + '     {"from":"<your terminal name>","outcome":"failed"} and a one-line reason.\n'
            + '   - If the response shows any other column, report to your head (step 3).\n\n'
            + '2. If you do not have a PLAN_ID (ad-hoc prompt, file-based queue item),\n'
            + '   POST /terminals/teams/team_test/queue/done with {"from":"<your terminal name>"}.\n'
            + '   The system will relay your report to your team lead, clear your terminal,\n'
            + '   and dispatch the next queued item.\n'
            + '   If the POST fails, report to your head directly (step 3).\n\n'
            + '3. Fallback: report to your head Coding-lead via POST /terminals/verb/ptySendPrompt with\n'
            + '   {"name":"Coding-lead","data":"<your report>","clearBeforePrompt":false} — naming what\n'
            + '   you changed and what to review. Do not wait to be asked.\n\n'
            + 'Before reporting, if you have a featureId, check GET /kanban/plans?featureId=<your feature id> —\n'
            + 'if all subtasks are in LEAD CODED, POST /kanban/dispatch with\n'
            + '{"plan":"<featurePlanId>","targetColumn":"CODE REVIEWED","from":"<your terminal name>"}\n'
            + 'instead of any of the above. The feature is complete — hand it to review.';

        const testOrders = [
            {
                id: 'context-aware-completion:team-head:team_test',
                parent: 'Coding-lead',
                child: '',
                instruction: legacyBody,
                scope: 'team-head',
                teamId: 'team_test',
            }
        ];

        const migrated = migrateCodingTeamOrders(testOrders);
        assert.strictEqual(migrated.length, 1, 'migrated order should survive');
        assert.strictEqual(
            migrated[0].instruction,
            CONTEXT_AWARE_HEAD_COMPLETION_ORDER_BODY('team_test'),
            'legacy port-file head order must be rewritten to modern CONTEXT_AWARE_HEAD_COMPLETION_ORDER_BODY'
        );
        assert.ok(
            !migrated[0].instruction.includes('api-server-port.txt'),
            'migrated instruction must not name api-server-port.txt'
        );
        assert.ok(
            migrated[0].instruction.includes('SWITCHBOARD STATUS'),
            'migrated instruction must point at SWITCHBOARD STATUS line'
        );
    });

    // ── 5. Endpoints cover order reads ──────────────────────────────────

    check('endpoints cover all order reads', () => {
        const memberText = buildMemberCompletionFragment({ teamId: 'team_1', headName: 'Lead' });
        assert.ok(memberText.includes('GET /kanban/plan'), 'member completion reads plan via GET /kanban/plan');

        const headText = buildHeadCompletionFragment();
        assert.ok(headText.includes('POST /kanban/round/register'), 'head completion registers rounds via POST /kanban/round/register');
        assert.ok(headText.includes('POST /kanban/task/complete'), 'head completion completes tasks via POST /kanban/task/complete');
        assert.ok(headText.includes('POST /kanban/round/complete'), 'head completion completes rounds via POST /kanban/round/complete');
        assert.ok(headText.includes('POST /kanban/feature/complete'), 'head completion completes features via POST /kanban/feature/complete');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
