'use strict';

/**
 * Contract: Read-State Channels section in SparkContextExporter output.
 *
 * Invariants (from the plan's Verification Plan):
 *  1. No secrets: the generated text contains no credential, token, or API key.
 *  2. Check-shape: every entry contains a verification clause and a fallback clause.
 *  3. No repo writes: the only file written is .switchboard/switchboard-spark.md.
 *  4. Empty means empty: with no user channels, the section offers a useful message, not an empty template.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js --require ./src/test/bootstrap/vscodeStub.js src/test/spark-context-read-state-channels.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

const {
    generateSparkContext,
    ReadStateChannel,
} = require('../../out/services/SparkContextExporter');

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

function makeTempWorkspace() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-test-'));
    const sbDir = path.join(tmp, '.switchboard');
    fs.mkdirSync(sbDir, { recursive: true });
    return { tmp, sbDir };
}

function run() {
    console.log('\nspark-context-read-state-channels\n');

    // ── 1. No secrets in output ──────────────────────────────────────────

    check('no credentials, tokens, or API keys in the generated text', () => {
        const { tmp, sbDir } = makeTempWorkspace();
        // Write a channels file with a channel name that looks like it could leak a token
        fs.writeFileSync(
            path.join(sbDir, 'read-state-channels.json'),
            JSON.stringify([
                {
                    channel: 'Linear MCP for project Acme',
                    verify: 'list issues for the Acme project',
                    fallback: 'read plan files in .switchboard/plans/intake/',
                },
            ])
        );
        // Plant a fake token in the workspace to ensure it does not appear in output
        fs.writeFileSync(path.join(sbDir, 'api-token'), 'sk-secret-token-12345');

        const result = generateSparkContext(tmp, '0.0.0-test');
        const content = fs.readFileSync(result.path, 'utf8');

        assert.ok(!content.includes('sk-secret-token-12345'), 'output must not contain planted token');
        assert.ok(!content.includes('api-token'), 'output must not name the token file');
        assert.ok(content.includes('Read-State Channels'), 'output must contain the Read-State Channels section');

        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // ── 2. Check-shape: every entry has verify + fallback ────────────────

    check('every user-supplied entry contains a verification clause and a fallback clause', () => {
        const { tmp, sbDir } = makeTempWorkspace();
        fs.writeFileSync(
            path.join(sbDir, 'read-state-channels.json'),
            JSON.stringify([
                {
                    channel: 'Git plans repo',
                    verify: 'clone the repo and list .switchboard/plans/',
                    fallback: 'ask the user for the current plan list',
                },
                {
                    channel: 'Notion board mirror',
                    verify: 'query the Notion database for the board view',
                    fallback: 'read .switchboard/kanban-state-*.md files',
                },
            ])
        );

        const result = generateSparkContext(tmp, '0.0.0-test');
        const content = fs.readFileSync(result.path, 'utf8');

        // Extract the Read-State Channels section
        const sectionStart = content.indexOf('## Read-State Channels');
        assert.ok(sectionStart >= 0, 'Read-State Channels section must exist');
        const sectionEnd = content.indexOf('\n## ', sectionStart + 10);
        const section = sectionEnd > 0 ? content.slice(sectionStart, sectionEnd) : content.slice(sectionStart);

        // Each entry should have "Verify:" and "If unavailable:"
        const entries = section.split('\n').filter(l => l.startsWith('- **'));
        assert.ok(entries.length === 2, `expected 2 user entries, got ${entries.length}`);
        for (const entry of entries) {
            assert.ok(entry.includes('Verify:'), `entry must contain a verification clause: ${entry}`);
            assert.ok(entry.includes('If unavailable:'), `entry must contain a fallback clause: ${entry}`);
            // No bare assertions — must not say "is available" or "is reachable" without a verify clause
            assert.ok(!/is (available|reachable)/.test(entry.replace('Verify:', '')), `entry must not assert availability: ${entry}`);
        }

        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // ── 3. No repo writes ────────────────────────────────────────────────

    check('no files written to .agents/, .claude/, or committed paths', () => {
        const { tmp, sbDir } = makeTempWorkspace();
        fs.writeFileSync(
            path.join(sbDir, 'read-state-channels.json'),
            JSON.stringify([
                { channel: 'Test channel', verify: 'check it', fallback: 'skip it' },
            ])
        );

        const result = generateSparkContext(tmp, '0.0.0-test');

        // The only file written should be .switchboard/switchboard-spark.md
        assert.ok(result.path.endsWith(path.join('.switchboard', 'switchboard-spark.md')), 'output path must be .switchboard/switchboard-spark.md');
        assert.ok(fs.existsSync(result.path), 'output file must exist');

        // No .agents/ or .claude/ directories should be created
        assert.ok(!fs.existsSync(path.join(tmp, '.agents')), 'must not create .agents/');
        assert.ok(!fs.existsSync(path.join(tmp, '.claude')), 'must not create .claude/');

        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // ── 4. Empty means empty — useful message, not empty template ─────────

    check('zero configured channels produces a useful message, not an empty template', () => {
        const { tmp, sbDir } = makeTempWorkspace();
        // No read-state-channels.json — zero channels

        const result = generateSparkContext(tmp, '0.0.0-test');
        const content = fs.readFileSync(result.path, 'utf8');

        const sectionStart = content.indexOf('## Read-State Channels');
        assert.ok(sectionStart >= 0, 'Read-State Channels section must exist even with zero channels');
        const sectionEnd = content.indexOf('\n## ', sectionStart + 10);
        const section = sectionEnd > 0 ? content.slice(sectionStart, sectionEnd) : content.slice(sectionStart);

        // Must contain a useful message about the plan file being the only channel
        assert.ok(section.includes('plan file'), 'zero-channel section must mention the plan file as the only channel');
        assert.ok(!section.includes('- **'), 'zero-channel section must not render empty list entries');

        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // ── 5. Section is part of the exporter output, not a new surface ────

    check('read-state-channels is in the sections list', () => {
        const { tmp } = makeTempWorkspace();
        const result = generateSparkContext(tmp, '0.0.0-test');
        assert.ok(result.sections.includes('read-state-channels'), 'sections list must include read-state-channels');
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // ── 6. Malformed channels file is handled gracefully ────────────────

    check('malformed read-state-channels.json is treated as zero channels', () => {
        const { tmp, sbDir } = makeTempWorkspace();
        fs.writeFileSync(path.join(sbDir, 'read-state-channels.json'), '{ not valid json');
        const result = generateSparkContext(tmp, '0.0.0-test');
        const content = fs.readFileSync(result.path, 'utf8');
        const sectionStart = content.indexOf('## Read-State Channels');
        assert.ok(sectionStart >= 0, 'section must exist even with malformed channels file');
        const sectionEnd = content.indexOf('\n## ', sectionStart + 10);
        const section = sectionEnd > 0 ? content.slice(sectionStart, sectionEnd) : content.slice(sectionStart);
        assert.ok(section.includes('plan file'), 'malformed channels file must produce zero-channel message');
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
