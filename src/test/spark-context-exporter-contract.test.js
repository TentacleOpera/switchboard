'use strict';
/**
 * Contract: the switchboard-spark context artifact is a curated, generated,
 * self-contained uploadable protocol. It must include the selected AGENTS.md
 * sections, the authoring/review skills, the jobs protocol, explicit exclusions,
 * the anti-confabulation rule, and a version/timestamp header. It must never
 * leak secrets or absolute host paths, and it must skip (not throw) when a
 * source is missing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(__dirname, '..', '..', 'out');
const { generateSparkContext } = require(path.join(OUT, 'services', 'SparkContextExporter.js'));

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

function mkTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-context-test-'));
    return dir;
}

const sampleAgentsMd = `<!-- switchboard:agents-protocol:start -->
# AGENTS.md - Switchboard Protocol

## 🚨 STRICT PROTOCOL ENFORCEMENT

This is omitted.

### Workflow Registry

| Trigger | Workflow |
|---|---|
| /switchboard | switchboard.md |

## 📝 Plan Authoring & Problem Analysis Protocol

When creating or improving any implementation plan:
- Split before drafting.

## 📂 Workspace Detection for Plan Creation

1. Active IDE workspace.
2. Task content keywords.
3. \`.switchboard/\` existence.

## 📌 Plan Project Pinning

The workspace/repo name is NOT a project. Never pin it.

## 📌 Memo Capture Mode — Priority Rule

The sole exit trigger is the exact command \`process memo\`.
<!-- switchboard:agents-protocol:end -->
`;

const sampleImprovePlan = `# Improve Plan

Use this workflow to strengthen an existing plan.
`;

const sampleImproveFeature = `# Improve Feature

Use this workflow for a feature container.
`;

const sampleMemo = `---
description: Memo capture
---

# Memo Capture Mode

Append-only.
`;

function writeGoodWorkspace(dir) {
    fs.mkdirSync(path.join(dir, '.switchboard'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.agents', 'protocols', 'improve-plan'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.agents', 'protocols', 'improve-feature'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.agents', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), sampleAgentsMd, 'utf8');
    fs.writeFileSync(path.join(dir, '.agents', 'protocols', 'improve-plan', 'SKILL.md'), sampleImprovePlan, 'utf8');
    fs.writeFileSync(path.join(dir, '.agents', 'protocols', 'improve-feature', 'SKILL.md'), sampleImproveFeature, 'utf8');
    fs.writeFileSync(path.join(dir, '.agents', 'workflows', 'switchboard-memo.md'), sampleMemo, 'utf8');
}

test('generation is skipped and creates nothing when .switchboard/ is absent', () => {
    const tmp = mkTmp();
    const res = generateSparkContext(tmp, '1.0.0');
    assert.strictEqual(res.bytes, 0);
    assert.strictEqual(fs.existsSync(path.join(tmp, '.switchboard')), false,
        'activation-time generation must not scaffold .switchboard/');
});

test('the artifact carries the version stamp and the timestamp header', () => {
    const tmp = mkTmp();
    writeGoodWorkspace(tmp);
    const res = generateSparkContext(tmp, '1.2.3');
    const content = fs.readFileSync(res.path, 'utf8');
    assert.ok(content.includes('**Extension Version:** 1.2.3'), 'version stamp missing');
    assert.ok(/\*\*Generated At:\*\* \d{4}-\d{2}-\d{2}T/.test(content), 'timestamp missing');
});

test('all expected sections are present', () => {
    const tmp = mkTmp();
    writeGoodWorkspace(tmp);
    const res = generateSparkContext(tmp, '1.0.0');
    const content = fs.readFileSync(res.path, 'utf8');
    const expected = [
        '## Core Switchboard Protocol',
        '## Skill: improve-plan',
        '## Skill: improve-feature',
        '## Skill: switchboard-memo',
        '## Write-Back Convention & Plan File Conventions',
        '## Scheduled Jobs & Instruction Inbox Protocol',
        '## Exclusions & Overrides',
        '### Anti-confabulation rule'
    ];
    for (const section of expected) {
        assert.ok(content.includes(section), `expected section missing: ${section}`);
    }
});

test('AGENTS.md is curated, not dumped verbatim', () => {
    const tmp = mkTmp();
    writeGoodWorkspace(tmp);
    const res = generateSparkContext(tmp, '1.0.0');
    const content = fs.readFileSync(res.path, 'utf8');
    assert.ok(content.includes('## Core Switchboard Protocol (curated from AGENTS.md)'),
        'curated header missing');
    assert.ok(content.includes('### Omitted AGENTS.md sections'),
        'omitted-sections list missing');
    assert.ok(!content.includes('## 🚨 STRICT PROTOCOL ENFORCEMENT'),
        'STRICT PROTOCOL ENFORCEMENT should not be in the curated artifact');
    assert.ok(content.includes('## 📝 Plan Authoring & Problem Analysis Protocol'),
        'wanted AGENTS.md section not emitted');
});

// The fixture above is hand-written and therefore models whatever heading level the
// author assumed. That is how this suite went green over a generator that emitted
// NO protocol at all: the fixture used `##` for the wanted sections while the real
// AGENTS.md uses `###`, so an H2-only parser matched the fake and missed the file.
// This test runs the generator against the REPO'S OWN AGENTS.md, which is the only
// input that cannot be shaped to fit the implementation.
test('every wanted section is extracted from the REAL repo AGENTS.md', () => {
    const realAgents = path.join(__dirname, '..', '..', 'AGENTS.md');
    assert.ok(fs.existsSync(realAgents), 'repo AGENTS.md not found — this test has no subject');

    const tmp = mkTmp();
    fs.mkdirSync(path.join(tmp, '.switchboard'), { recursive: true });
    fs.copyFileSync(realAgents, path.join(tmp, 'AGENTS.md'));

    const res = generateSparkContext(tmp, '1.0.0');
    const content = fs.readFileSync(res.path, 'utf8');

    const included = (content.match(/### Included AGENTS\.md sections\n\n([\s\S]*?)\n\n/) || [])[1] || '';
    assert.ok(included.trim().length > 0,
        'the Included list is EMPTY against the real AGENTS.md — the artifact carries no protocol, ' +
        'which is worse than the verbatim dump it replaced and is invisible to every other assertion here');

    for (const wanted of [
        'Plan Authoring & Problem Analysis Protocol',
        'Workspace Detection for Plan Creation',
        'Plan Project Pinning',
        'Memo Capture Mode'
    ]) {
        assert.ok(included.includes(wanted), `'${wanted}' was not selected from the real AGENTS.md`);
    }

    // Body, not just the manifest: the protocol text itself has to be present, since
    // the whole point is that the user stops hand-pasting AGENTS.md.
    assert.ok(/never pin it|Never pin it|omit the line/i.test(content),
        'the project-pinning RULES are absent from the body — only the section name was carried');
    assert.ok(res.bytes > 4000, `artifact is implausibly small (${res.bytes} bytes) for a curated protocol`);
});

test('a missing source is skipped and reported, not a thrown error', () => {
    const tmp = mkTmp();
    fs.mkdirSync(path.join(tmp, '.switchboard'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), sampleAgentsMd, 'utf8');
    // intentionally omit the improve-plan skill
    const res = generateSparkContext(tmp, '1.0.0');
    assert.ok(res.skippedSections.includes('improve-plan'),
        'missing skill should be reported in skippedSections');
    assert.ok(fs.existsSync(res.path), 'artifact should still be generated');
    assert.ok(res.bytes > 0, 'artifact should still have content');
});

test('the jobs protocol includes the §6 details', () => {
    const tmp = mkTmp();
    writeGoodWorkspace(tmp);
    const res = generateSparkContext(tmp, '1.0.0');
    const content = fs.readFileSync(res.path, 'utf8');
    assert.ok(content.includes('24 hours'), 'staleness window missing');
    assert.ok(content.includes('kanban-state-<column-slug>'), 'kanban state file format missing');
    assert.ok(content.includes('frozen'), 'frozen-between-sessions caveat missing');
    assert.ok(content.includes('run-log.md'), 'run log missing');
    assert.ok(content.includes('mtime-supplement cursor'), 'mtime-supplement rule missing');
    assert.ok(content.includes('kind: board-moves'), 'moves frontmatter missing');
    assert.ok(content.includes('Do not use `CODED` as a column id'), 'CODED caveat missing');
});

test('the output passes the secret-leak assertion (no tokens, no absolute paths)', () => {
    const tmp = mkTmp();
    writeGoodWorkspace(tmp);
    const res = generateSparkContext(tmp, '1.0.0');
    const content = fs.readFileSync(res.path, 'utf8');
    assert.ok(!content.includes(tmp),
        `absolute workspace path leaked: ${tmp}`);
    const tokenPatterns = [/\bsk-[a-zA-Z0-9]{20,}\b/, /\b(token|secret|api[_-]?key|password|bearer)\s*[:=]\s*['"]?[a-zA-Z0-9]{8,}/i];
    for (const pattern of tokenPatterns) {
        assert.ok(!pattern.test(content), `token-shaped string leaked: ${pattern}`);
    }
});

test('a different version stamp is reflected in the regenerated artifact', () => {
    const tmp = mkTmp();
    writeGoodWorkspace(tmp);
    const first = generateSparkContext(tmp, '1.0.0');
    const content1 = fs.readFileSync(first.path, 'utf8');
    assert.ok(content1.includes('**Extension Version:** 1.0.0'), 'first version missing');
    const before = fs.statSync(first.path).mtimeMs;

    const second = generateSparkContext(tmp, '1.1.0');
    const content2 = fs.readFileSync(second.path, 'utf8');
    assert.ok(content2.includes('**Extension Version:** 1.1.0'), 'regenerated version missing');
    const after = fs.statSync(second.path).mtimeMs;
    assert.ok(after > before, 'artifact was not rewritten with the new version');
    assert.strictEqual(second.bytes, fs.statSync(second.path).size, 'bytes match stats');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
