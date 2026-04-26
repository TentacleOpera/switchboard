'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    applyKanbanStateToPlanContent,
    writePlanStateToFile
} = require(path.join(process.cwd(), 'out', 'services', 'planStateUtils.js'));
const { importPlanFiles } = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

const taskViewerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const kanbanProviderSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');

function buildPlanContent(title, sessionId) {
    return [
        `# ${title}`,
        '',
        '## Goal',
        'Verify custom lane round-tripping through plan-file-only import/reset recovery.',
        '',
        `**Plan ID:** ${sessionId}`,
        `**Session ID:** ${sessionId}`,
        ''
    ].join('\n');
}

async function run() {
    assert.match(
        taskViewerSource,
        /writePlanStateToFile\([\s\S]*column,\s*column === 'COMPLETED' \? 'completed' : 'active'[\s\S]*\);/s,
        'Expected TaskViewerProvider to persist the exact resolved column id to the plan footer.'
    );
    assert.match(
        kanbanProviderSource,
        /_schedulePlanStateWrite\([\s\S]*normalizedColumn,\s*normalizedColumn === 'COMPLETED' \? 'completed' : 'active'[\s\S]*\);/s,
        'Expected KanbanProvider to persist normalized board column ids without snapping custom lanes back to a built-in alias.'
    );

    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-custom-lane-'));
    try {
        const switchboardDir = path.join(workspaceRoot, '.switchboard');
        const plansDir = path.join(switchboardDir, 'plans');
        await fs.promises.mkdir(plansDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(switchboardDir, 'state.json'),
            JSON.stringify({
                customAgents: [],
                customKanbanColumns: [
                    {
                        id: 'custom_column_docs_ready',
                        label: 'Docs Ready',
                        role: 'coder',
                        triggerPrompt: 'Polish the docs handoff.',
                        order: 250,
                        dragDropMode: 'cli'
                    }
                ]
            }, null, 2),
            'utf8'
        );

        // File-based state writes are DISABLED — writePlanStateToFile is a no-op.
        // Use applyKanbanStateToPlanContent to embed state directly into the file content
        // so that the importer (which also has file-state disabled) will still default
        // to CREATED. We verify the no-op behavior instead.
        const configuredPlanPath = path.join(plansDir, 'custom-lane-roundtrip.md');
        await fs.promises.writeFile(
            configuredPlanPath,
            buildPlanContent('Custom Lane Roundtrip Fixture', 'custom-lane-roundtrip'),
            'utf8'
        );
        await writePlanStateToFile(configuredPlanPath, workspaceRoot, 'custom_column_docs_ready', 'active');

        // writePlanStateToFile is now a no-op — file content should be UNCHANGED
        const configuredContent = await fs.promises.readFile(configuredPlanPath, 'utf8');
        assert.ok(
            !configuredContent.includes('**Kanban Column:** custom_column_docs_ready'),
            'Expected writePlanStateToFile no-op to NOT modify the file (file-based state disabled).'
        );

        const missingPlanPath = path.join(plansDir, 'missing-custom-lane.md');
        await fs.promises.writeFile(
            missingPlanPath,
            applyKanbanStateToPlanContent(
                buildPlanContent('Missing Custom Lane Fixture', 'missing-custom-lane'),
                {
                    kanbanColumn: 'custom_column_deleted_lane',
                    status: 'active',
                    lastUpdated: '2026-01-01T00:00:00.000Z',
                    formatVersion: 1
                }
            ),
            'utf8'
        );

        const imported = await importPlanFiles(workspaceRoot);
        assert.strictEqual(imported.count, 2, 'Expected importPlanFiles to ingest both custom-lane fixtures.');

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'Expected KanbanDatabase to initialize for custom-lane regression coverage.');

        const configuredPlan = await db.getPlanBySessionId('custom-lane-roundtrip');
        assert.ok(configuredPlan, 'Expected configured custom-lane fixture to be imported.');
        // File-based state is DISABLED — importer defaults to CREATED since inspectKanbanState returns null.
        assert.strictEqual(
            configuredPlan?.kanbanColumn,
            'CREATED',
            'Expected importer to default to CREATED since file-based state inspection is disabled.'
        );

        const missingPlan = await db.getPlanBySessionId('missing-custom-lane');
        assert.ok(missingPlan, 'Expected missing-lane fixture to be imported.');
        assert.strictEqual(
            missingPlan?.kanbanColumn,
            'CREATED',
            'Expected unknown custom column ids not present in state.json to fall back to CREATED.'
        );
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }

    console.log('custom lane roundtrip regression test passed');
}

run().catch((error) => {
    console.error('custom lane roundtrip regression test failed:', error);
    process.exit(1);
});
