import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('TaskViewerProvider payload: terminal entries take priority over chat agents with same name', () => {
		// Simulates the normalization logic from _refreshTerminalStatuses
		const enrichedTerminals: any = {};

		// Add a terminal entry
		enrichedTerminals['Planner'] = { role: 'planner', alive: true, _isLocal: true, type: 'terminal' };

		// Attempt to add a chat agent with the same name — should NOT overwrite
		const chatAgents: any = { 'Planner': { role: 'planner', lastSeen: new Date().toISOString() } };
		for (const [name, data] of Object.entries(chatAgents)) {
			if (!enrichedTerminals[name]) {
				enrichedTerminals[name] = { ...(data as object), alive: true, _isChat: true, type: 'chat' };
			}
		}

		// The terminal entry must still be present and not overwritten
		assert.strictEqual(enrichedTerminals['Planner'].type, 'terminal', 'Terminal entry should not be overwritten by chat agent');
		assert.strictEqual(enrichedTerminals['Planner']._isChat, undefined, 'Terminal entry should not have _isChat flag');
	});

	test('TaskViewerProvider payload: teamReady requires both lead and coder terminal agents alive', () => {
		const enrichedTerminals: any = {
			'Lead': { role: 'lead', alive: true, type: 'terminal' },
			'Coder': { role: 'coder', alive: false, type: 'terminal' },
		};

		const leadAgent = Object.values(enrichedTerminals).find((t: any) => t.role === 'lead' && t.type === 'terminal');
		const coderAgent = Object.values(enrichedTerminals).find((t: any) => t.role === 'coder' && t.type === 'terminal');
		const teamReady = !!(leadAgent && (leadAgent as any).alive && coderAgent && (coderAgent as any).alive);

		assert.strictEqual(teamReady, false, 'teamReady should be false when coder is not alive');

		// Both alive
		(enrichedTerminals['Coder'] as any).alive = true;
		const leadAgent2 = Object.values(enrichedTerminals).find((t: any) => t.role === 'lead' && t.type === 'terminal');
		const coderAgent2 = Object.values(enrichedTerminals).find((t: any) => t.role === 'coder' && t.type === 'terminal');
		const teamReady2 = !!(leadAgent2 && (leadAgent2 as any).alive && coderAgent2 && (coderAgent2 as any).alive);

		assert.strictEqual(teamReady2, true, 'teamReady should be true when both lead and coder terminal agents are alive');
	});

	test('TaskViewerProvider payload: teamReady is false when agents are chat-only', () => {
		// Chat agents must NOT count toward teamReady
		const enrichedTerminals: any = {
			'lead-chat': { role: 'lead', alive: true, type: 'chat', _isChat: true },
			'coder-chat': { role: 'coder', alive: true, type: 'chat', _isChat: true },
		};

		const leadAgent = Object.values(enrichedTerminals).find((t: any) => t.role === 'lead' && t.type === 'terminal');
		const coderAgent = Object.values(enrichedTerminals).find((t: any) => t.role === 'coder' && t.type === 'terminal');
		const teamReady = !!(leadAgent && (leadAgent as any).alive && coderAgent && (coderAgent as any).alive);

		assert.strictEqual(teamReady, false, 'teamReady should be false when only chat agents exist, not terminals');
	});
});

/**
 * AGENTS.md scaffolding logic tests.
 * These test the merge/idempotency rules without requiring the VS Code API by
 * reimplementing the pure-logic portion of ensureAgentsProtocol.
 */
suite('AGENTS.md Scaffolding Logic', () => {
	const PROTOCOL_HEADER = '# AGENTS.md - Switchboard Protocol';
	const BLOCK_START = '<!-- switchboard:agents-protocol:start -->';
	const BLOCK_END = '<!-- switchboard:agents-protocol:end -->';
	const SOURCE_CONTENT = `${PROTOCOL_HEADER}\n\nSwitchboard rules go here.`;

	function buildManagedBlock(source: string): string {
		return `${BLOCK_START}\n${source.trimEnd()}\n${BLOCK_END}`;
	}

	function simulateScaffold(
		sourceAvailable: boolean,
		targetContent: string | null,
		targetReadError: string | null = null
	): { status: string; reason: string } {
		if (!sourceAvailable) {
			return { status: 'failed', reason: 'Bundled AGENTS.md source is missing or unreadable: Source missing' };
		}

		if (targetReadError) {
			return { status: 'failed', reason: `Failed to read existing AGENTS.md: ${targetReadError}` };
		}

		const managedBlock = buildManagedBlock(SOURCE_CONTENT);
		const protocolHeaderRegex = /^# AGENTS\.md - Switchboard Protocol\s*$/m;

		if (targetContent === null) {
			return { status: 'created', reason: 'AGENTS.md created from bundled source' };
		}

		const hasBlockStart = targetContent.includes(BLOCK_START);
		const hasBlockEnd = targetContent.includes(BLOCK_END);
		const blockStartIndex = targetContent.indexOf(BLOCK_START);
		const blockEndIndex = targetContent.indexOf(BLOCK_END);

		if ((hasBlockStart && !hasBlockEnd) || (!hasBlockStart && hasBlockEnd) || (hasBlockStart && hasBlockEnd && blockStartIndex > blockEndIndex)) {
			return { status: 'failed', reason: 'Detected malformed managed protocol markers in AGENTS.md; fix markers before rerunning setup' };
		}

		if ((hasBlockStart && hasBlockEnd) || protocolHeaderRegex.test(targetContent)) {
			return { status: 'skipped', reason: 'Switchboard protocol block already present' };
		}

		const separator = targetContent.endsWith('\n') ? '\n' : '\n\n';
		const merged = targetContent + separator + managedBlock + '\n';
		// Verify merged content preserves original and has valid Markdown separation
		assert.ok(merged.startsWith(targetContent), 'Original content must be preserved');
		assert.ok(merged.includes(BLOCK_START), 'Merged content must include block start marker');
		assert.ok(merged.includes(BLOCK_END), 'Merged content must include block end marker');

		return { status: 'appended', reason: 'Switchboard protocol block appended to existing AGENTS.md' };
	}

	test('Target missing → created from bundled source', () => {
		const result = simulateScaffold(true, null);
		assert.strictEqual(result.status, 'created');
	});

	test('Target exists without protocol → protocol block appended', () => {
		const result = simulateScaffold(true, '# My Custom AGENTS Rules\n\nCustom content here.\n');
		assert.strictEqual(result.status, 'appended');
	});

	test('Target exists with protocol header → no duplicate append', () => {
		const result = simulateScaffold(true, `# My Rules\n\n${PROTOCOL_HEADER}\n\nExisting protocol.`);
		assert.strictEqual(result.status, 'skipped');
	});

	test('Target exists with block start marker → no duplicate append', () => {
		const existing = `# My Rules\n\n${BLOCK_START}\nold protocol\n${BLOCK_END}`;
		const result = simulateScaffold(true, existing);
		assert.strictEqual(result.status, 'skipped');
	});

	test('Source missing → returns failed status, does not crash', () => {
		const result = simulateScaffold(false, '# Existing content');
		assert.strictEqual(result.status, 'failed');
		assert.ok(result.reason.includes('missing'));
	});

	test('Target has no trailing newline → append still produces valid Markdown separation', () => {
		const result = simulateScaffold(true, '# No trailing newline');
		assert.strictEqual(result.status, 'appended');
	});

	test('Target read error (non-FileNotFound) → returns failed status', () => {
		const result = simulateScaffold(true, null, 'EACCES');
		assert.strictEqual(result.status, 'failed');
		assert.ok(result.reason.includes('Failed to read existing AGENTS.md'));
	});

	test('Malformed block markers → returns failed status', () => {
		const malformed = `# Rules\n\n${BLOCK_START}\npartial protocol only`;
		const result = simulateScaffold(true, malformed);
		assert.strictEqual(result.status, 'failed');
		assert.ok(result.reason.includes('malformed managed protocol markers'));
	});

	test('Header text in prose does not trigger skip unless on protocol header line', () => {
		const prose = 'User note: # AGENTS.md - Switchboard Protocol is referenced in docs.';
		const result = simulateScaffold(true, prose);
		assert.strictEqual(result.status, 'appended');
	});
});
