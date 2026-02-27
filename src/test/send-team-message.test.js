/**
 * Unit tests for send_team_message fan-out and persona injection
 * Run with: node src/test/send-team-message.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Create isolated temp directory for each test run
const TEST_ROOT = path.join(os.tmpdir(), `switchboard-team-msg-test-${Date.now()}`);
const STATE_DIR = path.join(TEST_ROOT, '.switchboard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const INBOX_ROOT = path.join(TEST_ROOT, '.switchboard', 'inbox');
const PERSONAS_DIR = path.join(TEST_ROOT, '.agent', 'personas', 'roles');

// Override env before requiring the module
process.env.SWITCHBOARD_WORKSPACE_ROOT = TEST_ROOT;
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(PERSONAS_DIR, { recursive: true });

// Create test persona files
fs.writeFileSync(path.join(PERSONAS_DIR, 'coder.md'), 'You are a Coder. Write clean code.');
fs.writeFileSync(path.join(PERSONAS_DIR, 'reviewer.md'), 'You are a Reviewer. Critique thoroughly.');
fs.writeFileSync(path.join(PERSONAS_DIR, 'planner.md'), 'You are a Planner. Harden plans before execution.');
fs.writeFileSync(path.join(PERSONAS_DIR, 'task_runner.md'), 'You are a Task Runner. Run commands precisely.');

// Clear module cache to force re-initialization with test root
delete require.cache[require.resolve('../mcp-server/state-manager')];
const { loadState, updateState } = require('../mcp-server/state-manager');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        // Clean state before each test
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        const lockFile = `${STATE_FILE}.lock`;
        if (fs.existsSync(lockFile)) {
            try { fs.unlinkSync(lockFile); } catch { }
        }
        // Clean inbox
        if (fs.existsSync(INBOX_ROOT)) {
            fs.rmSync(INBOX_ROOT, { recursive: true, force: true });
        }

        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

// Helper: set up state with a team and members
async function setupTeamState({ teamId, teamName, isComposite, members }) {
    await updateState(current => {
        current.teams = current.teams || {};
        current.teams[teamId] = {
            name: teamName,
            members: members.map(m => m.name),
            isComposite: isComposite || false,
            capabilities: [],
            createdAt: new Date().toISOString()
        };
        current.terminals = current.terminals || {};
        for (const m of members) {
            current.terminals[m.name] = {
                purpose: 'testing',
                pid: m.pid || 99999,
                status: 'active',
                role: m.role || 'none',
                team: teamId
            };
        }
        return current;
    });
}

// Helper: read all inbox messages for a given agent
function readInboxMessages(agentName) {
    const inboxDir = path.join(INBOX_ROOT, agentName);
    if (!fs.existsSync(inboxDir)) return [];
    return fs.readdirSync(inboxDir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')));
}

// --- Inline simulation of send_team_message logic ---
// We test the core logic directly since the MCP server tool registration
// requires the full server context. This mirrors the exact logic in mcp-server.js.

function resolvePersonaForRecipient(state, recipient) {
    const ROLE_TO_PERSONA_FILE = {
        'lead': 'lead.md',
        'coder': 'coder.md',
        'coder 1': 'coder.md', // Backwards compatibility
        'coder 2': 'coder.md', // Backwards compatibility
        'reviewer': 'reviewer.md',
        'planner': 'planner.md',
        'tester': 'tester.md',
        'researcher': 'researcher.md',
        'researcher': 'researcher.md',
        'task runner': 'task_runner.md'
    };

    const role = state.terminals?.[recipient]?.role || state.chatAgents?.[recipient]?.role;
    if (!role || role === 'none') return null;

    const personaFile = ROLE_TO_PERSONA_FILE[role];
    if (!personaFile) return null;

    const personaPath = path.join(PERSONAS_DIR, personaFile);
    try {
        if (!fs.existsSync(personaPath)) return null;
        return fs.readFileSync(personaPath, 'utf8').trim();
    } catch {
        return null;
    }
}

function formatPersonaMessage(persona, originalMessage) {
    return `---PERSONA---\n${persona}\n---END PERSONA---\n\n${originalMessage}`;
}

async function simulateSendTeamMessage({ team, action, payload, sender, role_filter }) {
    const state = await loadState();
    if (!state.teams || !state.teams[team]) {
        return { isError: true, text: `Team '${team}' not found.` };
    }
    const teamData = state.teams[team];
    const allMembers = teamData.members || [];
    if (allMembers.length === 0) {
        return { isError: true, text: `Team has no members.` };
    }

    const members = role_filter
        ? allMembers.filter(m => {
            const memberRole = state.terminals?.[m]?.role || state.chatAgents?.[m]?.role || 'none';
            return memberRole === role_filter;
        })
        : allMembers;

    if (members.length === 0) {
        return { isError: true, text: `No members match role '${role_filter}'.` };
    }

    const senderName = sender || 'standby-agent';
    const results = [];

    for (const member of members) {
        const persona = resolvePersonaForRecipient(state, member);
        const enrichedPayload = persona ? formatPersonaMessage(persona, payload) : payload;

        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const message = {
            id: messageId,
            action,
            sender: senderName,
            recipient: member,
            team,
            payload: enrichedPayload,
            createdAt: new Date().toISOString()
        };
        if (persona) message.persona = persona;

        const targetDir = path.join(INBOX_ROOT, member);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, `${messageId}.json`), JSON.stringify(message, null, 2));
        results.push({ member, messageId, hasPersona: !!persona });
    }

    return { isError: false, results, totalMembers: allMembers.length, sentTo: members.length };
}

async function run() {
    console.log('\n🧪 send_team_message Fan-Out & Persona Injection Tests\n');

    await test('fan-out delivers to all team members', async () => {
        await setupTeamState({
            teamId: 'team-alpha',
            teamName: 'Alpha Team',
            members: [
                { name: 'agent-1', role: 'coder', pid: 1001 },
                { name: 'agent-2', role: 'reviewer', pid: 1002 },
                { name: 'agent-3', role: 'task runner', pid: 1003 }
            ]
        });

        const result = await simulateSendTeamMessage({
            team: 'team-alpha',
            action: 'delegate_task',
            payload: 'Implement feature X'
        });

        assert.strictEqual(result.isError, false);
        assert.strictEqual(result.results.length, 3, 'Should send to all 3 members');

        // Verify inbox files exist for each member
        for (const r of result.results) {
            const msgs = readInboxMessages(r.member);
            assert.strictEqual(msgs.length, 1, `${r.member} should have 1 inbox message`);
        }
    });

    await test('persona injection applies correct persona per role', async () => {
        await setupTeamState({
            teamId: 'team-beta',
            teamName: 'Beta Team',
            members: [
                { name: 'coder-agent', role: 'coder 1', pid: 2001 },
                { name: 'reviewer-agent', role: 'reviewer', pid: 2002 }
            ]
        });

        const result = await simulateSendTeamMessage({
            team: 'team-beta',
            action: 'delegate_task',
            payload: 'Implement feature Y'
        });

        assert.strictEqual(result.isError, false);
        assert.strictEqual(result.results.length, 2);

        // Both should have persona injection
        assert.ok(result.results[0].hasPersona, 'Coder should have persona');
        assert.ok(result.results[1].hasPersona, 'Reviewer should have persona');

        // Verify coder gets coder persona
        const coderMsgs = readInboxMessages('coder-agent');
        assert.ok(coderMsgs[0].payload.includes('You are a Coder'), 'Coder should get Coder persona');
        assert.ok(coderMsgs[0].payload.includes('Implement feature Y'), 'Original payload preserved');

        // Verify reviewer gets reviewer persona
        const reviewerMsgs = readInboxMessages('reviewer-agent');
        assert.ok(reviewerMsgs[0].payload.includes('You are a Reviewer'), 'Reviewer should get Reviewer persona');
        assert.ok(reviewerMsgs[0].payload.includes('Implement feature Y'), 'Original payload preserved');
    });

    await test('planner and task runner personas both resolve without regression', async () => {
        await setupTeamState({
            teamId: 'team-planning',
            teamName: 'Planning Team',
            members: [
                { name: 'planner-agent', role: 'planner', pid: 2101 },
                { name: 'task-agent', role: 'task runner', pid: 2102 }
            ]
        });

        const result = await simulateSendTeamMessage({
            team: 'team-planning',
            action: 'delegate_task',
            payload: 'Prepare and execute feature plan'
        });

        assert.strictEqual(result.isError, false);
        assert.strictEqual(result.results.length, 2);

        const plannerMsgs = readInboxMessages('planner-agent');
        assert.ok(plannerMsgs[0].payload.includes('You are a Planner'), 'Planner should get Planner persona');

        const taskMsgs = readInboxMessages('task-agent');
        assert.ok(taskMsgs[0].payload.includes('You are a Task Runner'), 'Task Runner should still get Task Runner persona');
    });

    await test('agent with no role gets no persona injection', async () => {
        await setupTeamState({
            teamId: 'team-gamma',
            teamName: 'Gamma Team',
            members: [
                { name: 'plain-agent', role: 'none', pid: 3001 }
            ]
        });

        const result = await simulateSendTeamMessage({
            team: 'team-gamma',
            action: 'delegate_task',
            payload: 'Do something'
        });

        assert.strictEqual(result.isError, false);
        assert.strictEqual(result.results[0].hasPersona, false, 'No-role agent should not get persona');

        const msgs = readInboxMessages('plain-agent');
        assert.strictEqual(msgs[0].payload, 'Do something', 'Payload should be raw, no persona wrapper');
    });

    await test('role_filter sends only to matching members', async () => {
        await setupTeamState({
            teamId: 'team-delta',
            teamName: 'Delta Team',
            members: [
                { name: 'coder-1', role: 'coder', pid: 4001 },
                { name: 'review-1', role: 'reviewer', pid: 4002 },
                { name: 'task-1', role: 'task runner', pid: 4003 }
            ]
        });

        const result = await simulateSendTeamMessage({
            team: 'team-delta',
            action: 'execute',
            payload: 'Code this',
            role_filter: 'coder'
        });

        assert.strictEqual(result.isError, false);
        assert.strictEqual(result.sentTo, 1, 'Should send to 1 coder');
    });

    await test('role_filter with no matches returns error', async () => {
        await setupTeamState({
            teamId: 'team-epsilon',
            teamName: 'Epsilon Team',
            members: [
                { name: 'coder-only', role: 'coder', pid: 5001 }
            ]
        });

        const result = await simulateSendTeamMessage({
            team: 'team-epsilon',
            action: 'delegate_task',
            payload: 'Review this',
            role_filter: 'reviewer'
        });

        assert.strictEqual(result.isError, true, 'Should error when no members match filter');
    });

    await test('composite team single-member constraint (state-level check)', async () => {
        await setupTeamState({
            teamId: 'team-composite',
            teamName: 'Composite Agent',
            isComposite: true,
            members: [
                { name: 'claude-code', role: 'task runner', pid: 6001 }
            ]
        });

        const state = await loadState();
        const teamData = state.teams['team-composite'];

        // Verify composite flag
        assert.strictEqual(teamData.isComposite, true);
        assert.strictEqual(teamData.members.length, 1);

        // Simulate the guard from assign_to_team
        const newAgent = 'another-agent';
        const isBlocked = teamData.isComposite &&
            teamData.members.length >= 1 &&
            !teamData.members.includes(newAgent);
        assert.ok(isBlocked, 'Should block adding a second member to composite team');
    });

    // Cleanup
    try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch { }

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
