/**
 * Unit tests for InboxWatcher message protocol
 * Tests the file-based messaging layer independently of VS Code.
 * Run with: node src/test/inbox-watcher.test.js
 *
 * Since InboxWatcher.ts is compiled to JS and depends on vscode,
 * we test the protocol contract directly: file creation, schema, routing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_ROOT = path.join(os.tmpdir(), `inbox-test-${Date.now()}`);
const INBOX_ROOT = path.join(TEST_ROOT, '.switchboard', 'inbox');
const OUTBOX_ROOT = path.join(TEST_ROOT, '.switchboard', 'outbox');

let passed = 0;
let failed = 0;

function setup() {
    fs.mkdirSync(INBOX_ROOT, { recursive: true });
    fs.mkdirSync(OUTBOX_ROOT, { recursive: true });
}

function cleanup() {
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { }
}

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

// --- Helpers that mirror what MCP tools and InboxWatcher do ---

function createMessage(recipient, action, payload, sender = 'test-agent', replyTo = undefined) {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    return {
        id,
        action,
        sender,
        recipient,
        payload,
        replyTo,
        createdAt: new Date().toISOString()
    };
}

function writeMessageToInbox(message) {
    const dir = path.join(INBOX_ROOT, message.recipient);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${message.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(message, null, 2));
    return filePath;
}

function deliverToOutbox(message) {
    const dir = path.join(OUTBOX_ROOT, message.recipient);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${message.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(message, null, 2));
    return filePath;
}

function readOutbox(agent) {
    const dir = path.join(OUTBOX_ROOT, agent);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && !f.endsWith('.receipt.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function readInbox(agent) {
    const dir = path.join(INBOX_ROOT, agent);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && !f.endsWith('.result.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// --- Tests ---

async function run() {
    console.log('\n🧪 Inbox Protocol Tests\n');
    setup();

    await test('Message schema: all required fields present', async () => {
        const msg = createMessage('coding', 'delegate_task', 'Implement feature X');
        assert.ok(msg.id, 'id is required');
        assert.ok(msg.action, 'action is required');
        assert.ok(msg.sender, 'sender is required');
        assert.ok(msg.recipient, 'recipient is required');
        assert.ok(msg.payload, 'payload is required');
        assert.ok(msg.createdAt, 'createdAt is required');
    });

    await test('Message schema: all action types are valid', async () => {
        const validActions = ['execute', 'delegate_task'];
        for (const action of validActions) {
            const msg = createMessage('agent', action, 'test');
            assert.strictEqual(msg.action, action);
        }
    });

    await test('Inbox write: message file is created in correct directory', async () => {
        const msg = createMessage('coding', 'delegate_task', 'Build the thing');
        const filePath = writeMessageToInbox(msg);
        assert.ok(fs.existsSync(filePath), 'Message file should exist');
        assert.ok(filePath.includes(path.join('inbox', 'coding')), 'Should be in coding inbox');
    });

    await test('Inbox write: message is valid JSON on disk', async () => {
        const msg = createMessage('review', 'execute', 'Check this PR');
        const filePath = writeMessageToInbox(msg);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.strictEqual(content.id, msg.id);
        assert.strictEqual(content.action, 'execute');
        assert.strictEqual(content.payload, 'Check this PR');
    });

    await test('Outbox delivery: file-based action routes to outbox', async () => {
        const msg = createMessage('gemini-cli', 'delegate_task', 'Implement auth module', 'windsurf');
        deliverToOutbox(msg);
        const messages = readOutbox('gemini-cli');
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].sender, 'windsurf');
        assert.strictEqual(messages[0].action, 'delegate_task');
    });

    await test('Outbox: multiple messages accumulate', async () => {
        const agent = 'multi-test';
        deliverToOutbox(createMessage(agent, 'delegate_task', 'Task 1', 'sender1'));
        deliverToOutbox(createMessage(agent, 'execute', 'Review 1', 'sender2'));
        deliverToOutbox(createMessage(agent, 'delegate_task', 'Task 3', 'sender1'));
        const messages = readOutbox(agent);
        assert.strictEqual(messages.length, 3);
    });

    await test('Inbox read: can filter by action type', async () => {
        const agent = 'filter-test';
        writeMessageToInbox(createMessage(agent, 'delegate_task', 'Task'));
        writeMessageToInbox(createMessage(agent, 'execute', 'Review'));
        writeMessageToInbox(createMessage(agent, 'delegate_task', 'Task 2'));

        const all = readInbox(agent);
        assert.strictEqual(all.length, 3);

        const delegations = all.filter(m => m.action === 'delegate_task');
        assert.strictEqual(delegations.length, 2);

        const reviews = all.filter(m => m.action === 'execute');
        assert.strictEqual(reviews.length, 1);
    });

    await test('Cross-agent: sender writes to recipient inbox, recipient reads from outbox', async () => {
        // Simulate: Windsurf sends a task to Gemini
        const task = createMessage('gemini', 'delegate_task', 'Refactor auth module', 'windsurf');
        writeMessageToInbox(task);

        // Simulate: InboxWatcher picks it up and delivers to outbox
        const inboxMessages = readInbox('gemini');
        assert.strictEqual(inboxMessages.length, 1);

        // Deliver to outbox (what InboxWatcher.handleFileBasedAction does)
        deliverToOutbox(inboxMessages[0]);

        // Gemini reads its outbox
        const outboxMessages = readOutbox('gemini');
        assert.strictEqual(outboxMessages.length, 1);
        assert.strictEqual(outboxMessages[0].sender, 'windsurf');
        assert.strictEqual(outboxMessages[0].action, 'delegate_task');
    });

    await test('Agent isolation: messages do not leak between agents', async () => {
        writeMessageToInbox(createMessage('agent-a', 'delegate_task', 'For A only', 'sender'));
        writeMessageToInbox(createMessage('agent-b', 'delegate_task', 'For B only', 'sender'));

        const aMessages = readInbox('agent-a');
        const bMessages = readInbox('agent-b');

        assert.strictEqual(aMessages.length, 1);
        assert.strictEqual(bMessages.length, 1);
        assert.strictEqual(aMessages[0].payload, 'For A only');
        assert.strictEqual(bMessages[0].payload, 'For B only');
    });

    cleanup();

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
