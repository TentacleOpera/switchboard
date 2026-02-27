/**
 * Regression tests for send_message sender/recipient guardrails.
 * Run with: node src/test/send-message-guards.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_ROOT = path.join(os.tmpdir(), `switchboard-send-message-guards-${Date.now()}`);
const STATE_DIR = path.join(TEST_ROOT, '.switchboard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

process.env.SWITCHBOARD_WORKSPACE_ROOT = TEST_ROOT;
fs.mkdirSync(STATE_DIR, { recursive: true });

delete require.cache[require.resolve('../mcp-server/state-manager')];
delete require.cache[require.resolve('../mcp-server/register-tools')];

const { updateState } = require('../mcp-server/state-manager');
const { registerTools } = require('../mcp-server/register-tools');

const tools = {};
const mockServer = {
    tool(name, _schema, handler) {
        tools[name] = handler;
    },
    resource() {
        // no-op for unit tests
    }
};
registerTools(mockServer);
const sendMessage = tools.send_message;
const checkInbox = tools.check_inbox;

let passed = 0;
let failed = 0;

function readText(result) {
    return result?.content?.[0]?.text || '';
}

function extractJsonPayload(text) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;
    return JSON.parse(text.slice(start, end + 1));
}

function getLatestInboxMessage(recipient) {
    const inboxDir = path.join(TEST_ROOT, '.switchboard', 'inbox', recipient);
    if (!fs.existsSync(inboxDir)) return null;
    const files = fs.readdirSync(inboxDir)
        .filter(f => f.endsWith('.json'))
        .sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1];
    return JSON.parse(fs.readFileSync(path.join(inboxDir, latest), 'utf8'));
}

async function resetWorkspace() {
    if (fs.existsSync(TEST_ROOT)) {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
}

async function seedState({ sessionWorkflow = 'handoff', includeWorker = true } = {}) {
    await updateState(state => {
        state.session = state.session || {};
        state.session.activeWorkflow = sessionWorkflow;
        state.session.status = sessionWorkflow ? 'IN_PROGRESS' : 'IDLE';
        state.session.currentStep = 1;

        state.chatAgents = state.chatAgents || {};
        if (includeWorker) {
            state.chatAgents['worker-agent'] = {
                type: 'chat',
                interface: 'gemini',
                role: 'task runner',
                status: 'active',
                activeWorkflow: null,
                currentStep: 0,
                activeWorkflowPhase: 0,
                activePersona: null,
                friendlyName: 'worker-agent',
                lastSeen: new Date().toISOString()
            };
        }
        return state;
    });
}

async function seedCanonicalRoleTerminals() {
    await updateState(state => {
        state.session = state.session || {};
        state.session.activeWorkflow = 'challenge';
        state.session.status = 'IN_PROGRESS';
        state.session.currentStep = 1;

        state.terminals = state.terminals || {};
        state.terminals.Reviewer = {
            purpose: 'agent-grid',
            role: 'reviewer',
            status: 'active',
            friendlyName: 'Reviewer',
            lastSeen: new Date().toISOString()
        };
        return state;
    });
}

async function seedLockedReviewerState() {
    await updateState(state => {
        state.session = state.session || {};
        state.session.activeWorkflow = 'challenge';
        state.session.status = 'IN_PROGRESS';
        state.session.currentStep = 1;

        state.chatAgents = state.chatAgents || {};
        state.chatAgents['reviewer'] = {
            type: 'chat',
            interface: 'gemini',
            role: 'reviewer',
            status: 'working',
            activeWorkflow: 'challenge',
            currentStep: 1,
            activeWorkflowPhase: 1,
            activePersona: null,
            friendlyName: 'reviewer',
            lastSeen: new Date().toISOString()
        };
        return state;
    });
}

async function test(name, fn) {
    try {
        await resetWorkspace();
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}: ${e.message}`);
        failed++;
    }
}

async function run() {
    console.log('\nRunning send_message guard tests\n');

    await test('routes execute in handoff to coder', async () => {
        await seedState({ sessionWorkflow: 'handoff' });

        const result = await sendMessage({
            action: 'delegate_task',
            payload: 'execute task'
        });

        assert.ok(!result.isError, readText(result));
        const inboxDir = path.join(TEST_ROOT, '.switchboard', 'inbox', 'coder');
        const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter(f => f.endsWith('.json')) : [];
        assert.ok(files.length > 0, 'Expected delegated message in coder inbox');
    });

    await test('routes execute in challenge to reviewer', async () => {
        await seedState({ sessionWorkflow: 'challenge', includeWorker: false });

        const result = await sendMessage({
            action: 'execute',
            payload: 'execute task'
        });

        assert.ok(!result.isError, readText(result));
        const inboxDir = path.join(TEST_ROOT, '.switchboard', 'inbox', 'reviewer');
        const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter(f => f.endsWith('.json')) : [];
        assert.ok(files.length > 0, 'Expected reviewer recipient message in reviewer inbox');
    });

    await test('routes execute in challenge to reviewer', async () => {
        await seedState({ sessionWorkflow: 'challenge', includeWorker: false });

        const result = await sendMessage({
            action: 'execute',
            payload: 'review this plan'
        });

        assert.ok(!result.isError, readText(result));
        const inboxDir = path.join(TEST_ROOT, '.switchboard', 'inbox', 'reviewer');
        const files = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter(f => f.endsWith('.json')) : [];
        assert.ok(files.length > 0, 'Expected reviewer recipient message in reviewer inbox');
    });

    await test('execute is permissive without registered reviewer and reports terminal push failure', async () => {
        await seedState({ sessionWorkflow: 'challenge', includeWorker: false });

        const result = await sendMessage({
            action: 'execute',
            payload: 'review this plan now'
        });

        assert.ok(!result.isError, readText(result));
        assert.match(readText(result), /Action:\s*execute/i);
        assert.match(readText(result), /terminal direct push failed/i);
    });

    await test('blocks execute dispatch when reviewer is workflow-locked', async () => {
        await seedLockedReviewerState();

        const result = await sendMessage({
            action: 'execute',
            payload: 'run this review now'
        });

        // Debugging output if it fails
        if (!result.isError) {
            console.log('Unexpected success result:', JSON.stringify(result, null, 2));
        }

        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /workflow-locked/i);
    });

    await test('removed standby workflow no longer accepts delegation actions', async () => {
        await seedState({ sessionWorkflow: 'standby' });

        const result = await sendMessage({
            action: 'delegate_task',
            payload: 'execute task'
        });

        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /is not valid for workflow 'standby'/i);
    });


    await test('error when no active workflow for delegation', async () => {
        await seedState({ sessionWorkflow: null });

        const result = await sendMessage({
            action: 'delegate_task',
            payload: 'do work'
        });

        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /No active workflow/i);
    });

    await test('error when workflow does not support action', async () => {
        await seedState({ sessionWorkflow: 'accuracy' });

        const result = await sendMessage({
            action: 'delegate_task',
            payload: 'do work'
        });

        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /is not valid for workflow/i);
    });

    await test('challenge execute no longer requires review metadata', async () => {
        await seedState({ sessionWorkflow: 'challenge', includeWorker: false });

        const result = await sendMessage({
            action: 'execute',
            payload: 'Please review plan at .switchboard/handoff/implementation_plan.md'
        });

        assert.ok(!result.isError, readText(result));
    });

    await test('challenge execute enriches review metadata', async () => {
        await seedState({ sessionWorkflow: 'challenge', includeWorker: false });

        const result = await sendMessage({
            action: 'execute',
            payload: 'Review this plan',
            metadata: {
                review: {
                    authorized_plan: '.switchboard/handoff/implementation_plan.md',
                    report_path: '.switchboard/handoff/challenge_report_test.md'
                }
            }
        });

        assert.ok(!result.isError, readText(result));
        const reviewerInbox = path.join(TEST_ROOT, '.switchboard', 'inbox', 'reviewer');
        const files = fs.existsSync(reviewerInbox) ? fs.readdirSync(reviewerInbox).filter(f => f.endsWith('.json')) : [];
        assert.ok(files.length > 0, 'Expected reviewer inbox message');
        const latest = files.sort().pop();
        const message = JSON.parse(fs.readFileSync(path.join(reviewerInbox, latest), 'utf8'));

        assert.strictEqual(message.action, 'execute');
        assert.ok(message.metadata?.review?.authorized_plan, 'Missing authorized plan in review metadata');
        assert.ok(message.metadata?.review?.report_path, 'Missing report path in review metadata');
        assert.ok(!message.metadata?.review?.dispatch_id, 'Review metadata should no longer be auto-enriched with dispatch_id');
    });

    await test('execute payload is compact enough for chat delivery limits', async () => {
        await seedState({ sessionWorkflow: 'challenge', includeWorker: false });

        const verbosePayload = 'Review this implementation and list all concerns.\n' + 'details '.repeat(500);
        const result = await sendMessage({
            action: 'execute',
            payload: verbosePayload
        });

        assert.ok(!result.isError, readText(result));
        const message = getLatestInboxMessage('reviewer');
        assert.ok(message, 'Expected reviewer inbox message');
        // Payload is now raw (no guardrail/persona wrapping) — it stays as-is
        assert.strictEqual(message.payload, verbosePayload);
        // Guardrail metadata is stored separately, not in the payload text
        assert.ok(message.metadata, 'Expected metadata on message');
    });

    await test('all execute-routing workflows keep raw payload (no envelope wrapping)', async () => {
        const cases = [
            { workflow: 'handoff', recipient: 'coder' },
            { workflow: 'challenge', recipient: 'reviewer' },
            { workflow: 'challenge', recipient: 'reviewer' }
        ];

        const rawPayload = 'Perform review and execution checks.\n' + 'x '.repeat(700);
        for (const c of cases) {
            await resetWorkspace();
            await seedState({ sessionWorkflow: c.workflow, includeWorker: false });
            const result = await sendMessage({
                action: 'execute',
                payload: rawPayload
            });
            assert.ok(!result.isError, `${c.workflow}: ${readText(result)}`);
            const message = getLatestInboxMessage(c.recipient);
            assert.ok(message, `${c.workflow}: expected message in ${c.recipient} inbox`);
            // Payload should be the raw user text — no persona/guardrail wrapping
            assert.strictEqual(message.payload, rawPayload, `${c.workflow}: payload should be raw`);
            // Metadata should exist with dispatch info
            assert.ok(message.metadata, `${c.workflow}: missing metadata`);
        }
    });

    await test('check_inbox returns all execute messages in Blind Send model', async () => {
        await seedState({ sessionWorkflow: null, includeWorker: false });
        const reviewerInbox = path.join(TEST_ROOT, '.switchboard', 'inbox', 'reviewer');
        fs.mkdirSync(reviewerInbox, { recursive: true });

        const now = Date.now();
        const writeMessage = (id, sender, createdAtOffsetMs, expiresAtOffsetMs, action = 'execute') => {
            const createdAt = new Date(now + createdAtOffsetMs).toISOString();
            const payload = {
                id,
                action,
                sender,
                recipient: 'reviewer',
                payload: `${action}-${id}`,
                createdAt,
                metadata: {
                    dispatch: {
                        dispatch_id: id,
                        created_at: createdAt,
                        expires_at: new Date(now + expiresAtOffsetMs).toISOString()
                    }
                }
            };
            fs.writeFileSync(path.join(reviewerInbox, `${id}.json`), JSON.stringify(payload, null, 2));
        };

        // In Blind Send model, all messages are returned - user confirms completion manually
        writeMessage('msg_old', 'sender-a', -60000, 3600000);
        writeMessage('msg_new', 'sender-a', -1000, 3600000);
        writeMessage('msg_expired', 'sender-b', -5000, -1000);
        writeMessage('msg_delegate', 'sender-c', -2000, 3600000, 'delegate_task');

        const result = await checkInbox({
            agent: 'reviewer',
            box: 'inbox',
            verbose: true
        });

        assert.ok(!result.isError, readText(result));
        const entries = extractJsonPayload(readText(result)) || [];
        const ids = entries.map(m => m.id);
        // In Blind Send, we don't filter - all messages visible to agent
        assert.strictEqual(entries.length, 4, 'Expected all 4 messages to be returned');
        assert.ok(ids.includes('msg_new'), 'Expected latest execute request');
        assert.ok(ids.includes('msg_delegate'), 'Expected delegate_task message retained');
        assert.ok(ids.includes('msg_old'), 'Expected old execute request visible');
        assert.ok(ids.includes('msg_expired'), 'Expected expired execute request visible');
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error(`Fatal test error: ${err.message}`);
    process.exit(1);
});
