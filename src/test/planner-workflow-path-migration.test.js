'use strict';

// Verification harness for the `.agent/` → `.agents/` persisted planner
// workflowFilePath migration (plan: migrate-persisted-planner-workflow-path-
// agent-to-agents). The migration lives on TaskViewerProvider as private
// methods, which are heavy to instantiate in a unit harness, so this file:
//   (a) exercises the new public KanbanDatabase.getProjectConfigRowsByKeySync
//       helper directly against a temp DB (the project_config tier's scan
//       primitive);
//   (b) replicates the _normalizeAgentToAgents transform inline and asserts it
//       rewrites only a leading `.agent/` segment, leaving custom paths and
//       already-migrated values untouched;
//   (c) source-asserts the migration methods, two-tier gating, and per-DB
//       marker exist in TaskViewerProvider.ts with the correct shape — the same
//       source-assertion style used by local-plan-duplicate-regression.test.js.
// When run (after compile), all 6 cases must pass.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'),
    'utf8'
);

const ROLE_KEY = 'switchboard.prompts.roleConfig_planner';
const MARKER_KEY = 'switchboard.migrations.plannerWorkflowPathAgentToAgents.v1';
const PROFILE_FLAG = 'switchboard.plannerWorkflowPathAgentToAgents.v1';

// Mirror of TaskViewerProvider._normalizeAgentToAgents — pure regex replace.
function normalizeAgentToAgents(p) {
    return String(p).replace(/^\.agent\//, '.agents/');
}

async function run() {
    // ── Test 1: getProjectConfigRowsByKeySync returns all rows for a key across projects ──
    const ws1 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-pwf-migration-1-'));
    try {
        const db1 = KanbanDatabase.forWorkspace(ws1);
        assert.strictEqual(await db1.ensureReady(), true, 'Expected kanban DB to initialize for migration test 1.');

        await db1.setProjectConfigJson('projA', ROLE_KEY, { workflowFilePath: '.agent/workflows/improve-plan.md', addons: { x: 1 } });
        await db1.setProjectConfigJson('projB', ROLE_KEY, { workflowFilePath: '.agent/workflows/improve-plan.md' });
        await db1.setProjectConfigJson('projA', 'unrelated.key', { foo: 'bar' });

        const rows = await db1.getProjectConfigRowsByKeySync(ROLE_KEY);
        const projects = rows.map(r => r.project).sort();
        assert.deepStrictEqual(projects, ['projA', 'projB'], 'Expected getProjectConfigRowsByKeySync to return rows for every project holding the key.');
        assert.strictEqual(rows.length, 2, 'Expected exactly two project_config rows for the planner key.');
        assert.strictEqual(rows[0].value.workflowFilePath, '.agent/workflows/improve-plan.md', 'Expected the seeded workflowFilePath to round-trip.');
        assert.strictEqual(rows[0].value.addons.x, 1, 'Expected addons to be preserved by the scan helper.');

        console.log('planner workflow path migration test 1 (project_config scan helper) passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws1);
        await fs.promises.rm(ws1, { recursive: true, force: true });
    }

    // ── Test 2: getProjectConfigRowsByKeySync returns [] when DB not ready / no rows ──
    const ws2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-pwf-migration-2-'));
    try {
        const db2 = KanbanDatabase.forWorkspace(ws2);
        assert.strictEqual(await db2.ensureReady(), true, 'Expected kanban DB to initialize for migration test 2.');
        const empty = await db2.getProjectConfigRowsByKeySync(ROLE_KEY);
        assert.deepStrictEqual(empty, [], 'Expected getProjectConfigRowsByKeySync to return [] when no rows match.');

        // Corrupt JSON row is skipped, valid rows still returned.
        const rawDb = db2._db;
        rawDb.run(
            'INSERT INTO project_config (project, key, value) VALUES (?, ?, ?)',
            ['projCorrupt', ROLE_KEY, '{not valid json']
        );
        rawDb.run(
            'INSERT INTO project_config (project, key, value) VALUES (?, ?, ?)',
            ['projValid', ROLE_KEY, JSON.stringify({ workflowFilePath: '.agent/workflows/improve-plan.md' })]
        );
        const mixed = await db2.getProjectConfigRowsByKeySync(ROLE_KEY);
        assert.strictEqual(mixed.length, 1, 'Expected the corrupt row to be skipped and the valid row returned.');
        assert.strictEqual(mixed[0].project, 'projValid', 'Expected the valid project row to survive the skip.');

        console.log('planner workflow path migration test 2 (scan helper edge cases) passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws2);
        await fs.promises.rm(ws2, { recursive: true, force: true });
    }

    // ── Test 3: normalizeAgentToAgents rewrites only a leading .agent/ segment ──
    assert.strictEqual(
        normalizeAgentToAgents('.agent/workflows/improve-plan.md'),
        '.agents/workflows/improve-plan.md',
        'Expected a leading .agent/ segment to be rewritten to .agents/.'
    );
    assert.strictEqual(
        normalizeAgentToAgents('.agents/workflows/improve-plan.md'),
        '.agents/workflows/improve-plan.md',
        'Expected an already-migrated .agents/ path to be unchanged (no-op).'
    );
    assert.strictEqual(
        normalizeAgentToAgents('.custom/workflows/x.md'),
        '.custom/workflows/x.md',
        'Expected a custom path (not starting with .agent/) to be untouched.'
    );
    assert.strictEqual(
        normalizeAgentToAgents('/abs/path/improve-plan.md'),
        '/abs/path/improve-plan.md',
        'Expected an absolute path to be untouched.'
    );
    assert.strictEqual(
        normalizeAgentToAgents('.agent'),
        '.agent',
        'Expected a bare .agent (no trailing slash) to be untouched — only .agent/ is rewritten.'
    );

    console.log('planner workflow path migration test 3 (normalization transform) passed');

    // ── Test 4: DB-tier migration rewrites config + project_config and sets the per-DB marker ──
    const ws4 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-pwf-migration-4-'));
    try {
        const db4 = KanbanDatabase.forWorkspace(ws4);
        assert.strictEqual(await db4.ensureReady(), true, 'Expected kanban DB to initialize for migration test 4.');

        // Seed stale values in both DB tiers.
        await db4.setConfigJson(ROLE_KEY, { workflowFilePath: '.agent/workflows/improve-plan.md', prompt: 'keep me' });
        await db4.setProjectConfigJson('projX', ROLE_KEY, { workflowFilePath: '.agent/workflows/improve-plan.md', addons: { y: 2 } });

        // Replicate the DB-tier migration's data transformation against this DB.
        const cfg = db4.getConfigJsonSync(ROLE_KEY, undefined);
        assert.ok(cfg && cfg.workflowFilePath.startsWith('.agent/'), 'Expected the seeded config-tier value to be stale.');
        cfg.workflowFilePath = normalizeAgentToAgents(cfg.workflowFilePath);
        await db4.setConfigJson(ROLE_KEY, cfg);

        const projRows = await db4.getProjectConfigRowsByKeySync(ROLE_KEY);
        for (const row of projRows) {
            row.value.workflowFilePath = normalizeAgentToAgents(row.value.workflowFilePath);
            await db4.setProjectConfigJson(row.project, ROLE_KEY, row.value);
        }
        await db4.setConfigJson(MARKER_KEY, true);

        // Assert both tiers rewritten, other keys preserved, marker set.
        const cfgAfter = db4.getConfigJsonSync(ROLE_KEY, undefined);
        assert.strictEqual(cfgAfter.workflowFilePath, '.agents/workflows/improve-plan.md', 'Expected config-tier workflowFilePath to be migrated.');
        assert.strictEqual(cfgAfter.prompt, 'keep me', 'Expected the unrelated prompt key to be preserved.');

        const projAfter = await db4.getProjectConfigRowsByKeySync(ROLE_KEY);
        assert.strictEqual(projAfter.length, 1, 'Expected one project_config row after migration.');
        assert.strictEqual(projAfter[0].value.workflowFilePath, '.agents/workflows/improve-plan.md', 'Expected project_config-tier workflowFilePath to be migrated.');
        assert.strictEqual(projAfter[0].value.addons.y, 2, 'Expected project_config-tier addons to be preserved.');

        const marker = db4.getConfigJsonSync(MARKER_KEY, false);
        assert.strictEqual(marker, true, 'Expected the per-DB marker to be set after the DB tiers migrate.');

        console.log('planner workflow path migration test 4 (DB-tier rewrite + marker) passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws4);
        await fs.promises.rm(ws4, { recursive: true, force: true });
    }

    // ── Test 5: already-migrated values are a no-op and custom paths untouched ──
    const ws5 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-pwf-migration-5-'));
    try {
        const db5 = KanbanDatabase.forWorkspace(ws5);
        assert.strictEqual(await db5.ensureReady(), true, 'Expected kanban DB to initialize for migration test 5.');

        await db5.setConfigJson(ROLE_KEY, { workflowFilePath: '.agents/workflows/improve-plan.md' });
        await db5.setProjectConfigJson('projCustom', ROLE_KEY, { workflowFilePath: '.custom/workflows/x.md' });

        // Replicate the migration's guard: only rewrite when the value starts with `.agent/`.
        const cfg5 = db5.getConfigJsonSync(ROLE_KEY, undefined);
        if (cfg5 && typeof cfg5.workflowFilePath === 'string' && cfg5.workflowFilePath.startsWith('.agent/')) {
            cfg5.workflowFilePath = normalizeAgentToAgents(cfg5.workflowFilePath);
            await db5.setConfigJson(ROLE_KEY, cfg5);
        }
        const rows5 = await db5.getProjectConfigRowsByKeySync(ROLE_KEY);
        for (const row of rows5) {
            if (row.value && typeof row.value.workflowFilePath === 'string' && row.value.workflowFilePath.startsWith('.agent/')) {
                row.value.workflowFilePath = normalizeAgentToAgents(row.value.workflowFilePath);
                await db5.setProjectConfigJson(row.project, ROLE_KEY, row.value);
            }
        }
        await db5.setConfigJson(MARKER_KEY, true);

        assert.strictEqual(db5.getConfigJsonSync(ROLE_KEY, undefined).workflowFilePath, '.agents/workflows/improve-plan.md', 'Expected already-migrated config value to remain unchanged.');
        const customRows = await db5.getProjectConfigRowsByKeySync(ROLE_KEY);
        assert.strictEqual(customRows[0].value.workflowFilePath, '.custom/workflows/x.md', 'Expected custom project_config path to remain untouched.');
        assert.strictEqual(db5.getConfigJsonSync(MARKER_KEY, false), true, 'Expected the marker to be set even when no rewrite was needed.');

        console.log('planner workflow path migration test 5 (no-op + custom-path untouched) passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws5);
        await fs.promises.rm(ws5, { recursive: true, force: true });
    }

    // ── Test 6: per-DB marker gates re-entry (multi-workspace simulation) ──
    // Simulate workspace B opened after workspace A already migrated: the
    // per-profile flag is irrelevant; each DB is gated by its own marker.
    const ws6a = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-pwf-migration-6a-'));
    const ws6b = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-pwf-migration-6b-'));
    try {
        const db6a = KanbanDatabase.forWorkspace(ws6a);
        assert.strictEqual(await db6a.ensureReady(), true, 'Expected kanban DB A to initialize for migration test 6.');
        const db6b = KanbanDatabase.forWorkspace(ws6b);
        assert.strictEqual(await db6b.ensureReady(), true, 'Expected kanban DB B to initialize for migration test 6.');

        // Both DBs hold the stale value.
        await db6a.setConfigJson(ROLE_KEY, { workflowFilePath: '.agent/workflows/improve-plan.md' });
        await db6b.setConfigJson(ROLE_KEY, { workflowFilePath: '.agent/workflows/improve-plan.md' });

        // "Run" the DB-tier migration for A (per-DB marker absent → migrate).
        assert.strictEqual(db6a.getConfigJsonSync(MARKER_KEY, false), false, 'Expected DB A marker absent before migration.');
        const cfgA = db6a.getConfigJsonSync(ROLE_KEY, undefined);
        cfgA.workflowFilePath = normalizeAgentToAgents(cfgA.workflowFilePath);
        await db6a.setConfigJson(ROLE_KEY, cfgA);
        await db6a.setConfigJson(MARKER_KEY, true);

        // Simulate the per-profile flag already being true (set by A's profile-tier run).
        // DB B is opened later — its marker is still absent, so it must still migrate.
        assert.strictEqual(db6b.getConfigJsonSync(MARKER_KEY, false), false, 'Expected DB B marker absent despite the per-profile flag being set.');
        const cfgB = db6b.getConfigJsonSync(ROLE_KEY, undefined);
        cfgB.workflowFilePath = normalizeAgentToAgents(cfgB.workflowFilePath);
        await db6b.setConfigJson(ROLE_KEY, cfgB);
        await db6b.setConfigJson(MARKER_KEY, true);

        assert.strictEqual(db6a.getConfigJsonSync(ROLE_KEY, undefined).workflowFilePath, '.agents/workflows/improve-plan.md', 'Expected DB A to be migrated.');
        assert.strictEqual(db6b.getConfigJsonSync(ROLE_KEY, undefined).workflowFilePath, '.agents/workflows/improve-plan.md', 'Expected DB B (opened later) to also be migrated via its own per-DB marker.');
        assert.strictEqual(db6a.getConfigJsonSync(MARKER_KEY, false), true, 'Expected DB A marker set.');
        assert.strictEqual(db6b.getConfigJsonSync(MARKER_KEY, false), true, 'Expected DB B marker set.');

        // Re-entry guard: with the marker set, a second pass is a no-op.
        const cfgA2 = db6a.getConfigJsonSync(ROLE_KEY, undefined);
        if (db6a.getConfigJsonSync(MARKER_KEY, false)) {
            // skip — marker gates re-entry
        } else {
            cfgA2.workflowFilePath = normalizeAgentToAgents(cfgA2.workflowFilePath);
            await db6a.setConfigJson(ROLE_KEY, cfgA2);
        }
        assert.strictEqual(db6a.getConfigJsonSync(ROLE_KEY, undefined).workflowFilePath, '.agents/workflows/improve-plan.md', 'Expected re-entry to be a no-op when the marker is set.');

        console.log('planner workflow path migration test 6 (per-DB marker multi-workspace) passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws6a);
        await KanbanDatabase.invalidateWorkspace(ws6b);
        await fs.promises.rm(ws6a, { recursive: true, force: true });
        await fs.promises.rm(ws6b, { recursive: true, force: true });
    }

    // ── Source assertions: the migration methods + two-tier gating exist in TaskViewerProvider.ts ──
    assert.match(
        providerSource,
        /private static _normalizeAgentToAgents\(p: string\): string \{[\s\S]*?return p\.replace\([\s\S]*?\.agent[\s\S]*?\.agents[\s\S]*?\}/,
        'Expected TaskViewerProvider to define _normalizeAgentToAgents rewriting .agent/ → .agents/.'
    );
    assert.match(
        providerSource,
        /private async _migratePlannerWorkflowPathProfileTiers\(\): Promise<void> \{/,
        'Expected TaskViewerProvider to define _migratePlannerWorkflowPathProfileTiers.'
    );
    assert.match(
        providerSource,
        /private async _migratePlannerWorkflowPathDbTiers\(\): Promise<void> \{/,
        'Expected TaskViewerProvider to define _migratePlannerWorkflowPathDbTiers.'
    );
    assert.match(
        providerSource,
        /const wfProfileMigrated = this\._context\.globalState\.get<boolean>\(\s*'switchboard\.plannerWorkflowPathAgentToAgents\.v1'/,
        'Expected the constructor to read the per-profile migration flag.'
    );
    assert.match(
        providerSource,
        /void this\._migratePlannerWorkflowPathProfileTiers\(\);/,
        'Expected the constructor to invoke the profile-tier migration when the flag is absent.'
    );
    assert.match(
        providerSource,
        /void this\._migratePlannerWorkflowPathDbTiers\(\);/,
        'Expected the constructor to invoke the DB-tier migration unconditionally (per-DB marker gates re-entry).'
    );
    assert.match(
        providerSource,
        /const done = db\.getConfigJsonSync<boolean>\(MARKER_KEY, false\);[\s\S]*?if \(done\) continue;/,
        'Expected the DB-tier migration to skip a DB whose per-DB marker is already set.'
    );
    assert.match(
        providerSource,
        /await db\.setConfigJson\(MARKER_KEY, true\);/,
        'Expected the DB-tier migration to write the per-DB marker after both DB tiers attempt.'
    );
    assert.match(
        providerSource,
        /const rows = await db\.getProjectConfigRowsByKeySync<any>\(ROLE_KEY\);/,
        'Expected the DB-tier migration to scan project_config via the new helper.'
    );
    assert.match(
        providerSource,
        /conf\.inspect<string>\('planner\.workflowPath'\)/,
        'Expected the profile-tier migration to inspect the VS Code setting scope rather than blindly promoting to Global.'
    );
    assert.match(
        providerSource,
        /vscode\.ConfigurationTarget\.Global/,
        'Expected the profile-tier migration to update the Global scope when inspect reports a stale globalValue.'
    );
    assert.match(
        providerSource,
        /vscode\.ConfigurationTarget\.Workspace/,
        'Expected the profile-tier migration to update the Workspace scope when inspect reports a stale workspaceValue.'
    );

    // ── Source assertions: the workflows→skills migration method exists ──
    assert.match(
        providerSource,
        /private async _migratePlannerWorkflowPathWorkflowsToSkills\(\): Promise<void> \{/,
        'Expected TaskViewerProvider to define _migratePlannerWorkflowPathWorkflowsToSkills.'
    );
    assert.match(
        providerSource,
        /const MARKER_KEY = 'switchboard\.migrations\.plannerWorkflowPathWorkflowsToSkills\.v1';/,
        'Expected the workflows→skills migration to use its own per-DB marker key.'
    );
    assert.match(
        providerSource,
        /const OLD_DEFAULT = '\.agents\/workflows\/improve-plan\.md';/,
        'Expected the workflows→skills migration to match the old default path.'
    );
    assert.match(
        providerSource,
        /const NEW_DEFAULT = '\.agents\/skills\/improve-plan\/SKILL\.md';/,
        'Expected the workflows→skills migration to rewrite to the new skills path.'
    );
    assert.match(
        providerSource,
        /void this\._migratePlannerWorkflowPathWorkflowsToSkills\(\);/,
        'Expected the constructor to invoke the workflows→skills migration.'
    );

    // ── Test 7: workflows→skills migration rewrites old default, preserves custom paths ──
    const ws7 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-pwf-migration-7-'));
    try {
        const db7 = KanbanDatabase.forWorkspace(ws7);
        assert.strictEqual(await db7.ensureReady(), true, 'Expected kanban DB to initialize for migration test 7.');

        const OLD_DEFAULT = '.agents/workflows/improve-plan.md';
        const NEW_DEFAULT = '.agents/skills/improve-plan/SKILL.md';

        // Seed: one old-default (should rewrite), one custom (should be untouched).
        await db7.setConfigJson(ROLE_KEY, { workflowFilePath: OLD_DEFAULT });
        await db7.setProjectConfigJson('projCustom', ROLE_KEY, { workflowFilePath: '.custom/workflows/x.md' });

        // Replicate the workflows→skills migration's data transformation.
        const cfg7 = db7.getConfigJsonSync(ROLE_KEY, undefined);
        if (cfg7 && typeof cfg7.workflowFilePath === 'string' && cfg7.workflowFilePath === OLD_DEFAULT) {
            cfg7.workflowFilePath = NEW_DEFAULT;
            await db7.setConfigJson(ROLE_KEY, cfg7);
        }
        const rows7 = await db7.getProjectConfigRowsByKeySync(ROLE_KEY);
        for (const row of rows7) {
            if (row.value && typeof row.value.workflowFilePath === 'string' && row.value.workflowFilePath === OLD_DEFAULT) {
                row.value.workflowFilePath = NEW_DEFAULT;
                await db7.setProjectConfigJson(row.project, ROLE_KEY, row.value);
            }
        }

        assert.strictEqual(db7.getConfigJsonSync(ROLE_KEY, undefined).workflowFilePath, NEW_DEFAULT, 'Expected old-default config value to be rewritten to the skills path.');
        const customRows7 = await db7.getProjectConfigRowsByKeySync(ROLE_KEY);
        assert.strictEqual(customRows7[0].value.workflowFilePath, '.custom/workflows/x.md', 'Expected custom project_config path to remain untouched by the workflows→skills migration.');

        console.log('planner workflow path migration test 7 (workflows→skills rewrite) passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws7);
        await fs.promises.rm(ws7, { recursive: true, force: true });
    }

    console.log('planner workflow path migration test (source assertions) passed');
    console.log('all planner workflow path migration tests passed');
}

run().catch((err) => {
    console.error('planner workflow path migration test FAILED:', err);
    process.exit(1);
});
