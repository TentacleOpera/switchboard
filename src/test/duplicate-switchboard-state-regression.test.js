'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    inspectKanbanState,
    extractKanbanState,
    applyKanbanStateToPlanContent
} = require(path.join(process.cwd(), 'out', 'services', 'planStateUtils.js'));
const { importPlanFiles } = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function run() {
    const duplicateTopLevelContent = [
        '# Duplicate Top-Level State Fixture',
        '',
        '## Goal',
        'Ensure duplicate top-level state sections resolve correctly.',
        '',
        '**Plan ID:** duplicate-state-top-level',
        '**Session ID:** duplicate-state-top-level',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** BACKLOG',
        '**Status:** active',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** PLAN REVIEWED',
        '**Status:** active',
        ''
    ].join('\n');

    const malformedTailContent = [
        '# Malformed Trailing State Fixture',
        '',
        '## Goal',
        'Ensure malformed trailing state does not erase an earlier valid state.',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** BACKLOG',
        '**Status:** active',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** NOT_A_REAL_COLUMN',
        '**Status:** active',
        ''
    ].join('\n');

    const preservedDraftContent = [
        '# Preserved Draft Fixture',
        '',
        '## Goal',
        'Ensure preserved draft content survives state rewrites.',
        '',
        '## Preserved Original Draft',
        '```markdown',
        '## Switchboard State',
        '',
        '**Kanban Column:** BACKLOG',
        '**Status:** active',
        '```',
        '',
        '## Notes',
        'This content must survive state rewrites.',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** CREATED',
        '**Status:** active',
        ''
    ].join('\n');

    const duplicateWithTrailingContent = [
        '# Duplicate State With Tail Fixture',
        '',
        '## Goal',
        'Ensure save-side normalization removes all live state sections even when later headings follow them.',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** BACKLOG',
        '**Status:** active',
        '',
        '## Notes',
        'Keep these notes intact.',
        '',
        '## Switchboard State',
        '',
        '**Kanban Column:** PLAN REVIEWED',
        '**Status:** active',
        '',
        '## Tail',
        'This content must stay above the rewritten footer.',
        ''
    ].join('\n');

    // File-based state inspection is DISABLED — inspectKanbanState always returns null state.
    const duplicateInspection = inspectKanbanState(duplicateTopLevelContent);
    assert.strictEqual(
        duplicateInspection.state,
        null,
        'Expected inspectKanbanState to return null state (file-based state disabled).'
    );
    assert.strictEqual(
        duplicateInspection.topLevelSectionCount,
        0,
        'Expected topLevelSectionCount to be 0 (file-based state disabled).'
    );

    const malformedTrailingState = extractKanbanState(malformedTailContent);
    assert.strictEqual(
        malformedTrailingState,
        null,
        'Expected extractKanbanState to return null (file-based state disabled).'
    );

    const preservedInspection = inspectKanbanState(preservedDraftContent);
    assert.strictEqual(
        preservedInspection.state,
        null,
        'Expected inspectKanbanState to return null state for preserved-draft content (file-based state disabled).'
    );
    const rewrittenPreservedDraft = applyKanbanStateToPlanContent(preservedDraftContent, {
        kanbanColumn: 'PLAN REVIEWED',
        status: 'active',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        formatVersion: 1
    });
    assert.ok(
        rewrittenPreservedDraft.includes('```markdown\n## Switchboard State\n\n**Kanban Column:** BACKLOG\n**Status:** active\n```'),
        'Expected preserved original draft state examples inside fenced code to remain intact after rewriting the live footer.'
    );
    assert.ok(
        rewrittenPreservedDraft.trimEnd().endsWith([
            '## Switchboard State',
            '**Kanban Column:** PLAN REVIEWED',
            '**Status:** active',
            '**Last Updated:** 2026-01-01T00:00:00.000Z',
            '**Format Version:** 1'
        ].join('\n')),
        'Expected rewritten content to end with exactly one authoritative live Switchboard State footer.'
    );

    const rewrittenDuplicateWithTail = applyKanbanStateToPlanContent(duplicateWithTrailingContent, {
        kanbanColumn: 'COMPLETED',
        status: 'completed',
        lastUpdated: '2026-01-02T00:00:00.000Z',
        formatVersion: 1
    });
    assert.strictEqual(
        (rewrittenDuplicateWithTail.match(/^## Switchboard State$/gm) || []).length,
        1,
        'Expected save-side normalization to remove every prior live Switchboard State section before appending the new footer.'
    );
    assert.ok(
        rewrittenDuplicateWithTail.includes('## Tail\nThis content must stay above the rewritten footer.'),
        'Expected non-state content after duplicate live sections to survive normalization.'
    );
    assert.doesNotMatch(
        rewrittenDuplicateWithTail,
        /\*\*Kanban Column:\*\*\s+BACKLOG/,
        'Expected stale earlier live state sections to be removed during normalization.'
    );
    assert.ok(
        rewrittenDuplicateWithTail.trimEnd().endsWith([
            '## Switchboard State',
            '**Kanban Column:** COMPLETED',
            '**Status:** completed',
            '**Last Updated:** 2026-01-02T00:00:00.000Z',
            '**Format Version:** 1'
        ].join('\n')),
        'Expected normalized content with trailing non-state headings to still end with exactly one authoritative footer.'
    );

    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-duplicate-state-'));
    try {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        await fs.promises.mkdir(plansDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(plansDir, 'duplicate-top-level.md'),
            duplicateTopLevelContent,
            'utf8'
        );

        const imported = await importPlanFiles(workspaceRoot);
        assert.strictEqual(imported.count, 1, 'Expected importPlanFiles to ingest the duplicate-state fixture.');

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'Expected KanbanDatabase to initialize for duplicate-state regression test.');

        const importedPlan = await db.getPlanBySessionId('duplicate-state-top-level');
        assert.ok(importedPlan, 'Expected imported duplicate-state fixture to be persisted.');
        // File-based state is DISABLED — importer defaults to CREATED/active regardless of embedded state.
        assert.strictEqual(
            importedPlan?.kanbanColumn,
            'CREATED',
            'Expected importer to default to CREATED since file-based state inspection is disabled.'
        );
        assert.strictEqual(
            importedPlan?.status,
            'active',
            'Expected importer to default to active status.'
        );
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }

    const stateUtilsSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'planStateUtils.ts'),
        'utf8'
    );
    assert.doesNotMatch(
        stateUtilsSource,
        /content\.replace\(\/\\n\?## Switchboard State\[\\s\\S\]\*\$\/, ''\)/,
        'Expected applyKanbanStateToPlanContent() to stop stripping from the first Switchboard State match to EOF.'
    );

    console.log('duplicate switchboard state regression test passed');
}

run().catch((error) => {
    console.error('duplicate switchboard state regression test failed:', error);
    process.exit(1);
});
