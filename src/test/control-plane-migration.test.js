'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

function installVsCodeMock() {
    const originalLoad = Module._load;
    const state = {
        executeCommandCalls: [],
        errorMessages: [],
        warningMessages: [],
        informationMessages: []
    };

    const mock = {
        window: {
            withProgress: async (_options, task) => task({ report() { } }),
            showErrorMessage: async (message) => {
                state.errorMessages.push(message);
                return undefined;
            },
            showWarningMessage: async (message) => {
                state.warningMessages.push(message);
                return undefined;
            },
            showInformationMessage: async (message) => {
                state.informationMessages.push(message);
                return undefined;
            }
        },
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({
                get: (_key, fallback) => fallback,
                update: async () => undefined
            })
        },
        commands: {
            executeCommand: async (command, ...args) => {
                state.executeCommandCalls.push({ command, args });
                return true;
            }
        },
        Uri: {
            file(value) {
                const resolved = path.resolve(value);
                return {
                    fsPath: resolved,
                    path: resolved,
                    toString() {
                        return resolved;
                    }
                };
            }
        },
        ProgressLocation: {
            Notification: 15
        }
    };

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'vscode') {
            return mock;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    return {
        mock,
        state,
        restore() {
            Module._load = originalLoad;
        }
    };
}

function buildPlanContent(title, sessionId, metadataLines = []) {
    return [
        `# ${title}`,
        '',
        '## Goal',
        `Migrate ${title}.`,
        '',
        `**Plan ID:** ${sessionId}`,
        `**Session ID:** ${sessionId}`,
        '',
        '## Metadata',
        ...metadataLines,
        ''
    ].join('\n');
}

async function createRepoFixture(repoDir, planFileName, sessionId, options = {}) {
    const switchboardDir = path.join(repoDir, '.switchboard');
    const plansDir = path.join(switchboardDir, 'plans');
    const agentDir = path.join(repoDir, '.agent');

    await fs.promises.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.promises.mkdir(plansDir, { recursive: true });
    await fs.promises.mkdir(path.join(agentDir, 'personas'), { recursive: true });
    await fs.promises.mkdir(path.join(agentDir, 'workflows'), { recursive: true });
    await fs.promises.mkdir(path.join(agentDir, 'skills'), { recursive: true });
    await fs.promises.mkdir(path.join(agentDir, 'rules'), { recursive: true });

    await fs.promises.writeFile(
        path.join(plansDir, planFileName),
        buildPlanContent(`${options.repoName || path.basename(repoDir)} plan`, sessionId, options.metadataLines || ['**Tags:** backend']),
        'utf8'
    );
    await fs.promises.writeFile(path.join(plansDir, 'brain_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md'), '# mirror', 'utf8');
    await fs.promises.writeFile(path.join(plansDir, 'ingested_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.md'), '# mirror', 'utf8');
    await fs.promises.writeFile(path.join(switchboardDir, 'kanban.db'), 'stub', 'utf8');
    await fs.promises.writeFile(path.join(agentDir, 'personas', 'shared-persona.md'), '# shared persona', 'utf8');
    await fs.promises.writeFile(path.join(agentDir, 'workflows', 'shared-workflow.md'), '# shared workflow', 'utf8');
    await fs.promises.writeFile(path.join(agentDir, 'skills', 'shared-skill.md'), '# shared skill', 'utf8');
    await fs.promises.writeFile(path.join(agentDir, 'rules', 'shared-rule.md'), options.ruleContent || '# divergent rule', 'utf8');
    await fs.promises.writeFile(path.join(repoDir, 'AGENTS.md'), options.agentsContent || '# repo agents', 'utf8');
}

async function run() {
    const vscodeMock = installVsCodeMock();
    const { ControlPlaneMigrationService } = require(path.join(process.cwd(), 'out', 'services', 'ControlPlaneMigrationService.js'));
    const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
    const { importPlanFiles } = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));

    const unsafeCandidate = await ControlPlaneMigrationService.detectCandidateParent(path.join(os.homedir(), 'child-repo'));
    assert.strictEqual(
        unsafeCandidate.suggestedParentDir,
        null,
        'Expected detectCandidateParent() to reject the home directory as an unsafe control-plane parent.'
    );

    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-control-plane-'));
    const originalReconcile = KanbanDatabase.reconcileDatabases;
    const originalInvalidate = KanbanDatabase.invalidateWorkspace;

    try {
        const parentDir = path.join(tempRoot, 'GitHub');
        const beDir = path.join(parentDir, 'be');
        const feDir = path.join(parentDir, 'fe');
        await fs.promises.mkdir(parentDir, { recursive: true });
        await createRepoFixture(beDir, 'be-plan.md', 'be-plan', { repoName: 'be', ruleContent: '# be rule', agentsContent: '# shared repo agents' });
        await createRepoFixture(feDir, 'fe-plan.md', 'fe-plan', { repoName: 'fe', ruleContent: '# fe rule', agentsContent: '# shared repo agents' });

        await fs.promises.mkdir(path.join(parentDir, '.switchboard'), { recursive: true });
        await fs.promises.writeFile(path.join(parentDir, '.switchboard', 'kanban.db'), 'present', 'utf8');
        const candidate = await ControlPlaneMigrationService.detectCandidateParent(beDir);
        assert.strictEqual(candidate.suggestedParentDir, parentDir, 'Expected the direct parent folder to be suggested.');
        assert.strictEqual(candidate.alreadyControlPlane, true, 'Expected detectCandidateParent() to mark an existing parent control plane.');
        assert.strictEqual(candidate.discoveredRepos.filter((repo) => repo.hasGit).length, 2, 'Expected both child git repos to be discovered.');

        const injectedMissingMetadata = ControlPlaneMigrationService.injectRepoScope(
            [
                '# Missing Metadata Fixture',
                '',
                '## Goal',
                'Insert metadata after goal.',
                '',
                '## Complexity Audit',
                '- none'
            ].join('\n'),
            'be'
        );
        assert.match(
            injectedMissingMetadata,
            /## Goal[\s\S]*## Metadata\n\n\*\*Repo:\*\* be\n\n## Complexity Audit/,
            'Expected injectRepoScope() to add a metadata block immediately after the Goal section when Metadata is missing.'
        );

        const injectedConflictingMetadata = ControlPlaneMigrationService.injectRepoScope(
            [
                '# Conflicting Metadata Fixture',
                '',
                '## Goal',
                'Overwrite stale repo metadata.',
                '',
                '## Metadata',
                '',
                '**Tags:** backend',
                '**Repo:** fe',
                ''
            ].join('\n'),
            'be'
        );
        assert.match(
            injectedConflictingMetadata,
            /\*\*Repo:\*\* be/,
            'Expected injectRepoScope() to overwrite stale embedded repo metadata.'
        );
        assert.doesNotMatch(
            injectedConflictingMetadata,
            /\*\*Repo:\*\* fe/,
            'Expected injectRepoScope() not to leave the stale repo metadata behind.'
        );

        await fs.promises.rm(path.join(parentDir, '.switchboard'), { recursive: true, force: true });

        const reconcileCalls = [];
        const invalidateCalls = [];
        KanbanDatabase.reconcileDatabases = async (sourcePath, targetPath) => {
            reconcileCalls.push({
                sourcePath,
                targetPath,
                targetExists: fs.existsSync(targetPath)
            });
            return path.basename(path.dirname(path.dirname(sourcePath))) === 'be' ? 2 : 1;
        };
        KanbanDatabase.invalidateWorkspace = async (workspaceRoot) => {
            invalidateCalls.push(workspaceRoot);
            return originalInvalidate.call(KanbanDatabase, workspaceRoot);
        };

        const migrationResult = await ControlPlaneMigrationService.executeMigration(parentDir, {
            currentWorkspaceRoot: beDir,
            extensionPath: process.cwd(),
            cleanupConfirmed: ['be']
        });

        assert.strictEqual(migrationResult.success, true, `Expected executeMigration() to succeed: ${migrationResult.error || 'unknown error'}`);
        assert.deepStrictEqual(
            reconcileCalls.map((call) => path.basename(path.dirname(path.dirname(call.sourcePath)))),
            ['be', 'fe'],
            'Expected executeMigration() to reconcile child databases sequentially.'
        );
        assert.ok(
            reconcileCalls.every((call) => call.targetExists),
            'Expected executeMigration() to ensure the target control-plane DB exists before the first reconcileDatabases() call.'
        );
        assert.deepStrictEqual(
            invalidateCalls,
            [parentDir],
            'Expected executeMigration() to invalidate the target workspace DB after the merge loop.'
        );

        assert.ok(
            fs.existsSync(path.join(parentDir, '.switchboard', 'plans', 'be', 'be-plan.md')),
            'Expected migrated plan files to land under plans/<repoName>/.'
        );
        assert.ok(
            fs.existsSync(path.join(parentDir, '.switchboard', 'plans', 'fe', 'fe-plan.md')),
            'Expected plan files from each source repo to be copied into the parent control plane.'
        );
        assert.ok(
            !fs.existsSync(path.join(parentDir, '.switchboard', 'plans', 'be', 'brain_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md')),
            'Expected executeMigration() to skip brain_* runtime mirrors when copying plan files.'
        );
        assert.ok(
            !fs.existsSync(path.join(parentDir, '.switchboard', 'plans', 'be', 'ingested_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.md')),
            'Expected executeMigration() to skip ingested_* runtime mirrors when copying plan files.'
        );

        assert.ok(
            fs.existsSync(path.join(parentDir, '.agent', 'personas', 'shared-persona.md')) &&
            fs.existsSync(path.join(parentDir, '.agent', 'workflows', 'shared-workflow.md')) &&
            fs.existsSync(path.join(parentDir, '.agent', 'skills', 'shared-skill.md')),
            'Expected identical shared persona/workflow/skill files to be promoted into the parent control plane.'
        );
        assert.ok(
            !fs.existsSync(path.join(parentDir, '.agent', 'rules', 'shared-rule.md')),
            'Expected divergent rules files not to be copied into the parent control plane.'
        );

        const reportPath = migrationResult.reportPath;
        assert.ok(reportPath && fs.existsSync(reportPath), 'Expected executeMigration() to write MIGRATION_REPORT.md.');
        const reportContent = fs.readFileSync(reportPath, 'utf8');
        assert.match(
            reportContent,
            /shared-rule\.md/,
            'Expected MIGRATION_REPORT.md to record divergent rules that require manual review.'
        );

        assert.ok(
            fs.readdirSync(beDir).some((entry) => /^\.switchboard\.migrated(?:\.\d+)?\.bak$/.test(entry)),
            'Expected optional cleanup to archive the migrated source .switchboard directory instead of deleting it.'
        );

        assert.ok(
            vscodeMock.state.executeCommandCalls.some((call) =>
                call.command === 'vscode.openFolder'
                && call.args[0]
                && call.args[0].fsPath === migrationResult.workspaceFilePath
            ),
            'Expected executeMigration() to reopen VS Code with the generated control-plane workspace file.'
        );

        const importRoot = path.join(tempRoot, 'import-root');
        const importPlansDir = path.join(importRoot, '.switchboard', 'plans');
        await fs.promises.mkdir(path.join(importPlansDir, 'be'), { recursive: true });
        await fs.promises.writeFile(
            path.join(importPlansDir, 'top-level-plan.md'),
            buildPlanContent('Top Level Plan', 'top-level-plan', ['**Tags:** docs']),
            'utf8'
        );
        await fs.promises.writeFile(
            path.join(importPlansDir, 'brain_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.md'),
            '# top-level mirror',
            'utf8'
        );
        await fs.promises.writeFile(
            path.join(importPlansDir, 'ingested_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.md'),
            '# top-level mirror',
            'utf8'
        );
        await fs.promises.writeFile(
            path.join(importPlansDir, 'be', 'repo-plan.md'),
            buildPlanContent('Repo Plan', 'repo-plan', ['**Tags:** backend']),
            'utf8'
        );
        await fs.promises.writeFile(
            path.join(importPlansDir, 'be', 'brain_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.md'),
            '# nested mirror',
            'utf8'
        );
        await fs.promises.writeFile(
            path.join(importPlansDir, 'be', 'ingested_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.md'),
            '# nested mirror',
            'utf8'
        );

        const imported = await importPlanFiles(importRoot);
        assert.strictEqual(
            imported.count,
            2,
            'Expected importPlanFiles() to discover top-level and one-level repo-folder plan files while ignoring runtime mirror files.'
        );

        const importDb = KanbanDatabase.forWorkspace(importRoot);
        const ready = await importDb.ensureReady();
        assert.strictEqual(ready, true, 'Expected KanbanDatabase to initialize for control-plane importer coverage.');

        const topLevelPlan = await importDb.getPlanBySessionId('top-level-plan');
        const repoPlan = await importDb.getPlanBySessionId('repo-plan');
        assert.strictEqual(topLevelPlan?.repoScope, '', 'Expected top-level control-plane plans to stay unscoped.');
        assert.strictEqual(repoPlan?.repoScope, 'be', 'Expected plans discovered in plans/<repoName>/ to inherit the folder repo scope.');
    } finally {
        KanbanDatabase.reconcileDatabases = originalReconcile;
        KanbanDatabase.invalidateWorkspace = originalInvalidate;
        await KanbanDatabase.invalidateWorkspace(path.join(tempRoot, 'GitHub')).catch(() => undefined);
        await KanbanDatabase.invalidateWorkspace(path.join(tempRoot, 'import-root')).catch(() => undefined);
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
        vscodeMock.restore();
    }

    console.log('control plane migration test passed');
}

run().catch((error) => {
    console.error('control plane migration test failed:', error);
    process.exit(1);
});
