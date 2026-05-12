'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { importPlanFiles } = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

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

        const configuredPlanPath = path.join(plansDir, 'custom-lane-roundtrip.md');
        await fs.promises.writeFile(
            configuredPlanPath,
            buildPlanContent('Custom Lane Roundtrip Fixture', 'custom-lane-roundtrip'),
            'utf8'
        );

        const missingPlanPath = path.join(plansDir, 'missing-custom-lane.md');
        await fs.promises.writeFile(
            missingPlanPath,
            buildPlanContent('Missing Custom Lane Fixture', 'missing-custom-lane'),
            'utf8'
        );

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.createIfMissing();

        const imported = await importPlanFiles(workspaceRoot);
        assert.strictEqual(imported.count, 2, 'Expected importPlanFiles to ingest both custom-lane fixtures.');

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
